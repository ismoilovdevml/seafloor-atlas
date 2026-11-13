"""Publication figures for the README (figures/*.png). Re-run after pipeline/coverage.py.

fig1_seafloor.png         Equal Earth relief map of GEBCO_2026 (shaded, cmocean 'deep' for the ocean)
fig2_measured.png         where the seafloor is directly measured (TID 10-17) vs predicted
fig3_depth.png            ocean hypsometry and measured fraction vs depth
fig4_latitude_sources.png measured fraction by latitude band and area share per TID source type
"""
from __future__ import annotations

import json
from pathlib import Path

import cartopy.crs as ccrs
import cmocean
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from matplotlib.colors import ListedColormap  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ELEV = ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif"
COV = ROOT / "data/derived/coverage_1arcmin.tif"
STATS = ROOT / "data/derived/stats.json"
FIG = ROOT / "figures"
DS = 4  # 1' -> 4' for plotting
CITE = "Data: GEBCO Compilation Group (2026) GEBCO_2026 Grid, doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa"
TID_NAMES = {10: "Single beam", 11: "Multibeam", 12: "Seismic", 13: "Isolated sounding", 14: "ENC sounding",
             15: "Lidar", 16: "Optical", 17: "Combined direct", 40: "Satellite gravity (predicted)",
             41: "Interpolated", 42: "Chart contours", 43: "ENC contours", 44: "Mixed gridded",
             45: "Airborne gravity", 46: "Iceberg draft", 47: "Argo float", 48: "Animal loggers",
             70: "Pre-generated grid", 71: "Unknown", 72: "Steering points"}

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False,
                     "axes.spines.right": False, "savefig.dpi": 200, "savefig.bbox": "tight"})


def block_mean(a: np.ndarray, k: int) -> np.ndarray:
    h, w = a.shape
    return a[: h // k * k, : w // k * k].reshape(h // k, k, w // k, k).mean(axis=(1, 3))


def load():
    with rasterio.open(ELEV) as s:
        z = block_mean(s.read(1).astype(np.float32), DS)
    with rasterio.open(COV) as s:
        c = s.read(1)
    ocean = c > 0
    f = np.where(ocean, (c.astype(np.float32) - 1) / 254, np.nan)
    with np.errstate(invalid="ignore"):
        fo = block_mean(np.nan_to_num(f), DS)
        oc = block_mean(ocean.astype(np.float32), DS)
        frac = np.where(oc > 0.5, fo / np.maximum(oc, 1e-9), np.nan)
    return z, frac


def relief_rgb(z: np.ndarray) -> np.ndarray:
    deep = cmocean.cm.deep_r
    sea = (np.clip(z, -8000, 0) + 8000) / 8000
    land = np.clip(z, 0, 5000) / 5000
    rgb_sea = deep(sea)[..., :3]
    grey = plt.get_cmap("Greys")
    rgb_land = grey(0.25 + 0.45 * land)[..., :3]
    rgb = np.where((z < 0)[..., None], rgb_sea, rgb_land)
    # hillshade on a lat/lon grid: scale dx by cos(lat) so slopes are not stretched E-W
    lat = np.linspace(90, -90, z.shape[0])[:, None]
    dy = 111_320 * 180 / z.shape[0]
    dx = dy * np.maximum(np.cos(np.radians(lat)), 0.05)
    gy, gx = np.gradient(z, dy, axis=0), np.gradient(z, axis=1) / dx
    slope = np.pi / 2 - np.arctan(np.hypot(gx, gy) * 12)
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(315), np.radians(40)
    hs = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos(az - aspect)
    hs = np.clip(hs, 0, 1)[..., None]
    return np.clip(rgb * (0.55 + 0.6 * hs), 0, 1)


def globe_axes(fig, pos=111):
    ax = fig.add_subplot(pos, projection=ccrs.EqualEarth(central_longitude=150))
    ax.set_global()
    ax.spines["geo"].set_linewidth(0.6)
    return ax


def fig1(z: np.ndarray) -> None:
    fig = plt.figure(figsize=(12, 6.4))
    ax = globe_axes(fig)
    ax.imshow(relief_rgb(z), extent=[-180, 180, -90, 90], transform=ccrs.PlateCarree(),
              origin="upper", interpolation="bilinear", regrid_shape=(2400, 4800))
    sm = plt.cm.ScalarMappable(cmap=cmocean.cm.deep_r, norm=plt.Normalize(-8000, 0))
    cb = fig.colorbar(sm, ax=ax, orientation="horizontal", fraction=0.035, pad=0.03, shrink=0.45)
    cb.set_ticks([-8000, -6000, -4000, -2000, 0])
    cb.set_label("Seafloor depth (m)")
    ax.set_title("The seafloor of the whole Earth — GEBCO_2026 (15″ grid, shown at 4′)", fontsize=13)
    fig.text(0.5, 0.01, CITE, ha="center", fontsize=7, color="0.35")
    fig.savefig(FIG / "fig1_seafloor.png")
    plt.close(fig)


def fig2(z: np.ndarray, frac: np.ndarray, stats: dict) -> None:
    fig = plt.figure(figsize=(12, 6.4))
    ax = globe_axes(fig)
    base = np.full(z.shape + (3,), 0.86)
    base[z >= 0] = 0.97
    ax.imshow(base, extent=[-180, 180, -90, 90], transform=ccrs.PlateCarree(), origin="upper",
              regrid_shape=(1800, 3600))
    cmap = ListedColormap(plt.get_cmap("magma_r")(np.linspace(0.08, 0.85, 256)))
    m = np.ma.masked_where(~(frac > 0.02), frac)
    im = ax.imshow(m, extent=[-180, 180, -90, 90], transform=ccrs.PlateCarree(), origin="upper",
                   cmap=cmap, vmin=0, vmax=1, regrid_shape=(2400, 4800), interpolation="nearest")
    cb = fig.colorbar(im, ax=ax, orientation="horizontal", fraction=0.035, pad=0.03, shrink=0.45)
    cb.set_label("Share of each 4′ cell measured directly by ship, lidar or other sounding (TID 10–17)")
    pct = 100 * stats["measured_fraction_area"]
    ax.set_title(f"Only {pct:.1f}% of the seafloor is directly measured; grey = predicted from satellite gravity",
                 fontsize=13)
    fig.text(0.5, 0.01, CITE + " — Type Identifier grid", ha="center", fontsize=7, color="0.35")
    fig.savefig(FIG / "fig2_measured.png")
    plt.close(fig)


def fig3(stats: dict) -> None:
    e = np.array(stats["depth_bins_m"], dtype=float)
    mid = (e[:-1] + e[1:]) / 2
    area = np.array(stats["depth_ocean_area_rel"]) * 100
    mf = np.array(stats["depth_measured_fraction"], dtype=float) * 100
    fig, (a, b) = plt.subplots(1, 2, figsize=(11, 5.2), sharey=True)
    a.barh(-mid / 1000, area, height=0.25, color=cmocean.cm.deep(0.65))
    a.set_xlabel("Share of ocean area per 250 m depth bin (%)")
    a.set_ylabel("Depth (km)")
    a.invert_yaxis()
    a.set_title("How deep is the ocean floor?")
    ok = area > 0.02
    b.plot(mf[ok], -mid[ok] / 1000, color="#b3367a", lw=2)
    b.axvline(100 * stats["measured_fraction_area"], color="0.4", ls="--", lw=1)
    b.text(100 * stats["measured_fraction_area"] + 1, 10.6, "global mean", color="0.35", fontsize=8)
    b.set_xlabel("Directly measured (%)")
    b.set_xlim(0, 100)
    b.set_title("How much of each depth is measured?")
    fig.suptitle("Ocean hypsometry and mapping coverage, GEBCO_2026", fontsize=13)
    fig.text(0.5, -0.02, CITE + ". Depth = 1′ cell mean; coverage from 15″ TID cells, area-weighted.",
             ha="center", fontsize=7, color="0.35")
    fig.tight_layout()
    fig.savefig(FIG / "fig3_depth.png")
    plt.close(fig)


def fig4(stats: dict) -> None:
    le = np.array(stats["lat_edges"], dtype=float)
    lm = (le[:-1] + le[1:]) / 2
    lf = np.array(stats["lat_measured_fraction"], dtype=float) * 100
    la = np.array(stats["lat_ocean_area_rel"]) * 100
    codes = {int(k): v["ocean_fraction"] for k, v in stats["codes"].items() if int(k) != 0}
    top = sorted(((k, v) for k, v in codes.items() if v >= 1e-4), key=lambda kv: -kv[1])
    rest = sum(v for v in codes.values() if v < 1e-4)
    if rest > 0:
        top.append((-1, rest))
    fig, (a, b) = plt.subplots(1, 2, figsize=(12, 5.4), gridspec_kw={"width_ratios": [1, 1.25]})
    ok = la > 0.05
    a.barh(lm[ok], lf[ok], height=4.2, color="#b3367a")
    a.set_xlabel("Directly measured (%)")
    a.set_ylabel("Latitude band (5°)")
    a.set_yticks(range(-80, 81, 20))
    a.set_title("Measured share by latitude")
    labels = [f"{TID_NAMES.get(k, k)} ({k})" if k >= 0 else "Other sources (< 0.01% each)" for k, _ in top]
    vals = [100 * v for _, v in top]
    cols = ["#b3367a" if 10 <= k <= 17 else ("0.6" if 40 <= k <= 48 else "0.8") for k, _ in top]
    b.barh(range(len(top)), vals, color=cols)
    b.set_yticks(range(len(top)), labels, fontsize=8)
    b.invert_yaxis()
    b.set_xscale("log")
    b.set_xlim(5e-3, 200)
    b.set_xlabel("Share of ocean area (%, log scale)")
    b.set_title("What each seafloor cell is based on (TID code)")
    for i, v in enumerate(vals):
        b.text(v * 1.08, i, f"{v:.3g}%", va="center", fontsize=7)
    fig.text(0.5, -0.02, CITE + ". Magenta = direct measurement, grey = indirect, light = unknown.",
             ha="center", fontsize=7, color="0.35")
    fig.tight_layout()
    fig.savefig(FIG / "fig4_latitude_sources.png")
    plt.close(fig)


def fig5(z: np.ndarray) -> None:
    """Newly measured seafloor between the GEBCO_2025 and GEBCO_2026 grids (needs pipeline/change.py)."""
    npz = ROOT / "data/derived/new_measured_4arcmin.npz"
    js = ROOT / "data/derived/change_2025_2026.json"
    if not (npz.exists() and js.exists()):
        return
    d = np.load(npz)
    ch = json.loads(js.read_text())
    fig = plt.figure(figsize=(12, 6.4))
    ax = globe_axes(fig)
    base = np.full(z.shape + (3,), 0.88)
    base[z >= 0] = 0.97
    m25 = d["m25"][: z.shape[0], : z.shape[1]]
    base[(z < 0) & (m25 > 0.25)] = 0.70  # already measured in 2025
    ax.imshow(base, extent=[-180, 180, -90, 90], transform=ccrs.PlateCarree(), origin="upper",
              regrid_shape=(1800, 3600))
    new = d["new"][: z.shape[0], : z.shape[1]]
    # dilate 1 px so thin new survey lines stay visible at this scale
    big = np.maximum.reduce([np.roll(np.roll(new, i, 0), j, 1) for i in (-1, 0, 1) for j in (-1, 0, 1)])
    m = np.ma.masked_where(big < 0.02, big)
    ax.imshow(m, extent=[-180, 180, -90, 90], transform=ccrs.PlateCarree(), origin="upper",
              cmap=ListedColormap(["#e4572e"]), vmin=0, vmax=1, regrid_shape=(2400, 4800), interpolation="nearest")
    new_m = ch["newly_measured_km2"] / 1e6
    net = ch["net_km2"] / 1e6
    ax.set_title(f"New in GEBCO_2026: {new_m:.1f} million km\u00b2 newly counted as directly measured (red)",
                 fontsize=13)
    fig.text(0.5, 0.06,
             f"Measured share {100 * ch['measured_2025_frac']:.1f}% (2025 grid) \u2192 {100 * ch['measured_2026_frac']:.1f}% (2026 grid), "
             f"net +{net:.1f} million km\u00b2 ({ch['no_longer_measured_km2'] / 1e6:.1f} M km\u00b2 went the other way). "
             "Red includes older surveys newly contributed. Dark grey = measured in 2025.",
             ha="center", fontsize=9, color="0.25")
    fig.text(0.5, 0.01, CITE + " and GEBCO_2025 (doi:10.5285/37c52e96-24ea-67ce-e063-7086abc05f29), TID grids",
             ha="center", fontsize=7, color="0.35")
    fig.savefig(FIG / "fig5_new_in_2026.png")
    plt.close(fig)


def main() -> None:
    FIG.mkdir(exist_ok=True)
    stats = json.loads(STATS.read_text())
    z, frac = load()
    fig1(z)
    fig2(z, frac, stats)
    fig3(stats)
    fig4(stats)
    fig5(z)
    print("figures written:", sorted(p.name for p in FIG.glob("*.png")))


if __name__ == "__main__":
    main()
