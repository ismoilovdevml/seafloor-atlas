"""Unmeasured seafloor under ship traffic: where vessels already sail over seafloor that GEBCO does not have.

Question. Crowdsourced bathymetry (IHO CSB) collects depths from the echo sounders of ordinary vessels. How much of
the seafloor that is not coded as measured in GEBCO_2026 lies under recorded ship tracks, how much under heavy
traffic, and how much of that is shallow enough for a navigational echo sounder?

Inputs (all on disk; `unit-check` streams a few 5 x 5 deg windows out of the source zip, nothing is downloaded)
  data/derived/shipping_counts_0p02deg.tif   4 x 4 block SUMS of the source raster on a 0.02 deg grid
                                             (pipeline/shipping.py; sum checked equal to the source's own statistics)
  data/raw/shipping/shipdensity_global.zip   World Bank / IMF Global Shipping Traffic Density, all vessel types,
                                             Jan 2015 - Feb 2021, 0.005 deg, 85 N - 85 S (Cerdeiro et al. 2020; CC BY 4.0)
  data/derived/history_ocean_1arcmin.npy     ocean 15" cells per 1' cell (0..16)
  data/derived/history_frac_latest_1arcmin.npy  of those, coded TID 10-17 in GEBCO_2026 (0..16)
  data/derived/world_ocean_1arcmin.npy       world ocean without inland basins (pipeline/distance.py)
  data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif   depth class of the 1' cell
  dataset/build/regions_1arcmin.npy          ocean basin and EEZ / high seas code (pipeline/build_dataset.py)

Unit of the shipping raster. The World Bank catalogue (dataset 0037580) says the cells hold "the total number of AIS
positions that have been reported by ships in each grid cell", from "IMF's analysis of hourly AIS positions". The
values do not behave like counts (`unit-check`, data/derived/shipping_unit_check.json):
  * the raster sums to 6.56e14; the IMF AIS set behind it holds "over one billion messages from over 50,000
    distinct ships", hourly (Cerdeiro et al. 2020, IMF WP/20/57, section II), i.e. ~1e9;
  * in empty ocean, single ships leave isolated 0.005 deg cells about 13 km apart (one hourly fix at ~7 kn) whose
    values are 10^2 - 10^6.6 (median ~10^5.3), not 1;
  * the non-zero cells fall into two populations with an empty gap between ~10 and ~100: a diffuse background of
    values 1 - ~9 that is not arranged along tracks, and the track values.
So each recorded position carries an undocumented weight that varies over four orders of magnitude; the raster is a
relative intensity, and its absolute unit cannot be recovered from the published documentation. It is used here
only through thresholds and ranks, reported in raster units ("raster value per km2 per year" = 0.02 deg block sum /
cell area / (74/12) years, as in pipeline/shipping.py).

Classes. At the 0.02 deg level the background and the track values stay separate (no ocean area between density
1 and ~100). Density >= 100 is therefore "at least one recorded vessel position (track value) in the 0.02 deg cell
in six years" -- it is NOT "dense traffic": a single position of median weight in a 4 km2 cell already gives ~8,000.
Higher thresholds (1e4, 1e5, 1e6) rank traffic intensity; at the median position weight they correspond very roughly
to ~1, ~10 and ~100 position-equivalents per 0.02 deg cell in six years (5-95 % range of the weight: a factor ~20
either way), so they are labelled by raster value, not by vessels. "Heavy traffic" in the summary = density >= 1e6,
the busiest 5.5 % of the world ocean.
Unmeasured area of a 1' cell = (ocean cells - measured cells) x exact 15" cell area.

  python pipeline/shipping_gap.py unit-check  -> data/derived/shipping_unit_check.json (~1 min)
  python pipeline/shipping_gap.py run         -> data/derived/shipping_gap.json
  python pipeline/shipping_gap.py figure      -> figures/fig_shipping_gap.png
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history  # noqa: E402

ROOT = history.ROOT
DERIVED = history.DERIVED
COUNTS = DERIVED / "shipping_counts_0p02deg.tif"
REGIONS = ROOT / "dataset/build/regions_1arcmin.npy"
REGION_LABELS = ROOT / "dataset/build/regions_labels.json"
OUT_JSON = DERIVED / "shipping_gap.json"
OUT_FIG = ROOT / "figures/fig_shipping_gap.png"
OUT_GRID = DERIVED / "shipping_gap_8arcmin.npz"
H1, W1 = history.H1, history.W1
R_KM = history.R_KM
YEARS = 74 / 12
THRESHOLDS = (100.0, 1e4, 1e5, 1e6)                   # density classes in raster units per km2 per year
TRACK = 100.0                                        # >= this: at least one recorded position (track value)
HEAVY = 1e6                                          # >= this: heaviest-traffic class
DEPTH_EDGES = (0, 200, 1000, 3000, 12000)            # metres
DEPTH_LABELS = ("0-200 m", "200-1,000 m", "1,000-3,000 m", "> 3,000 m")
BOX = 10
AGG = 8
ZIP_SRC = f"/vsizip/{ROOT / 'data/raw/shipping/shipdensity_global.zip'}/shipdensity_global.tif"
OUT_UNIT = DERIVED / "shipping_unit_check.json"
# remote 5 x 5 deg windows (lon0, lat0, lon1, lat1) with few ships: S Pacific, S Indian, S Atlantic, Southern Ocean
REMOTE_BOXES = ((-120, -35, -115, -30), (-140, -45, -135, -40), (80, -40, 85, -35), (-20, -45, -15, -40),
                (-130, -20, -125, -15), (160, -50, 165, -45), (-100, -55, -95, -50))
TRACK_RAW = 100                                      # raw 0.005 deg value: background is 1..~9, track values >= ~100
IMF_MESSAGES = 1e9                                   # "over one billion messages" (Cerdeiro et al. 2020, section II)


def density_on_1arcmin(counts: np.ndarray, transform) -> np.ndarray:
    """raster value per km2 per year of the 0.02 deg cell under every 1' cell centre; NaN outside the shipping grid.

    counts are 4 x 4 block SUMS (pipeline/shipping.py), so dividing by the 0.02 deg cell area gives an area density
    that can be sampled at any point without further scaling."""
    lat = 90 - (np.arange(H1) + 0.5) / 60
    lon = -180 + (np.arange(W1) + 0.5) / 60
    step = transform.a
    rr = np.floor((transform.f - lat) / step).astype(np.int64)
    cc = np.floor((lon - transform.c) / step).astype(np.int64)
    inside = (rr >= 0) & (rr < counts.shape[0])
    rrc = np.clip(rr, 0, counts.shape[0] - 1)
    d = np.radians(step)
    top = np.radians(transform.f - rrc * step)
    cell_km2 = (R_KM ** 2) * d * (np.sin(top) - np.sin(top - d))
    out = counts[rrc][:, np.clip(cc, 0, counts.shape[1] - 1)] / (cell_km2[:, None] * YEARS)
    out[~inside] = np.nan
    return out.astype(np.float32)


def class_names() -> list[str]:
    return (["no value", "background only (< 1e2)"]
            + [f"1e{int(np.log10(a))}-1e{int(np.log10(b))}" for a, b in zip(THRESHOLDS[:-1], THRESHOLDS[1:])]
            + [f">= 1e{int(np.log10(THRESHOLDS[-1]))}"])


def traffic_class(dens: np.ndarray) -> np.ndarray:
    """0 = no value (0 or NaN), 1 = background (0 < d < 1e2), 2.. = [1e2, 1e4), [1e4, 1e5), [1e5, 1e6), >= 1e6"""
    d = np.nan_to_num(np.asarray(dens, dtype=np.float64), nan=0.0)
    return np.where(d > 0, 1 + np.digitize(d, THRESHOLDS), 0)


def isolated_track_values(a: np.ndarray, raw_min: int = TRACK_RAW, radius: int = 2) -> np.ndarray:
    """raw values of track cells (>= raw_min) with no other track cell within `radius` cells (single ship fixes)"""
    from scipy import ndimage
    t = a >= raw_min
    k = 2 * radius + 1
    nb = ndimage.convolve(t.astype(np.int32), np.ones((k, k), np.int32), mode="constant") - 1
    return a[t & (nb == 0)]


def unit_check() -> dict:
    """evidence that the raster values are weighted, not counts of hourly positions"""
    import rasterio
    from rasterio.windows import from_bounds

    with rasterio.open(ZIP_SRC) as s:
        stats = s.tags(1)
        nodata = s.nodata
        mean, ncell = float(stats["STATISTICS_MEAN"]), s.width * s.height
        boxes, iso, raw = [], [], []
        for b in REMOTE_BOXES:
            a = s.read(1, window=from_bounds(*b, transform=s.transform).round_offsets().round_lengths()).astype(np.int64)
            if nodata is not None:
                a[a == nodata] = 0
            v = isolated_track_values(a)
            iso.append(v)
            raw.append(a[a > 0])
            boxes.append({"box_lon0_lat0_lon1_lat1": list(b), "nonzero_cells": int((a > 0).sum()),
                          "background_cells_1_to_9": int(((a > 0) & (a < 10)).sum()),
                          "cells_10_to_99": int(((a >= 10) & (a < TRACK_RAW)).sum()),
                          "track_cells": int((a >= TRACK_RAW).sum()), "isolated_track_cells": int(v.size),
                          "isolated_log10_median": float(np.log10(np.median(v))) if v.size else None})
    with rasterio.open(COUNTS) as s:
        agg_sum = float(s.read(1).sum(dtype=np.float64))
    iso, raw = np.concatenate(iso), np.concatenate(raw)
    h, e = np.histogram(np.log10(raw), bins=np.arange(0, 7.01, 0.25))
    res = {
        "documented_unit": "total number of AIS positions reported by ships in each 0.005 deg cell, from hourly AIS positions "
                           "Jan 2015 - Feb 2021 (World Bank Data Catalog dataset 0037580)",
        "source_statistics_mean": mean, "source_cells": ncell, "source_sum_from_statistics": mean * ncell,
        "aggregated_0p02deg_sum": agg_sum,
        "aggregated_equals_source_rel_diff": abs(agg_sum - mean * ncell) / (mean * ncell),
        "imf_ais_messages_order": IMF_MESSAGES,
        "sum_over_imf_messages": mean * ncell / IMF_MESSAGES,
        "remote_boxes": boxes,
        "isolated_track_values": {"n": int(iso.size),
                                  "log10_percentiles_5_25_50_75_95": np.percentile(np.log10(iso), [5, 25, 50, 75, 95]).tolist()},
        "remote_raw_log10_hist": {"edges": e.tolist(), "cells": h.tolist()},
        "conclusion": "values are not counts: one hourly fix of one ship carries 10^2-10^6.6 (median ~10^5.3) and the raster "
                      "sums to ~6.6e5 times the IMF message count; the absolute unit is undocumented, use as relative intensity",
    }
    OUT_UNIT.write_text(json.dumps(res, indent=1))
    print(json.dumps({k: v for k, v in res.items() if k not in ("remote_boxes", "remote_raw_log10_hist")}, indent=1))
    return res


def summarise(dens, unmeas_km2, meas_km2, depth_m, zone, goas, labels) -> dict:
    """all inputs are flat arrays over world-ocean 1' cells inside the shipping grid"""
    tot_un, tot_me = float(unmeas_km2.sum()), float(meas_km2.sum())
    res = {"area_km2": {"unmeasured": tot_un, "measured": tot_me}}
    res["unmeasured_with_any_value"] = float(unmeas_km2[dens > 0].sum() / tot_un)
    res["unmeasured_share_at_density_ge"] = {f"{t:.0e}": float(unmeas_km2[dens >= t].sum() / tot_un) for t in THRESHOLDS}
    res["unmeasured_km2_at_density_ge"] = {f"{t:.0e}": float(unmeas_km2[dens >= t].sum()) for t in THRESHOLDS}
    res["ocean_share_at_density_ge"] = {f"{t:.0e}": float((unmeas_km2 + meas_km2)[dens >= t].sum() / (tot_un + tot_me))
                                        for t in THRESHOLDS}
    # is busy seafloor better measured?
    cls = traffic_class(dens)
    res["measured_share_by_traffic"] = {}
    for i, nme in enumerate(class_names()):
        s = cls == i
        a = float(unmeas_km2[s].sum() + meas_km2[s].sum())
        res["measured_share_by_traffic"][nme] = {"ocean_km2": a, "measured_share": float(meas_km2[s].sum() / a) if a else None}
    masks = {"track": dens >= TRACK, "heavy": dens >= HEAVY}
    dcl = np.clip(np.digitize(depth_m, DEPTH_EDGES) - 1, 0, len(DEPTH_LABELS) - 1)

    def split(s) -> dict:
        un = float(unmeas_km2[s].sum())
        out = {"unmeasured_km2": un, "measured_share": float(meas_km2[s].sum() / (un + meas_km2[s].sum()))
               if (un + meas_km2[s].sum()) > 0 else None}
        for k, m in masks.items():
            out[f"unmeasured_under_{k}_km2"] = float(unmeas_km2[s & m].sum())
            out[f"share_of_unmeasured_under_{k}"] = float(unmeas_km2[s & m].sum() / un) if un else None
        return out

    res["by_depth"] = {nme: split(dcl == i) for i, nme in enumerate(DEPTH_LABELS)}
    res["by_zone"] = {zn: split(zone == zi) for zi, zn in enumerate(labels["zones"]) if unmeas_km2[zone == zi].sum() > 0}
    res["by_ocean"] = {gn: split(goas == gi) for gi, gn in enumerate(labels["goas"]) if unmeas_km2[goas == gi].sum() > 1e4}
    for k, m in masks.items():
        tot = float(unmeas_km2[m].sum())
        res[f"unmeasured_under_{k}"] = {
            "km2": tot, "share_of_unmeasured": tot / tot_un,
            "share_0_200m": float(unmeas_km2[m & (dcl == 0)].sum() / tot) if tot else None,
            "share_eez": float(unmeas_km2[m & (zone == labels["zones"].index("eez"))].sum() / tot) if tot else None,
            "share_high_seas": float(unmeas_km2[m & (zone == labels["zones"].index("high_seas"))].sum() / tot) if tot else None,
        }
    return res


def run() -> None:
    import rasterio

    import distance
    with rasterio.open(COUNTS) as s:
        counts, tr = s.read(1), s.transform
    with rasterio.open(history.ELEV) as s:
        elev = s.read(1)
    cnt = np.load(DERIVED / "history_ocean_1arcmin.npy")
    meas = np.load(DERIVED / "history_frac_latest_1arcmin.npy")
    wo = distance.world_ocean(cnt)
    reg = np.load(REGIONS, mmap_mode="r")
    labels = json.loads(REGION_LABELS.read_text())
    dens = density_on_1arcmin(counts, tr)
    raster_sum = counts.sum(dtype=np.float64)
    del counts
    cell15 = distance.cell_area_km2()[:, None] / 16.0
    un_km2 = np.where(wo, (cnt.astype(np.float32) - meas) * cell15, 0).astype(np.float32)
    me_km2 = np.where(wo, meas * cell15, 0).astype(np.float32)
    sel = wo & np.isfinite(dens)
    lg = np.log10(dens[sel & (dens > 0)])
    hh, ee = np.histogram(lg, bins=np.arange(-2, 8.01, 0.5), weights=((cnt * cell15)[sel & (dens > 0)]).astype(np.float64))
    modes = {"log10_bin_edges": ee.tolist(), "ocean_km2": [float(x) for x in hh]}
    res = {
        "definition": "density = 0.02 deg block sum of the World Bank / IMF shipping raster (all vessel types, Jan 2015 - Feb 2021) "
                      "per km2 per year, for the 0.02 deg cell under each 1' cell centre, in RAW RASTER UNITS (the documented unit, "
                      "AIS positions, does not hold; see shipping_unit_check.json). track = density >= 1e2 (at least one recorded "
                      "position in six years); heavy = density >= 1e6 (top intensity class). Unmeasured = ocean 15\" cells not coded "
                      "TID 10-17 in GEBCO_2026; world ocean only (no inland basins), 85 N - 85 S",
        "world_ocean_km2": float((un_km2 + me_km2).sum()),
        "outside_shipping_grid_km2": float((un_km2 + me_km2)[wo & ~np.isfinite(dens)].sum()),
        "depth_labels": list(DEPTH_LABELS), "thresholds": list(THRESHOLDS), "track_threshold": TRACK, "heavy_threshold": HEAVY,
        "raster_sum": float(raster_sum),
        "density_modes": modes,
    }
    if OUT_UNIT.exists():
        u = json.loads(OUT_UNIT.read_text())
        res["unit_check"] = {k: u[k] for k in ("documented_unit", "sum_over_imf_messages", "isolated_track_values", "conclusion")}
    res.update(summarise(dens[sel], un_km2[sel].astype(np.float64), me_km2[sel].astype(np.float64), -elev[sel].astype(np.float32),
                         np.asarray(reg)[sel] % 4, np.asarray(reg)[sel] // 4, labels))
    # where: 10 x 10 degree boxes with the most unmeasured seafloor under heavy traffic
    busy_un = np.where(sel & (dens >= HEAVY), un_km2, 0).astype(np.float64)
    track_un = np.where(sel & (dens >= TRACK), un_km2, 0).astype(np.float64)
    shallow = busy_un * (elev > -200)
    k = 60 * BOX
    box = busy_un.reshape(H1 // k, k, W1 // k, k).sum(axis=(1, 3))
    box_sh = shallow.reshape(H1 // k, k, W1 // k, k).sum(axis=(1, 3))
    top = []
    for j in np.argsort(box, axis=None)[::-1][:12]:
        i, c = divmod(int(j), box.shape[1])
        top.append({"lat": [90 - (i + 1) * BOX, 90 - i * BOX], "lon": [-180 + c * BOX, -180 + (c + 1) * BOX],
                    "unmeasured_under_heavy_km2": round(float(box[i, c])),
                    "of_which_shallower_than_200m_km2": round(float(box_sh[i, c]))})
    res["top_boxes_heavy"] = top
    OUT_JSON.write_text(json.dumps(res, indent=1))
    # figure grid: share of each 8' cell that is unmeasured under heavy traffic / under any track, and unmeasured at all
    area = np.where(wo, cnt * cell15, 0).astype(np.float64)
    agg = lambda x: x.reshape(H1 // AGG, AGG, W1 // AGG, AGG).sum(axis=(1, 3))  # noqa: E731
    a8 = agg(area)
    with np.errstate(invalid="ignore", divide="ignore"):
        np.savez_compressed(OUT_GRID, heavy_unmeasured=(agg(busy_un) / a8).astype(np.float32),
                            track_unmeasured=(agg(track_un) / a8).astype(np.float32),
                            unmeasured=(agg(un_km2.astype(np.float64)) / a8).astype(np.float32))
    print(json.dumps({k_: v for k_, v in res.items() if k_ not in ("by_ocean", "top_boxes_heavy", "density_modes")}, indent=1))
    for t in top:
        print(t)


def figure() -> Path:
    import matplotlib
    matplotlib.use("Agg")
    import cartopy.crs as ccrs
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap

    res = json.loads(OUT_JSON.read_text())
    g = np.load(OUT_GRID)
    grey, sky, orange, verm, blue = "0.6", "#56B4E9", "#E69F00", "#D55E00", "#0072B2"    # Okabe-Ito
    fig = plt.figure(figsize=(13, 9.4), facecolor="white")
    ax = fig.add_axes([0.02, 0.36, 0.96, 0.62], projection=ccrs.EqualEarth(central_longitude=150))
    ax.set_facecolor("white")
    un = g["unmeasured"]
    ext = dict(extent=(-180, 180, -90, 90), origin="upper", transform=ccrs.PlateCarree(), interpolation="nearest")
    ax.imshow(np.where(np.isfinite(un), 1 - un, np.nan), cmap="Greys", vmin=-0.6, vmax=2.2, **ext)
    # categorical overlay: unmeasured under any track (>= 1e2) vs under heavy traffic (>= 1e6), >= 25 % of the 8' cell
    cat = np.full(un.shape, np.nan, dtype=np.float32)
    cat[g["track_unmeasured"] >= 0.25] = 0
    cat[g["heavy_unmeasured"] >= 0.25] = 1
    ax.imshow(cat, cmap=ListedColormap([sky, verm]), vmin=-0.5, vmax=1.5, **ext)
    ax.coastlines(lw=0.2, color="0.3")
    ax.set_global()
    from matplotlib.patches import Patch
    ax.legend(handles=[Patch(color=sky, label="≥ 25 % of the 8′ cell not measured and under a recorded vessel track (raster ≥ 1e2)"),
                       Patch(color=verm, label="≥ 25 % not measured and under the heaviest traffic class (raster ≥ 1e6)"),
                       Patch(color="0.75", label="not measured (darker = larger share measured)")],
              loc="lower center", bbox_to_anchor=(0.5, -0.09), ncol=1, fontsize=8.5, frameon=False)
    a1 = fig.add_axes([0.07, 0.07, 0.38, 0.21])
    d = res["by_depth"]
    xi = np.arange(len(d))
    w = 0.27
    a1.bar(xi - w, [v["unmeasured_km2"] / 1e6 for v in d.values()], w, color=grey, label="not measured")
    a1.bar(xi, [v["unmeasured_under_track_km2"] / 1e6 for v in d.values()], w, color=sky, label="… under a recorded track (≥ 1e2)")
    a1.bar(xi + w, [v["unmeasured_under_heavy_km2"] / 1e6 for v in d.values()], w, color=verm, label="… under heavy traffic (≥ 1e6)")
    for x, v in zip(xi, d.values()):
        for dx, key in ((0, "track"), (w, "heavy")):
            a1.annotate(f"{100 * v[f'share_of_unmeasured_under_{key}']:.0f} %", (x + dx, v[f"unmeasured_under_{key}_km2"] / 1e6),
                        ha="center", va="bottom", fontsize=7)
    a1.set_xticks(xi)
    a1.set_xticklabels(d.keys(), fontsize=8)
    a1.set_yscale("log")
    a1.set_ylabel("million km²")
    a1.set_xlabel("water depth")
    a1.legend(fontsize=7.5, frameon=False)
    a1.grid(alpha=.3, axis="y")
    a2 = fig.add_axes([0.56, 0.07, 0.40, 0.21])
    m = res["measured_share_by_traffic"]
    xi = np.arange(len(m))
    a2.bar(xi, [100 * (v["measured_share"] or 0) for v in m.values()], color=blue)
    a2.set_xticks(xi)
    a2.set_xticklabels(m.keys(), fontsize=7, rotation=20)
    a2.set_ylabel("% measured in GEBCO_2026")
    a2.set_xlabel("ship-traffic class (raster value per km² per year; relative units)")
    a2.grid(alpha=.3, axis="y")
    fig.savefig(OUT_FIG, dpi=150, facecolor="white")
    return OUT_FIG


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("unit-check", "run", "figure"))
    a = ap.parse_args()
    {"unit-check": unit_check, "run": run, "figure": lambda: print(figure())}[a.cmd]()
