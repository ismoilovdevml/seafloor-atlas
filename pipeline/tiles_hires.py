"""High-zoom tiles (z6-z7) from the full 15" GEBCO_2026 grid, written to PMTiles archives.

The z0-5 tiles stay as static files on GitHub Pages (pipeline/tiles.py). z6-7 are too big for Pages
(~1 GB limit), so they go into two PMTiles files hosted on Hugging Face and read with HTTP range requests:
  data/derived/hires/dem_z6-7.pmtiles       Terrarium, integer metres, lossless WebP (same as dem/)
  data/derived/hires/coverage_z6-7.pmtiles  veil RGBA (same encoding as coverage/), from the 15" TID grid

Work is done per z6 tile: a 1024 x 1024 window of the global z7 Web Mercator grid is warped from the
15" source with GDAL 'average' (WarpedVRT), giving 4 z7 tiles and, by 2x2 mean, 1 z6 tile.
Polar rows are blended into the same caps as the low zooms (pipeline/tiles.py), so no fan at the poles.
"""
from __future__ import annotations

import argparse
from contextlib import nullcontext
import io
import json
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from rasterio.crs import CRS
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from rasterio.warp import Resampling
from rasterio.windows import Window
from scipy.ndimage import distance_transform_edt

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tiles import BLEND_FROM, MERC, blend_poles, down2, terrarium, veil  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/gebco_2026"
OUT = ROOT / "data/derived/hires"
TILE = 512
ZMAX = 7


def webp(rgb: np.ndarray) -> bytes:
    b = io.BytesIO()
    Image.fromarray(rgb).save(b, "WEBP", lossless=True, quality=100, method=4)
    return b.getvalue()


def row_lat_global(rows: np.ndarray, size: int) -> np.ndarray:
    y = (rows + 0.5) / size
    return np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y))))


def fill_nearest(a: np.ndarray) -> np.ndarray:
    """Replace NaN pixels with the value of the nearest finite pixel (Euclidean, in pixels).

    Used for the DEM, where Terrarium needs a finite height everywhere: the warp leaves hairline gaps at the
    antimeridian seam, and a nearest-neighbour fill keeps the local depth instead of a tile-wide mean.
    Returns a unchanged if it has no NaN, and an all-NaN array unchanged (nothing to fill from).
    """
    bad = np.isnan(a)
    if not bad.any() or bad.all():
        return a
    idx = distance_transform_edt(bad, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def build_coverage_15s(elev15: Path, tid15: Path, out: Path, land15: Path | None = None) -> None:
    """15" measured flag: 255 = direct (TID 10-17), 0 = other ocean, 128 = nodata (land / elev >= 0, and the
    viewer land mask of pipeline/viewer_land.py when land15 is given)."""
    if out.exists():
        return
    land = rasterio.open(land15) if land15 else None
    with rasterio.open(elev15) as e, rasterio.open(tid15) as t:
        assert e.shape == t.shape
        prof = t.profile.copy()
        prof.update(dtype="uint8", nodata=128, compress="deflate", tiled=True, blockxsize=512, blockysize=512)
        with rasterio.open(out, "w", **prof) as dst:
            for r0 in range(0, t.height, 1024):
                w = Window(0, r0, t.width, min(1024, t.height - r0))
                tid = t.read(1, window=w).astype(np.int16)
                h = e.read(1, window=w)
                o = np.full(tid.shape, 128, dtype=np.uint8)
                ocean = (tid != 0) & (h < 0)
                if land is not None:
                    ocean &= land.read(1, window=w) == 0
                o[ocean] = 0
                o[ocean & (tid >= 10) & (tid <= 17)] = 255
                dst.write(o, 1, window=w)
                print(f"\rcoverage15 rows {r0 + w.height}/{t.height}", end="", file=sys.stderr)
    print(file=sys.stderr)


def run(kind: str, src_path: Path, caps: tuple[float, float], out_path: Path, limit: int | None,
        low_path: Path | None = None) -> dict:
    """low_path (coverage only): 15" viewer land mask (and its viewer_lake_15s.tif sibling), averaged per pixel and
    drawn with the reserved alphas: dry share = land - lake, lake share = lake."""
    size = TILE * 2 ** ZMAX                       # z7 global pixels per side
    dst_t = from_bounds(-MERC, -MERC, MERC, MERC, size, size)
    n6 = 2 ** (ZMAX - 1)
    stats = {"tiles": 0, "bytes": 0}
    t0 = time.time()
    with rasterio.open(src_path) as src, WarpedVRT(
            src, crs=CRS.from_epsg(3857), transform=dst_t, width=size, height=size,
            resampling=Resampling.average, src_nodata=src.nodata, nodata=np.nan, dtype="float32",
            warp_mem_limit=1024, num_threads=8) as vrt, open(out_path, "wb") as f, \
            (rasterio.open(low_path) if low_path else nullcontext()) as lsrc, \
            (WarpedVRT(lsrc, crs=CRS.from_epsg(3857), transform=dst_t, width=size, height=size,
                       resampling=Resampling.average, dtype="float32", warp_mem_limit=1024, num_threads=8)
             if low_path else nullcontext()) as lvrt, \
            (rasterio.open(low_path.with_name("viewer_lake_15s.tif")) if low_path else nullcontext()) as ksrc, \
            (WarpedVRT(ksrc, crs=CRS.from_epsg(3857), transform=dst_t, width=size, height=size,
                       resampling=Resampling.average, dtype="float32", warp_mem_limit=1024, num_threads=8)
             if low_path else nullcontext()) as kvrt:
        w = Writer(f)
        done = 0
        for y6 in range(n6):
            for x6 in range(n6):
                win = Window(x6 * 2 * TILE, y6 * 2 * TILE, 2 * TILE, 2 * TILE)
                a = vrt.read(1, window=win).astype(np.float32)
                low = lake = None
                if kind == "coverage":
                    a = a / 255.0                       # mean of 0/255 flags = measured fraction
                    if lvrt is not None:
                        lake = kvrt.read(1, window=win).astype(np.float32)
                        low = lvrt.read(1, window=win).astype(np.float32) - lake
                lat = row_lat_global(np.arange(win.row_off, win.row_off + win.height), size)
                if np.abs(lat).max() > BLEND_FROM:
                    blend_poles(a, *caps, lat=lat, edge_rows=(y6 == 0, y6 == n6 - 1))
                if kind == "dem":
                    a = fill_nearest(a)                  # tiny gaps at the antimeridian seam
                    enc = lambda b: terrarium(np.rint(b))
                else:
                    enc = veil
                for dy in range(2):
                    for dx in range(2):
                        sl = (slice(dy * TILE, (dy + 1) * TILE), slice(dx * TILE, (dx + 1) * TILE))
                        data = webp(enc(a[sl]) if low is None else enc(a[sl], low[sl], lake[sl]))
                        w.write_tile(zxy_to_tileid(7, 2 * x6 + dx, 2 * y6 + dy), data)
                        stats["tiles"] += 1
                        stats["bytes"] += len(data)
                data = webp(enc(down2(a)) if low is None else enc(down2(a), down2(low), down2(lake)))
                w.write_tile(zxy_to_tileid(6, x6, y6), data)
                stats["tiles"] += 1
                stats["bytes"] += len(data)
                done += 1
                if done % 64 == 0:
                    el = time.time() - t0
                    print(f"\r{kind}: {done}/{n6 * n6} z6 blocks, {stats['bytes'] / 1e9:.2f} GB, "
                          f"eta {el / done * (n6 * n6 - done) / 60:.0f} min", end="", file=sys.stderr)
                if limit and done >= limit:
                    break
            if limit and done >= limit:
                break
        w.finalize({
            "tile_type": TileType.WEBP, "tile_compression": Compression.NONE,
            "min_lon_e7": -1800000000, "min_lat_e7": -850511287, "max_lon_e7": 1800000000, "max_lat_e7": 850511287,
            "center_zoom": 6, "center_lon_e7": 0, "center_lat_e7": 0,
        }, {"name": f"seafloor-atlas {kind} z6-7", "attribution": "GEBCO Compilation Group (2026) GEBCO 2026 Grid",
            "encoding": "terrarium" if kind == "dem" else "veil", "source": "GEBCO_2026 15 arc-second"})
    print(file=sys.stderr)
    stats["seconds"] = round(time.time() - t0)
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["dem", "coverage", "all"], default="all")
    ap.add_argument("--limit", type=int, default=None, help="only the first N z6 blocks (timing test)")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    meta = json.loads((ROOT / "web/public/tiles/meta.json").read_text())
    caps = meta["polarCaps"]
    elev15 = RAW / "GEBCO_2026_15s.tif"
    res = {}
    if args.only in ("dem", "all"):
        res["dem"] = run("dem", elev15, tuple(np.nan if v is None else v for v in caps["dem"]),
                         OUT / "dem_z6-7.pmtiles", args.limit)
    if args.only in ("coverage", "all"):
        cov15 = ROOT / "data/derived/coverage_viewer_15s.tif"
        build_coverage_15s(elev15, RAW / "gebco_2026_tid.tif", cov15, ROOT / "data/derived/viewer_land_15s.tif")
        res["coverage"] = run("coverage", cov15, tuple(np.nan if v is None else v for v in caps["coverage"]),
                              OUT / "coverage_z6-7.pmtiles", args.limit, ROOT / "data/derived/viewer_land_15s.tif")
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
