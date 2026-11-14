"""Prediction confidence of SWOT-gravity machine-learning bathymetry (see docs/data-contract.md, "Uncertainty").

Source: Nilsson, Phrampus, Salajegheh, Liu, Yu, Sandwell, Harper, Andersen, Smith, Elmore, Kirby, Beale,
Roberts & Altamirano (2025) "Bathymetry Prediction with SWOT Gravity Anomaly using Machine Learning Methods:
Paper 2 - Model Evaluation and Uncertainty Analysis", Zenodo doi:10.5281/zenodo.17673974, CC BY 4.0.
File Bathymetry_Prediction_Confidence_Level_v1.1.nc (model v1.1.0, created 2025-11-21): 1' grid, 80 S - 80 N,
cell centres identical to GEBCO's 1' grid. Variables (no units attribute in the file):

* classification: 0 = contains a sounding, 1 = high, 2 = medium, 3 = low confidence in the prediction, 4 = land
  (definition from the file's global `description`);
* predicted_error: "the numerical value of the predicted error (more noisy than classification level)". The
  file gives no unit or statistical definition and the companion paper's DOI is a placeholder. Measured here:
  class 1 <=> predicted_error < 80, class 2 <=> 80-150, class 3 <=> > 150 in every non-sounding cell, so the
  classes are thresholds on predicted_error, which is consistent with metres of depth error.

What it describes: the confidence of the authors' SWOT-gravity ML ensemble bathymetry (computed from features
of the gravity field and the distance to ship soundings), NOT of GEBCO_2026 itself.

Outputs
  web/public/tiles/uncertainty/{z}/{x}/{y}.webp + legend.json   predicted_error outside sounding cells, 3 classes
  data/derived/uncertainty_stats.json                           validation against GEBCO TID and AUST - GEBCO
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
from netCDF4 import Dataset
from PIL import Image
from scipy.stats import spearmanr

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tiles import blend_poles, down2, warp_to_merc  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
NC = ROOT / "data/raw/swot_confidence/Bathymetry_Prediction_Confidence_Level_v1.1.nc"
ELEV = ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif"
COV = ROOT / "data/derived/coverage_1arcmin.tif"
DIFF = ROOT / "data/derived/disagree_1arcmin.tif"          # from pipeline/disagree.py
SRC = ROOT / "data/derived/uncertainty_err_1arcmin.tif"
STATS = ROOT / "data/derived/uncertainty_stats.json"
OUT = ROOT / "web/public/tiles/uncertainty"

R_KM = 6371.0072
CLASS_EDGES = (80.0, 150.0)          # measured from the file: class 1 < 80 <= class 2 <= 150 < class 3
COLORS = {1: ((0x4f, 0xb3, 0xbf), 70), 2: ((0xf2, 0xb7, 0x05), 160), 3: ((0xe0, 0x3e, 0x52), 225)}
CITATION = ("Nilsson, B., Phrampus, B. J., Salajegheh, F., Liu, B., Yu, Y., Sandwell, D., Harper, H., Andersen, O. B., "
            "Smith, W. H. F., Elmore, P., Kirby, J., Beale, J., Roberts, J. & Altamirano, L. (2025) Bathymetry "
            "Prediction with SWOT Gravity Anomaly using Machine Learning Methods: Paper 2 - Model Evaluation and "
            "Uncertainty Analysis [Bathymetry_Prediction_Confidence_Level_v1.1]. Zenodo. doi:10.5281/zenodo.17673974")
ATTRIBUTION = ("Prediction confidence: Nilsson, Phrampus, Sandwell et al. (2025), SWOT ML bathymetry confidence "
               "level v1.1, doi:10.5281/zenodo.17673974, CC BY 4.0")


def read_nc() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """classification (uint8) and predicted_error (float32), north-up; plus the GEBCO 1' row index of row 0."""
    with Dataset(NC) as ds:
        lat = np.asarray(ds["latitude"][:])
        lon = np.asarray(ds["longitude"][:])
        cls = np.ma.filled(ds["classification"][:], 255).astype(np.uint8)
        err = np.ma.filled(ds["predicted_error"][:].astype(np.float32), np.nan)
    assert abs(np.diff(lat).mean() - 1 / 60) < 1e-9 and abs(lon[0] + 180 - 1 / 120) < 1e-6, (lat[:2], lon[:2])
    if lat[0] < lat[-1]:
        lat, cls, err = lat[::-1], cls[::-1], err[::-1]
    row0 = int(round((90 - lat[0]) * 60 - 0.5))
    assert abs(90 - (row0 + 0.5) / 60 - lat[0]) < 1e-6
    return cls, err, row0


def area_rows(H: int, row0: int) -> np.ndarray:
    top = 90 - (row0 + np.arange(H)) / 60
    return R_KM ** 2 * math.radians(1 / 60) * np.abs(np.sin(np.radians(top)) - np.sin(np.radians(top - 1 / 60)))


def colorize(block: np.ndarray) -> np.ndarray:
    out = np.zeros(block.shape + (4,), dtype=np.uint8)
    ok = np.isfinite(block)
    lo, hi = CLASS_EDGES
    for k, m in ((1, ok & (block < lo)), (2, ok & (block >= lo) & (block <= hi)), (3, ok & (block > hi))):
        (r, g, b), a = COLORS[k]
        out[m] = (r, g, b, a)
    return out


def write_tiles(maxzoom: int, tile: int) -> dict:
    size = tile * 2 ** maxzoom
    level = warp_to_merc(SRC, size, np.float32, src_nodata=np.nan)
    blend_poles(level, float("nan"), float("nan"))     # 80 S - 80 N only: polar caps blank
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
                Image.fromarray(rgba).save(f, lossless=True, quality=100, method=6)
                empty += int(rgba[..., 3].max() == 0)
                nbytes += f.stat().st_size
                ntiles += 1
        print(f"  z{z}: {nbytes / 1e6:.1f} MB so far", flush=True)
        if z:
            level = down2(level)      # mean predicted error of the non-sounding ocean pixels
    return {"tiles": ntiles, "emptyTiles": empty, "bytes": nbytes}


def wsum(m: np.ndarray, w: np.ndarray) -> float:
    return float((m * w).sum())


def validate(cls: np.ndarray, err: np.ndarray, row0: int) -> dict:
    H, W = cls.shape
    with rasterio.open(COV) as s:
        cov = s.read(1, window=((row0, row0 + H), (0, W)))
    with rasterio.open(ELEV) as s:
        g = s.read(1, window=((row0, row0 + H), (0, W)))
    with rasterio.open(DIFF) as s:
        d = s.read(1, window=((row0, row0 + H), (0, W)))
    w = np.broadcast_to(area_rows(H, row0)[:, None], (H, W))
    ocean = cov > 0
    meas = cov == 255
    unmeas = cov == 1
    out: dict = {"grid": "1' (21600 x 9600), 80 S - 80 N, cell centres = GEBCO 1' centres", "weights": "spherical cell area"}
    # 1. class definition check: classes are thresholds on predicted_error
    nz = (cls >= 1) & (cls <= 3)
    out["class_vs_error_check"] = {
        str(k): {"min": round(float(np.nanmin(err[cls == k])), 1), "max": round(float(np.nanmax(err[cls == k])), 1)}
        for k in (0, 1, 2, 3)}
    # 2. agreement of the masks: their land vs our ocean, their soundings vs GEBCO measured
    A = wsum(ocean, w)
    out["ocean_area_km2_80S_80N"] = round(A)
    out["class_share_of_gebco_ocean"] = {str(k): round(wsum(ocean & (cls == k), w) / A, 4) for k in range(5)}
    out["gebco_measured_share_by_class"] = {
        str(k): round(wsum(ocean & (cls == k) & meas, w) / max(wsum(ocean & (cls == k), w), 1e-9), 4)
        for k in range(4)}
    out["gebco_unmeasured_share_by_class"] = {
        str(k): round(wsum(ocean & (cls == k) & unmeas, w) / max(wsum(ocean & (cls == k), w), 1e-9), 4)
        for k in range(4)}
    out["class_share_within_gebco_unmeasured"] = {
        str(k): round(wsum(unmeas & (cls == k), w) / wsum(unmeas, w), 4) for k in range(5)}
    out["class_share_within_gebco_measured"] = {
        str(k): round(wsum(meas & (cls == k), w) / wsum(meas, w), 4) for k in range(5)}
    # 3. does the predicted error track |AUST - GEBCO|?  (deep ocean, outside soundings, where AUST exists)
    deep = (g <= -1000) & np.isfinite(d) & nz & np.isfinite(err)
    ad = np.abs(d)
    out["abs_diff_by_class_deep"] = {}
    for k in (1, 2, 3):
        m = deep & (cls == k)
        x, ww = ad[m], w[m]
        o = np.argsort(x)
        c = np.cumsum(ww[o]) / ww.sum()
        out["abs_diff_by_class_deep"][str(k)] = {
            "area_km2": round(float(ww.sum())),
            "median_abs_diff_m": round(float(x[o][np.searchsorted(c, 0.5)]), 1),
            "p90_abs_diff_m": round(float(x[o][np.searchsorted(c, 0.9)]), 1),
            "rms_diff_m": round(float(np.sqrt((x.astype(np.float64) ** 2 * ww).sum() / ww.sum())), 1),
            "median_predicted_error": round(float(np.median(err[m])), 1)}
    rng = np.random.default_rng(0)
    idx = np.flatnonzero(deep)
    sub = rng.choice(idx, size=min(2_000_000, idx.size), replace=False)
    rho1 = spearmanr(err.ravel()[sub], ad.ravel()[sub]).statistic
    pr1 = np.corrcoef(err.ravel()[sub], ad.ravel()[sub])[0, 1]
    # 15' blocks: averages out the pixel noise of both grids
    k = 15
    Hb, Wb = H // k, W // k
    blk = lambda a: a[: Hb * k, : Wb * k].reshape(Hb, k, Wb, k)
    nb = blk(deep).sum(axis=(1, 3))
    eb = np.where(deep, err, 0)
    db = np.where(deep, ad, 0)
    me = blk(eb).sum(axis=(1, 3)) / np.maximum(nb, 1)
    md = blk(db).sum(axis=(1, 3)) / np.maximum(nb, 1)
    okb = nb >= 0.5 * k * k
    rho2 = spearmanr(me[okb], md[okb]).statistic
    pr2 = np.corrcoef(me[okb], md[okb])[0, 1]
    out["correlation_predicted_error_vs_abs_aust_minus_gebco"] = {
        "domain": "GEBCO depth >= 1000 m, classification 1-3 (no sounding), AUST defined (75 S - 75 N)",
        "cells_1arcmin": {"n_sample": int(sub.size), "spearman": round(float(rho1), 3), "pearson": round(float(pr1), 3)},
        "blocks_15arcmin": {"n": int(okb.sum()), "spearman": round(float(rho2), 3), "pearson": round(float(pr2), 3),
                            "note": "block = mean over its qualifying 1' cells; blocks with >= 50 % qualifying cells"},
    }
    # same correlation restricted to GEBCO-unmeasured cells only
    um = deep & unmeas
    idx = np.flatnonzero(um)
    sub = rng.choice(idx, size=min(2_000_000, idx.size), replace=False)
    out["correlation_predicted_error_vs_abs_aust_minus_gebco"]["cells_1arcmin_gebco_unmeasured"] = {
        "n_sample": int(sub.size), "spearman": round(float(spearmanr(err.ravel()[sub], ad.ravel()[sub]).statistic), 3)}
    return out


def legend(info: dict, maxzoom: int, tile: int, st: dict) -> dict:
    return {
        "layer": "uncertainty",
        "title": "Confidence of satellite-predicted depth (SWOT ML model)",
        "units": "predicted depth error (file gives no unit; class thresholds 80 / 150 are consistent with metres)",
        "description": ("Where the seafloor depth is predicted from SWOT satellite gravity rather than measured, "
                        "how confident the prediction is: high (predicted error < 80), medium (80–150), low (> 150). "
                        "Cells containing a ship sounding and land are transparent. Confidence of the authors' SWOT "
                        "machine-learning bathymetry, which is related to but not the same grid as GEBCO_2026."),
        "classes": [
            {"class": 1, "label": "High confidence", "range": [None, CLASS_EDGES[0]],
             "color": "#%02x%02x%02x" % COLORS[1][0], "alpha": COLORS[1][1]},
            {"class": 2, "label": "Medium confidence", "range": list(CLASS_EDGES),
             "color": "#%02x%02x%02x" % COLORS[2][0], "alpha": COLORS[2][1]},
            {"class": 3, "label": "Low confidence", "range": [CLASS_EDGES[1], None],
             "color": "#%02x%02x%02x" % COLORS[3][0], "alpha": COLORS[3][1]},
        ],
        "transparent": "class 0 (contains a sounding), class 4 (land), beyond 80 deg",
        "lowerZooms": "pixels are the mean predicted_error of the non-sounding cells underneath, then classed",
        "shareOfOcean": st["class_share_of_gebco_ocean"],
        "tileSize": tile, "minzoom": 0, "maxzoom": maxzoom, "format": "webp (lossless RGBA)",
        "sourceResolutionArcsec": 60,
        "source": "Bathymetry_Prediction_Confidence_Level_v1.1.nc (Zenodo 17673974)",
        "sourceUrl": "https://zenodo.org/records/17673974",
        "citation": CITATION, "licence": "CC BY 4.0", "attribution": ATTRIBUTION,
        **info,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--maxzoom", type=int, default=5)
    ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--no-tiles", action="store_true")
    args = ap.parse_args()
    cls, err, row0 = read_nc()
    print(f"grid {cls.shape}, GEBCO 1' row offset {row0}", flush=True)
    st = {"source": CITATION, "licence": "CC BY 4.0", **validate(cls, err, row0)}
    STATS.write_text(json.dumps(st, indent=1))
    print(json.dumps(st, indent=1), flush=True)
    if args.no_tiles:
        return
    # tile source on the full GEBCO 1' grid: predicted_error outside sounding/land cells, NaN elsewhere
    with rasterio.open(ELEV) as s:
        prof = s.profile.copy()
        H, W = s.height, s.width
    full = np.full((H, W), np.nan, dtype=np.float32)
    full[row0:row0 + cls.shape[0]] = np.where((cls >= 1) & (cls <= 3), err, np.nan)
    with rasterio.open(COV) as s:            # keep it on GEBCO's ocean so it lines up with the other layers
        full[s.read(1) == 0] = np.nan
    prof.update(dtype="float32", nodata=np.nan, compress="deflate", predictor=3, tiled=True,
                blockxsize=512, blockysize=512)
    with rasterio.open(SRC, "w", **prof) as dst:
        dst.write(full, 1)
    del full, cls, err
    info = write_tiles(args.maxzoom, args.tile)
    (OUT / "legend.json").write_text(json.dumps(legend(info, args.maxzoom, args.tile, st), indent=1,
                                                ensure_ascii=False))
    print(json.dumps(info))


if __name__ == "__main__":
    main()
