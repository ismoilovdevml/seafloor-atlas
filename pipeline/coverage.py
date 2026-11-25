"""Measured-coverage grid and global statistics from the GEBCO_2026 TID grid.

Input : data/raw/gebco_2026/gebco_2026_tid.tif   (Int8, 86400 x 43200, 15")
        data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif (Int16, 21600 x 10800, 1')
Output: data/derived/coverage_1arcmin.tif  (UInt8: 0 = no ocean sub-cell, 1..255 = 1 + round(254 * direct/ocean))
        data/derived/stats.json            (area-weighted numbers, see docs/data-contract.md)

`python coverage.py viewer` writes data/derived/coverage_viewer_1arcmin.tif for the viewer tiles: the same grid
with the 15" cells of data/derived/viewer_land_15s.tif (pipeline/viewer_land.py) counted as land, and
data/derived/viewer_lowland_1arcmin.tif (UInt8 0..16: how many of the 16 sub-cells are that viewer land and dry) and
data/derived/viewer_lakes_1arcmin.tif (the same count for inland water, viewer_lake_15s.tif), which the tiles draw
with the two reserved alphas. stats.json and the paper's numbers always use the
unmodified mask.

"Direct" = TID 10..17, "ocean" = TID != 0 and the 1' elevation < 0 (excludes ice sheet / ice shelves). Areas weight every 15" cell by cos(latitude),
so the result is a true area fraction on the sphere, not a cell count.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import rasterio

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/gebco_2026"
OUT = ROOT / "data/derived"

TID_GROUPS = {
    "direct": range(10, 18),
    "indirect": range(40, 49),
    "unknown": range(70, 73),
}
DEPTH_EDGES = np.arange(-11000, 1, 250)  # m, bins for the hypsometric / coverage-by-depth curve
LAT_EDGES = np.arange(-90, 91, 5)


def group_of(code: int) -> str:
    for name, r in TID_GROUPS.items():
        if code in r:
            return name
    return "land" if code == 0 else "other"


def run(tid_path: Path, elev_path: Path, out_dir: Path, band_rows_1m: int = 270,
        exclude_path: Path | None = None, cov_name: str = "coverage_1arcmin.tif") -> dict:
    """Writes the 1' coverage grid; with exclude_path (15" UInt8, 1 = land for the viewer) those cells leave the
    ocean mask and only the grid is written (no stats.json)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    exclude = rasterio.open(exclude_path) if exclude_path else None
    with rasterio.open(tid_path) as tid, rasterio.open(elev_path) as elev:
        assert tid.width == 4 * elev.width and tid.height == 4 * elev.height, (tid.shape, elev.shape)
        assert abs(tid.transform.a * 4 - elev.transform.a) < 1e-9
        H1, W1 = elev.height, elev.width
        prof = elev.profile.copy()
        prof.update(dtype="uint8", nodata=None, compress="deflate", predictor=2, tiled=True,
                    blockxsize=512, blockysize=512)
        cov_path = out_dir / cov_name
        low_dst = lake_dst = lake_src = None
        if exclude is not None:
            low_dst = rasterio.open(out_dir / "viewer_lowland_1arcmin.tif", "w", **prof)
            lake_dst = rasterio.open(out_dir / "viewer_lakes_1arcmin.tif", "w", **prof)
            lake_src = rasterio.open(Path(exclude_path).with_name("viewer_lake_15s.tif"))

        code_area = np.zeros(128, dtype=np.float64)      # area per TID code (all cells)
        nbins = len(DEPTH_EDGES) - 1
        depth_ocean = np.zeros(nbins)                    # ocean area per depth bin (1' cell depth)
        depth_direct = np.zeros(nbins)
        lat_ocean = np.zeros(len(LAT_EDGES) - 1)
        lat_direct = np.zeros(len(LAT_EDGES) - 1)
        cells_ocean = 0
        cells_direct = 0

        with rasterio.open(cov_path, "w", **prof) as dst:
            for r0 in range(0, H1, band_rows_1m):
                r1 = min(H1, r0 + band_rows_1m)
                n1 = r1 - r0
                win15 = rasterio.windows.Window(0, 4 * r0, tid.width, 4 * n1)
                t = tid.read(1, window=win15).astype(np.int16)
                h = elev.read(1, window=rasterio.windows.Window(0, r0, W1, n1)).astype(np.float64)
                # Ocean = TID != 0 AND the 1' cell is below sea level. The TID grid is non-zero over
                # the Antarctic ice sheet and ice shelves (2.7 % of Earth), which are not open seafloor.
                sea15 = np.repeat(np.repeat(h < 0, 4, axis=0), 4, axis=1)
                t = np.where(sea15, t, 0)
                if exclude is not None:
                    x = exclude.read(1, window=win15) == 1
                    lk = lake_src.read(1, window=win15) == 1
                    w1 = rasterio.windows.Window(0, r0, W1, n1)
                    low_dst.write((x & ~lk).reshape(n1, 4, W1, 4).sum(axis=(1, 3)).astype(np.uint8), 1, window=w1)
                    lake_dst.write(lk.reshape(n1, 4, W1, 4).sum(axis=(1, 3)).astype(np.uint8), 1, window=w1)
                    t = np.where(x, 0, t)
                # latitude of each 15" row centre (row 0 = north edge)
                rows15 = np.arange(4 * r0, 4 * r1)
                lat15 = tid.transform.f + (rows15 + 0.5) * tid.transform.e
                w15 = np.cos(np.radians(lat15))[:, None]  # area weight per row

                code_area += np.bincount(t.ravel(), weights=np.broadcast_to(w15, t.shape).ravel(),
                                         minlength=128)[:128]
                ocean = t != 0
                direct = (t >= 10) & (t <= 17)
                cells_ocean += int(ocean.sum())
                cells_direct += int(direct.sum())

                # 4x4 block aggregation -> 1' cells
                ob = ocean.reshape(n1, 4, W1, 4).sum(axis=(1, 3))
                db = direct.reshape(n1, 4, W1, 4).sum(axis=(1, 3))
                wo = (ocean * w15).reshape(n1, 4, W1, 4).sum(axis=(1, 3))
                wd = (direct * w15).reshape(n1, 4, W1, 4).sum(axis=(1, 3))
                cov = np.zeros((n1, W1), dtype=np.uint8)
                m = ob > 0
                cov[m] = (1 + np.rint(254.0 * db[m] / ob[m])).astype(np.uint8)
                dst.write(cov, 1, window=rasterio.windows.Window(0, r0, W1, n1))

                b = np.digitize(h, DEPTH_EDGES) - 1
                ok = (b >= 0) & (b < nbins) & m
                depth_ocean += np.bincount(b[ok], weights=wo[ok], minlength=nbins)
                depth_direct += np.bincount(b[ok], weights=wd[ok], minlength=nbins)

                lat1 = elev.transform.f + (np.arange(r0, r1) + 0.5) * elev.transform.e
                lb = np.clip(np.digitize(lat1, LAT_EDGES) - 1, 0, len(LAT_EDGES) - 2)
                np.add.at(lat_ocean, lb, wo.sum(axis=1))
                np.add.at(lat_direct, lb, wd.sum(axis=1))
                print(f"\rrows {r1}/{H1}", end="", file=sys.stderr)
        print(file=sys.stderr)
    if exclude is not None:
        exclude.close()
        for f in (low_dst, lake_dst, lake_src):
            f.close()
        return {"coverage": str(cov_path)}

    ocean_area = code_area[1:].sum()
    groups: dict[str, float] = {}
    codes = {}
    for c in np.nonzero(code_area)[0]:
        c = int(c)
        codes[str(c)] = {"group": group_of(c), "ocean_fraction": None if c == 0 else code_area[c] / ocean_area}
        if c:
            groups[group_of(c)] = groups.get(group_of(c), 0.0) + code_area[c] / ocean_area
    stats = {
        "source": "GEBCO_2026 TID grid (15 arc-sec), area-weighted by cos(lat)",
        "measured_definition": "TID 10-17 (direct measurement) / ocean = TID != 0 and 1-arcmin elevation < 0",
        "measured_fraction_area": groups.get("direct", 0.0),
        "measured_fraction_cells": cells_direct / cells_ocean,
        "ocean_fraction_of_earth": ocean_area / code_area.sum(),
        "group_fraction": groups,
        "codes": codes,
        "depth_bins_m": DEPTH_EDGES.tolist(),
        "depth_ocean_area_rel": (depth_ocean / ocean_area).tolist(),
        "depth_measured_fraction": np.where(depth_ocean > 0, depth_direct / np.maximum(depth_ocean, 1e-300), np.nan).tolist(),
        "lat_edges": LAT_EDGES.tolist(),
        "lat_ocean_area_rel": (lat_ocean / ocean_area).tolist(),
        "lat_measured_fraction": np.where(lat_ocean > 0, lat_direct / np.maximum(lat_ocean, 1e-300), np.nan).tolist(),
    }
    (out_dir / "stats.json").write_text(json.dumps(stats, indent=1, allow_nan=True))
    return stats


if __name__ == "__main__":
    if sys.argv[1:] == ["viewer"]:
        print(run(RAW / "gebco_2026_tid.tif", RAW / "gebco_2026_elev_1arcmin.tif", OUT,
                  exclude_path=OUT / "viewer_land_15s.tif", cov_name="coverage_viewer_1arcmin.tif"))
        sys.exit(0)
    s = run(RAW / "gebco_2026_tid.tif", RAW / "gebco_2026_elev_1arcmin.tif", OUT)
    print(json.dumps({k: s[k] for k in ("measured_fraction_area", "measured_fraction_cells",
                                         "ocean_fraction_of_earth", "group_fraction")}, indent=1))
