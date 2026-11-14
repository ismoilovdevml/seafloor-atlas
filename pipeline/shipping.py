"""Global shipping traffic density -> web/public/tiles/shipping/{z}/{x}/{y}.webp + legend.json.

Source: World Bank / IMF "Global Shipping Traffic Density" (dataset 0037580, CC BY 4.0):
shipdensity_global.tif inside shipdensity_global.zip, Int32 count of AIS positions per 0.005 deg cell,
Jan 2015 - Feb 2021, all vessel types. 72006 x 33998, about 85 S to 85 N, 9.8 GB uncompressed.

Steps (see docs/data-contract.md, "Shipping traffic density"):
1. stream the GeoTIFF straight out of the zip (/vsizip/, 128-row strips read in file order, no 9.8 GB
   extract) and sum 4 x 4 blocks -> 0.02 deg grid of counts (data/derived/shipping_counts_0p02deg.tif);
2. counts / (cell area km2 * years) -> AIS positions per km2 per year;
3. warp to Web Mercator at z5 x 512 px with GDAL 'average', 2x2 means for z4..z0 (same as the DEM);
4. colour-map log10(density) and write lossy WebP RGBA (0 traffic = transparent).
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np
import rasterio
from matplotlib import colormaps
from PIL import Image
from rasterio.transform import Affine
from rasterio.windows import Window

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tiles import down2, warp_to_merc  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ZIP = ROOT / "data/raw/shipping/shipdensity_global.zip"
SRC = f"/vsizip/{ZIP}/shipdensity_global.tif"
COUNTS = ROOT / "data/derived/shipping_counts_0p02deg.tif"
DENSITY = ROOT / "data/derived/shipping_density_0p02deg.tif"
OUT = ROOT / "web/public/tiles/shipping"

BLOCK = 4                       # 0.005 deg -> 0.02 deg
YEARS = 74 / 12                 # Jan 2015 .. Feb 2021 inclusive = 74 months
R_KM = 6371.0072
# colour scale: log10(positions / km2 / yr). Fixed so the legend is stable across rebuilds.
# The non-zero 0.02 deg cells are bimodal (density() prints the percentiles): a noise mode of cells with
# a handful of positions in six years (log10 -1.5 .. 0.5) and the traffic mode (log10 2 .. 7.5, peak 5.5),
# with a gap at 1 .. 1.5. Colour spans the traffic mode; below 10**(LOG_MIN-1) is transparent.
LOG_MIN, LOG_MAX = 2.5, 8.0
FADE_FROM = 2.0                 # log10: transparent below, alpha ramps up to ALPHA_MIN at LOG_MIN
CMAP = "inferno"
CMAP_FROM = 0.18                # skip the near-black start of inferno (invisible on a dark ocean)
ALPHA_MIN, ALPHA_MAX = 70, 235


def aggregate() -> None:
    """Stream the 9.8 GB tif from the zip and write the 0.02 deg block sums."""
    with rasterio.open(SRC) as src:
        assert src.dtypes[0] == "int32" and abs(src.res[0] - 0.005) < 1e-9, src.profile
        nodata = src.nodata
        w, h = src.width // BLOCK * BLOCK, src.height // BLOCK * BLOCK
        out = np.zeros((h // BLOCK, w // BLOCK), dtype=np.float64)
        strip = 128
        total = 0.0
        for r0 in range(0, h, strip):
            rows = min(strip, h - r0)
            a = src.read(1, window=Window(0, r0, w, rows)).astype(np.float64)
            if nodata is not None:
                a[a == nodata] = 0
            assert (a >= 0).all(), "negative counts"
            total += a.sum()
            out[r0 // BLOCK:(r0 + rows) // BLOCK] = a.reshape(rows // BLOCK, BLOCK, w // BLOCK, BLOCK).sum(axis=(1, 3))
            if (r0 // strip) % 20 == 0:
                print(f"  rows {r0}/{h}", flush=True)
        t = src.transform
        transform = Affine(t.a * BLOCK, 0, t.c, 0, t.e * BLOCK, t.f)
    assert math.isclose(out.sum(), total, rel_tol=1e-9)
    COUNTS.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(COUNTS, "w", driver="GTiff", width=out.shape[1], height=out.shape[0], count=1,
                       dtype="float32", crs="EPSG:4326", transform=transform, compress="deflate",
                       predictor=3, tiled=True, nodata=None) as dst:
        dst.write(out.astype(np.float32), 1)
    print(f"wrote {COUNTS} {out.shape}, total positions {total:.4e}")


def cell_area_km2(transform: Affine, height: int, width_deg: float) -> np.ndarray:
    """Area of each grid row's cells on the sphere (km2), shape (height, 1)."""
    lat_top = transform.f + np.arange(height) * transform.e
    lat_bot = lat_top + transform.e
    dlon = math.radians(width_deg)
    a = R_KM ** 2 * dlon * np.abs(np.sin(np.radians(lat_top)) - np.sin(np.radians(lat_bot)))
    return a[:, None]


def density() -> None:
    with rasterio.open(COUNTS) as src:
        c = src.read(1).astype(np.float64)
        t, prof = src.transform, src.profile
    d = c / (cell_area_km2(t, c.shape[0], t.a) * YEARS)
    prof.update(dtype="float32")
    with rasterio.open(DENSITY, "w", **prof) as dst:
        dst.write(d.astype(np.float32), 1)
    nz = d[d > 0]
    lg = np.log10(nz)
    print(f"density: {nz.size} non-zero cells of {d.size} ({nz.size / d.size:.1%}); "
          "log10 percentiles p1/p10/p50/p90/p99/p99.9/max = "
          + " / ".join(f"{np.percentile(lg, q):.2f}" for q in (1, 10, 50, 90, 99, 99.9)) + f" / {lg.max():.2f}")


def colorize(block: np.ndarray) -> np.ndarray:
    cmap = colormaps[CMAP]
    out = np.zeros(block.shape + (4,), dtype=np.uint8)
    ok = np.isfinite(block) & (block > 0)
    if not ok.any():
        return out
    t = np.clip((np.log10(block[ok]) - LOG_MIN) / (LOG_MAX - LOG_MIN), 0, 1)
    rgba = cmap(CMAP_FROM + (1 - CMAP_FROM) * t)
    out[..., :3][ok] = np.rint(rgba[:, :3] * 255).astype(np.uint8)
    # below LOG_MIN fades out instead of clipping, so light traffic still shows faintly
    lo = np.clip((np.log10(block[ok]) - FADE_FROM) / (LOG_MIN - FADE_FROM), 0, 1)
    out[..., 3][ok] = np.rint(lo * (ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * t)).astype(np.uint8)
    return out


def write_tiles(maxzoom: int, tile: int, quality: int, alpha_quality: int) -> dict:
    size = tile * 2 ** maxzoom
    level = warp_to_merc(DENSITY, size, np.float32, src_nodata=None)
    # zeros stay 0 so the 2x2 means are true area means; NaN only beyond the source's +-85 deg
    nbytes, ntiles, empty = 0, 0, 0
    for z in range(maxzoom, -1, -1):
        n = 2 ** z
        for y in range(n):
            for x in range(n):
                block = level[y * tile:(y + 1) * tile, x * tile:(x + 1) * tile]
                rgba = colorize(block)
                p = OUT / str(z) / str(x)
                p.mkdir(parents=True, exist_ok=True)
                f = p / f"{y}.webp"
                if rgba[..., 3].max() == 0:
                    empty += 1
                    Image.fromarray(rgba).save(f, lossless=True)   # ~100 B
                else:
                    Image.fromarray(rgba).save(f, quality=quality, alpha_quality=alpha_quality, method=6)
                nbytes += f.stat().st_size
                ntiles += 1
        print(f"  z{z}: done, {nbytes / 1e6:.1f} MB so far", flush=True)
        if z:
            level = down2(level)
    return {"tiles": ntiles, "emptyTiles": empty, "bytes": nbytes}


def legend(info: dict, maxzoom: int, tile: int) -> dict:
    cmap = colormaps[CMAP]
    stops = []
    for v in sorted({LOG_MIN, LOG_MAX, *range(math.ceil(LOG_MIN), math.floor(LOG_MAX) + 1)}):
        t = (v - LOG_MIN) / (LOG_MAX - LOG_MIN)
        r, g, b, _ = cmap(CMAP_FROM + (1 - CMAP_FROM) * t)
        stops.append({"value": float(f"{10 ** v:.3g}"), "log10": float(v),
                      "color": "#%02x%02x%02x" % tuple(int(round(c * 255)) for c in (r, g, b))})
    return {
        "layer": "shipping",
        "title": "Shipping traffic density",
        "units": "AIS position reports per km² per year",
        "period": "2015-01/2021-02",
        "scale": "log10",
        "log10Min": LOG_MIN, "log10Max": LOG_MAX,
        "transparentBelow": float(10 ** FADE_FROM), "alphaMin": ALPHA_MIN, "alphaMax": ALPHA_MAX,
        "colormap": f"matplotlib {CMAP} from {CMAP_FROM}",
        "stops": stops,
        "tileSize": tile, "minzoom": 0, "maxzoom": maxzoom, "format": "webp (lossy RGBA)",
        "sourceResolutionDeg": 0.005, "aggregatedResolutionDeg": 0.005 * BLOCK,
        "source": "World Bank / IMF, Global Shipping Traffic Density (dataset 0037580)",
        "sourceUrl": "https://datacatalog.worldbank.org/search/dataset/0037580",
        "licence": "CC BY 4.0",
        "attribution": "Shipping density: World Bank / IMF (Cerdeiro, Komaromi, Liu & Saeed 2020), CC BY 4.0",
        **info,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--maxzoom", type=int, default=5)
    ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--quality", type=int, default=35, help="WebP colour quality (size budget ~40 MB)")
    ap.add_argument("--alpha-quality", type=int, default=35)
    ap.add_argument("--force", action="store_true", help="redo the aggregation even if cached")
    args = ap.parse_args()
    if args.force or not COUNTS.exists():
        aggregate()
    density()
    shutil.rmtree(OUT, ignore_errors=True)
    info = write_tiles(args.maxzoom, args.tile, args.quality, args.alpha_quality)
    leg = legend(info, args.maxzoom, args.tile)
    (OUT / "legend.json").write_text(json.dumps(leg, indent=1, ensure_ascii=False))
    print(json.dumps(info))


if __name__ == "__main__":
    main()
