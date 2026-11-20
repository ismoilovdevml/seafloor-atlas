"""Seal dives deeper than the chart: SO-ABBA v1.0 vs GEBCO_2026 (see docs/data-contract.md, "Seal dives").

Source: Hindell, McMahon, Jonsen et al. (2026) SO-ABBA: A Southern Ocean Animal-Borne Bathymetry Analysis,
Zenodo doi:10.5281/zenodo.19121676, CC BY 4.0. 4,492,019 dives by 1,394 southern elephant, Weddell and
crabeater seals (CTD-SRDL tags), each with a state-space-model location and its standard errors.

Per dive (flag != 0 only, the authors' "reliable depth" filter, see their MATLAB_seal_read.m):
* `max_dep`  = maximum dive depth (m, positive down) recorded by the tag's pressure sensor;
* chart depth at the point = GEBCO_2026 15" bilinear;
* chart depth within the location uncertainty = the DEEPEST GEBCO_2026 15" cell in a box of half-width
  K_SIGMA * max(x_se, y_se) around the location (the box contains the 1-sigma error ellipse; K_SIGMA = 1 matches
  the authors' own `ellipse_elev_deepest` column best, see K_SIGMA);
* excess = max_dep - deepest chart depth within the uncertainty. excess > 20 m = the seal went deeper than
  the seafloor can be anywhere it plausibly was: the chart is too shallow there.
This mirrors the paper's own test (dfb = max_dep + ellipse_elev_deepest against IBCSO v2); the IBCSO-based
share is recomputed from their columns as a check of our reading.

Outputs
  web/public/data/seals.geojson   0.1 deg bins (Points at bin centres), see the data contract
  data/derived/seals_stats.json
  figures/fig8_seals.png
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import rasterio
from rasterio.windows import Window
from scipy.ndimage import minimum_filter1d

ROOT = Path(__file__).resolve().parents[1]
PARQUET = ROOT / "data/raw/so_abba/SO-ABBA-v1.0.parquet"
GEBCO15 = ROOT / "data/raw/gebco_2026/GEBCO_2026_15s.tif"
TID15 = ROOT / "data/raw/gebco_2026/gebco_2026_tid.tif"
OUT_JSON = ROOT / "web/public/data/seals.geojson"
OUT_COV = ROOT / "web/public/data/seals-coverage.geojson"
STATS = ROOT / "data/derived/seals_stats.json"
CACHE = ROOT / "data/derived/seals_dives.npz"
FIG = ROOT / "figures/fig8_seals.png"

THRESH = 20.0        # m: deeper than the chart by more than this (the paper's threshold)
K_SIGMA = 1.0        # half-width of the search box in location standard errors. 1 reproduces the authors'
                     # ellipse_elev_deepest best (checked on 200k dives where GEBCO = IBCSO at the point: median
                     # difference 2 m, 81 % within 20 m; 0.5 / 1.5 / 2 / 3 sigma: 12 / -4 / -14 / -33 m)
K_SENS = (2.0,)      # also report the share for these wider boxes (sensitivity)
R_MAX_KM = 20.0      # cap on the search radius (a handful of dives have huge location errors)
BIN = 0.1            # deg, aggregation bins
CELL_KM = 6371.0072 * math.radians(1 / 240)   # 15" in km along a meridian (0.463 km)
CITATION = ("Hindell, M., McMahon, C., Jonsen, I., Harcourt, R., Guinet, C., Picard, B., Coleman, R., Padman, L., "
            "Fedak, M., Blight, C., Costa, D. P., Bester, M., Bornemann, H., Charrassin, J.-B., Labrousse, S., "
            "Campagna, C., Campagna, J., Boehme, L., Lee, W. Y., Kokubun, N., Takahashi, A., Muelbert, M. M. C., "
            "Lowther, A., McCormack, F., Ribeiro Santos, N., Post, A., Holland, M., Wege, M. & Raymond, B. (2026) "
            "SO-ABBA: A Southern Ocean Animal-Borne Bathymetry Analysis (v1.0). Zenodo. doi:10.5281/zenodo.19121676")
ATTRIBUTION = ("Seal dives: SO-ABBA v1.0 (Hindell, McMahon, Jonsen et al. 2026, doi:10.5281/zenodo.19121676), "
               "CC BY 4.0; compared with GEBCO_2026")
COLS = ["date", "max_dep", "flag", "lon", "lat", "x_se", "y_se", "pt_elevation", "ibcso_source_tid",
        "ellipse_elev_deepest", "ellipse_any_multibeam", "unittype"]


def load_dives() -> dict[str, np.ndarray]:
    t = pq.read_table(PARQUET, columns=COLS)
    d = {c: t[c].to_numpy(zero_copy_only=False) for c in COLS}
    n_all = d["flag"].size
    keep = d["flag"] == 1                       # flag 0 = unreliable depth (authors' filter)
    d = {k: v[keep] for k, v in d.items()}
    d["lon"] = ((d["lon"] + 180.0) % 360.0) - 180.0
    d["n_rows"] = np.array(n_all)
    return d


def gebco_band(lat_min: float, lat_max: float, margin_deg: float):
    """GEBCO_2026 15" elevation (Int16) for a latitude band, full longitude. Returns (array, row0, transform)."""
    with rasterio.open(GEBCO15) as s:
        T = s.transform
        r0 = max(int(math.floor((T.f - (lat_max + margin_deg)) / -T.e)), 0)
        r1 = min(int(math.ceil((T.f - (lat_min - margin_deg)) / -T.e)), s.height)
        a = s.read(1, window=Window(0, r0, s.width, r1 - r0))
        assert s.nodata is None or not (a == s.nodata).any(), "GEBCO nodata in band"
    return a, r0, T


def tid_at(rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    with rasterio.open(TID15) as s:
        r0, r1 = int(rows.min()), int(rows.max()) + 1
        a = s.read(1, window=Window(0, r0, s.width, r1 - r0))
    return a[rows - r0, cols]


def bilinear(E: np.ndarray, r0: int, T, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    fi = (T.f - lat) / -T.e - 0.5 - r0
    fj = (lon - T.c) / T.a - 0.5
    i0 = np.floor(fi).astype(np.int64)
    j0 = np.floor(fj).astype(np.int64)
    wi, wj = fi - i0, fj - j0
    W = E.shape[1]
    j0w, j1w = j0 % W, (j0 + 1) % W
    e = E.astype(np.float64)
    top = e[i0, j0w] * (1 - wj) + e[i0, j1w] * wj
    bot = e[i0 + 1, j0w] * (1 - wj) + e[i0 + 1, j1w] * wj
    return top * (1 - wi) + bot * wi


QUANT = np.array([0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128,
                  160, 192, 224, 256])
QUANT_STEP = 64      # beyond the ladder: round up to a multiple of this


def quantize_cells(cells: np.ndarray) -> np.ndarray:
    """Round half-widths (in cells) UP to the QUANT ladder, so few distinct filter sizes are needed.

    Values above QUANT[-1] (possible for x near the pole, where cos(lat) is small) round up to a multiple of
    QUANT_STEP instead of indexing past the end of QUANT. The result is never smaller than the input.
    """
    c = np.ceil(np.asarray(cells, dtype=np.float64))
    i = np.searchsorted(QUANT, c)
    big = i >= QUANT.size
    out = QUANT[np.minimum(i, QUANT.size - 1)].astype(np.int64)
    out[big] = (np.ceil(c[big] / QUANT_STEP) * QUANT_STEP).astype(np.int64)
    return out


def deepest_within(E: np.ndarray, r0: int, T, lat: np.ndarray, lon: np.ndarray, r_km: np.ndarray) -> np.ndarray:
    """Minimum GEBCO elevation (= deepest seafloor) in a box of half-width r_km around each point.

    Half-widths are converted to 15" cells (rows: r / 0.463 km, columns: r / (0.463 km * cos lat)) and
    rounded UP to the QUANT ladder, so the box always contains the circle of radius r_km.
    Computed with separable 1-D minimum filters per (rx, ry) pair, in 1-degree latitude chunks.
    """
    ci = np.floor((T.f - lat) / -T.e).astype(np.int64) - r0           # containing 15" cell
    cj = np.floor((lon - T.c) / T.a).astype(np.int64) % E.shape[1]
    ry = quantize_cells(r_km / CELL_KM)
    rx = np.minimum(quantize_cells(r_km / (CELL_KM * np.cos(np.radians(lat)))), E.shape[1] // 2)
    out = np.empty(lat.size, dtype=np.float64)
    chunk = 240
    for c0 in range(0, E.shape[0], chunk):
        sel = np.nonzero((ci >= c0) & (ci < c0 + chunk))[0]
        if sel.size == 0:
            continue
        mrg = int(ry[sel].max())
        a0, a1 = max(c0 - mrg, 0), min(c0 + chunk + mrg, E.shape[0])
        sub = E[a0:a1]
        for x in np.unique(rx[sel]):
            sx = sel[rx[sel] == x]
            X = minimum_filter1d(sub, 2 * int(x) + 1, axis=1, mode="wrap") if x else sub
            for y in np.unique(ry[sx]):
                sy = sx[ry[sx] == y]
                Y = minimum_filter1d(X, 2 * int(y) + 1, axis=0, mode="nearest") if y else X
                out[sy] = Y[ci[sy] - a0, cj[sy]]
    return out


def share(m: np.ndarray, base: np.ndarray | None = None) -> float:
    b = np.ones_like(m, bool) if base is None else base
    return round(float((m & b).sum() / max(b.sum(), 1)), 4)


def analyse(k_sigma: float) -> dict:
    d = load_dives()
    n = d["lat"].size
    print(f"dives: {int(d['n_rows'])} rows, {n} with flag == 1", flush=True)
    E, r0, T = gebco_band(float(d["lat"].min()), float(d["lat"].max()), margin_deg=0.25)
    print(f"GEBCO band {E.shape} from row {r0}", flush=True)
    el_pt = bilinear(E, r0, T, d["lat"], d["lon"])
    se_km = np.maximum(d["x_se"], d["y_se"]) / 1000.0
    r_km = np.minimum(k_sigma * se_km, R_MAX_KM)
    el_box = deepest_within(E, r0, T, d["lat"], d["lon"], r_km)
    rows = np.floor((T.f - d["lat"]) / -T.e).astype(np.int64)
    cols = np.floor((d["lon"] - T.c) / T.a).astype(np.int64) % E.shape[1]
    del E
    tid = tid_at(rows, cols)
    np.savez_compressed(CACHE, lat=d["lat"].astype(np.float32), lon=d["lon"].astype(np.float32),
                        max_dep=d["max_dep"].astype(np.float32), el_pt=el_pt.astype(np.float32),
                        el_box=el_box.astype(np.float32), tid=tid, se_km=se_km.astype(np.float32),
                        ibcso_pt=d["pt_elevation"].astype(np.float32),
                        ibcso_ell=d["ellipse_elev_deepest"].astype(np.float32))
    sens = {}
    for k in K_SENS:
        print(f"sensitivity box {k:g} sigma", flush=True)
        E, r0, T = gebco_band(float(d["lat"].min()), float(d["lat"].max()), margin_deg=0.25)
        eb = deepest_within(E, r0, T, d["lat"], d["lon"], np.minimum(k * se_km, R_MAX_KM))
        del E
        ex = d["max_dep"] + eb
        sens[f"{k:g}"] = {"gt20": share(ex > THRESH), "gt200": share(ex > 200)}
    return d | {"el_pt": el_pt, "el_box": el_box, "tid": tid, "se_km": se_km, "r_km": r_km, "sens": sens}


def stats_of(v: dict, k_sigma: float) -> dict:
    md = v["max_dep"]
    ex_pt = md + v["el_pt"]                  # > 0: dive deeper than the chart at the point
    ex_box = md + v["el_box"]                # > 0: deeper than the deepest chart cell within the uncertainty
    ib_pt = md + v["pt_elevation"].astype(np.float64)
    ib_ell = md + v["ellipse_elev_deepest"]
    land = v["el_pt"] >= 0
    meas = (v["tid"] >= 10) & (v["tid"] <= 17)
    depth = -v["el_pt"]
    n = md.size
    ok_ib = np.isfinite(ib_pt)
    ok_ie = np.isfinite(ib_ell)
    dgi = v["el_pt"] - v["pt_elevation"]
    out = {
        "source": CITATION,
        "rows_in_file": int(v["n_rows"]), "dives_flag1": int(n),
        "units_unittype": int(np.unique(v["unittype"]).size),
        "date_range": [str(v["date"].min()), str(v["date"].max())],
        "lat_range": [round(float(v["lat"].min()), 2), round(float(v["lat"].max()), 2)],
        "method": {
            "point": "GEBCO_2026 15\" bilinear at the SSM location; excess = max_dep + elevation",
            "within_uncertainty": (f"deepest GEBCO_2026 15\" cell in a box of half-width {k_sigma:g} x "
                                   f"max(x_se, y_se) (capped at {R_MAX_KM:g} km), rounded up to whole cells"),
            "threshold_m": THRESH,
        },
        "location_se_km": {"median": round(float(np.median(v["se_km"])), 2),
                           "mean": round(float(np.mean(v["se_km"])), 2),
                           "p95": round(float(np.percentile(v["se_km"], 95)), 2),
                           "share_capped": share(v["se_km"] * k_sigma > R_MAX_KM)},
        "paper_check_ibcso_v2": {
            "note": "recomputed from the file's own IBCSO v2 columns (pt_elevation, ellipse_elev_deepest); "
                    "the abstract's 8.4 % / 1.3 % match the POINT comparison",
            "point_ge20": share(ib_pt >= THRESH, ok_ib), "point_ge200": share(ib_pt >= 200, ok_ib),
            "ellipse_ge20": share(ib_ell >= THRESH, ok_ie), "ellipse_ge200": share(ib_ell >= 200, ok_ie),
        },
        "gebco_vs_ibcso_at_point": {
            "median_m": round(float(np.nanmedian(dgi)), 1),
            "median_abs_m": round(float(np.nanmedian(np.abs(dgi))), 1),
            "share_abs_gt_20m": share(np.abs(dgi) > 20, np.isfinite(dgi)),
            "share_gebco_deeper_by_gt_20m": share(dgi < -20, np.isfinite(dgi)),
        },
        "gebco2026": {
            "point_gt20": share(ex_pt > THRESH), "point_gt200": share(ex_pt > 200),
            "within_uncertainty_gt20": share(ex_box > THRESH), "within_uncertainty_gt200": share(ex_box > 200),
            "within_uncertainty_gt20_count": int((ex_box > THRESH).sum()),
            "sensitivity_wider_box_sigma": v["sens"],
            "chart_says_land_or_ice_at_point": share(land),
            "within_uncertainty_gt20_excl_land": share(ex_box > THRESH, ~land),
            "within_uncertainty_gt20_where_point_measured": share(ex_box > THRESH, meas),
            "within_uncertainty_gt20_where_point_unmeasured": share(ex_box > THRESH, ~meas & ~land),
            "share_dives_at_measured_cells": share(meas),
            "excess_within_uncertainty_m_of_deeper_dives": {
                q: round(float(np.percentile(ex_box[ex_box > THRESH], p)), 1)
                for q, p in (("median", 50), ("p90", 90), ("p99", 99), ("max", 100))},
        },
        "by_chart_depth": [],
    }
    for lo, hi in ((0, 200), (200, 500), (500, 1000), (1000, 2000), (2000, 12000)):
        m = ~land & (depth >= lo) & (depth < hi)
        out["by_chart_depth"].append({"band_m": [lo, hi], "dives": int(m.sum()),
                                      "within_uncertainty_gt20": share(ex_box > THRESH, m),
                                      "point_gt20": share(ex_pt > THRESH, m)})
    return out, ex_pt, ex_box


def _bins(lat: np.ndarray, lon: np.ndarray, deg: float):
    ib = np.floor((lat + 90.0) / deg).astype(np.int64)
    jb = np.floor((lon + 180.0) / deg).astype(np.int64) % int(round(360 / deg))
    u, inv = np.unique(ib * 100000 + jb, return_inverse=True)
    clat = np.round(-90.0 + (u // 100000 + 0.5) * deg, 3)
    clon = np.round(-180.0 + (u % 100000 + 0.5) * deg, 3)
    return inv, u.size, clat, clon


def bin_counts(n: np.ndarray, keep: np.ndarray) -> dict:
    """Bin and dive counts for the seals.geojson metadata.

    dives_in_file is ALL reliable (flag == 1) dives in the SO-ABBA file, i.e. the denominator of the headline
    share; the viewer (web/src/certainty.ts) divides the summed `d` by it. dives_in_bins is the sum of `n`
    over the bins actually written (only bins with >= 1 deeper dive), so it is smaller.
    """
    return {"bins": int(keep.size), "bins_all": int(n.size),
            "dives_in_file": int(n.sum()), "dives_in_bins": int(n[keep].sum())}


def _meta(extra: dict) -> dict:
    return {"source": "SO-ABBA v1.0 (Zenodo 19121676), dives with flag == 1, vs GEBCO_2026 15\"",
            "citation": CITATION, "licence": "CC BY 4.0 (SO-ABBA); OGL v3 (GEBCO_2026)",
            "attribution": ATTRIBUTION, "threshold_m": THRESH, "k_sigma": K_SIGMA, "r_max_km": R_MAX_KM, **extra}


def aggregate(v: dict, ex_box: np.ndarray, ex_pt: np.ndarray) -> tuple[dict, dict, dict]:
    """seals.geojson: 0.1 deg bins with >= 1 dive deeper than the chart beyond the location uncertainty.
    seals-coverage.geojson: 0.5 deg bins of all dives (where the seals sampled at all), for context."""
    deeper = ex_box > THRESH
    inv, nb, clat, clon = _bins(v["lat"], v["lon"], BIN)
    n = np.bincount(inv, minlength=nb)
    d = np.bincount(inv, weights=deeper, minlength=nb).astype(int)
    dp = np.bincount(inv, weights=(ex_pt > THRESH), minlength=nb).astype(int)
    xmax = np.full(nb, -np.inf)
    np.maximum.at(xmax, inv, ex_box)
    dmax = np.zeros(nb)
    np.maximum.at(dmax, inv, v["max_dep"])
    chart = np.bincount(inv, weights=-v["el_pt"], minlength=nb) / n
    keep = np.flatnonzero(d > 0)
    keep = keep[np.argsort(xmax[keep], kind="stable")]       # largest excess drawn last (on top)
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(clon[k]), float(clat[k])]},
              "properties": {"n": int(n[k]), "d": int(d[k]), "dp": int(dp[k]), "x": int(round(xmax[k])),
                             "md": int(round(dmax[k])), "cd": int(round(chart[k]))}} for k in keep]
    gj = {"type": "FeatureCollection", "metadata": _meta({
        "bin_deg": BIN,
        "selection": "only bins with at least one dive deeper than the chart beyond the location uncertainty",
        "properties": {
            "n": "dives in the bin",
            "d": f"dives deeper than the deepest GEBCO_2026 15\" cell within {K_SIGMA:g} x location s.e. by > {THRESH:g} m",
            "dp": f"dives deeper than GEBCO_2026 at the dive location (bilinear) by > {THRESH:g} m",
            "x": "largest excess in the bin (m) = max_dep minus the deepest chart depth within the uncertainty",
            "md": "deepest dive in the bin (m)",
            "cd": "mean GEBCO_2026 depth at the dive locations (m, positive down; negative = chart says land/ice)"},
        **bin_counts(n, keep)}), "features": feats}
    # context layer: where the seals dived at all
    inv2, nb2, clat2, clon2 = _bins(v["lat"], v["lon"], 0.5)
    n2 = np.bincount(inv2, minlength=nb2)
    d2 = np.bincount(inv2, weights=deeper, minlength=nb2).astype(int)
    feats2 = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(clon2[k]), float(clat2[k])]},
               "properties": {"n": int(n2[k]), "d": int(d2[k])}} for k in range(nb2)]
    cov = {"type": "FeatureCollection", "metadata": _meta({
        "bin_deg": 0.5, "selection": "every 0.5 deg bin with at least one dive",
        "properties": {"n": "dives in the bin", "d": "of which deeper than the chart beyond the location uncertainty"},
        "bins": int(nb2)}), "features": feats2}
    info = {"bins_0p1deg_all": int(nb), "bins_0p1deg_with_deeper": int(keep.size),
            "bins_0p1deg_with_deeper_and_ge5_dives": int(((d > 0) & (n >= 5)).sum()), "bins_0p5deg_all": int(nb2)}
    return gj, cov, info


def figure(v: dict, ex_box: np.ndarray, ex_pt: np.ndarray, st: dict) -> Path:
    import cartopy.crs as ccrs
    import cartopy.feature as cfeature
    import cmocean
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.path as mpath
    import matplotlib.pyplot as plt
    from matplotlib.colors import BoundaryNorm, ListedColormap

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False,
                         "axes.spines.right": False, "savefig.dpi": 200, "savefig.bbox": "tight"})
    # background: GEBCO 1' south of 45 S, 3' blocks
    with rasterio.open(ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif") as s:
        r0 = int((90 - (-45)) * 60)
        z = s.read(1, window=Window(0, r0, s.width, s.height - r0)).astype(np.float32)
    k = 3
    z = z[: z.shape[0] // k * k].reshape(z.shape[0] // k, k, z.shape[1] // k, k).mean(axis=(1, 3))
    # 0.25 deg bins for the map: share of dives deeper than the chart (within the uncertainty)
    B = 0.25
    ib = np.floor((v["lat"] + 90) / B).astype(int)
    jb = np.floor((v["lon"] + 180) / B).astype(int) % int(360 / B)
    H, W = int(180 / B), int(360 / B)
    n = np.bincount(ib * W + jb, minlength=H * W).reshape(H, W)
    dd = np.bincount(ib * W + jb, weights=(ex_box > THRESH), minlength=H * W).reshape(H, W)
    with np.errstate(invalid="ignore"):
        frac = np.where(n >= 3, dd / n, np.nan)
    rows = slice(0, int((90 - 45) / B))       # 90 S .. 45 S

    fig = plt.figure(figsize=(12, 7.6))
    gs = fig.add_gridspec(2, 2, width_ratios=[1.45, 1], height_ratios=[1, 1], wspace=0.28, hspace=0.45)
    ax = fig.add_subplot(gs[:, 0], projection=ccrs.SouthPolarStereo())
    ax.set_extent([-180, 180, -90, -47], ccrs.PlateCarree())
    theta = np.linspace(0, 2 * np.pi, 200)
    ax.set_boundary(mpath.Path(np.c_[np.sin(theta), np.cos(theta)] * 0.5 + 0.5), transform=ax.transAxes)
    sea = np.ma.masked_where(z >= 0, z)
    ax.imshow(sea, extent=[-180, 180, -90, -45], transform=ccrs.PlateCarree(), origin="upper",
              cmap=plt.get_cmap("Greys_r"), vmin=-7000, vmax=1500, regrid_shape=1800, interpolation="bilinear")
    land = np.ma.masked_where(z < 0, np.ones_like(z))
    ax.imshow(land, extent=[-180, 180, -90, -45], transform=ccrs.PlateCarree(), origin="upper",
              cmap=ListedColormap(["#f2efe9"]), regrid_shape=1800)
    bounds = [0, 0.01, 0.05, 0.1, 0.2, 0.4, 1.0001]
    cols = ["#9ecae1", "#fee391", "#fec44f", "#fe9929", "#d95f0e", "#993404"]
    cmap = ListedColormap(cols)
    sub = frac[rows][::-1]                                   # north-up: row 0 = 45 S
    cls = np.digitize(sub, bounds[1:-1])
    rgba = np.zeros(sub.shape + (4,))
    for i, c in enumerate(cols):
        m = np.isfinite(sub) & (cls == i)
        rgba[m] = matplotlib.colors.to_rgba(c, alpha=0.75 if i == 0 else 1.0)
    ax.imshow(rgba, extent=[-180, 180, -90, -45], transform=ccrs.PlateCarree(), origin="upper",
              regrid_shape=1800, interpolation="nearest")
    ax.gridlines(color="0.6", lw=0.3, ylocs=[-80, -70, -60, -50], xlocs=range(-180, 180, 45))
    sm = plt.cm.ScalarMappable(cmap=cmap, norm=BoundaryNorm(bounds, cmap.N))
    cb = fig.colorbar(sm, ax=ax, orientation="horizontal", fraction=0.04, pad=0.03, shrink=0.8)
    cb.set_ticks(bounds, labels=["0", "1", "5", "10", "20", "40", "100"])
    cb.set_label(f"% of dives deeper than the chart by > {THRESH:g} m (0.25° bins, ≥ 3 dives)")
    g = st["gebco2026"]
    ax.set_title(f"{g['within_uncertainty_gt20_count']:,} seal dives went deeper than GEBCO_2026 allows\n"
                 f"({100 * g['within_uncertainty_gt20']:.1f}% of {st['dives_flag1']:,} dives, beyond the location "
                 "uncertainty)", fontsize=11.5)

    a1 = fig.add_subplot(gs[0, 1])
    bins = np.arange(-1000, 1001, 10)
    for ex, lab, col in ((ex_pt, "chart at the dive location", "0.55"),
                         (ex_box, "deepest chart cell within the uncertainty", "#d95f0e")):
        h, _ = np.histogram(np.clip(ex, -995, 995), bins=bins)
        a1.step(bins[:-1], h, where="post", color=col, lw=1.4, label=lab)
    a1.axvline(THRESH, color="k", lw=0.8, ls="--")
    a1.text(THRESH + 15, 0.55, f"+{THRESH:g} m", transform=a1.get_xaxis_transform(), fontsize=8)
    a1.set_yscale("log")
    a1.set_xlim(-1000, 1000)
    a1.set_xlabel("dive depth − chart depth (m); > 0 = below the chart\n(values beyond ±1000 m piled in the end bins)",
                  fontsize=9)
    a1.set_ylabel("dives per 10 m")
    a1.set_title("How far below the chart?", fontsize=11)
    a1.legend(frameon=False, fontsize=7.5, loc="upper left", bbox_to_anchor=(0.03, 1.0))

    a2 = fig.add_subplot(gs[1, 1])
    rows_ = st["by_chart_depth"]
    lab = [f"{r['band_m'][0]}–{r['band_m'][1]}" if r["band_m"][1] < 12000 else f"> {r['band_m'][0]}" for r in rows_]
    y = np.arange(len(rows_))
    a2.barh(y - 0.2, [100 * r["point_gt20"] for r in rows_], height=0.38, color="0.6", label="at the location")
    a2.barh(y + 0.2, [100 * r["within_uncertainty_gt20"] for r in rows_], height=0.38, color="#d95f0e",
            label="beyond the uncertainty")
    for i, r in enumerate(rows_):
        a2.text(100 * r["point_gt20"] + 0.3, i - 0.2, f"{r['dives'] / 1e6:.2f} M dives", va="center", fontsize=7,
                color="0.3")
    a2.set_yticks(y, lab)
    a2.invert_yaxis()
    a2.set_xlabel(f"% of dives deeper than the chart by > {THRESH:g} m")
    a2.set_ylabel("GEBCO_2026 depth (m)")
    a2.set_title("Where the chart is too shallow, by charted depth", fontsize=11)
    a2.legend(frameon=False, fontsize=7.5, loc="lower right")
    pc_ = st["paper_check_ibcso_v2"]
    fig.text(0.5, 0.02, f"Same test against IBCSO v2 with the dataset's own columns: {100 * pc_['point_ge20']:.1f}% at the "
             f"location (paper: 8.4%), {100 * pc_['ellipse_ge20']:.1f}% beyond the location ellipse. Uncertainty = "
             f"box of ±{K_SIGMA:g} × location s.e. (median s.e. {st['location_se_km']['median']:.1f} km).",
             ha="center", fontsize=8, color="0.25")
    fig.text(0.5, -0.005, "Data: Hindell, McMahon, Jonsen et al. (2026) SO-ABBA v1.0, doi:10.5281/zenodo.19121676 "
             "(CC BY 4.0); GEBCO Compilation Group (2026) GEBCO_2026 Grid, doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa",
             ha="center", fontsize=7, color="0.35")
    FIG.parent.mkdir(exist_ok=True)
    fig.savefig(FIG)
    plt.close(fig)
    return FIG


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--k-sigma", type=float, default=K_SIGMA)
    ap.add_argument("--outputs-only", action="store_true",
                    help="rebuild the GeoJSON files and fig8 from data/derived/seals_dives.npz + seals_stats.json")
    args = ap.parse_args()
    if args.outputs_only:
        c = np.load(CACHE)
        v = {k: c[k].astype(np.float64) for k in ("lat", "lon", "max_dep", "el_pt", "el_box")}
        st = json.loads(STATS.read_text())
        ex_pt, ex_box = v["max_dep"] + v["el_pt"], v["max_dep"] + v["el_box"]
    else:
        v = analyse(args.k_sigma)
        st, ex_pt, ex_box = stats_of(v, args.k_sigma)
    gj, cov, binfo = aggregate(v, ex_box, ex_pt)
    st.pop("bins_0p1deg", None)
    st["bins"] = binfo
    OUT_JSON.write_text(json.dumps(gj, separators=(",", ":")))
    OUT_COV.write_text(json.dumps(cov, separators=(",", ":")))
    st["geojson_bytes"] = {OUT_JSON.name: OUT_JSON.stat().st_size, OUT_COV.name: OUT_COV.stat().st_size}
    STATS.write_text(json.dumps(st, indent=1))
    print(json.dumps({k: st[k] for k in ("gebco2026", "bins", "geojson_bytes")}, indent=1))
    print(figure(v, ex_box, ex_pt, st))


if __name__ == "__main__":
    main()
