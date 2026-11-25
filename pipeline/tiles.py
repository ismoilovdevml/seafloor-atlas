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
LOW_LAND_ALPHA = 1           # reserved: dry land below sea level (polders, dry basins); ocean pixels never use it
LAKE_ALPHA = 3               # reserved: inland water below sea level (Caspian, Dead Sea, Great Lakes beds)
RESERVED = (LOW_LAND_ALPHA, LAKE_ALPHA)
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


def veil(f: np.ndarray, low: np.ndarray | None = None, lake: np.ndarray | None = None) -> np.ndarray:
    """measured fraction (NaN = land) -> RGBA uint8.

    Alpha 0 means "fully measured" over a DEM height below 0, so land below sea level gets reserved alphas
    instead, invisible on the map and decoded as land (pipeline/viewer_land.py): `low` = share of the pixel that
    is dry viewer land (alpha 1; the viewer draws it as land), `lake` = share that is inland water (alpha 3; the
    viewer keeps its bed relief). Ocean pixels that would round to a reserved alpha move one step away
    (a 0.4 % shift).
    """
    out = np.zeros(f.shape + (4,), dtype=np.uint8)
    out[..., 0], out[..., 1], out[..., 2] = VEIL_RGB
    ocean = ~np.isnan(f)
    v = VEIL_MAX * (1.0 - np.clip(f[ocean], 0, 1))
    a = np.rint(v)
    for r in RESERVED:
        hit = a == r
        a[hit] = np.where(v[hit] < r, r - 1, r + 1)
    out[..., 3][ocean] = a.astype(np.uint8)
    lo = np.zeros(f.shape, np.float32) if low is None else low
    lk = np.zeros(f.shape, np.float32) if lake is None else lake
    reserved = ~ocean & (lo + lk >= 0.5)
    out[..., 3][reserved & (lo >= lk)] = LOW_LAND_ALPHA
    out[..., 3][reserved & (lk > lo)] = LAKE_ALPHA
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


MERC_LAT = 85.0511287798066  # Web Mercator tiles end here
BLEND_FROM = 84.8            # start of the fade into the polar cap (keeps real Arctic data such as the Gakkel Ridge, 84.7 N)
EXACT_FROM = 84.92           # poleward of this the value IS the cap: 64 rows at z5, so the outermost
                             # rows stay exact after the 2x2 means down to z0 (else hillshade draws faint spokes)


def polar_caps(src_path: Path, src_nodata, transform_values=None) -> tuple[float, float]:
    """Area-weighted mean of the source grid beyond +-MERC_LAT (north, south). NaN when most of the cap is NaN.

    MapLibre's globe draws the area beyond the last tile row by stretching that row to the pole, which
    turns any variation along it into a radial fan. Making the last rows equal to the real cap mean
    turns the fan into a smooth, flat cap with the correct average depth.
    """
    with rasterio.open(src_path) as src:
        a = src.read(1).astype(np.float64)
        if src_nodata is not None and not (isinstance(src_nodata, float) and np.isnan(src_nodata)):
            a[a == src_nodata] = np.nan
        if transform_values is not None:
            a = transform_values(a)
        lat = src.transform.f + (np.arange(src.height) + 0.5) * src.transform.e
    out = []
    for m in (lat > MERC_LAT, lat < -MERC_LAT):
        v = a[m]
        w = np.broadcast_to(np.cos(np.radians(lat[m]))[:, None], v.shape)
        ok = ~np.isnan(v)
        if w[ok].sum() < 0.5 * w.sum():
            out.append(float("nan"))
        else:
            out.append(float((v[ok] * w[ok]).sum() / w[ok].sum()))
    return out[0], out[1]


def row_latitudes(size: int) -> np.ndarray:
    y = (np.arange(size) + 0.5) / size          # 0 = north edge
    return np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y))))


def blend_poles(a: np.ndarray, north: float, south: float, lat: np.ndarray | None = None,
                edge_rows: tuple[bool, bool] = (True, True)) -> np.ndarray:
    """Fade the rows poleward of BLEND_FROM into the cap value (in place). NaN cap = fade into NaN.

    `lat` = latitude of each row (default: a full-globe Mercator array). For a band cut out of a larger
    grid, pass its row latitudes and say which of its ends are the true north/south edges of the map.
    """
    lat = row_latitudes(a.shape[0]) if lat is None else lat
    t = np.clip((np.abs(lat) - BLEND_FROM) / (EXACT_FROM - BLEND_FROM), 0, 1)
    w = t * t * (3 - 2 * t)  # smoothstep, = 1 from EXACT_FROM to the edge
    # the rows MapLibre stretches to the pole must be exactly the cap (also after 2x2 means)
    if edge_rows[0]:
        w[:2] = 1.0
    if edge_rows[1]:
        w[-2:] = 1.0
    for rows, cap in ((lat > BLEND_FROM, north), (lat < -BLEND_FROM, south)):
        for r in np.nonzero(rows)[0]:
            if np.isnan(cap):
                if w[r] >= 0.5:
                    a[r] = np.nan
            else:
                # NaN (e.g. land in the coverage layer) stays NaN until the cap takes over
                row = np.where(np.isnan(a[r]), cap if w[r] >= 0.5 else np.nan, a[r])
                a[r] = (1 - w[r]) * row + w[r] * cap
    return a


def down2(a: np.ndarray) -> np.ndarray:
    """2x2 NaN-aware mean."""
    h, w = a.shape
    b = a.reshape(h // 2, 2, w // 2, 2)
    with np.errstate(invalid="ignore"):
        s = np.nansum(b, axis=(1, 3))
        n = np.sum(~np.isnan(b), axis=(1, 3))
        return np.where(n > 0, s / np.maximum(n, 1), np.nan).astype(np.float32)


def write_pyramid(base: np.ndarray, out: Path, maxzoom: int, tile: int, encode,
                  extra: tuple[np.ndarray, ...] = ()) -> int:
    """Tiles of `base` for z = maxzoom..0 (2x2 NaN-aware means); extra arrays are passed as encode(block, *extra)."""
    level, xl = base, list(extra)
    count = 0
    for z in range(maxzoom, -1, -1):
        n = 2 ** z
        assert level.shape == (n * tile, n * tile), (z, level.shape)
        for y in range(n):
            for x in range(n):
                sl = (slice(y * tile, (y + 1) * tile), slice(x * tile, (x + 1) * tile))
                block = level[sl]
                p = out / str(z) / str(x)
                p.mkdir(parents=True, exist_ok=True)
                img = encode(block, *(x[sl] for x in xl))
                Image.fromarray(img).save(p / f"{y}.webp", lossless=True, quality=100, method=4)
                count += 1
        if z:
            level = down2(level)
            xl = [down2(x) for x in xl]
    return count


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--elev", type=Path, default=ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif")
    ap.add_argument("--coverage", type=Path, default=ROOT / "data/derived/coverage_viewer_1arcmin.tif",
                    help="1' coverage grid; the viewer one (coverage.py viewer) draws inland basins and polders as land")
    ap.add_argument("--stats", type=Path, default=ROOT / "data/derived/stats.json")
    ap.add_argument("--out", type=Path, default=ROOT / "web/public/tiles")
    ap.add_argument("--maxzoom", type=int, default=5)
    ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--source-arcsec", type=int, default=60)
    ap.add_argument("--low-land", type=Path, default=ROOT / "data/derived/viewer_lowland_1arcmin.tif",
                    help="viewer-land sub-cells per 1' cell (coverage.py viewer); drawn as reserved alpha 1")
    ap.add_argument("--lakes", type=Path, default=ROOT / "data/derived/viewer_lakes_1arcmin.tif",
                    help="inland-water sub-cells per 1' cell (coverage.py viewer); drawn as reserved alpha 3")
    ap.add_argument("--only", choices=["dem", "coverage", "new2026", "all"], default="all")
    ap.add_argument("--new2026", type=Path, default=ROOT / "data/derived/new2026_1arcmin.tif")
    ap.add_argument("--change", type=Path, default=ROOT / "data/derived/change_2025_2026.json")
    args = ap.parse_args()
    size = args.tile * 2 ** args.maxzoom

    caps: dict[str, tuple[float, float]] = {}
    count = lambda d: sum(1 for _ in (args.out / d).rglob("*.webp")) if (args.out / d).exists() else 0
    if args.only in ("dem", "all"):
        dem = warp_to_merc(args.elev, size, np.float32, src_nodata=-32767)
        assert not np.isnan(dem).any(), "DEM has holes after warp"
        caps["dem"] = polar_caps(args.elev, -32767)
        blend_poles(dem, *caps["dem"])
        write_pyramid(dem, args.out / "dem", args.maxzoom, args.tile, lambda b: terrarium(np.rint(b)))  # integer metres: GEBCO is integer, and B=0 compresses 2.3x better
        del dem
    if args.only in ("coverage", "all"):
        # coverage: 0 = land -> NaN, 1..255 -> fraction
        tv = lambda a: np.where(a == 0, np.nan, (a - 1.0) / 254.0)
        cov = warp_to_merc(args.coverage, size, np.float32, src_nodata=np.nan, transform_values=tv)
        caps["coverage"] = polar_caps(args.coverage, None, tv)
        blend_poles(cov, *caps["coverage"])
        extra = []
        for path in (args.low_land, args.lakes):   # 0..16 sub-cells per 1' cell (coverage.py viewer)
            if not path.exists():
                break
            extra.append(np.nan_to_num(warp_to_merc(path, size, np.float32, src_nodata=None,
                                                    transform_values=lambda a: a / 16.0)))
        write_pyramid(cov, args.out / "coverage", args.maxzoom, args.tile, veil, extra=tuple(extra))
        del cov, extra
    if args.only in ("new2026", "all") and args.new2026.exists():
        tv = lambda a: np.where(a == 0, np.nan, a / 255.0)
        nw = warp_to_merc(args.new2026, size, np.float32, src_nodata=np.nan, transform_values=tv)
        # sparse layer: only a few cells are new, so fade the cap to "nothing new"
        caps["new2026"] = (float("nan"), float("nan"))
        blend_poles(nw, *caps["new2026"])
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
        "polarCaps": {k: [None if np.isnan(v) else round(v, 3) for v in vals] for k, vals in caps.items()},
        "tiles": {"dem": n_dem, "coverage": n_cov, "new2026": count("new2026")},
    }
    old_meta = args.out / "meta.json"
    if old_meta.exists():  # keep the z6+ archive pointer written by pipeline/publish_hires.py
        prev = json.loads(old_meta.read_text())
        if prev.get("hires"):
            meta["hires"] = prev["hires"]
    (args.out / "meta.json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
