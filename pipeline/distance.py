"""Distance from every ocean cell to the nearest directly measured seafloor, per GEBCO release.

Input : data/derived/history_mask_1arcmin.npy   (bit i set = the 1' cell holds a TID 10-17 cell in release 2019+i)
        data/derived/history_ocean_1arcmin.npy  (number of ocean 15" cells in the 1' cell, 0..16; the paper's mask)
Output: data/derived/distance_stats.json                     statistics for every release
        data/derived/distance_<year>_1arcmin.npz             key "d": uint16, 0.1 km units, 65535 = not world ocean
                                                             (KEEP years only: the inputs of pipeline/blindtest.py)
        data/derived/distance_<LATEST>_8arcmin.npz           key "d": float32 8' block mean, km (map of the figure)

Definition. A 1' cell is "measured" in a release if at least one of its 16 15" cells is coded TID 10-17. The distance
of an ocean 1' cell is the great-circle distance (sphere R = 6371.0072 km) from its centre to the centre of the nearest
measured 1' cell; measured cells have distance 0. The smallest non-zero distance is therefore one cell (1.85 km
north-south), and distances are straight over land (the nearest sounding may lie in another basin).

Method. Cell centres are turned into unit vectors; a k-d tree of the measured cells answers nearest-neighbour queries
in chord length c, and the arc is 2 R asin(c / 2). This is exact on the sphere, unlike a pixel distance transform on a
latitude-longitude grid.

  python pipeline/distance.py run [YEAR ...]     default: all releases
  python pipeline/distance.py figure
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history  # noqa: E402

ROOT = history.ROOT
DERIVED = history.DERIVED
OUT_JSON = DERIVED / "distance_stats.json"
OUT_FIG = ROOT / "figures/fig_distance_to_measurement.png"
H1, W1 = history.H1, history.W1
R_KM = history.R_KM
KEEP = (2024, 2025)                   # releases whose full 1' distance grid is written to disk (blind test inputs)
MAP_AGG = 8                           # 1' -> 8' block mean for the figure map of the latest release
DEEP_M = 200                          # "beyond the shelf": 1' GEBCO_2026 elevation below -DEEP_M
UNIT_KM = 0.1
NODATA = 65535
THRESHOLDS_KM = (5, 10, 25, 50, 100, 200)
LAT_EDGES = np.arange(-90, 91, 5)
HIST_EDGES_KM = np.concatenate([[0.0], np.geomspace(1.0, 3000.0, 241)])   # for area-weighted quantiles


def cell_area_km2() -> np.ndarray:
    """exact spherical area of a 1' cell, per row (row 0 = north)"""
    d = np.radians(1 / 60)
    top = np.radians(90 - np.arange(H1) / 60)
    return (R_KM ** 2) * d * (np.sin(top) - np.sin(top - d))


def unit_vectors(rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    """unit vectors of 1' cell centres, (n, 3) float64"""
    lat = np.radians(90 - (rows + 0.5) / 60)
    lon = np.radians(-180 + (cols + 0.5) / 60)
    cl = np.cos(lat)
    return np.column_stack([cl * np.cos(lon), cl * np.sin(lon), np.sin(lat)])


def chord_to_km(c: np.ndarray) -> np.ndarray:
    return 2 * R_KM * np.arcsin(np.clip(c / 2, 0, 1))


def nearest_km(measured: np.ndarray, query: np.ndarray, chunk: int = 4_000_000, row0: int = 0,
               col0: int = 0) -> np.ndarray:
    """great-circle distance (km) from every True cell of `query` to the nearest True cell of `measured`.

    Both are (H, W) bool grids of 1' cells whose element [0, 0] is the global 1' cell [row0, col0] (row 0 = north
    edge, column 0 = 180 W). Returns float32 in the order of np.nonzero(query)."""
    from scipy.spatial import cKDTree
    mr, mc = np.nonzero(measured)
    tree = cKDTree(unit_vectors(mr + row0, mc + col0), leafsize=32, balanced_tree=False, compact_nodes=False)
    qr, qc = np.nonzero(query)
    qr, qc = qr + row0, qc + col0
    out = np.empty(qr.size, dtype=np.float32)
    for i in range(0, qr.size, chunk):
        d, _ = tree.query(unit_vectors(qr[i:i + chunk], qc[i:i + chunk]), k=1, workers=-1)
        out[i:i + chunk] = chord_to_km(d)
    return out


def weighted_quantiles(hist: np.ndarray, qs) -> list[float]:
    """quantiles from an area histogram on HIST_EDGES_KM (linear inside a bin)"""
    c = np.cumsum(hist)
    tot = c[-1]
    res = []
    for q in qs:
        t = q * tot
        j = int(np.searchsorted(c, t))
        j = min(j, len(hist) - 1)
        prev = c[j - 1] if j > 0 else 0.0
        f = 0.0 if hist[j] == 0 else (t - prev) / hist[j]
        res.append(float(HIST_EDGES_KM[j] + f * (HIST_EDGES_KM[j + 1] - HIST_EDGES_KM[j])))
    return res


def grid_path(year: int) -> Path:
    return DERIVED / f"distance_{year}_1arcmin.npz"


def _point(r: int, c: int, dist_km: np.ndarray, elev: np.ndarray | None) -> dict:
    p = {"km": float(dist_km[r, c]), "lat": float(90 - (r + 0.5) / 60), "lon": float(-180 + (c + 0.5) / 60)}
    if elev is not None:
        p["elevation_2026_1arcmin_m"] = int(elev[r, c])
    return p


def stats_for(dist_km: np.ndarray, ocean_cnt: np.ndarray, elev: np.ndarray | None = None) -> dict:
    """dist_km: (H1, W1) float32 with NaN outside the ocean. Area weight = ocean share of the cell x cell area.
    elev (optional): 1' GEBCO_2026 elevation, used to describe the farthest point and to find the farthest point
    beyond the shelf (elevation < -DEEP_M)."""
    area_row = cell_area_km2()
    w = (ocean_cnt.astype(np.float32) / 16.0) * area_row[:, None].astype(np.float32)
    oc = ocean_cnt > 0
    d = dist_km[oc]
    ww = w[oc].astype(np.float64)
    total = float(ww.sum())
    unm = d > 0
    res = {"ocean_km2": total, "unmeasured_cells_km2": float(ww[unm].sum()),
           "mean_km": float((d * ww).sum() / total)}
    h_all, _ = np.histogram(d, bins=HIST_EDGES_KM, weights=ww)
    h_unm, _ = np.histogram(d[unm], bins=HIST_EDGES_KM, weights=ww[unm])
    for name, h in (("all_ocean", h_all), ("unmeasured_only", h_unm)):
        q = weighted_quantiles(h, (0.5, 0.75, 0.9, 0.99))
        res[name] = {"median_km": q[0], "p75_km": q[1], "p90_km": q[2], "p99_km": q[3]}
    res["share_farther_than_km"] = {str(t): float(ww[d > t].sum() / total) for t in THRESHOLDS_KM}
    # farthest point from any measurement
    r, c = divmod(int(np.argmax(np.where(oc, dist_km, -1))), W1)
    res["farthest"] = _point(r, c, dist_km, elev)
    if elev is not None:
        r, c = divmod(int(np.argmax(np.where(oc & (elev < -DEEP_M), dist_km, -1))), W1)
        res[f"farthest_deeper_than_{DEEP_M}m"] = _point(r, c, dist_km, elev)
        deep = oc & (elev < -DEEP_M)
        res[f"share_farther_than_km_deeper_than_{DEEP_M}m"] = {
            str(t): float(w[deep & (dist_km > t)].sum(dtype=np.float64) / w[deep].sum(dtype=np.float64))
            for t in THRESHOLDS_KM}
    # by latitude band: median over all ocean in the band
    band = np.clip(np.digitize(90 - (np.arange(H1) + 0.5) / 60, LAT_EDGES) - 1, 0, len(LAT_EDGES) - 2)
    med = []
    for b in range(len(LAT_EDGES) - 1):
        rows = np.nonzero(band == b)[0]
        sub_oc = oc[rows]
        if not sub_oc.any():
            med.append(None)
            continue
        hb, _ = np.histogram(dist_km[rows][sub_oc], bins=HIST_EDGES_KM, weights=w[rows][sub_oc].astype(np.float64))
        med.append(weighted_quantiles(hb, (0.5,))[0])
    res["lat_median_km"] = med
    res["hist_all_ocean_km2"] = [float(x) for x in h_all]
    return res


WORLD = DERIVED / "world_ocean_1arcmin.npy"
RECORD_NC = ROOT / "dataset/build/seafloor_measured_record_2019_2026.nc"


def build_world_ocean() -> np.ndarray:
    """1' cells that hold at least one 15" cell of the ocean mask connected to the world ocean.

    The paper's mask (TID != 0 and elevation < 0) also holds the Caspian Sea and dry land below sea level (the Turpan
    Depression, the Qattara Depression, ...). Those are not seafloor and would otherwise be the "farthest" places.
    Connectivity is taken from the published per-cell record (variable inland_below_sea_level, computed on the 15"
    grid by pipeline/build_dataset.py); at 1' the Bosphorus closes and the Black Sea would be cut off."""
    import netCDF4
    ds = netCDF4.Dataset(RECORD_NC)
    v = ds["inland_below_sea_level"]
    v.set_auto_maskandscale(False)
    assert float(ds["lat"][0]) < 0, "record is stored south-first"
    h, w = v.shape
    out = np.zeros((h // 4, w // 4), dtype=bool)
    for r0 in range(0, h, 960):
        a = v[r0:r0 + 960] == 0                           # 0 = in the mask and connected; 1 = inland; -1 = outside
        out[r0 // 4:(r0 + a.shape[0]) // 4] = a.reshape(a.shape[0] // 4, 4, w // 4, 4).any(axis=(1, 3))
    out = out[::-1].copy()                                # north-first, like every other grid here
    np.save(WORLD, out)
    return out


def world_ocean(ocean_cnt: np.ndarray) -> np.ndarray:
    wo = np.load(WORLD) if WORLD.exists() else build_world_ocean()
    return wo & (ocean_cnt > 0)


def distance_grid(year: int, mask: np.ndarray, ocean_cnt: np.ndarray) -> np.ndarray:
    """ocean_cnt must already be limited to the world ocean (0 elsewhere)"""
    bit = np.uint8(1 << (year - history.YEARS[0]))
    oc = ocean_cnt > 0
    measured = ((mask & bit) > 0) & oc
    out = np.full((H1, W1), np.nan, dtype=np.float32)
    out[measured] = 0.0
    q = oc & ~measured
    out[q] = nearest_km(measured, q)
    return out


def load_inputs() -> tuple[np.ndarray, np.ndarray, dict]:
    mask = np.load(DERIVED / "history_mask_1arcmin.npy")
    cnt_all = np.load(DERIVED / "history_ocean_1arcmin.npy")
    wo = world_ocean(cnt_all)
    ocean_cnt = np.where(wo, cnt_all, 0).astype(cnt_all.dtype)
    w = cell_area_km2()[:, None] / 16.0
    info = {"mask_km2": float((cnt_all * w).sum()), "world_ocean_km2": float((ocean_cnt * w).sum())}
    info["excluded_inland_km2"] = info["mask_km2"] - info["world_ocean_km2"]
    return mask, ocean_cnt, info


def run(years: list[int], save: bool = True) -> None:
    import rasterio
    mask, ocean_cnt, info = load_inputs()
    with rasterio.open(history.ELEV) as src:
        elev = src.read(1)
    assert elev.shape == (H1, W1)
    print(info, flush=True)
    res = json.loads(OUT_JSON.read_text()) if OUT_JSON.exists() else {}
    res.update({
        "definition": "great-circle distance from the centre of each ocean 1' cell to the centre of the nearest 1' cell "
                      "that holds a TID 10-17 15\" cell in that release; measured cells = 0; sphere R = 6371.0072 km",
        "resolution_note": "smallest non-zero distance is one 1' cell (1.85 km north-south)",
        "lat_edges": LAT_EDGES.tolist(), "hist_edges_km": HIST_EDGES_KM.tolist(),
        "ocean": "the paper's ocean mask without the cells flagged inland_below_sea_level in the published record "
                 "(Caspian Sea, lakes and land below sea level); the Black Sea is part of the world ocean", **info,
    })
    res.setdefault("years", {})
    for y in years:
        t0 = time.time()
        d = distance_grid(y, mask, ocean_cnt)
        s = stats_for(d, ocean_cnt, elev)
        s["runtime_s"] = round(time.time() - t0, 1)
        res["years"][str(y)] = s
        if save and y in KEEP:
            g = np.where(np.isnan(d), NODATA, np.minimum(np.rint(d / UNIT_KM), NODATA - 1)).astype(np.uint16)
            np.savez_compressed(grid_path(y), d=g)
            del g
        if save and y == history.LATEST:
            k = MAP_AGG
            with np.errstate(invalid="ignore"):
                dm = np.nanmean(d.reshape(H1 // k, k, W1 // k, k), axis=(1, 3)).astype(np.float32)
            np.savez_compressed(DERIVED / f"distance_{y}_{k}arcmin.npz", d=dm)
        OUT_JSON.write_text(json.dumps(res, indent=1))
        print(y, {k: s[k] for k in ("mean_km", "all_ocean", "unmeasured_only", "share_farther_than_km", "farthest",
                                     "runtime_s")}, flush=True)


def load_grid(year: int) -> np.ndarray:
    """distance grid in km (float32, NaN outside the world ocean)"""
    with np.load(grid_path(year)) as z:
        g = z["d"]
    return np.where(g == NODATA, np.nan, g.astype(np.float32) * UNIT_KM)


def figure() -> Path:
    import matplotlib
    matplotlib.use("Agg")
    import cartopy.crs as ccrs
    import matplotlib.pyplot as plt
    from matplotlib.colors import LogNorm

    res = json.loads(OUT_JSON.read_text())
    years = sorted(int(y) for y in res["years"])
    with np.load(DERIVED / f"distance_{history.LATEST}_{MAP_AGG}arcmin.npz") as z:
        dm = z["d"]                                          # 8' block mean of the 1' distances
    oi = {"black": "#000000", "orange": "#E69F00", "sky": "#56B4E9", "green": "#009E73", "blue": "#0072B2",
          "vermillion": "#D55E00"}                           # Okabe-Ito
    fig = plt.figure(figsize=(13, 9.2), facecolor="white")
    ax = fig.add_axes([0.02, 0.36, 0.96, 0.62], projection=ccrs.EqualEarth(central_longitude=150))
    im = ax.imshow(np.where(dm <= 0, 0.5, dm), extent=(-180, 180, -90, 90), origin="upper",
                   transform=ccrs.PlateCarree(), cmap="magma_r", norm=LogNorm(1, 500), interpolation="nearest")
    ax.set_facecolor("#d9d9d9")
    ax.set_global()
    f = res["years"][str(history.LATEST)]["farthest"]
    ax.plot(f["lon"], f["lat"], marker="*", ms=13, mfc=oi["sky"], mec="k", transform=ccrs.PlateCarree())
    cb = fig.colorbar(im, ax=ax, orientation="horizontal", fraction=0.045, pad=0.02, extend="max")
    cb.set_label(f"Distance to the nearest directly measured seafloor, GEBCO_{history.LATEST} (km); star = farthest point")
    a1 = fig.add_axes([0.07, 0.07, 0.40, 0.23])
    a1.plot(years, [res["years"][str(y)]["all_ocean"]["median_km"] for y in years], "o-", color=oi["black"],
            label="median, all ocean")
    a1.plot(years, [res["years"][str(y)]["all_ocean"]["p90_km"] for y in years], "s--", color=oi["vermillion"],
            label="90th percentile")
    a1.plot(years, [res["years"][str(y)]["mean_km"] for y in years], "^:", color=oi["blue"], label="mean")
    a1.set_xlabel("GEBCO release")
    a1.set_ylabel("km")
    a1.set_ylim(0)
    a1.grid(alpha=.3)
    a1.legend(fontsize=8)
    a2 = fig.add_axes([0.56, 0.07, 0.40, 0.23])
    for t, c in zip(("10", "25", "50", "100"), (oi["sky"], oi["green"], oi["orange"], oi["vermillion"])):
        a2.plot(years, [100 * res["years"][str(y)]["share_farther_than_km"][t] for y in years], "o-", color=c, label=f"> {t} km")
    a2.set_xlabel("GEBCO release")
    a2.set_ylabel("% of the ocean")
    a2.set_ylim(0)
    a2.grid(alpha=.3)
    a2.legend(fontsize=8, ncol=2)
    fig.savefig(OUT_FIG, dpi=150, facecolor="white")
    return OUT_FIG


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("run", "figure"))
    ap.add_argument("years", nargs="*", type=int)
    ap.add_argument("--no-save", action="store_true", help="statistics only, do not write the distance grids")
    a = ap.parse_args()
    if a.cmd == "run":
        run(a.years or history.YEARS, save=not a.no_save)
    else:
        print(figure())
