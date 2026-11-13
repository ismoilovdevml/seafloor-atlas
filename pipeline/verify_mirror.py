"""Check the Source Cooperative COG mirrors against the official GEBCO_2026 files on BODC/CEDA THREDDS.

For a few 16 x 16 windows at full 15" resolution:
  * elevation: mirror COG (level 0, remote) == official netCDF (OPeNDAP ASCII)
  * TID:       local mirror copy == official netCDF
  * 1' overview pixel vs the official 4 x 4 block: reports whether it equals the block mean,
    or one of the 16 source cells (nearest-type decimation).
Writes data/derived/verify_mirror.json and prints a summary. Network: small ASCII requests only.
"""
from __future__ import annotations

import json
import os
import re
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


def official_window(var: str, lat_i0: int, col0: int) -> np.ndarray:
    url = f"{OFFICIAL[var]}[{lat_i0}:1:{lat_i0 + W - 1}][{col0}:1:{col0 + W - 1}]"
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


if __name__ == "__main__":
    main()
