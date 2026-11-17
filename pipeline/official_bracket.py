"""Bracket the official Seabed 2030 "mapped" share with the public TID grids and the depth-dependent target cells.

Seabed 2030 counts the seafloor as mapped "if at least one sounding falls in a grid cell" of the depth-dependent
size in Mayer et al. (2018, Geosciences 8, 63, doi:10.3390/geosciences8020063), Table 2:

    0-1,500 m      100 x 100 m
    1,500-3,000 m  200 x 200 m
    3,000-5,750 m  400 x 400 m
    5,750-11,000 m 800 x 800 m

How the official percentage is computed from the source data is not published. The public TID grid only says
whether a 15" cell (about 463 m x 463 cos(lat) m) holds direct measurements (TID 10-17), not how many target cells
inside it hold a sounding. That leaves a range for each measured 15" cell:

  upper   every target cell inside the 15" cell holds a sounding    -> credit 1 (the whole cell)
  lower   exactly one target cell inside it holds a sounding         -> credit min(1, s^2 / A15)
  mixed   TID 11 (multibeam) and 17 (combination) in full, every other direct code (10, 12-16: single beam,
          seismic, isolated sounding, ENC, lidar, optical) one target cell

s = target cell size of the depth class, A15 = exact spherical area of the 15" cell. Where s^2 >= A15 (800 m class
everywhere; 400 m class poleward of about 41.7 deg) one sounding covers more than its own 15" cell; that spill-over
into unmeasured neighbours is not modelled (all three variants give credit 1), so there the numbers are low.
pipeline/sensitivity_cellsize.py measures the size of that effect.

Depth is the GEBCO_2026 15" elevation for every release (the grid of the release itself is not on disk); the ocean
mask is the one of pipeline/history.py (GEBCO_2026 TID != 0 and GEBCO_2026 1' elevation < 0), so "upper" equals the
history_stats.json measured share (self-check: 2026 upper = 30.81 %).

Implementation: one pass over 512-row strips (the TIFF block height). Each strip reads the 15" elevation, the 1'
elevation and each of the 8 TID grids once, and reduces them with np.bincount to per-row counts of measured cells by
(depth class, multibeam-or-combination flag). The bracket arithmetic is then done on those small count arrays
(bracket(), unit-tested in tests/test_official_bracket.py).

  python pipeline/official_bracket.py run [--workers N]  -> data/derived/official_bracket.json (+ counts .npz)
  python pipeline/official_bracket.py figure             -> figures/fig_official_bracket.png
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history  # noqa: E402

ROOT = history.ROOT
OUT_JSON = history.DERIVED / "official_bracket.json"
OUT_COUNTS = history.DERIVED / "official_bracket_counts.npz"
OUT_FIG = ROOT / "figures/fig_official_bracket.png"
ELEV15 = history.RAW / "gebco_2026/GEBCO_2026_15s.tif"
H15, W15 = history.H15, history.W15
STRIP = 512                                              # = TIFF block height of every input
DEPTH_EDGES_M = (1500.0, 3000.0, 5750.0)                 # class k = number of edges <= depth
TARGET_M = np.array([100.0, 200.0, 400.0, 800.0])        # Mayer et al. 2018, Table 2
TABLE2_OCEAN_SHARE = (0.137, 0.11, 0.726, 0.027)         # Mayer et al. 2018, Table 2, "% of World Ocean"
FULL_CODES = (11, 17)                                    # full credit in the "mixed" variant
VARIANTS = ("upper", "mixed", "lower")
NCLS = len(TARGET_M)


def depth_class(depth_m: np.ndarray) -> np.ndarray:
    """0..3 for 0-1500 / 1500-3000 / 3000-5750 / >= 5750 m (depth positive down; land and 0 m go to class 0)"""
    k = np.zeros(depth_m.shape, dtype=np.uint8)
    for e in DEPTH_EDGES_M:
        k += depth_m >= e
    return k


def lower_credit(cell_km2: np.ndarray) -> np.ndarray:
    """(n_rows, 4): share of a 15" cell of the given area that ONE target cell of each class covers, capped at 1"""
    return np.minimum(1.0, (TARGET_M[None, :] ** 2) / (np.asarray(cell_km2, dtype=np.float64)[:, None] * 1e6))


def bracket(ocean_cnt: np.ndarray, meas_cnt: np.ndarray, cell_km2: np.ndarray) -> dict:
    """Bracket arithmetic on per-row counts.

    ocean_cnt (n, 4): ocean 15" cells per row and depth class
    meas_cnt  (n, 4, 2): measured (TID 10-17) ocean cells per row and depth class; [..., 1] = TID 11 or 17
    cell_km2  (n,): area of one 15" cell in each row
    Returns areas (km2) per variant and per depth class, and the shares of the ocean.
    """
    a = np.asarray(cell_km2, dtype=np.float64)[:, None]
    low = lower_credit(cell_km2)
    oc = ocean_cnt * a                                   # (n, 4) km2
    m_all = meas_cnt.sum(axis=2) * a                     # (n, 4) km2, every measured cell in full
    m_full = meas_cnt[..., 1] * a
    m_part = meas_cnt[..., 0] * a
    by = {"upper": m_all.sum(axis=0), "lower": (m_all * low).sum(axis=0),
          "mixed": (m_full + m_part * low).sum(axis=0)}
    ocean_km2 = float(oc.sum())
    out = {"ocean_km2": ocean_km2, "ocean_km2_by_class": oc.sum(axis=0).tolist()}
    for v in VARIANTS:
        out[v + "_km2"] = float(by[v].sum())
        out[v] = float(by[v].sum() / ocean_km2)
        out[v + "_km2_by_class"] = by[v].tolist()
    out["full_code_km2"] = float(m_full.sum())
    return out


def strip_counts(r0: int) -> tuple[int, np.ndarray, np.ndarray]:
    """ocean counts (n, 4) and measured counts (n_years, n, 4, 2) for rows r0 .. r0+n-1"""
    import rasterio
    from rasterio.windows import Window

    n = min(STRIP, H15 - r0)
    win = Window(0, r0, W15, n)
    with rasterio.open(history.ELEV) as s:            # 1' elevation: ocean = < 0 (as history.py)
        h = s.read(1, window=Window(0, r0 // 4, W15 // 4, n // 4))
    with rasterio.open(history.tid_path(history.LATEST)) as s:
        t26 = s.read(1, window=win)
    ocean = np.repeat(np.repeat(h < 0, 4, axis=0), 4, axis=1)
    ocean &= t26 != 0
    with rasterio.open(ELEV15) as s:
        z = s.read(1, window=win)
    k = depth_class(-z.astype(np.float32))
    del z
    # bin = (row * 4 + class) for ocean cells; one extra bin collects everything else
    base = (np.arange(n, dtype=np.int32)[:, None] * NCLS + k).astype(np.int32)
    del k
    junk = n * NCLS
    base[~ocean] = junk
    ocean_cnt = np.bincount(base.ravel(), minlength=junk + 1)[:junk].reshape(n, NCLS)
    meas = np.zeros((len(history.YEARS), n, NCLS, 2), dtype=np.int64)
    for i, y in enumerate(history.YEARS):
        if y == history.LATEST:
            t = t26
        else:
            with rasterio.open(history.tid_path(y)) as s:
                t = s.read(1, window=win)
        m = history.direct(t)
        full = (t == FULL_CODES[0]) | (t == FULL_CODES[1])
        code = base * 2 + full                         # int32; junk bin stays out of range below
        code[~m] = 2 * junk
        meas[i] = np.bincount(code.ravel(), minlength=2 * junk + 2)[:2 * junk].reshape(n, NCLS, 2)
    return r0, ocean_cnt, meas


def run(workers: int = 6) -> dict:
    t0 = time.time()
    rows = list(range(0, H15, STRIP))
    ocean_cnt = np.zeros((H15, NCLS), dtype=np.int64)
    meas = np.zeros((len(history.YEARS), H15, NCLS, 2), dtype=np.int64)
    with ProcessPoolExecutor(workers) as ex:
        for i, (r0, oc, me) in enumerate(ex.map(strip_counts, rows)):
            n = oc.shape[0]
            ocean_cnt[r0:r0 + n] = oc
            meas[:, r0:r0 + n] = me
            print(f"\rstrips {i + 1}/{len(rows)}  {time.time() - t0:.0f} s", end="", file=sys.stderr)
    print(file=sys.stderr)
    np.savez_compressed(OUT_COUNTS, ocean=ocean_cnt, measured=meas, years=np.array(history.YEARS))
    elapsed = time.time() - t0
    res = summarise(ocean_cnt, meas)
    res["runtime_s"] = round(elapsed, 1)
    res["workers"] = workers
    OUT_JSON.write_text(json.dumps(res, indent=1))
    print(f"runtime {elapsed:.0f} s with {workers} workers")
    for y, r in res["years"].items():
        print(y, " ".join(f"{k} {100 * r[k]:.2f}" for k in VARIANTS), "official", r["official_percent"],
              "->", r["official_in"], f"(position {r['official_position_in_bracket']:.2f})")
    return res


def where(off: float, lo: float, mx: float, up: float) -> str:
    if off < lo:
        return "below lower"
    if off > up:
        return "above upper"
    return "lower-mixed" if off <= mx else "mixed-upper"


def summarise(ocean_cnt: np.ndarray, meas: np.ndarray) -> dict:
    area = history.row_area_km2(0, H15)
    hs = json.loads((history.DERIVED / "history_stats.json").read_text())
    hist = {d["year"]: d["measured_frac"] for d in hs["years"]}
    res = {
        "definition": "share of the ocean that would count as mapped on the Seabed 2030 target cells (Mayer et al. 2018, Table 2, "
                      "doi:10.3390/geosciences8020063), bracketed from the 15\" TID grid of each release: upper = every measured "
                      "(TID 10-17) 15\" cell in full; lower = one target cell per measured 15\" cell (credit min(1, s^2/A15)); "
                      "mixed = TID 11 and 17 in full, other direct codes one target cell. Depth from GEBCO_2026 15\" for every "
                      "release; ocean mask of pipeline/history.py. An approximation: the official computation is not published.",
        "target_cells": {"depth_edges_m": [0, *DEPTH_EDGES_M, 11000], "size_m": TARGET_M.tolist(),
                         "mayer2018_table2_ocean_share": list(TABLE2_OCEAN_SHARE)},
        "years": {},
    }
    for i, y in enumerate(history.YEARS):
        b = bracket(ocean_cnt, meas[i], area)
        if i == 0:
            res["ocean_km2"] = b["ocean_km2"]
            res["target_cells"]["ocean_share_this_mask"] = [x / b["ocean_km2"] for x in b["ocean_km2_by_class"]]
        off = history.OFFICIAL[y]["percent"] / 100
        lo, mx, up = b["lower"], b["mixed"], b["upper"]
        res["years"][str(y)] = {
            "upper": up, "mixed": mx, "lower": lo, "official_percent": history.OFFICIAL[y]["percent"],
            "official_in": where(off, lo, mx, up),
            "official_position_in_bracket": (off - lo) / (up - lo),
            "official_minus_upper_points": 100 * (off - up),
            "official_minus_mixed_points": 100 * (off - mx),
            "upper_equals_history_measured_frac": abs(up - hist[y]) < 1e-9,
            "multibeam_or_combination_share_of_measured": b["full_code_km2"] / b["upper_km2"],
            "by_target_class": [{"size_m": float(TARGET_M[k]),
                                 "ocean_km2": b["ocean_km2_by_class"][k],
                                 **{f"{v}_share": b[v + "_km2_by_class"][k] / b["ocean_km2_by_class"][k] for v in VARIANTS}}
                                for k in range(NCLS)],
        }
    return res


def figure() -> Path:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    res = json.loads(OUT_JSON.read_text())
    ys = [int(y) for y in res["years"]]
    g = lambda k: np.array([100 * res["years"][str(y)][k] for y in ys])  # noqa: E731
    blue, orange, grey = "#0072B2", "#E69F00", "#000000"     # Okabe-Ito
    fig, ax = plt.subplots(figsize=(7.2, 4.4), facecolor="white")
    ax.fill_between(ys, g("lower"), g("upper"), color=blue, alpha=.15, lw=0, label="range allowed by the TID grid")
    ax.plot(ys, g("upper"), color=blue, lw=1.4, marker="^", ms=4, label="upper: each measured 15″ cell in full")
    ax.plot(ys, g("mixed"), color=orange, lw=1.4, ls="--", marker="s", ms=4,
            label="mixed: multibeam/combination in full, other codes one target cell")
    ax.plot(ys, g("lower"), color=blue, lw=1.4, ls=":", marker="v", ms=4, label="lower: one target cell per measured 15″ cell")
    ax.plot(ys, [res["years"][str(y)]["official_percent"] for y in ys], color=grey, marker="o", ms=5, lw=1.2,
            label="official Seabed 2030 figure")
    ax.set_xlabel("GEBCO release")
    ax.set_ylabel("% of the ocean floor counted as mapped")
    ax.set_ylim(0, 35)
    ax.set_xticks(ys)
    ax.grid(alpha=.3)
    ax.legend(fontsize=7.5, loc="upper left", frameon=False)
    fig.tight_layout()
    fig.savefig(OUT_FIG, dpi=200, facecolor="white")
    return OUT_FIG


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("run", "figure"))
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    run(a.workers) if a.cmd == "run" else print(figure())
