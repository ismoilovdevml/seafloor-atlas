"""Blind test of predicted bathymetry: depths GEBCO estimated in one release against depths measured in the next.

Between two releases a < b, some 15" cells change from an indirect code (TID 40 = predicted from satellite gravity,
41 = interpolated, 44 = flight-derived gravity, 70 = pre-generated grid, ...) to a direct measurement (TID 10-17).
For those cells the depth published in release a was an estimate made without the measurement, and the depth in
release b is the measurement. Their difference is an out-of-sample error of the estimate.

  diff = z_a - z_b   (metres; elevations are negative down; diff > 0: the estimate was too shallow)

z is the 15" elevation of each release (ice-surface grid, the variant GEBCO calls "the GEBCO_<year> Grid"), for the
same 15" cell in both releases.

Classes (per pair a -> b)
  new_from_<code>   direct in b, code <code> in a (40, 41, 44, 70); new_from_other = any other non-direct code
  ctrl_pred_pred    TID 40 in both releases: how much the prediction itself changed between releases (not an error)
  ctrl_meas_meas    direct in both releases: how much measured cells changed (re-gridding, new overlapping surveys)
Strata (per group): measured depth -z_b, distance from the 1' cell to the nearest measured 1' cell in release a
(pipeline/distance.py), code received in b, 5-degree latitude band. Groups:
  f40  = new_from_40,  est = every new_from_* class pooled,  c40 = ctrl_pred_pred.

Inputs  TID grids (local, pipeline/history.py); elevation: GEBCO_2026 local, GEBCO_2024 / GEBCO_2025 streamed from the
        Source Cooperative COG mirror (checked equal to the official netCDF: pipeline/verify_mirror.py releases);
        the 15" world-ocean mask from the published record (inland_below_sea_level == 0, which implies the paper's
        ocean mask); distance grids data/derived/distance_<a>_1arcmin.npz.
Cells   world ocean and TID != 0 in both releases. Areas: exact spherical 15" cell areas (history.row_area_km2).

  python pipeline/blindtest.py run       -> data/derived/blindtest_acc.npz (resumable) + blindtest_stats.json
  python pipeline/blindtest.py stats     -> recompute blindtest_stats.json from the accumulators
  python pipeline/blindtest.py figure    -> figures/fig_blindtest.png
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history  # noqa: E402

ROOT = history.ROOT
DERIVED = history.DERIVED
ACC = DERIVED / "blindtest_acc.npz"
OUT_JSON = DERIVED / "blindtest_stats.json"
OUT_FIG = ROOT / "figures/fig_blindtest.png"
RECORD_NC = ROOT / "dataset/build/seafloor_measured_record_2019_2026.nc"
H15, W15 = history.H15, history.W15
MIRROR = ("/vsicurl/https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/ausantarctic/gebco/"
          "GEBCO_{y}.tif")
ELEV_LOCAL = {2026: history.RAW / "gebco_2026/GEBCO_2026_15s.tif"}
PAIRS = ((2024, 2025), (2025, 2026))
STRIP = 512
DMAX = 3000                                  # histogram range of diff, metres; 1 m bins, ends hold the overflow
NB = 2 * DMAX + 1
FROM = (40, 41, 44, 70)                      # from-codes kept separately; every other non-direct code -> "other"
DEPTH_EDGES = (0, 200, 1000, 2000, 3000, 4000, 5000, 6000, 12000)      # depth -z_b, metres (z_b >= 0 -> first bin)
DIST_EDGES = (0, 0.05, 3, 5, 10, 20, 50, 100, 1e9)                     # km; first bin = distance 0
DIST_LABELS = ("same 1' cell", "< 3", "3-5", "5-10", "10-20", "20-50", "50-100", "> 100", "no distance")
NDIST = len(DIST_LABELS)                     # last stratum: 1' cell without a distance value (should stay empty)
TO_CODES = tuple(range(10, 18))
NLAT = 36                                    # 5-degree bands, south first
AGG = 16                                     # 15" -> 4' for the error map
THRESH = (50, 100, 200, 500)
GROUPS = ("f40", "est", "c40")
STRATA = {"depth": len(DEPTH_EDGES) - 1, "dist": NDIST, "to": len(TO_CODES), "lat": NLAT}


def classes() -> list[str]:
    return [f"new_from_{c}" for c in FROM] + ["new_from_other", "ctrl_pred_pred", "ctrl_meas_meas"]


C_OTHER = len(FROM)
C_PP = len(FROM) + 1
C_MM = len(FROM) + 2


def empty_acc(h: int = H15, w: int = W15) -> dict:
    nc = len(classes())
    a = {"next_row": np.int64(0)}
    for p in PAIRS:
        k = f"{p[0]}_{p[1]}"
        a[f"{k}/cls"] = np.zeros((nc, NB))                              # km2 per 1 m bin
        a[f"{k}/cls_n"] = np.zeros(nc, dtype=np.int64)                  # 15" cells
        for g in GROUPS:
            for s, n in STRATA.items():
                a[f"{k}/{g}/{s}"] = np.zeros((n, NB))
                a[f"{k}/{g}/{s}_n"] = np.zeros(n, dtype=np.int64)
        a[f"{k}/map_sum"] = np.zeros((h // AGG, w // AGG), dtype=np.float32)   # sum |diff| of new_from_40 cells
        a[f"{k}/map_n"] = np.zeros((h // AGG, w // AGG), dtype=np.int32)
    return a


def hist_add(target: np.ndarray, strat: np.ndarray, diff: np.ndarray, w: np.ndarray,
             count: np.ndarray | None = None) -> None:
    """target (S, NB) += area histogram of diff per stratum; count (S,) += number of cells per stratum"""
    b = np.clip(diff, -DMAX, DMAX).astype(np.int64) + DMAX
    s = strat.astype(np.int64)
    assert s.size == 0 or (s.min() >= 0 and s.max() < target.shape[0]), "stratum out of range"
    target += np.bincount(s * NB + b, weights=w, minlength=target.size).reshape(target.shape)
    if count is not None:
        count += np.bincount(s, minlength=count.size)


def depth_stratum(zb: np.ndarray) -> np.ndarray:
    return np.clip(np.digitize(-zb.astype(np.int32), DEPTH_EDGES) - 1, 0, len(DEPTH_EDGES) - 2)


def dist_stratum(dk: np.ndarray) -> np.ndarray:
    """dk in km, NaN = no distance value -> last stratum"""
    s = np.clip(np.digitize(np.nan_to_num(dk, nan=0.0), DIST_EDGES) - 1, 0, len(DIST_EDGES) - 2)
    return np.where(np.isnan(dk), NDIST - 1, s)


def lat_stratum(r_global: np.ndarray, h: int = H15) -> np.ndarray:
    lat = 90 - (r_global + 0.5) * (180 / h)
    return np.clip(((lat + 90) // 5).astype(np.int64), 0, NLAT - 1)


def classify(ta: np.ndarray, tb: np.ndarray, ocean: np.ndarray) -> np.ndarray:
    """class index per cell (-1 = not used)"""
    da, db = history.direct(ta), history.direct(tb)
    valid = ocean & (ta != 0) & (tb != 0)
    cls_id = np.full(ta.shape, -1, dtype=np.int8)
    new = valid & db & ~da
    for i, c in enumerate(FROM):
        cls_id[new & (ta == c)] = i
    cls_id[new & (cls_id < 0)] = C_OTHER
    cls_id[valid & (ta == 40) & (tb == 40)] = C_PP
    cls_id[valid & da & db] = C_MM
    return cls_id


def strip_update(acc: dict, key: str, r0: int, ta, tb, za, zb, ocean, dist_a_km, h: int = H15) -> None:
    """ta, tb: TID (n, W) int; za, zb: elevation (n, W) int; ocean: bool (n, W);
    dist_a_km: (n/4, W/4) float32 km, NaN = no value, or None (distance strata skipped)"""
    n = ta.shape[0]
    area = history.row_area_km2(r0, n) if h == H15 else np.ones(n)
    cls_id = classify(ta, tb, ocean)
    rr, cc = np.nonzero(cls_id >= 0)
    if rr.size == 0:
        return
    d = za[rr, cc].astype(np.int32) - zb[rr, cc].astype(np.int32)
    w = area[rr]
    ci = cls_id[rr, cc]
    hist_add(acc[f"{key}/cls"], ci, d, w, acc[f"{key}/cls_n"])
    sel = {"f40": ci == 0, "est": ci <= C_OTHER, "c40": ci == C_PP}
    for g, s in sel.items():
        if not s.any():
            continue
        r, c, dd, ww = rr[s], cc[s], d[s], w[s]
        pre = f"{key}/{g}/"
        hist_add(acc[pre + "depth"], depth_stratum(zb[r, c]), dd, ww, acc[pre + "depth_n"])
        hist_add(acc[pre + "to"], np.clip(tb[r, c].astype(np.int64) - 10, 0, len(TO_CODES) - 1), dd, ww,
                 acc[pre + "to_n"])
        hist_add(acc[pre + "lat"], lat_stratum(r0 + r, h), dd, ww, acc[pre + "lat_n"])
        if dist_a_km is not None:
            hist_add(acc[pre + "dist"], dist_stratum(dist_a_km[r // 4, c // 4]), dd, ww, acc[pre + "dist_n"])
        if g == "f40":
            mr, mc = (r0 + r) // AGG, c // AGG
            np.add.at(acc[f"{key}/map_sum"], (mr, mc), np.abs(dd).astype(np.float32))
            np.add.at(acc[f"{key}/map_n"], (mr, mc), 1)


# ------------------------------------------------------------------------------------------------ statistics
def _wq(h: np.ndarray, p: float) -> int:
    """index of the p-quantile of a histogram"""
    c = np.cumsum(h)
    return int(np.searchsorted(c, p * c[-1]))


def hist_stats(h: np.ndarray, n: int | None = None) -> dict | None:
    """summary of an area histogram of diff (1 m bins centred on integers -DMAX..DMAX)"""
    tot = float(h.sum())
    if tot <= 0:
        return None
    x = np.arange(-DMAX, DMAX + 1, dtype=np.float64)
    med = float(x[_wq(h, 0.5)])
    q25, q75 = float(x[_wq(h, 0.25)]), float(x[_wq(h, 0.75)])
    absx = np.abs(x).astype(np.int64)
    ab = np.bincount(absx, weights=h, minlength=DMAX + 1)                  # |diff|
    dev = np.bincount(np.abs(x - med).astype(np.int64), weights=h)         # |diff - median|
    res = {
        "n_cells": n, "area_km2": tot, "bias_mean_m": float((h * x).sum() / tot), "bias_median_m": med,
        "nmad_m": 1.4826 * _wq(dev, 0.5), "iqr_sigma_m": (q75 - q25) / 1.349, "q25_m": q25, "q75_m": q75,
        "median_abs_m": float(_wq(ab, 0.5)), "p68_abs_m": float(_wq(ab, 0.68)), "p90_abs_m": float(_wq(ab, 0.90)),
        "p95_abs_m": float(_wq(ab, 0.95)),
        "rms_m": float(np.sqrt((h * x * x).sum() / tot)),
        "share_abs_gt": {str(t): float(ab[t + 1:].sum() / tot) for t in THRESH},
        "share_exact_zero": float(h[DMAX] / tot),
        "share_estimate_too_shallow": float(h[DMAX + 1:].sum() / tot),
        "overflow_share": float((h[0] + h[-1]) / tot),
    }
    return res


def drop_exact_zero(h: np.ndarray) -> np.ndarray:
    """the histogram without its diff == 0 m bin.

    Sensitivity variant: a cell whose earlier depth already equals the measured depth to the metre is often not a
    prediction at all but a re-labelled measurement (the survey was already in the grid, coded as TID 40; seen
    e.g. in GEBCO_2025 -> GEBCO_2026 around the Tuamotu). Dropping the 0 m bin removes those and, with them, the few
    genuine exact hits (about 1-3 % of a distribution with a 40-60 m spread)."""
    g = h.copy()
    g[DMAX] = 0.0
    return g


def make_stats(acc: dict) -> dict:
    res = {
        "definition": "diff = z_a - z_b in metres over the same 15\" cell, z = 15\" ice-surface elevation of each "
                      "release; positive = the earlier (estimated) depth was too shallow. Area-weighted (exact "
                      "spherical cell areas). nmad = 1.4826 x median |diff - median|; iqr_sigma = IQR / 1.349; rms "
                      "is capped by the +-3000 m histogram (see overflow_share). n_cells = number of 15\" cells. *_excl_exact_zero: "
                      "the same without cells whose diff is exactly 0 m (re-labelled measurements; n_cells not kept).",
        "mask": "world ocean (record variable inland_below_sea_level == 0, inside the paper's mask GEBCO_2026 TID != 0 "
                "and 1' elevation < 0) and TID != 0 in both releases",
        "groups": {"f40": "new_from_40", "est": "all new_from_* pooled", "c40": "ctrl_pred_pred (TID 40 in both)"},
        "depth_edges_m": list(DEPTH_EDGES), "distance_labels_km": list(DIST_LABELS), "to_codes": list(TO_CODES),
        "lat_band_edges": list(range(-90, 91, 5)),
        "complete": bool(int(acc["next_row"]) >= H15), "rows_done": int(acc["next_row"]), "pairs": {},
    }
    for p in PAIRS:
        k = f"{p[0]}_{p[1]}"
        d = {"classes": {}}
        d["classes_excl_exact_zero"] = {}
        for i, name in enumerate(classes()):
            d["classes"][name] = hist_stats(acc[f"{k}/cls"][i], int(acc[f"{k}/cls_n"][i]))
            d["classes_excl_exact_zero"][name] = hist_stats(drop_exact_zero(acc[f"{k}/cls"][i]))
        for g in GROUPS:
            gd = {}
            for s in STRATA:
                hs = [hist_stats(h, int(n)) for h, n in zip(acc[f"{k}/{g}/{s}"], acc[f"{k}/{g}/{s}_n"])]
                gd[s] = dict(zip(map(str, TO_CODES), hs)) if s == "to" else hs
                if s in ("depth", "dist") and g != "c40":
                    gd[s + "_excl_exact_zero"] = [hist_stats(drop_exact_zero(h)) for h in acc[f"{k}/{g}/{s}"]]
            d[g] = gd
        res["pairs"][k] = d
    return res


# ------------------------------------------------------------------------------------------------ run
def _read(src, r0: int, n: int, tries: int = 8) -> np.ndarray:
    import rasterio
    for i in range(tries):
        try:
            return src.read(1, window=rasterio.windows.Window(0, r0, W15, n))
        except Exception as e:  # network hiccup on the streamed grids
            if i == tries - 1:
                raise
            print(f"  retry {i + 1} at row {r0}: {e}", flush=True)
            time.sleep(5 * (i + 1))
    raise RuntimeError


def world_ocean_15s(ds, r0: int, n: int) -> np.ndarray:
    """rows r0 .. r0+n-1 (north-first) of the 15" world-ocean mask from the south-first record"""
    v = ds["inland_below_sea_level"]
    v.set_auto_maskandscale(False)
    a = v[H15 - r0 - n:H15 - r0]
    return np.asarray(a)[::-1] == 0          # 0 = in the ocean mask and connected; 1 = inland; -1 = outside


def run() -> None:
    import netCDF4
    import rasterio

    import distance
    acc = dict(np.load(ACC)) if ACC.exists() else empty_acc()
    years = sorted({y for p in PAIRS for y in p})
    dist = {}
    for a, _ in PAIRS:
        g = distance.load_grid(a)                      # float32 km, NaN outside the world ocean
        assert g.shape == (H15 // 4, W15 // 4)
        dist[a] = g
        print("distance grid", a, "loaded", flush=True)
    ds = netCDF4.Dataset(RECORD_NC)
    assert float(ds["lat"][0]) < 0 and ds["inland_below_sea_level"].shape == (H15, W15)
    env = rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
                       GDAL_HTTP_MULTIRANGE="YES", GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", GDAL_HTTP_MAX_RETRY="5",
                       GDAL_HTTP_RETRY_DELAY="3", VSI_CACHE="FALSE")
    with env:
        tid = {y: rasterio.open(history.tid_path(y)) for y in years}
        elev = {y: rasterio.open(ELEV_LOCAL.get(y, MIRROR.format(y=y))) for y in years}
        ref = tid[history.LATEST].transform
        for s in list(tid.values()) + list(elev.values()):
            assert s.shape == (H15, W15) and all(abs(p - q) < 1e-9 for p, q in zip(s.transform, ref)), s.name
        pool = ThreadPoolExecutor(len(years))
        r0 = int(acc["next_row"])
        while r0 < H15:
            t0 = time.time()
            n = min(STRIP, H15 - r0)
            zf = {y: pool.submit(_read, elev[y], r0, n) for y in years}
            t = {y: _read(tid[y], r0, n).astype(np.int16) for y in tid}
            ocean = world_ocean_15s(ds, r0, n)
            z = {y: f.result() for y, f in zf.items()}
            for a, b in PAIRS:
                strip_update(acc, f"{a}_{b}", r0, t[a], t[b], z[a], z[b], ocean, dist[a][r0 // 4:(r0 + n) // 4])
            r0 += n
            acc["next_row"] = np.int64(r0)
            np.savez(ACC.with_suffix(".tmp.npz"), **acc)
            ACC.with_suffix(".tmp.npz").replace(ACC)
            print(f"rows {r0}/{H15}  {time.time() - t0:.1f} s", flush=True)
    np.savez_compressed(ACC.with_suffix(".tmp.npz"), **acc)            # final copy: compressed (~10x smaller)
    ACC.with_suffix(".tmp.npz").replace(ACC)
    OUT_JSON.write_text(json.dumps(make_stats(acc), indent=1))
    print("done")


def figure() -> Path:
    import matplotlib
    matplotlib.use("Agg")
    import cartopy.crs as ccrs
    import matplotlib.pyplot as plt
    from matplotlib.colors import LogNorm

    blue, verm, grey = "#0072B2", "#D55E00", "#7f7f7f"          # Okabe-Ito
    acc = np.load(ACC)
    st = json.loads(OUT_JSON.read_text())
    fig = plt.figure(figsize=(13, 10), facecolor="white")
    ax = fig.add_axes([0.02, 0.44, 0.96, 0.54], projection=ccrs.EqualEarth(central_longitude=150))
    s = sum(acc[f"{a}_{b}/map_sum"] for a, b in PAIRS)
    n = sum(acc[f"{a}_{b}/map_n"] for a, b in PAIRS)
    k = 4                                                              # 4' -> 16' so sparse tracks stay visible
    s = s.reshape(s.shape[0] // k, k, s.shape[1] // k, k).sum(axis=(1, 3))
    n = n.reshape(n.shape[0] // k, k, n.shape[1] // k, k).sum(axis=(1, 3))
    m = np.where(n > 0, s / np.maximum(n, 1), np.nan)
    ax.set_facecolor("#e6e6e6")
    im = ax.imshow(m, extent=(-180, 180, -90, 90), origin="upper", transform=ccrs.PlateCarree(), cmap="viridis_r",
                   norm=LogNorm(10, 1000), interpolation="nearest")
    ax.coastlines(lw=0.3, color="0.4")
    ax.set_global()
    cb = fig.colorbar(im, ax=ax, orientation="horizontal", fraction=0.045, pad=0.02, extend="both")
    cb.set_label("Mean |predicted - measured| depth (m) where a TID 40 prediction was replaced by a measurement, "
                 "GEBCO 2024->2025 and 2025->2026 (16' cells)")
    x = np.arange(-DMAX, DMAX + 1)
    a1 = fig.add_axes([0.06, 0.07, 0.27, 0.29])
    for (a, b), c in zip(PAIRS, (blue, verm)):
        h = acc[f"{a}_{b}/cls"][0]
        a1.plot(x, h / h.sum(), color=c, lw=1, label=f"{a}->{b}: TID 40, then measured")
    h = acc[f"{PAIRS[-1][0]}_{PAIRS[-1][1]}/cls"][C_MM]
    a1.plot(x, h / h.sum(), color=grey, lw=1, ls="--", label="control: measured in both (2025->2026)")
    a1.set_xlim(-600, 600)
    a1.set_yscale("log")
    a1.set_ylim(1e-6, 1)
    a1.set_xlabel("predicted - measured (m); > 0: prediction too shallow")
    a1.set_ylabel("share of area per metre")
    a1.legend(fontsize=7, loc="upper right")
    a1.grid(alpha=.3)

    def bars(axx, key, labels):
        xi = np.arange(len(labels))
        for j, ((a, b), c) in enumerate(zip(PAIRS, (blue, verm))):
            d = st["pairs"][f"{a}_{b}"]["f40"][key][:len(labels)]
            axx.bar(xi + (j - 0.5) * 0.38, [q["median_abs_m"] if q else 0 for q in d], 0.38, color=c,
                    label=f"{a}->{b} median |error|")
            axx.plot(xi + (j - 0.5) * 0.38, [q["p90_abs_m"] if q else np.nan for q in d], "_", color="k", ms=9)
        axx.set_xticks(xi)
        axx.set_xticklabels(labels, fontsize=7, rotation=30)
        axx.set_yscale("log")
        axx.grid(alpha=.3, axis="y")

    a2 = fig.add_axes([0.40, 0.07, 0.26, 0.29])
    lab = [f"{DEPTH_EDGES[i] / 1000:g}-{DEPTH_EDGES[i + 1] / 1000:g}" for i in range(len(DEPTH_EDGES) - 1)]
    lab[-1] = f"> {DEPTH_EDGES[-2] / 1000:g}"
    bars(a2, "depth", lab)
    a2.set_xlabel("measured depth (km)")
    a2.set_ylabel("|error| (m); dash = 90th percentile")
    a2.legend(fontsize=7, loc="upper left")
    a3 = fig.add_axes([0.72, 0.07, 0.26, 0.29])
    bars(a3, "dist", list(DIST_LABELS[:-1]))
    a3.set_xlabel("distance to the nearest measurement in the earlier release (km)")
    a3.set_ylabel("|error| (m)")
    fig.savefig(OUT_FIG, dpi=150, facecolor="white")
    return OUT_FIG


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("run", "stats", "figure"))
    a = ap.parse_args()
    if a.cmd == "run":
        run()
    elif a.cmd == "stats":
        OUT_JSON.write_text(json.dumps(make_stats(dict(np.load(ACC))), indent=1))
        print(OUT_JSON)
    else:
        print(figure())
