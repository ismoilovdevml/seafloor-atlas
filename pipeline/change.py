"""What was newly measured between GEBCO_2025 and GEBCO_2026 (TID grids, 15").

Same ocean mask for both years, so the difference comes only from the TID codes. The mask is the one of
the dataset tables (pipeline/build_dataset.py, pipeline/history.py, pipeline/coverage.py): a 15" cell is
ocean if its GEBCO_2026 TID != 0 and the 2026 1' elevation of the 1' cell containing it is < 0. Until
2026-11-20 this script used the union TID != 0 in 2025 OR 2026, which added ~64,000 km2 of cells that are
TID 0 (land) in 2026 and gave a 2026 share of 0.30805 (vs 0.30810) and 7,016 km2 more "no longer
measured" (2,512,741 vs 2,505,725 km2) than global_by_release.csv. Areas use the spherical cell area on
the authalic sphere (R = 6371.0072 km).

Output: data/derived/change_2025_2026.json, new_measured_4arcmin.npz (figure), new2026_1arcmin.tif (web tiles).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import rasterio

ROOT = Path(__file__).resolve().parents[1]
T25 = ROOT / "data/raw/gebco_2025/gebco_2025_tid.tif"
T26 = ROOT / "data/raw/gebco_2026/gebco_2026_tid.tif"
ELEV = ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif"
OUT = ROOT / "data/derived"
R_KM = 6371.0072
BOX = 10  # degrees, for the "where" table
AGG = 16  # 15" -> 4' for the figure grid


def direct(t: np.ndarray) -> np.ndarray:
    return (t >= 10) & (t <= 17)


def strip_masks(t25: np.ndarray, t26: np.ndarray, sea: np.ndarray) -> dict[str, np.ndarray]:
    """Masks of one strip of 15" cells. sea = 2026 1' elevation < 0, repeated to 15"."""
    ocean = sea & (t26 != 0)
    m25 = ocean & direct(t25)
    m26 = ocean & direct(t26)
    return {"ocean": ocean, "m25": m25, "m26": m26, "new": m26 & ~m25, "lost": m25 & ~m26}


def main() -> None:
    with rasterio.open(T25) as a, rasterio.open(T26) as b, rasterio.open(ELEV) as e:
        assert a.shape == b.shape == (43200, 86400)
        assert a.transform == b.transform
        H, W = a.shape
        d = np.radians(1 / 240)
        rows_per = 960  # multiple of AGG (16) and 4; divides 43200
        tot = {"ocean": 0.0, "m25": 0.0, "m26": 0.0, "new": 0.0, "lost": 0.0}
        nb = (180 // BOX, 360 // BOX)
        box_new = np.zeros(nb)
        box_lost = np.zeros(nb)
        fig_new = np.zeros((H // AGG, W // AGG), dtype=np.float32)
        fig_lost = np.zeros_like(fig_new)
        fig_m25 = np.zeros_like(fig_new)
        prof = e.profile.copy()
        prof.update(dtype="uint8", nodata=None, compress="deflate", predictor=2, tiled=True, blockxsize=512, blockysize=512)
        g1 = rasterio.open(OUT / "new2026_1arcmin.tif", "w", **prof)  # 0..255 = share of 15" cells newly measured
        for r0 in range(0, H, rows_per):
            n = min(rows_per, H - r0)
            win = rasterio.windows.Window(0, r0, W, n)
            t25 = a.read(1, window=win).astype(np.int16)
            t26 = b.read(1, window=win).astype(np.int16)
            h = e.read(1, window=rasterio.windows.Window(0, r0 // 4, W // 4, n // 4))
            sea = np.repeat(np.repeat(h < 0, 4, axis=0), 4, axis=1)
            mk = strip_masks(t25, t26, sea)
            ocean, m25, m26, new, lost = mk["ocean"], mk["m25"], mk["m26"], mk["new"], mk["lost"]
            lat_top = 90 - r0 / 240
            phi1 = np.radians(lat_top - np.arange(n) / 240)
            area = (R_KM ** 2) * d * (np.sin(phi1) - np.sin(phi1 - d))  # km2 per cell, per row
            A = np.broadcast_to(area[:, None], t25.shape)
            tot["ocean"] += A[ocean].sum()
            tot["m25"] += A[m25].sum()
            tot["m26"] += A[m26].sum()
            tot["new"] += A[new].sum()
            tot["lost"] += A[lost].sum()
            lat_c = lat_top - (np.arange(n) + 0.5) / 240
            bi = np.clip(((90 - lat_c) // BOX).astype(int), 0, nb[0] - 1)
            for mask, acc in ((new, box_new), (lost, box_lost)):
                per_row_box = (mask * area[:, None]).reshape(n, nb[1], 240 * BOX).sum(axis=2)
                np.add.at(acc, bi, per_row_box)
            fr = slice(r0 // AGG, (r0 + n) // AGG)
            fig_new[fr] = new.reshape(n // AGG, AGG, W // AGG, AGG).mean(axis=(1, 3))
            fig_lost[fr] = lost.reshape(n // AGG, AGG, W // AGG, AGG).mean(axis=(1, 3))
            fig_m25[fr] = m25.reshape(n // AGG, AGG, W // AGG, AGG).mean(axis=(1, 3))
            g1.write(np.rint(255 * new.reshape(n // 4, 4, W // 4, 4).mean(axis=(1, 3))).astype(np.uint8), 1,
                     window=rasterio.windows.Window(0, r0 // 4, W // 4, n // 4))
            print(f"\rrows {r0 + n}/{H}", end="", file=sys.stderr)
        print(file=sys.stderr)
        g1.close()

    top = []
    for i, j in zip(*np.unravel_index(np.argsort(box_new, axis=None)[::-1][:12], nb)):
        i, j = int(i), int(j)
        top.append({"lat": [90 - (i + 1) * BOX, 90 - i * BOX], "lon": [-180 + j * BOX, -180 + (j + 1) * BOX],
                    "new_km2": round(float(box_new[i, j])), "lost_km2": round(float(box_lost[i, j]))})
    res = {
        "ocean_km2": tot["ocean"],
        "measured_2025_km2": tot["m25"], "measured_2026_km2": tot["m26"],
        "measured_2025_frac": tot["m25"] / tot["ocean"], "measured_2026_frac": tot["m26"] / tot["ocean"],
        "newly_measured_km2": tot["new"], "no_longer_measured_km2": tot["lost"],
        "net_km2": tot["m26"] - tot["m25"],
        "top_boxes_new": top,
        "note": "same ocean mask both years (GEBCO_2026 TID != 0 and 2026 1' elevation < 0, as in the dataset "
                "tables); TID 10-17 = measured",
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "change_2025_2026.json").write_text(json.dumps(res, indent=1))
    np.savez_compressed(OUT / "new_measured_4arcmin.npz", new=fig_new, lost=fig_lost, m25=fig_m25)
    print(json.dumps({k: v for k, v in res.items() if k != "top_boxes_new"}, indent=1))
    for t in top:
        print(t)


if __name__ == "__main__":
    main()
