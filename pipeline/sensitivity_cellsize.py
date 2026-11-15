"""Cell-size sensitivity of the directly measured share of the seafloor (reviewer response).

A 15" cell is 463 m north-south everywhere but only 463 m * cos(lat) east-west (232 m at 60 deg, 80 m at 80 deg).
A cell counts as measured if its TID code is 10-17, so at high latitude one sounding marks a narrower strip. This
script re-counts the measured share on approximately equal-width blocks and compares it with the native 15" share.

Variants (s = block height in 15" rows, nominal size s * 463 m):

  native   every 15" cell on its own (the paper's number)
  ew<s>    rows are grouped into globally aligned groups of s rows (s = 1, 2, 4); in a group centred on latitude phi,
           k = max(1, round(s / cos(phi))) adjacent columns form one block, starting at 180 W; the last block of a
           row group is shorter when 86400 is not a multiple of k. Blocks are s rows x k columns, i.e. about
           s * 463 m in both directions (ew1 = the reviewer's k = max(1, round(1 / cos(phi))) rule).
  *_any    a block is measured if ANY of its ocean cells is TID 10-17
  *_majority  a block is measured if MORE THAN HALF of its ocean cells are TID 10-17 (strict; a tie is not)

The area of a block is the sum of the exact spherical areas of its ocean cells (history.row_area_km2, authalic
sphere), so every variant has the same total ocean area; blocks without ocean cells do not count. The ocean mask is
the paper's: GEBCO_2026 TID != 0 AND the GEBCO_2026 1' elevation < 0 (as in history.build). Bands: 5 deg; s <= 4
rows never straddle a band edge (1200 rows per band) and strips are multiples of 4 rows.

  python pipeline/sensitivity_cellsize.py run       data/derived/sensitivity_cellsize.json + docs/sensitivity_cellsize.md
  python pipeline/sensitivity_cellsize.py figure    figures/fig_sensitivity_cellsize.png
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history  # noqa: E402

ROOT = history.ROOT
DERIVED = history.DERIVED
OUT_JSON = DERIVED / "sensitivity_cellsize.json"
OUT_MD = ROOT / "docs/sensitivity_cellsize.md"
OUT_FIG = ROOT / "figures/fig_sensitivity_cellsize.png"
TID = history.tid_path(history.LATEST)
ELEV = history.ELEV
H15, W15 = history.H15, history.W15
CELL_M = history.R_KM * 1000 * np.radians(1 / 240)    # 15" of arc on the authalic sphere, 463.3 m
SCALES = (1, 2, 4)
STRIP = 512          # 15" rows per strip = one TID tile row; multiple of 4 (1' elevation rows) and of max(SCALES)
LAT_EDGES = np.arange(-90, 91, 5)
NBANDS = len(LAT_EDGES) - 1


def row_lat(r0: int, n: int) -> np.ndarray:
    """latitude of the centre of 15" rows r0 .. r0+n-1 (row 0 = north edge)"""
    return 90 - (r0 + np.arange(n) + 0.5) / 240


def k_for(lat: np.ndarray, s: int, ncol: int = W15) -> np.ndarray:
    """columns per block for a group of s rows centred on lat: max(1, round(s / cos(lat))), at most ncol"""
    k = np.rint(s / np.cos(np.radians(lat)))
    return np.clip(k, 1, ncol).astype(np.int64)


def band_of(lat: np.ndarray) -> np.ndarray:
    return np.clip(np.digitize(lat, LAT_EDGES) - 1, 0, NBANDS - 1)


def merge_blocks(ocean: np.ndarray, meas: np.ndarray, k: np.ndarray, s: int) -> np.ndarray:
    """Count ocean cells in measured blocks, per 15" row.

    ocean, meas: (n, W) bool, n a multiple of s; meas is reduced to meas & ocean. k: (n // s,) columns per block of
    each row group. Blocks are s rows x k columns starting at column 0; the last block of a row is W mod k wide
    when that is not 0. Returns int64 (3, n): ocean cells, ocean cells in ANY-measured blocks, ocean cells in
    MAJORITY-measured blocks, for every row (multiply by the row's cell area to get km2).
    """
    n, W = ocean.shape
    assert n % s == 0 and len(k) == n // s, (n, s, len(k))
    G = n // s
    oc = ocean.reshape(G, s, W)
    mc = (meas & ocean).reshape(G, s, W)
    out = np.zeros((3, G, s), dtype=np.int64)
    for kk in np.unique(k):
        g = np.nonzero(k == kk)[0]
        o, m = oc[g], mc[g]
        if kk == 1:
            co, cm = o, m                                     # (Gg, s, W): block = one column
        else:
            starts = np.arange(0, W, kk)
            co = np.add.reduceat(o, starts, axis=2, dtype=np.int32)   # ocean cells per row per block
            cm = np.add.reduceat(m, starts, axis=2, dtype=np.int32)
        bn = co.sum(axis=1, dtype=np.int32)                   # (Gg, nb) ocean cells per block
        bm = cm.sum(axis=1, dtype=np.int32)                   # measured ocean cells per block
        hit_any = bm > 0
        hit_maj = 2 * bm > bn
        out[0, g] = co.sum(axis=2, dtype=np.int64)
        out[1, g] = (co * hit_any[:, None, :]).sum(axis=2, dtype=np.int64)
        out[2, g] = (co * hit_maj[:, None, :]).sum(axis=2, dtype=np.int64)
    return out.reshape(3, n)


def strip_stats(ocean: np.ndarray, meas: np.ndarray, r0: int) -> dict:
    """km2 per 5 deg band for a strip of 15" rows starting at global row r0 (r0 a multiple of max(SCALES))."""
    n = ocean.shape[0]
    area = history.row_area_km2(r0, n)
    lat = row_lat(r0, n)
    band = band_of(lat)
    res = {}
    nat = np.zeros((2, NBANDS))
    np.add.at(nat[0], band, ocean.sum(axis=1) * area)
    np.add.at(nat[1], band, (ocean & meas).sum(axis=1) * area)
    res["native"] = nat
    for s in SCALES:
        latc = lat.reshape(n // s, s).mean(axis=1)
        cnt = merge_blocks(ocean, meas, k_for(latc, s, ocean.shape[1]), s)
        acc = np.zeros((3, NBANDS))
        for j in range(3):
            np.add.at(acc[j], band, cnt[j] * area)
        res[f"ew{s}"] = acc
    return res


# ---------------------------------------------------------------- full-grid run (row strips, process pool)

_SRC = {}


def _open():
    if not _SRC:
        import rasterio
        _SRC["tid"] = rasterio.open(TID)
        _SRC["elev"] = rasterio.open(ELEV)
    return _SRC["tid"], _SRC["elev"]


def _work(r0: int) -> tuple[int, dict]:
    import rasterio
    tid, elev = _open()
    n = min(STRIP, H15 - r0)
    t = tid.read(1, window=rasterio.windows.Window(0, r0, W15, n))
    h = elev.read(1, window=rasterio.windows.Window(0, r0 // 4, W15 // 4, n // 4))
    sea15 = np.repeat(np.repeat(h < 0, 4, axis=0), 4, axis=1)
    ocean = sea15 & (t != 0)                     # the paper's mask (history.build)
    meas = history.direct(t)
    return r0, strip_stats(ocean, meas, r0)


def width_table() -> dict:
    """nominal block size per band, from the row latitudes alone (no data)"""
    out = {}
    lat = row_lat(0, H15)
    band = band_of(lat)
    for s in SCALES:
        latc = lat.reshape(-1, s).mean(axis=1)
        k = k_for(latc, s)
        w = k * CELL_M * np.cos(np.radians(latc))
        b = band[::s]
        out[f"ew{s}"] = {"ns_m": s * CELL_M,
                         "k_min": [int(k[b == i].min()) for i in range(NBANDS)],
                         "k_max": [int(k[b == i].max()) for i in range(NBANDS)],
                         "ew_m_min": [float(w[b == i].min()) for i in range(NBANDS)],
                         "ew_m_max": [float(w[b == i].max()) for i in range(NBANDS)],
                         "ew_m_mean": [float(w[b == i].mean()) for i in range(NBANDS)]}
    w = CELL_M * np.cos(np.radians(lat))
    out["native"] = {"ns_m": CELL_M, "ew_m_min": [float(w[band == i].min()) for i in range(NBANDS)],
                     "ew_m_max": [float(w[band == i].max()) for i in range(NBANDS)],
                     "ew_m_mean": [float(w[band == i].mean()) for i in range(NBANDS)]}
    return out


def run(workers: int) -> dict:
    t0 = time.time()
    tot = {"native": np.zeros((2, NBANDS)), **{f"ew{s}": np.zeros((3, NBANDS)) for s in SCALES}}
    starts = list(range(0, H15, STRIP))
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for i, (r0, res) in enumerate(ex.map(_work, starts), 1):
            for key, v in res.items():
                tot[key] += v
            print(f"\rstrips {i}/{len(starts)}  {time.time() - t0:.0f}s", end="", file=sys.stderr)
    print(file=sys.stderr)
    runtime = time.time() - t0

    ocean = tot["native"][0]
    variants = {"native": tot["native"][1]}
    for s in SCALES:
        assert np.allclose(tot[f"ew{s}"][0], ocean, rtol=1e-12, atol=1e-6), s   # area conserved
        variants[f"ew{s}_any"] = tot[f"ew{s}"][1]
        variants[f"ew{s}_majority"] = tot[f"ew{s}"][2]
    widths = width_table()
    out = {
        "description": "Cell-size sensitivity of the GEBCO_2026 directly measured share (TID 10-17); "
                       "see pipeline/sensitivity_cellsize.py",
        "ocean_mask": "GEBCO_2026 TID != 0 and GEBCO_2026 1' elevation < 0 (same as pipeline/history.py)",
        "area": "exact spherical area of each 15\" ocean cell, authalic sphere R = 6371.0072 km; block area = sum "
                "of its ocean cells",
        "block_rule": "ew<s>: groups of s 15\" rows (globally aligned); k = max(1, round(s / cos(lat_group_centre))) "
                      "columns per block from 180 W, last block of a row shorter; any = >= 1 measured ocean cell, "
                      "majority = measured ocean cells > half of the block's ocean cells",
        "cell_m_at_equator": CELL_M,
        "lat_edges": LAT_EDGES.tolist(),
        "ocean_km2": float(ocean.sum()),
        "band_ocean_km2": ocean.tolist(),
        "variants": {},
        "runtime_s": round(runtime, 1),
        "workers": workers,
    }
    for name, m in variants.items():
        base = name.split("_")[0]
        out["variants"][name] = {
            "nominal_size_m": widths[base]["ns_m"],
            "measured_km2": float(m.sum()),
            "measured_frac": float(m.sum() / ocean.sum()),
            "band_measured_km2": m.tolist(),
            "band_measured_frac": [None if o == 0 else float(v / o) for v, o in zip(m, ocean)],
            "band_block_ew_m_mean": widths[base]["ew_m_mean"],
            "band_block_ew_m_min": widths[base]["ew_m_min"],
            "band_block_ew_m_max": widths[base]["ew_m_max"],
        }
    for s in SCALES:
        out["variants"][f"ew{s}_any"]["band_k_min"] = widths[f"ew{s}"]["k_min"]
        out["variants"][f"ew{s}_any"]["band_k_max"] = widths[f"ew{s}"]["k_max"]
    ref = json.loads((DERIVED / "history_stats.json").read_text())["years"][-1]
    out["check_native_vs_history_stats"] = {"history_measured_frac": ref["measured_frac"],
                                            "this_native_measured_frac": out["variants"]["native"]["measured_frac"],
                                            "abs_diff": abs(ref["measured_frac"]
                                                            - out["variants"]["native"]["measured_frac"])}
    assert out["check_native_vs_history_stats"]["abs_diff"] < 1e-9, out["check_native_vs_history_stats"]
    OUT_JSON.write_text(json.dumps(out, indent=1))
    return out


# ---------------------------------------------------------------- report

COLS = ["native", "ew1_any", "ew1_majority", "ew2_any", "ew2_majority", "ew4_any", "ew4_majority"]


def band_label(i: int) -> str:
    a, b = LAT_EDGES[i], LAT_EDGES[i + 1]
    f = lambda x: f"{abs(x)}°{'N' if x > 0 else 'S' if x < 0 else ''}"  # noqa: E731
    return f"{f(a)}–{f(b)}" if a >= 0 else f"{f(b)}–{f(a)}"


def table(out: dict) -> str:
    v = out["variants"]
    head = "| Band | Ocean (M km²) | 15″ cell E-W (m) | Native 15″ | EW 463 m any | EW 463 m majority " \
           "| EW 926 m any | EW 926 m majority | EW 1853 m any | EW 1853 m majority |"
    lines = [head, "|" + "---|" * (head.count("|") - 1)]
    pct = lambda x: "" if x is None else f"{100 * x:.1f}"  # noqa: E731
    lines.append("| **Global** | " + f"{out['ocean_km2'] / 1e6:.1f} | | " +
                 " | ".join(f"**{100 * v[c]['measured_frac']:.2f}**" for c in COLS) + " |")
    for i in range(NBANDS - 1, -1, -1):
        o = out["band_ocean_km2"][i]
        if o < 1e3:
            continue
        lines.append(f"| {band_label(i)} | {o / 1e6:.2f} | {v['native']['band_block_ew_m_mean'][i]:.0f} | " +
                     " | ".join(pct(v[c]["band_measured_frac"][i]) for c in COLS) + " |")
    return "\n".join(lines)


def write_md(out: dict) -> None:
    v = out["variants"]
    g = {c: 100 * v[c]["measured_frac"] for c in COLS}
    bf = lambda c, lo: 100 * v[c]["band_measured_frac"][list(LAT_EDGES).index(lo)]  # noqa: E731
    md = f"""# Cell-size sensitivity of the measured share

Response to the reviewer point that a 15″ cell is 463 m wide east-west at the equator but only 232 m at
60° and 80 m at 80°, so the same survey marks less area as "measured" at high latitude. Produced by
`pipeline/sensitivity_cellsize.py`; numbers in `data/derived/sensitivity_cellsize.json`; figure
`figures/fig_sensitivity_cellsize.png`.

## What was done

* Same ocean mask as the paper (GEBCO_2026 TID ≠ 0 and GEBCO_2026 1′ elevation < 0), same "measured"
  definition (TID 10–17), same exact spherical cell areas (authalic sphere, R = 6371.0072 km). The native 15″
  share was recomputed with this code: {g['native']:.4f} % (pipeline/history.py: {100 * out['check_native_vs_history_stats']['history_measured_frac']:.4f} %,
  difference {out['check_native_vs_history_stats']['abs_diff']:.1e}).
* **Equal-width blocks (EW 463 m).** In each 15″ row at latitude φ, k = max(1, round(1/cos φ)) adjacent
  cells along longitude form one block, starting at 180° W; the last block of a row is shorter when 86,400 is
  not a multiple of k. Because k is an integer, the block width is 309–618 m (k = 1 up to 48.2°, k = 2 to 66.4°,
  …), never the 80–232 m of the native cell at high latitude.
* **Coarser equal-width blocks (EW 926 m, EW 1853 m).** Rows are grouped into globally aligned groups of s = 2 or 4
  rows, and k = max(1, round(s/cos φ)) columns, φ = centre of the row group, so blocks are about s × 463 m in
  both directions. (Close to merging 2×2 / 4×4 equal-width blocks, but avoids blocks whose rows have
  different k.)
* A block is measured if **any** of its ocean cells is measured, or (variant) if **more than half** of its ocean
  cells are. Block area = sum of its ocean cells' areas, so every variant has the same total ocean area
  ({out['ocean_km2'] / 1e6:.3f} M km², checked). The native share is the area-weighted mean measured
  *fraction* of the blocks, so "any" ≥ native by construction; "majority" can fall on either side of native.
* Run time {out['runtime_s']:.0f} s on {out['workers']} processes, 512-row strips.

## Result (% of the ocean area in each band coded as directly measured)

{table(out)}

The 15″ cell E-W column is the mean width of a native cell in the band; EW block widths per band are in the JSON
(`band_block_ew_m_*`).

## Interpretation

"""
    keep = "TODO: interpretation (written by hand from the table above)\n"
    if OUT_MD.exists() and "## Interpretation" in OUT_MD.read_text():   # keep the hand-written text on re-runs
        keep = OUT_MD.read_text().split("## Interpretation", 1)[1].lstrip("\n")
    OUT_MD.write_text(md + keep)


# ---------------------------------------------------------------- figure

def figure() -> Path:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    from figures import CITE  # noqa: F401  (sets the shared rcParams)

    out = json.loads(OUT_JSON.read_text())
    v = out["variants"]
    lat_c = (LAT_EDGES[:-1] + LAT_EDGES[1:]) / 2
    keep = np.array(out["band_ocean_km2"]) > 1e5           # skip bands with < 0.1 M km2 of ocean (85-90 S etc.)
    fig, ax = plt.subplots(figsize=(7.5, 4.6), facecolor="white")
    ax.set_facecolor("white")
    style = [("native", "Native 15″ cells", "#0b0b0b", "-", "o", 2.0),
             ("ew1_any", "Equal-width 463 m, any", "#2a78d6", "-", "s", 1.6),
             ("ew1_majority", "Equal-width 463 m, majority", "#2a78d6", "--", "s", 1.2),
             ("ew2_any", "Equal-width 926 m, any", "#eb6834", "-", "^", 1.4),
             ("ew4_any", "Equal-width 1853 m, any", "#8f3fb0", "-", "D", 1.4)]
    for key, lab, col, ls, mk, lw in style:
        y = np.array([np.nan if f is None else 100 * f for f in v[key]["band_measured_frac"]])
        ax.plot(lat_c[keep], y[keep], color=col, ls=ls, lw=lw, marker=mk, ms=3.5,
                label=f"{lab} ({100 * v[key]['measured_frac']:.1f} % global)")
    ax.set_xlim(-82, 90)
    ax.set_xticks(np.arange(-80, 91, 20))
    ax.set_xticklabels([f"{abs(x)}°{'N' if x > 0 else 'S' if x < 0 else ''}" for x in np.arange(-80, 91, 20)])
    ax.set_xlabel("Latitude (5° bands)")
    ax.set_ylabel("Ocean area directly measured (%)")
    ax.set_ylim(0, None)
    ax.grid(axis="y", color="0.88", lw=0.6)
    ax.legend(frameon=False, fontsize=8, loc="upper left")
    ax.set_title("Measured share by latitude: native 15″ cells vs approximately equal-width blocks",
                 fontsize=10.5, loc="left")
    fig.text(0.01, -0.02, "GEBCO_2026 TID 10-17; ocean = TID ≠ 0 and 1′ elevation < 0; areas on the authalic "
             "sphere. Data: GEBCO Compilation Group (2026) GEBCO_2026 Grid", fontsize=7, color="0.35")
    OUT_FIG.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT_FIG, facecolor="white")
    plt.close(fig)
    return OUT_FIG


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["run", "report", "figure"])
    ap.add_argument("--workers", type=int, default=max(1, min(6, (os.cpu_count() or 2) // 2)))
    a = ap.parse_args()
    if a.step == "run":
        out = run(a.workers)
        write_md(out)
    elif a.step == "report":
        write_md(json.loads(OUT_JSON.read_text()))
    else:
        print(figure())
        return
    out = json.loads(OUT_JSON.read_text())
    for c in COLS:
        print(f"{c:14s} {100 * out['variants'][c]['measured_frac']:.3f} %")
    print("runtime", out["runtime_s"], "s")


if __name__ == "__main__":
    main()
