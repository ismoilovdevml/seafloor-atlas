"""Check the Source Cooperative COG mirrors against the official GEBCO_2026 files on BODC/CEDA THREDDS.

For a few 16 x 16 windows at full 15" resolution:
  * elevation: mirror COG (level 0, remote) == official netCDF (OPeNDAP ASCII)
  * TID:       local mirror copy == official netCDF
  * 1' overview pixel vs the official 4 x 4 block: reports whether it equals the block mean,
    or one of the 16 source cells (nearest-type decimation).
Writes data/derived/verify_mirror.json and prints a summary. Network: small ASCII requests only.

  python pipeline/verify_mirror.py                       the GEBCO_2026 check above
  python pipeline/verify_mirror.py releases 2024 2025    elevation of older releases (used by pipeline/blindtest.py):
        the mirror COG GEBCO_<year>.tif against BOTH official netCDF variants (ice-surface elevation and sub-ice
        topography) at 10 windows incl. two trenches, the Arctic and an Antarctic ice shelf, so the check also says
        which variant the mirror holds. With 2026 the local GEBCO_2026_15s.tif is checked as well.
        -> data/derived/verify_mirror_releases.json
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/gebco_2026"
DODS = "https://dap.ceda.ac.uk/thredds/dodsC/bodc/gebco/global/gebco_2026"
OFFICIAL = {
    "elevation": f"{DODS}/ice_surface_elevation/netcdf/GEBCO_2026.nc.ascii?elevation",
    "tid": f"{DODS}/type_identifier_grid/netcdf/gebco_2026_tid.nc.ascii?tid",
}
MIRROR_ELEV = ("/vsicurl/https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/"
               "ausantarctic/gebco/GEBCO_2026.tif")
N_ROWS, N_COLS = 43200, 86400
# (name, lat, lon) — window corners snapped to multiples of 4 so 1' blocks align
SITES = [("Challenger Deep", 11.37, 142.59), ("Mid-Atlantic Ridge", 35.0, -34.0),
         ("Hawaii slope", 19.0, -156.5), ("SE Indian Ocean", -35.0, 93.0),
         ("North Sea shelf", 55.0, 3.0), ("Himalaya (land)", 28.0, 87.0)]
W = 16


def official_window(var: str, lat_i0: int, col0: int, base: str | None = None) -> np.ndarray:
    url = f"{base or OFFICIAL[var]}[{lat_i0}:1:{lat_i0 + W - 1}][{col0}:1:{col0 + W - 1}]"
    for attempt in range(5):  # the THREDDS server is slow and sometimes stalls
        try:
            txt = urllib.request.urlopen(url, timeout=300).read().decode()
            break
        except OSError as e:
            print(f"  retry {attempt + 1} ({e})", flush=True)
            time.sleep(10)
    else:
        raise RuntimeError(f"official server did not answer: {url}")
    rows = re.findall(r"^\[(\d+)\]\[(\d+)\],\s*(.+)$", txt, flags=re.M)
    if not rows:
        rows = [(m[0], 0, m[1]) for m in re.findall(r"^\[(\d+)\],\s*(.+)$", txt, flags=re.M)]
    a = np.array([[int(v) for v in r[2].split(",")] for r in rows[:W]])
    assert a.shape == (W, W), (var, a.shape, txt[:300])
    return a  # official order: south -> north


def main() -> None:
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    report = []
    with rasterio.open(MIRROR_ELEV) as me, rasterio.open(RAW / "gebco_2026_tid.tif") as mt, \
            rasterio.open(RAW / "gebco_2026_elev_1arcmin.tif") as m1:
        for name, lat, lon in SITES:
            row0 = int((90 - lat) * 240) // 4 * 4          # mirror row (north-first)
            col0 = int((lon + 180) * 240) // 4 * 4
            lat_i0 = N_ROWS - (row0 + W)                     # official index of the southern row
            mir_e = me.read(1, window=Window(col0, row0, W, W))[::-1]  # -> south-first
            mir_t = mt.read(1, window=Window(col0, row0, W, W))[::-1]
            off_e = official_window("elevation", lat_i0, col0)
            off_t = official_window("tid", lat_i0, col0)
            # 1' overview: 4 x 4 pixels covering the same window
            ov = m1.read(1, window=Window(col0 // 4, row0 // 4, W // 4, W // 4))[::-1]
            blocks = off_e.reshape(W // 4, 4, W // 4, 4)
            mean = blocks.mean(axis=(1, 3))
            in_block = np.array([[ov[i, j] in blocks[i, :, j, :] for j in range(W // 4)] for i in range(W // 4)])
            rec = {
                "site": name, "lat": lat, "lon": lon, "row0": row0, "col0": col0,
                "elev_equal": bool(np.array_equal(mir_e, off_e)),
                "tid_equal": bool(np.array_equal(mir_t.astype(int), off_t)),
                "elev_min_official": int(off_e.min()), "elev_max_official": int(off_e.max()),
                "tid_codes": sorted({int(v) for v in np.unique(off_t)}),
                "ovr_max_abs_diff_vs_block_mean": float(np.abs(ov - mean).max()),
                "ovr_value_is_a_source_cell_fraction": float(in_block.mean()),
            }
            report.append(rec)
            print(rec, flush=True)
    out = ROOT / "data/derived/verify_mirror.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1))
    ok = all(r["elev_equal"] and r["tid_equal"] for r in report)
    print("ALL WINDOWS IDENTICAL" if ok else "MISMATCH FOUND")


# ---------------------------------------------------------------- older releases (elevation only)
CEDA_BASE = "https://dap.ceda.ac.uk/thredds/dodsC/bodc/gebco/global/gebco_{y}"
# file names differ between releases (read from the CEDA directory listings on 2026-11-17)
RELEASE_NC = {
    2024: {"ice_surface": "ice_surface_elevation/netcdf/GEBCO_2024_CF.nc",
           "sub_ice": "sub_ice_topography_bathymetry/netcdf/GEBCO_2024_sub_ice_topo.nc"},
    2025: {"ice_surface": "ice_surface_elevation/netcdf/GEBCO_2025.nc",
           "sub_ice": "sub_ice_topography_bathymetry/netcdf/gebco_2025_sub_ice.nc"},
    2026: {"ice_surface": "ice_surface_elevation/netcdf/GEBCO_2026.nc"},
}
MIRROR_TPL = ("/vsicurl/https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/"
              "ausantarctic/gebco/GEBCO_{y}.tif")
RELEASE_SITES = [("Challenger Deep (Mariana Trench)", 11.37, 142.59), ("Horizon Deep (Tonga Trench)", -23.27, -174.73),
                 ("Mid-Atlantic Ridge", 35.0, -34.0), ("North Sea shelf", 55.0, 3.0),
                 ("Fram Strait", 79.0, 2.0), ("Arctic Ocean, Nansen Basin", 85.0, 60.0),
                 ("Ross Ice Shelf", -80.0, -175.0), ("Weddell Sea shelf", -75.5, -45.0),
                 ("SE Indian Ocean (far from soundings)", -26.29, 81.94), ("Himalaya (land)", 28.0, 87.0)]


def official_coords(base: str, lat_i0: int, col0: int) -> tuple[np.ndarray, np.ndarray]:
    """centre coordinates of the requested official window (guards against an index or orientation slip)"""
    url = f"{base}.ascii?lat[{lat_i0}:1:{lat_i0 + W - 1}],lon[{col0}:1:{col0 + W - 1}]"
    txt = urllib.request.urlopen(url, timeout=300).read().decode()
    lat = np.array([float(v) for v in re.search(r"^lat\[\d+\]\n(.+)$", txt, re.M).group(1).split(",")])
    lon = np.array([float(v) for v in re.search(r"^lon\[\d+\]\n(.+)$", txt, re.M).group(1).split(",")])
    return lat, lon


def verify_releases(years: list[int]) -> bool:
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    out = ROOT / "data/derived/verify_mirror_releases.json"
    report = json.loads(out.read_text()) if out.exists() else {}
    ok = True
    for y in years:
        bases = {k: f"{CEDA_BASE.format(y=y)}/{v}" for k, v in RELEASE_NC[y].items()}
        srcs = {"mirror": MIRROR_TPL.format(y=y)}
        if y == 2026:
            srcs["local_15s"] = str(RAW / "GEBCO_2026_15s.tif")
        recs = []
        for name, lat, lon in RELEASE_SITES:
            row0 = int((90 - lat) * 240) // 4 * 4
            col0 = int((lon + 180) * 240) // 4 * 4
            lat_i0 = N_ROWS - (row0 + W)
            clat, clon = official_coords(bases["ice_surface"], lat_i0, col0)
            exp_lat = 90 - (row0 + np.arange(W)[::-1] + 0.5) / 240      # south-first
            exp_lon = -180 + (col0 + np.arange(W) + 0.5) / 240
            coords_ok = bool(np.allclose(clat, exp_lat, atol=1e-6) and np.allclose(clon, exp_lon, atol=1e-6))
            off = {k: official_window("elevation", lat_i0, col0, base=f"{b}.ascii?elevation") for k, b in bases.items()}
            rec = {"site": name, "lat": lat, "lon": lon, "row0": row0, "col0": col0, "official_coords_ok": coords_ok,
                   "elev_min_official": int(off["ice_surface"].min()), "elev_max_official": int(off["ice_surface"].max())}
            if "sub_ice" in off:
                rec["ice_surface_differs_from_sub_ice_cells"] = int((off["ice_surface"] != off["sub_ice"]).sum())
            for sk, path in srcs.items():
                with rasterio.open(path) as m:
                    a = m.read(1, window=Window(col0, row0, W, W))[::-1].astype(int)
                for k, o in off.items():
                    rec[f"{sk}_equals_{k}"] = bool(np.array_equal(a, o))
                    rec[f"{sk}_max_abs_diff_{k}_m"] = int(np.abs(a - o).max())
            print(y, rec, flush=True)
            recs.append(rec)
        # the mirror must equal the ice-surface grid everywhere (the variant GEBCO calls "the GEBCO_<year> Grid")
        good = all(r["official_coords_ok"] and all(r[f"{sk}_equals_ice_surface"] for sk in srcs) for r in recs)
        ok &= good
        report[str(y)] = {"checked": time.strftime("%Y-%m-%d"), "window_cells": W * W, "official": bases,
                          "sources": srcs, "all_equal_ice_surface": good, "sites": recs}
        out.write_text(json.dumps(report, indent=1))
        print(y, "ALL WINDOWS IDENTICAL (ice-surface elevation)" if good else "MISMATCH FOUND", flush=True)
    return ok


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "releases":
        sys.exit(0 if verify_releases([int(a) for a in sys.argv[2:]] or [2024, 2025]) else 1)
    main()
