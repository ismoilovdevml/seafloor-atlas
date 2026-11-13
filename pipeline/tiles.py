"""Web Mercator XYZ tiles for the viewer (see docs/data-contract.md).

dem/{z}/{x}/{y}.webp      lossless WebP, Terrarium encoding (fractional metres kept in B)
coverage/{z}/{x}/{y}.webp lossless WebP RGBA veil, alpha = VEIL_MAX * (1 - measured fraction) over ocean
meta.json

The base level (maxzoom) is warped once with GDAL 'average'; lower levels are 2x2 means
(NaN-aware for coverage), so every zoom level is consistent with the base.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject

ROOT = Path(__file__).resolve().parents[1]
MERC = 20037508.342789244
VEIL_MAX = 230
VEIL_RGB = (0x0B, 0x14, 0x24)


def terrarium(h: np.ndarray) -> np.ndarray:
    """float metres -> uint8 RGB (H, W, 3), Terrarium: h = R*256 + G + B/256 - 32768."""
    # quantise to 1/256 m in integer space so the B-channel rounding can carry into G and R
    v = np.rint((np.clip(h.astype(np.float64), -32768, 32767.99) + 32768.0) * 256.0).astype(np.int64)
    v = np.clip(v, 0, 2 ** 24 - 1)
    return np.stack([(v >> 16) & 255, (v >> 8) & 255, v & 255], axis=-1).astype(np.uint8)


def unterrarium(rgb: np.ndarray) -> np.ndarray:
    rgb = rgb.astype(np.float64)
    return rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0


def veil(f: np.ndarray) -> np.ndarray:
    """measured fraction (NaN = land) -> RGBA uint8."""
    out = np.zeros(f.shape + (4,), dtype=np.uint8)
    out[..., 0], out[..., 1], out[..., 2] = VEIL_RGB
    ocean = ~np.isnan(f)
    out[..., 3][ocean] = np.rint(VEIL_MAX * (1.0 - np.clip(f[ocean], 0, 1))).astype(np.uint8)
    return out


NEW_RGB = (0xE4, 0x57, 0x2E)


def new_layer(f: np.ndarray) -> np.ndarray:
    """share of a pixel newly measured in GEBCO_2026 (NaN = none) -> red RGBA; thin survey lines stay visible."""
    out = np.zeros(f.shape + (4,), dtype=np.uint8)
    out[..., 0], out[..., 1], out[..., 2] = NEW_RGB
    g = np.nan_to_num(f)
    out[..., 3] = np.where(g > 0, np.rint(80 + 175 * np.clip(3 * g, 0, 1)), 0).astype(np.uint8)
    return out


def warp_to_merc(src_path: Path, size: int, dtype, src_nodata, transform_values=None) -> np.ndarray:
    dst = np.full((size, size), np.nan, dtype=np.float32)
    with rasterio.open(src_path) as src:
        a = src.read(1).astype(np.float32)
        if transform_values is not None:
            a = transform_values(a)
        dst_t = from_bounds(-MERC, -MERC, MERC, MERC, size, size)
        reproject(a, dst, src_transform=src.transform, src_crs=src.crs or CRS.from_epsg(4326),
                  src_nodata=src_nodata, dst_transform=dst_t, dst_crs=CRS.from_epsg(3857),
                  dst_nodata=np.nan, resampling=Resampling.average, num_threads=8,
                  warp_mem_limit=4096)
    return dst


def down2(a: np.ndarray) -> np.ndarray:
    """2x2 NaN-aware mean."""
    h, w = a.shape
    b = a.reshape(h // 2, 2, w // 2, 2)
    with np.errstate(invalid="ignore"):
        s = np.nansum(b, axis=(1, 3))
        n = np.sum(~np.isnan(b), axis=(1, 3))
        return np.where(n > 0, s / np.maximum(n, 1), np.nan).astype(np.float32)


def write_pyramid(base: np.ndarray, out: Path, maxzoom: int, tile: int, encode) -> int:
    level = base
    count = 0
    for z in range(maxzoom, -1, -1):
        n = 2 ** z
        assert level.shape == (n * tile, n * tile), (z, level.shape)
        for y in range(n):
            for x in range(n):
                block = level[y * tile:(y + 1) * tile, x * tile:(x + 1) * tile]
                p = out / str(z) / str(x)
                p.mkdir(parents=True, exist_ok=True)
                Image.fromarray(encode(block)).save(p / f"{y}.webp", lossless=True, quality=100, method=4)
                count += 1
        if z:
            level = down2(level)
    return count


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--elev", type=Path, default=ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif")
    ap.add_argument("--coverage", type=Path, default=ROOT / "data/derived/coverage_1arcmin.tif")
    ap.add_argument("--stats", type=Path, default=ROOT / "data/derived/stats.json")
    ap.add_argument("--out", type=Path, default=ROOT / "web/public/tiles")
    ap.add_argument("--maxzoom", type=int, default=5)
    ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--source-arcsec", type=int, default=60)
    ap.add_argument("--only", choices=["dem", "coverage", "new2026", "all"], default="all")
    ap.add_argument("--new2026", type=Path, default=ROOT / "data/derived/new2026_1arcmin.tif")
    ap.add_argument("--change", type=Path, default=ROOT / "data/derived/change_2025_2026.json")
    args = ap.parse_args()
    size = args.tile * 2 ** args.maxzoom

    count = lambda d: sum(1 for _ in (args.out / d).rglob("*.webp")) if (args.out / d).exists() else 0
    if args.only in ("dem", "all"):
        dem = warp_to_merc(args.elev, size, np.float32, src_nodata=-32767)
        assert not np.isnan(dem).any(), "DEM has holes after warp"
        write_pyramid(dem, args.out / "dem", args.maxzoom, args.tile, lambda b: terrarium(np.rint(b)))  # integer metres: GEBCO is integer, and B=0 compresses 2.3x better
        del dem
    if args.only in ("coverage", "all"):
        # coverage: 0 = land -> NaN, 1..255 -> fraction
        cov = warp_to_merc(args.coverage, size, np.float32, src_nodata=np.nan,
                           transform_values=lambda a: np.where(a == 0, np.nan, (a - 1.0) / 254.0))
        write_pyramid(cov, args.out / "coverage", args.maxzoom, args.tile, veil)
        del cov
    if args.only in ("new2026", "all") and args.new2026.exists():
        nw = warp_to_merc(args.new2026, size, np.float32, src_nodata=np.nan,
                          transform_values=lambda a: np.where(a == 0, np.nan, a / 255.0))
        write_pyramid(nw, args.out / "new2026", args.maxzoom, args.tile, new_layer)
        del nw
    n_dem, n_cov = count("dem"), count("coverage")
    change = json.loads(args.change.read_text()) if args.change.exists() else None

    stats = json.loads(args.stats.read_text()) if args.stats.exists() else {}
    meta = {
        "version": "GEBCO_2026",
        "tileSize": args.tile,
        "minzoom": 0,
        "maxzoom": args.maxzoom,
        "encoding": "terrarium",
        "veilMax": VEIL_MAX,
        "veilColor": "#%02x%02x%02x" % VEIL_RGB,
        "sourceResolutionArcsec": args.source_arcsec,
        "citation": "GEBCO Compilation Group (2026) GEBCO 2026 Grid",
        "doi": "10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa",
        "licence": "Open Government Licence v3 (attribution required)",
        "stats": {k: stats.get(k) for k in ("measured_fraction_area", "measured_fraction_cells",
                                            "ocean_fraction_of_earth", "group_fraction")},
        "change2025to2026": None if change is None else {
            k: change[k] for k in ("measured_2025_frac", "measured_2026_frac", "newly_measured_km2",
                                   "no_longer_measured_km2", "net_km2")},
        "tiles": {"dem": n_dem, "coverage": n_cov, "new2026": count("new2026")},
    }
    (args.out / "meta.json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
