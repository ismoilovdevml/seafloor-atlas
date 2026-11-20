"""Polar relief for the globe: the GEBCO_2026 15" elevation poleward of 83 degrees on a polar grid.

Web Mercator tiles stop at +-85.051 degrees, so MapLibre fills the rest of each pole with the tiles' edge row and
tiles.py flattens the last rows into one mean value to keep that fill from streaking: a flat disc ~560 km across.
This script keeps the real relief there. The viewer (web/src/polar-layer.ts) drapes each image on a disc mesh
over the globe, coloured with the map's own ramp and shaded in the shader, and fades it in from 83.05 degrees, where
the tiles still carry real relief.

Grid: azimuthal equidistant around the pole, distance in degrees of latitude from the pole, N x N pixels over a
square of half-width RADIUS_DEG. Pixel (i, j) centre: X = (j + 0.5) * 2R / N - R, Y = R - (i + 0.5) * 2R / N;
d = hypot(X, Y); north: lat = 90 - d, lon = atan2(X, -Y); south: lat = -90 + d, lon = atan2(X, Y). Each pixel is
the area-weighted mean (cos lat) of the 15" cells falling into it (bin average); the few empty pixels take their
nearest neighbour. Encoded as Terrarium RGB in lossless WebP, like the depth tiles.

Input : data/raw/gebco_2026/GEBCO_2026_15s.tif (ice-surface grid, the same elevation as the depth tiles)
Output: web/public/tiles/polar/north.webp, south.webp, polar.json
    python pipeline/polar.py [--size 2048]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tiles import terrarium  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data/raw/gebco_2026/GEBCO_2026_15s.tif"
OUT = ROOT / "web/public/tiles/polar"
RADIUS_DEG = 7.0            # disc reaches 83 degrees; the viewer fades it in between 83.05 and 83.3, so it also covers the
                            # band where Mercator tiles stretch 15" rows into visible terraces (about 83-85 degrees)
ROWS = int(round((RADIUS_DEG + 0.1) * 240))  # 15" rows read per pole (a little beyond the disc)


def polar_xy(lat: np.ndarray, lon: np.ndarray, north: bool) -> tuple[np.ndarray, np.ndarray]:
    """Grid-plane coordinates (degrees) of lat/lon for the north or south disc."""
    d = (90.0 - lat) if north else (lat + 90.0)
    a = np.radians(lon)
    return d * np.sin(a), (-d * np.cos(a)) if north else (d * np.cos(a))


def pixel_latlon(n: int, north: bool, radius: float = RADIUS_DEG) -> tuple[np.ndarray, np.ndarray]:
    """lat, lon of every pixel centre (the inverse of polar_xy), shape (n, n)."""
    c = (np.arange(n) + 0.5) * 2 * radius / n - radius
    X, Y = np.meshgrid(c, -c)          # row 0 = top (+Y)
    d = np.hypot(X, Y)
    lat = 90.0 - d if north else -90.0 + d
    lon = np.degrees(np.arctan2(X, -Y) if north else np.arctan2(X, Y))
    return lat, lon


def bin_average(lat: np.ndarray, lon: np.ndarray, z: np.ndarray, n: int, north: bool,
                radius: float = RADIUS_DEG) -> np.ndarray:
    """Area-weighted mean of the cells (lat, lon, z: same-shape arrays) in each of n x n pixels; NaN = empty."""
    X, Y = polar_xy(lat, lon, north)
    j = np.floor((X + radius) / (2 * radius) * n).astype(np.int64)
    i = np.floor((radius - Y) / (2 * radius) * n).astype(np.int64)
    ok = (i >= 0) & (i < n) & (j >= 0) & (j < n) & np.isfinite(z)
    k = (i[ok] * n + j[ok])
    w = np.cos(np.radians(lat[ok]))
    s = np.bincount(k, weights=w * z[ok], minlength=n * n)
    sw = np.bincount(k, weights=w, minlength=n * n)
    out = np.full(n * n, np.nan)
    np.divide(s, sw, out=out, where=sw > 0)
    return out.reshape(n, n)


def fill_nearest(a: np.ndarray) -> np.ndarray:
    from scipy import ndimage

    bad = ~np.isfinite(a)
    if not bad.any():
        return a
    idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def build(size: int) -> None:
    import rasterio
    from PIL import Image
    from rasterio.windows import Window

    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"source": "GEBCO_2026 Grid, 15 arc-second ice-surface elevation (GEBCO Compilation Group 2026, "
                      "doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa)",
            "projection": "azimuthal equidistant around the pole, units = degrees of latitude from the pole; "
                          "pixel (i, j) centre X = (j + 0.5) * 2R / N - R, Y = R - (i + 0.5) * 2R / N; "
                          "north lon = atan2(X, -Y), south lon = atan2(X, Y)",
            "encoding": "Terrarium RGB, lossless WebP: h = R * 256 + G + B / 256 - 32768 (metres)",
            "size": size, "radius_deg": RADIUS_DEG, "pixel_km": round(2 * RADIUS_DEG * 111.195 / size, 3), "poles": {}}
    with rasterio.open(SRC) as src:
        H, W = src.height, src.width
        lon_c = -180 + (np.arange(W) + 0.5) * 360 / W
        for name, north in (("north", True), ("south", False)):
            r0 = 0 if north else H - ROWS
            z = src.read(1, window=Window(0, r0, W, ROWS)).astype(np.float64)
            lat_c = 90 - (r0 + np.arange(ROWS) + 0.5) * 180 / H
            LAT = np.broadcast_to(lat_c[:, None], z.shape)
            LON = np.broadcast_to(lon_c[None, :], z.shape)
            g = bin_average(LAT.ravel(), LON.ravel(), z.ravel(), size, north)
            empty = int((~np.isfinite(g)).sum())
            g = fill_nearest(g)
            plat, _ = pixel_latlon(size, north)
            disc = np.abs(plat) >= 90 - RADIUS_DEG
            # the square's corners lie outside the disc and are never drawn: one flat value compresses to nothing
            g[np.abs(plat) < 90 - RADIUS_DEG - 0.05] = float(np.median(g[disc & (np.abs(plat) < 90 - RADIUS_DEG + 0.1)]))
            # whole metres: the averages' fractions would fill the B channel with noise that does not compress
            g = np.rint(g)
            Image.fromarray(terrarium(g)).save(OUT / f"{name}.webp", "WEBP", lossless=True, quality=100, method=6)
            meta["poles"][name] = {"min_m": round(float(g[disc].min()), 1), "max_m": round(float(g[disc].max()), 1),
                                   "mean_m": round(float(g[disc].mean()), 1), "empty_pixels_filled": empty,
                                   "bytes": (OUT / f"{name}.webp").stat().st_size}
            print(name, meta["poles"][name], flush=True)
    (OUT / "polar.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--size", type=int, default=2048)
    build(ap.parse_args().size)
