"""Hypsometric curve for the viewer's sea-level control: area of Earth's surface at or above a level L.

Input : data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif (Int16 m, 21600 x 10800, EPSG:4326, nodata -32767)
Output: web/public/data/hypsometry.json

Every 1' cell is weighted by its true area on a sphere of radius R = 6371.0072 km (authalic radius of WGS84),
A = R^2 * dlon * (sin(lat_top) - sin(lat_bottom)), so the sum over the grid is 4 pi R^2 exactly.

Caveats (also shown in the viewer): elevations are 1' cell means of the ice surface, so the Antarctic and
Greenland ice sheets count as land, and a changed sea level is applied to today's topography without
isostatic adjustment, ice loading or sediment changes.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio

ROOT = Path(__file__).resolve().parents[1]
ELEV = ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif"
OUT = ROOT / "web/public/data/hypsometry.json"

R_KM = 6371.0072
H_MIN, H_MAX = -11000, 9000  # m; GEBCO 1' range is -10900 .. 8200


def row_areas_km2(top_lat: float, dlat: float, dlon: float, height: int, r_km: float = R_KM) -> np.ndarray:
    """True spherical area (km^2) of one cell in each row of a regular lat/lon grid, top row first."""
    edges = np.radians(top_lat - dlat * np.arange(height + 1))
    edges = np.clip(edges, -np.pi / 2, np.pi / 2)
    return r_km**2 * np.radians(dlon) * (np.sin(edges[:-1]) - np.sin(edges[1:]))


def levels() -> np.ndarray:
    """Dense where the viewer needs fine control (1 m from -500 to +200 m), 10 m elsewhere."""
    return np.unique(np.concatenate([
        np.arange(H_MIN, -500, 10), np.arange(-500, 201, 1), np.arange(210, H_MAX + 1, 10),
    ]))


def histogram(path: Path, band_rows: int = 540) -> tuple[np.ndarray, dict]:
    """Area (km^2) per 1 m elevation bin; bin i holds elevation H_MIN + i. Values outside are clipped."""
    with rasterio.open(path) as src:
        t = src.transform
        assert abs(t.b) < 1e-12 and abs(t.d) < 1e-12, "expects a north-up lat/lon grid"
        dlon, dlat = t.a, -t.e
        areas = row_areas_km2(t.f, dlat, dlon, src.height)
        nodata = src.nodata
        hist = np.zeros(H_MAX - H_MIN + 1, dtype=np.float64)
        n_nodata = 0
        clipped = 0
        for r0 in range(0, src.height, band_rows):
            h = min(band_rows, src.height - r0)
            a = src.read(1, window=((r0, r0 + h), (0, src.width)))
            w = np.broadcast_to(areas[r0:r0 + h, None], a.shape)
            valid = a != nodata if nodata is not None else np.ones(a.shape, bool)
            n_nodata += int((~valid).sum())
            v = a[valid].astype(np.int32)
            clipped += int(((v < H_MIN) | (v > H_MAX)).sum())
            idx = np.clip(v, H_MIN, H_MAX) - H_MIN
            hist += np.bincount(idx, weights=w[valid], minlength=hist.size)
        info = {"width": src.width, "height": src.height, "nodata_cells": n_nodata, "clipped_cells": clipped,
                "grid_area_km2": float(areas.sum() * src.width)}
    return hist, info


def land_at_or_above(hist: np.ndarray, lv: np.ndarray) -> np.ndarray:
    """Area of cells with elevation >= L for each L (integer metres)."""
    ge = np.cumsum(hist[::-1])[::-1]  # ge[i] = area with elevation >= H_MIN + i
    return ge[np.asarray(lv) - H_MIN]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--elev", type=Path, default=ELEV)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    hist, info = histogram(args.elev)
    earth = 4 * np.pi * R_KM**2
    lv = levels()
    land = land_at_or_above(hist, lv)
    today = float(land_at_or_above(hist, [0])[0])
    out = {
        "source": "GEBCO_2026 1 arc-minute grid (cell means, ice-surface elevation)",
        "method": "area of cells with elevation >= L, true spherical cell area",
        "radius_km": R_KM,
        "earth_km2": round(earth),
        "today_km2": round(today),
        "levels_m": [int(x) for x in lv],
        "land_km2": [int(round(x)) for x in land],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, separators=(",", ":")) + "\n")

    print(f"grid {info['width']}x{info['height']}, nodata cells {info['nodata_cells']}, clipped {info['clipped_cells']}")
    print(f"grid area {info['grid_area_km2'] / 1e6:.4f} M km2 vs 4 pi R^2 {earth / 1e6:.4f} M km2; histogram sum {hist.sum() / 1e6:.4f}")
    for L in (-6000, -2500, -200, -120, -50, 0, 1, 10, 70, 100):
        a = float(land_at_or_above(hist, [L])[0])
        print(f"L={L:>6} m  land {a / 1e6:7.2f} M km2  {100 * a / earth:5.1f} %  change {(a - today) / 1e6:+7.2f} M km2")
    print("wrote", args.out, f"({len(lv)} levels)")


if __name__ == "__main__":
    main()
