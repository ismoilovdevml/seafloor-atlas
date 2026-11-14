"""Model disagreement: AUST_2026_BAT minus GEBCO_2026 on the 1' grid (see docs/data-contract.md).

AUST_2026_BAT (Yuan & Yang 2026, Zenodo 10.5281/zenodo.22711109, CC BY 4.0) is a 1' bathymetry model,
75 S - 75 N, predicted from SIO V33.1 marine gravity with neural networks trained on NCEI ship soundings.
GEBCO_2026's unmeasured cells come from SRTM15+ (also satellite-gravity prediction), its measured cells
(TID 10-17) from soundings, many of which NCEI also holds. So:

* in measured cells, agreement is expected (AUST was trained on overlapping soundings): this is a
  consistency check, NOT an independent validation of either model;
* in unmeasured cells, both depths are predictions from overlapping inputs (SIO-type gravity). Where they
  disagree, at least one is wrong, so |AUST - GEBCO| is a lower bound on the real depth uncertainty there.

Outputs
  data/derived/disagree_1arcmin.tif       Float32 AUST - GEBCO (m) over ocean, NaN elsewhere (GEBCO 1' grid)
  data/derived/disagree_tiles_src.tif     Float32 |AUST - GEBCO| where < 50 % of the 1' cell is measured
  data/derived/disagree_stats.json        area-weighted statistics (measured / partial / unmeasured, by depth)
  web/public/tiles/disagree/{z}/{x}/{y}.webp + legend.json   (z0-5, 512 px)
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np
import rasterio
from matplotlib import colormaps
from netCDF4 import Dataset
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tiles import blend_poles, down2, warp_to_merc  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
AUST = ROOT / "data/raw/aust_2026/AUST_2026_BAT.nc"
ELEV = ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif"
COV = ROOT / "data/derived/coverage_1arcmin.tif"
TID = ROOT / "data/raw/gebco_2026/gebco_2026_tid.tif"
DIFF = ROOT / "data/derived/disagree_1arcmin.tif"
TSRC = ROOT / "data/derived/disagree_tiles_src.tif"
STATS = ROOT / "data/derived/disagree_stats.json"
OUT = ROOT / "web/public/tiles/disagree"

R_KM = 6371.0072
DEPTH_BANDS = [0, 200, 1000, 2000, 3000, 4000, 5000, 6000, 12000]   # GEBCO depth (m, positive down)
THRESH = [50, 100, 200, 500, 1000]
# AUST is a deep-ocean gravity model: on shelves and upper slopes it is systematically too deep (e.g. Gulf of
# Carpentaria: GEBCO median 54 m, AUST 196 m; in GEBCO 0-1000 m, >= 95 % of the |diff| > 500 m cells have AUST
# deeper). Those differences are AUST errors, not genuine depth uncertainty, so the map and the headline use
# GEBCO depth >= DEEP_FROM only. All bands are still in the statistics.
DEEP_FROM = 1000.0
# inland basins that the ocean mask (TID != 0 and elevation < 0) lets in; not marine-gravity territory
INLAND_BOXES = {"Caspian Sea": (46.0, 36.0, 55.5, 47.5), "Lake Baikal": (103.0, 51.0, 110.5, 56.0)}
# colour scale (fixed so the legend is stable): log10 |diff| from 50 m to 1000 m
VMIN, VMAX = 50.0, 1000.0
CMAP, CMAP_FROM = "plasma", 0.12
ALPHA_MIN, ALPHA_MAX = 110, 235
CITATION = ("Yuan, J. & Yang, C. (2026) AUST_2026_BAT: A Global Bathymetry Model Derived from Multi-Scale "
            "Marine Gravity Anomalies Using Fully Connected Deep Neural Networks and Adaptive Multi-Factor "
            "Spatial Partitioning (v2026). Zenodo. doi:10.5281/zenodo.22711109")
ATTRIBUTION = ("Model disagreement: AUST_2026_BAT (Yuan & Yang 2026, doi:10.5281/zenodo.22711109, CC BY 4.0) "
               "minus GEBCO_2026 (OGL v3)")


def read_aust(nc: Path, lat_g: np.ndarray, lon_g: np.ndarray) -> np.ndarray:
    """AUST elevation (m, up positive) sampled at the GEBCO 1' cell centres; NaN outside the model domain."""
    with Dataset(nc) as ds:
        names = {v.lower(): v for v in ds.variables}
        lat_n = next(names[k] for k in ("lat", "latitude", "y") if k in names)
        lon_n = next(names[k] for k in ("lon", "longitude", "x") if k in names)
        zvar = next(v for v in ds.variables.values() if v.ndim == 2)
        lat = np.asarray(ds[lat_n][:], dtype=np.float64)
        lon = np.asarray(ds[lon_n][:], dtype=np.float64)
        zvar.set_auto_mask(True)
        print(f"AUST variable {zvar.name} {zvar.dimensions} {zvar.shape} units={getattr(zvar, 'units', '?')}",
              flush=True)
        z = np.ma.filled(zvar[:].astype(np.float32), np.nan)
        dims = zvar.dimensions
    if dims[0] == lon_n:
        z = z.T
    if lat[0] > lat[-1]:
        lat, z = lat[::-1], z[::-1]
    lon = np.where(lon > 180, lon - 360, lon)
    order = np.argsort(lon, kind="stable")
    lon, z = lon[order], z[:, order]
    dlat, dlon = np.diff(lat).mean(), np.diff(lon).mean()
    assert abs(dlat - 1 / 60) < 1e-6 and abs(dlon - 1 / 60) < 1e-6, (dlat, dlon)
    # fractional index of each GEBCO centre in the AUST grid; bilinear (exact copy when the grids coincide)
    fi = (lat_g - lat[0]) / dlat
    fj = (lon_g - lon[0]) / dlon
    print(f"AUST grid: lat {lat[0]:.5f}..{lat[-1]:.5f} ({lat.size}), lon {lon[0]:.5f}..{lon[-1]:.5f} ({lon.size}); "
          f"GEBCO centre offset in AUST cells: lat {fi[0] - round(fi[0]):+.3f}, lon {fj[0] - round(fj[0]):+.3f}",
          flush=True)
    out = np.full((lat_g.size, lon_g.size), np.nan, dtype=np.float32)
    rows = np.nonzero((fi >= 0) & (fi <= lat.size - 1))[0]
    i0 = np.clip(np.floor(fi[rows] + 1e-9).astype(int), 0, lat.size - 2)
    wi = np.clip(fi[rows] - i0, 0, 1).astype(np.float32)
    fjw = np.mod(fj, lon.size)                       # wrap the antimeridian
    j0 = np.floor(fjw + 1e-9).astype(int) % lon.size
    j1 = (j0 + 1) % lon.size
    wj = (fjw - np.floor(fjw + 1e-9)).astype(np.float32)
    exact = np.all(np.abs(wi) < 1e-6) and np.all(np.abs(wj) < 1e-6)
    for k, r in enumerate(rows):
        a = z[i0[k]]
        if exact:
            out[r] = a[j0]
        else:
            b = z[i0[k] + 1]
            top = a[j0] * (1 - wj) + a[j1] * wj
            bot = b[j0] * (1 - wj) + b[j1] * wj
            out[r] = top * (1 - wi[k]) + bot * wi[k]
    return out


def wquantiles(values: np.ndarray, weights: np.ndarray, qs, lo: float, hi: float, step: float) -> list[float]:
    """Weighted quantiles via a fine histogram (exact to `step`)."""
    edges = np.arange(lo, hi + step, step)
    h, _ = np.histogram(np.clip(values, lo, hi - step / 2), bins=edges, weights=weights)
    c = np.cumsum(h)
    if c[-1] <= 0:
        return [float("nan")] * len(qs)
    c /= c[-1]
    mids = (edges[:-1] + edges[1:]) / 2
    return [float(mids[min(np.searchsorted(c, q), mids.size - 1)]) for q in qs]


def summary(d: np.ndarray, w: np.ndarray, area_km2_per_w: float) -> dict:
    if d.size == 0:
        return {"area_km2": 0}
    a = np.abs(d)
    W = w.sum()
    med, p95, p99 = wquantiles(a, w, (0.5, 0.95, 0.99), 0, 15000, 1.0)
    sm, = wquantiles(d, w, (0.5,), -15000, 15000, 1.0)
    return {
        "area_km2": round(float(W * area_km2_per_w)),
        "cells": int(d.size),
        "mean_diff_m": round(float((d * w).sum() / W), 1),           # AUST - GEBCO: >0 = AUST shallower
        "median_diff_m": sm,
        "median_abs_m": med,
        "rms_m": round(float(np.sqrt((d.astype(np.float64) ** 2 * w).sum() / W)), 1),
        "p95_abs_m": p95,
        "p99_abs_m": p99,
        "share_abs_gt": {str(t): round(float(w[a > t].sum() / W), 4) for t in THRESH},
    }


def colorize(block: np.ndarray) -> np.ndarray:
    cmap = colormaps[CMAP]
    out = np.zeros(block.shape + (4,), dtype=np.uint8)
    ok = np.isfinite(block) & (block >= VMIN)
    if not ok.any():
        return out
    t = np.clip((np.log10(block[ok]) - math.log10(VMIN)) / (math.log10(VMAX) - math.log10(VMIN)), 0, 1)
    rgba = cmap(CMAP_FROM + (1 - CMAP_FROM) * t)
    out[..., :3][ok] = np.rint(rgba[:, :3] * 255).astype(np.uint8)
    out[..., 3][ok] = np.rint(ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * t).astype(np.uint8)
    return out


def write_tiles(maxzoom: int, tile: int, quality: int) -> dict:
    size = tile * 2 ** maxzoom
    level = warp_to_merc(TSRC, size, np.float32, src_nodata=np.nan)
    blend_poles(level, float("nan"), float("nan"))    # AUST stops at 75 deg anyway: polar caps blank
    shutil.rmtree(OUT, ignore_errors=True)
    nbytes = ntiles = empty = 0
    for z in range(maxzoom, -1, -1):
        n = 2 ** z
        for y in range(n):
            for x in range(n):
                rgba = colorize(level[y * tile:(y + 1) * tile, x * tile:(x + 1) * tile])
                p = OUT / str(z) / str(x)
                p.mkdir(parents=True, exist_ok=True)
                f = p / f"{y}.webp"
                if rgba[..., 3].max() == 0:
                    empty += 1
                    Image.fromarray(rgba).save(f, lossless=True)
                else:
                    Image.fromarray(rgba).save(f, quality=quality, alpha_quality=quality, method=6)
                nbytes += f.stat().st_size
                ntiles += 1
        print(f"  z{z}: {nbytes / 1e6:.1f} MB so far", flush=True)
        if z:
            level = down2(level)          # NaN-aware: mean |diff| of the unmeasured-dominated pixels
    return {"tiles": ntiles, "emptyTiles": empty, "bytes": nbytes}


def legend(info: dict, maxzoom: int, tile: int, stats: dict) -> dict:
    cmap = colormaps[CMAP]
    stops = []
    for v in (50, 100, 200, 500, 1000):
        t = (math.log10(v) - math.log10(VMIN)) / (math.log10(VMAX) - math.log10(VMIN))
        r, g, b, _ = cmap(CMAP_FROM + (1 - CMAP_FROM) * t)
        stops.append({"value": v, "log10": round(math.log10(v), 4),
                      "color": "#%02x%02x%02x" % tuple(int(round(c * 255)) for c in (r, g, b))})
    um = stats["by_class_deep"]["unmeasured"]
    return {
        "layer": "disagree",
        "title": "Where two seafloor models disagree",
        "units": "m (|AUST_2026_BAT − GEBCO_2026|)",
        "description": ("Absolute depth difference between two independent-ish global models, shown only where "
                        "less than half of the 1′ cell is directly measured (TID 10–17) and the seafloor is deeper than 1,000 m "
                        "(on shelves and slopes AUST is biased deep, so differences there are not shown). Large values mean the "
                        "depth there is genuinely uncertain; small values do not prove it is right, because both "
                        "models use satellite gravity."),
        "scale": "log10", "vmin": VMIN, "vmax": VMAX, "transparentBelow": VMIN,
        "alphaMin": ALPHA_MIN, "alphaMax": ALPHA_MAX,
        "colormap": f"matplotlib {CMAP} from {CMAP_FROM}", "stops": stops,
        "mask": (f"ocean (GEBCO TID != 0 and 1' elevation < 0), GEBCO depth >= {DEEP_FROM:g} m, measured fraction "
                 "< 0.5, 75 S - 75 N, Caspian and Baikal excluded"),
        "headline": {"unmeasured_median_abs_m": um["median_abs_m"], "unmeasured_p95_abs_m": um["p95_abs_m"],
                     "unmeasured_share_gt_100m": um["share_abs_gt"]["100"],
                     "unmeasured_share_gt_200m": um["share_abs_gt"]["200"],
                     "measured_median_abs_m": stats["by_class_deep"]["measured"]["median_abs_m"],
                     "depthFromM": DEEP_FROM},
        "tileSize": tile, "minzoom": 0, "maxzoom": maxzoom, "format": "webp (lossy RGBA)",
        "sourceResolutionArcsec": 60,
        "source": "AUST_2026_BAT (Zenodo 22711109) and GEBCO_2026",
        "sourceUrl": "https://zenodo.org/records/22711109",
        "citation": CITATION,
        "licence": "CC BY 4.0 (AUST_2026_BAT); OGL v3 (GEBCO_2026)",
        "attribution": ATTRIBUTION,
        **info,
    }


def figure(stats: dict) -> Path:
    """figures/fig7_model_disagreement.png: map of |AUST - GEBCO| in deep unmeasured cells + distributions."""
    import cartopy.crs as ccrs
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap, LogNorm
    from matplotlib.patches import Patch

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False,
                         "axes.spines.right": False, "savefig.dpi": 200, "savefig.bbox": "tight"})
    k = 15                                                         # 1' -> 15' blocks for the map
    with rasterio.open(TSRC) as s:
        t = s.read(1)
    with rasterio.open(ELEV) as s:
        g = s.read(1)
    with rasterio.open(COV) as s:
        c = s.read(1)
    H, W = t.shape
    blk = lambda x: x.reshape(H // k, k, W // k, k)
    with np.errstate(invalid="ignore"):
        n = np.isfinite(blk(t)).sum(axis=(1, 3))
        mean = np.where(n > 0, np.nansum(blk(t), axis=(1, 3)) / np.maximum(n, 1), np.nan)
    ocean = blk(c > 0).mean(axis=(1, 3)) > 0.5
    deep = blk((c > 0) & (g <= -DEEP_FROM)).sum(axis=(1, 3))
    del t, g, c
    lat = 90 - (np.arange(H // k) + 0.5) * k / 60
    inside = (np.abs(lat) < 75)[:, None]
    base = np.ones(mean.shape + (3,))                              # land
    base[ocean] = 0.90                                             # shallower than DEEP_FROM / outside AUST
    mostly_meas = ocean & inside & (deep > 0.5 * k * k) & (n < 0.5 * deep)
    base[mostly_meas] = 0.55
    show = ocean & inside & (deep > 0.5 * k * k) & (n >= 0.5 * deep)
    m = np.ma.masked_where(~show, mean)
    cmap = ListedColormap(colormaps[CMAP](np.linspace(CMAP_FROM, 1, 256)))

    fig = plt.figure(figsize=(12, 10.6))
    outer = fig.add_gridspec(2, 1, height_ratios=[1.75, 1], hspace=0.3)
    top = outer[0].subgridspec(2, 1, height_ratios=[1, 0.03], hspace=0.13)
    bottom = outer[1].subgridspec(1, 2, wspace=0.24)
    ax = fig.add_subplot(top[0], projection=ccrs.EqualEarth(central_longitude=150))
    ax.set_global()
    ax.spines["geo"].set_linewidth(0.6)
    ext = [-180, 180, -90, 90]
    ax.imshow(base, extent=ext, transform=ccrs.PlateCarree(), origin="upper", regrid_shape=(1440, 2880))
    im = ax.imshow(m, extent=ext, transform=ccrs.PlateCarree(), origin="upper", cmap=cmap,
                   norm=LogNorm(25, 400), regrid_shape=(1440, 2880), interpolation="nearest")
    um, me = stats["by_class_deep"]["unmeasured"], stats["by_class_deep"]["measured"]
    ax.set_title(f"Where two global seafloor models disagree: unmeasured seafloor deeper than {DEEP_FROM / 1000:g} km, "
                 f"median {um['median_abs_m']:.0f} m apart, {100 * um['share_abs_gt']['100']:.0f}% > 100 m",
                 fontsize=12.5)
    ax.legend(handles=[Patch(color="0.55", label="mostly measured (TID 10–17)"),
                       Patch(color="0.90", label=f"shallower than {DEEP_FROM:g} m, or beyond 75°: not assessed")],
              loc="upper left", bbox_to_anchor=(0.0, 0.02), fontsize=8, frameon=False, ncol=1)
    cax = fig.add_subplot(top[1])
    pos = cax.get_position()
    cax.set_position([pos.x0 + pos.width * 0.45, pos.y0, pos.width * 0.4, pos.height])
    cbar = fig.colorbar(im, cax=cax, orientation="horizontal", extend="both")
    from matplotlib.ticker import NullFormatter
    cbar.ax.xaxis.set_minor_formatter(NullFormatter())
    cbar.set_ticks([25, 50, 100, 200, 400], labels=["25", "50", "100", "200", "400"])
    cbar.set_label("|AUST_2026_BAT − GEBCO_2026| (m): mean of 1′ cells in each 15′ block, cells < 50 % measured")

    edges = np.array(stats["hist_edges_m"], dtype=float)
    mid = (edges[:-1] + edges[1:]) / 2
    a1 = fig.add_subplot(bottom[0])
    cols = {"measured": "#3b6ea8", "partial": "0.55", "unmeasured": "#d1495b"}
    for kk in ("measured", "unmeasured"):
        h = np.array(stats["hist_km2_deep"][kk], dtype=float)
        a1.plot(mid, h / h.sum() / 10, color=cols[kk], lw=1.6,
                label=f"{kk}: median |Δ| {stats['by_class_deep'][kk]['median_abs_m']:.0f} m, "
                      f"RMS {stats['by_class_deep'][kk]['rms_m']:.0f} m")
    a1.set_yscale("log")
    a1.set_xlim(-1000, 1000)
    a1.set_ylim(1e-6, 0.03)
    a1.set_xlabel("AUST − GEBCO (m)   (> 0: AUST shallower)")
    a1.set_ylabel("Share of area per metre")
    a1.set_title(f"Distribution of the difference, depth ≥ {DEEP_FROM / 1000:g} km", fontsize=11)
    a1.legend(frameon=False, fontsize=8, loc="upper left")

    a2 = fig.add_subplot(bottom[1])
    bands = stats["depth_bands_m"]
    labels = [f"{lo / 1000:g}–{hi / 1000:g}" if hi < 12000 else f"> {lo / 1000:g}" for lo, hi in zip(bands[:-1], bands[1:])]
    y = np.arange(len(labels))
    nshallow = sum(1 for lo in bands[:-1] if lo < DEEP_FROM)
    a2.axhspan(-0.5, nshallow - 0.5, color="0.93", zorder=0)
    a2.text(0.43, (nshallow - 1) / 2, "AUST biased deep:\nnot in the map", ha="left", va="center", fontsize=7.5,
            color="0.35", transform=a2.get_yaxis_transform())
    for off, kk in ((-0.18, "measured"), (0.18, "unmeasured")):
        rows = stats["by_class_depth"][kk]
        med = np.array([r.get("median_abs_m", np.nan) for r in rows], dtype=float)
        p95 = np.array([r.get("p95_abs_m", np.nan) for r in rows], dtype=float)
        a2.barh(y + off, med, height=0.34, color=cols[kk])
        a2.scatter(p95, y + off, marker="|", s=110, linewidths=2, color=cols[kk])
    a2.set_yticks(y, labels)
    a2.set_ylim(len(labels) - 0.5, -0.5)
    a2.set_xscale("log")
    a2.set_xlim(5, 1500)
    a2.set_xlabel("|AUST − GEBCO| (m, log scale)")
    a2.set_ylabel("GEBCO depth (km)")
    a2.set_title("By depth: median (bar) and 95th percentile (tick)\nblue = measured, red = unmeasured 1′ cells",
                  fontsize=10.5)
    fig.text(0.5, 0.035, "Measured cells are not an independent check: AUST_2026_BAT was trained on NCEI ship soundings, "
             "which GEBCO also contains. In unmeasured cells both depths are\nsatellite-gravity predictions from "
             "overlapping inputs, so where they disagree at least one is wrong; agreement does not prove either right. "
             "Area-weighted, 75° S – 75° N.", ha="center", fontsize=8, color="0.25")
    fig.text(0.5, 0.012, "Data: Yuan & Yang (2026) AUST_2026_BAT, doi:10.5281/zenodo.22711109 (CC BY 4.0); "
             "GEBCO Compilation Group (2026) GEBCO_2026 Grid, doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa",
             ha="center", fontsize=7, color="0.35")
    out = ROOT / "figures/fig7_model_disagreement.png"
    fig.savefig(out)
    plt.close(fig)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--maxzoom", type=int, default=5)
    ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--quality", type=int, default=50)
    ap.add_argument("--no-tiles", action="store_true")
    ap.add_argument("--figure-only", action="store_true", help="only redraw fig7 from the derived files")
    args = ap.parse_args()
    if args.figure_only:
        print(figure(json.loads(STATS.read_text())))
        return

    with rasterio.open(ELEV) as s:
        g = s.read(1).astype(np.float32)
        prof, T = s.profile.copy(), s.transform
    H, W = g.shape
    lat_g = T.f + (np.arange(H) + 0.5) * T.e
    lon_g = T.c + (np.arange(W) + 0.5) * T.a
    with rasterio.open(COV) as s:
        c = s.read(1)
    with rasterio.open(TID) as s:      # one 15" sample per 1' cell (nearest), for the indirect-source split
        tid = s.read(1, out_shape=(H, W))
    a = read_aust(AUST, lat_g, lon_g)

    ocean = (c > 0) & (g < 0)
    for x0, y0, x1, y1 in INLAND_BOXES.values():
        r0, r1 = int((90 - y1) * 60), int((90 - y0) * 60)
        c0, c1 = int((x0 + 180) * 60), int((x1 + 180) * 60)
        ocean[r0:r1, c0:c1] = False
    dom = ocean & np.isfinite(a)
    d = np.where(dom, a - g, np.nan).astype(np.float32)
    f = np.where(ocean, (c.astype(np.float32) - 1) / 254, np.nan)

    p = prof.copy()
    p.update(dtype="float32", nodata=np.nan, compress="deflate", predictor=3, tiled=True,
             blockxsize=512, blockysize=512)
    with rasterio.open(DIFF, "w", **p) as dst:
        dst.write(d, 1)
    ts = np.where(dom & (f < 0.5) & (g <= -DEEP_FROM), np.abs(d), np.nan).astype(np.float32)
    with rasterio.open(TSRC, "w", **p) as dst:
        dst.write(ts, 1)
    del ts

    # area weights: exact spherical area of a 1' cell per row
    lat_top = T.f + np.arange(H) * T.e
    cell = (R_KM ** 2 * math.radians(T.a) * np.abs(np.sin(np.radians(lat_top)) -
                                                    np.sin(np.radians(lat_top + T.e)))).astype(np.float64)
    wrow = np.broadcast_to(cell[:, None], (H, W))
    depth = -g
    classes = {"measured": dom & (c == 255), "partial": dom & (c > 1) & (c < 255), "unmeasured": dom & (c == 1)}
    out: dict = {
        "source": CITATION,
        "comparison": "AUST_2026_BAT minus GEBCO_2026 1' (GEBCO 1' = mean of 4x4 15\" cells); "
                      "positive = AUST shallower than GEBCO",
        "domain": "ocean (TID != 0 and 1' elevation < 0) where AUST is defined (75 S - 75 N)",
        "classes": {"measured": "all 16 15\" sub-cells TID 10-17", "partial": "1-15 of 16 sub-cells measured",
                    "unmeasured": "no sub-cell measured"},
        "weights": "spherical cell area",
        "depth_bands_m": DEPTH_BANDS,
        "aust_grid": "AUST_2026_BAT.nc: GMT pixel-registered 1' grid (node_offset=1), 21600 x 9000, 75 S - 75 N; "
                     "its cell centres coincide with GEBCO's 1' centres, so values are compared cell for cell",
        "ocean_area_km2": round(float(wrow[ocean].sum())),
        "domain_area_km2": round(float(wrow[dom].sum())),
        "by_class": {}, "by_class_depth": {}, "unmeasured_by_tid": {},
    }
    out["all"] = summary(d[dom], wrow[dom], 1.0)
    deep = depth >= DEEP_FROM
    out["deep_from_m"] = DEEP_FROM
    out["by_class_deep"] = {}
    for k, m in classes.items():
        out["by_class_deep"][k] = summary(d[m & deep], wrow[m & deep], 1.0)
        print("deep", k, json.dumps(out["by_class_deep"][k]), flush=True)
    sh = dom & (depth < DEEP_FROM)
    big = sh & (np.abs(d) > 500)
    out["shallow_check"] = {
        "note": "GEBCO depth < DEEP_FROM: share of |diff| > 500 m cells where AUST is the deeper one, and share of "
                "cells where AUST is more than twice as deep as GEBCO (AUST shelf bias)",
        "share_big_aust_deeper": round(float(wrow[big & (d < 0)].sum() / wrow[big].sum()), 4),
        "share_aust_gt_2x_gebco_depth": round(float(wrow[sh & (-(g + d) > 2 * depth)].sum() / wrow[sh].sum()), 4),
        "excluded_inland": list(INLAND_BOXES),
    }
    for k, m in classes.items():
        out["by_class"][k] = summary(d[m], wrow[m], 1.0)
        out["by_class"][k]["share_of_domain_area"] = round(out["by_class"][k]["area_km2"] / out["domain_area_km2"], 4)
        rows = []
        for lo, hi in zip(DEPTH_BANDS[:-1], DEPTH_BANDS[1:]):
            mm = m & (depth >= lo) & (depth < hi)
            r = summary(d[mm], wrow[mm], 1.0)
            r["band_m"] = [lo, hi]
            rows.append(r)
        out["by_class_depth"][k] = rows
        print(k, json.dumps(out["by_class"][k]), flush=True)
    um = classes["unmeasured"]
    for name, codes in (("40 satellite gravity", [40]), ("41 interpolated", [41]),
                        ("other indirect 42-48", list(range(42, 49))), ("unknown 70-72", [70, 71, 72])):
        mm = um & np.isin(tid, codes)
        out["unmeasured_by_tid"][name] = summary(d[mm], wrow[mm], 1.0)
    # area-weighted histograms of the signed difference (10 m bins, tails clipped into the end bins), for fig7
    edges = np.arange(-2000, 2001, 10)
    out["hist_edges_m"] = edges.tolist()
    out["hist_km2"] = {k: np.histogram(np.clip(d[m], -1995, 1995), bins=edges, weights=wrow[m])[0].round().tolist()
                       for k, m in classes.items()}
    out["hist_km2_deep"] = {k: np.histogram(np.clip(d[m & deep], -1995, 1995), bins=edges,
                                            weights=wrow[m & deep])[0].round().tolist() for k, m in classes.items()}
    STATS.write_text(json.dumps(out, indent=1))
    print(f"wrote {STATS}")
    if not args.no_tiles:
        info = write_tiles(args.maxzoom, args.tile, args.quality)
        (OUT / "legend.json").write_text(json.dumps(legend(info, args.maxzoom, args.tile, out), indent=1,
                                                     ensure_ascii=False))
        print(json.dumps(info))
    print(figure(out))


if __name__ == "__main__":
    main()
