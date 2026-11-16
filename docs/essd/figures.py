"""Figures for the ESSD data description of the seafloor measured record (docs/essd/manuscript.tex).

Usage (from the repository root):
    .venv/bin/python docs/essd/figures.py            # all figures
    .venv/bin/python docs/essd/figures.py fig1 fig3  # selected figures

Inputs are the dataset files only:
    dataset/build/seafloor_measured_record_2019_2026.nc   (Fig. 1; aggregated once to 4 arc-min and cached in
                                                           dataset/build/essd_fig1_4arcmin.npz, git-ignored)
    dataset/tables/global_by_release.csv                  (Fig. 2)
    dataset/tables/recoded_away_by_destination_tid.csv    (Fig. 3)
    dataset/tables/cellsize_sensitivity_2026.csv          (Fig. 4)
    dataset/tables/by_depth_bin_by_release.csv            (Fig. 5)
Outputs: docs/essd/fig/fig0N_*.{png,pdf}. No titles inside figures (captions carry the text), white background,
CVD-friendly colours (viridis for the ordered release classes, Okabe-Ito for categories). Colour roles are the
same in every figure: orange = official Seabed 2030 figure only; blue = measured share of this record; vermillion =
re-coded away; the TID destination codes use hues not used for anything else.
"""
from __future__ import annotations

import csv
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
TABLES = ROOT / "dataset" / "tables"
NC = ROOT / "dataset" / "build" / "seafloor_measured_record_2019_2026.nc"
CACHE = ROOT / "dataset" / "build" / "essd_fig1_4arcmin.npz"
OUT = Path(__file__).resolve().parent / "fig"
YEARS = list(range(2019, 2027))
AGG = 16  # 15" cells per 4' block side

# Okabe-Ito palette (CVD-safe categorical)
OI = {"black": "#000000", "orange": "#E69F00", "sky": "#56B4E9", "green": "#009E73", "yellow": "#F0E442",
      "blue": "#0072B2", "vermillion": "#D55E00", "purple": "#CC79A7", "grey": "#999999"}

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 8, "axes.labelsize": 8, "xtick.labelsize": 7.5,
    "ytick.labelsize": 7.5, "legend.fontsize": 7.5, "axes.linewidth": 0.6, "xtick.major.width": 0.6,
    "ytick.major.width": 0.6, "savefig.dpi": 300, "savefig.facecolor": "white", "figure.facecolor": "white",
    "pdf.fonttype": 42, "axes.spines.top": False, "axes.spines.right": False,
})


def rows(name: str) -> list[dict]:
    with open(TABLES / name, newline="") as f:
        return list(csv.DictReader(f))


def panel(ax, letter: str, x: float = -0.12, y: float = 1.02) -> None:
    ax.text(x, y, f"({letter})", transform=ax.transAxes, fontsize=9, fontweight="bold", va="bottom", ha="left")


def save(fig, stem: str, formats=("pdf", "png")) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for ext in formats:
        fig.savefig(OUT / f"{stem}.{ext}", bbox_inches="tight", pad_inches=0.03)
    plt.close(fig)


# ---------------------------------------------------------------- Fig. 1 (map)

def aggregate_4arcmin() -> dict:
    """OR of the per-release bitmask and 'any ocean' over 16 x 16 blocks of 15" cells (= 4' cells).

    Rows are ascending in latitude (south first), as in the netCDF file.
    """
    if CACHE.exists():
        z = np.load(CACHE)
        return {k: z[k] for k in z.files}
    import netCDF4

    with netCDF4.Dataset(NC) as ds:
        flags_v, ocean_v = ds["measured_release_flags"], ds["ocean_mask"]
        flags_v.set_auto_mask(False)
        ocean_v.set_auto_mask(False)
        h, w = flags_v.shape
        flags4 = np.zeros((h // AGG, w // AGG), np.uint8)
        ocean4 = np.zeros((h // AGG, w // AGG), bool)
        strip = 720
        for i0 in range(0, h, strip):
            f = np.asarray(flags_v[i0:i0 + strip, :]).astype(np.uint8)
            o = np.asarray(ocean_v[i0:i0 + strip, :]) > 0
            fb = f.reshape(strip // AGG, AGG, w // AGG, AGG)
            flags4[i0 // AGG:(i0 + strip) // AGG] = np.bitwise_or.reduce(np.bitwise_or.reduce(fb, axis=3), axis=1)
            ocean4[i0 // AGG:(i0 + strip) // AGG] = o.reshape(strip // AGG, AGG, w // AGG, AGG).any(axis=(1, 3))
            print(f"  rows {i0}..{i0 + strip} of {h}", end="\r", flush=True)
    print()
    np.savez_compressed(CACHE, flags4=flags4, ocean4=ocean4)
    return {"flags4": flags4, "ocean4": ocean4}


def fig1() -> None:
    import cartopy.crs as ccrs
    from matplotlib.patches import Patch

    a = aggregate_4arcmin()
    flags4, ocean4 = a["flags4"], a["ocean4"]
    first = np.full(flags4.shape, -1, np.int8)                 # index of first release with a measured sub-cell
    for k in range(len(YEARS) - 1, -1, -1):
        first[(flags4 >> k) & 1 == 1] = k
    recoded = (flags4 > 0) & ((flags4 >> (len(YEARS) - 1)) & 1 == 0)  # measured earlier, no sub-cell measured in 2026

    year_cols = [plt.cm.viridis(v) for v in np.linspace(0.0, 0.93, len(YEARS))]   # distinct steps 2019 .. 2026
    never = (0.80, 0.80, 0.80)
    rec_col = matplotlib.colors.to_rgb(OI["vermillion"])
    rgb = np.ones(flags4.shape + (3,), np.float32)              # land and outside the mask: white
    rgb[ocean4] = never
    for k in range(len(YEARS)):
        rgb[ocean4 & (first == k)] = year_cols[k][:3]
    rgb[ocean4 & recoded] = rec_col

    fig = plt.figure(figsize=(7.0, 3.95))
    ax = fig.add_axes([0.0, 0.1, 1.0, 0.9], projection=ccrs.EqualEarth(central_longitude=150))
    ax.set_global()
    ax.imshow(rgb, extent=[-180, 180, -90, 90], transform=ccrs.PlateCarree(), origin="lower",
              regrid_shape=(2700, 5400), interpolation="nearest")
    ax.spines["geo"].set_linewidth(0.5)
    ax.gridlines(color="0.55", linewidth=0.25, alpha=0.6, xlocs=range(-180, 181, 60), ylocs=range(-60, 61, 30))
    handles = [Patch(facecolor=year_cols[k], edgecolor="none", label=str(y)) for k, y in enumerate(YEARS)]
    handles += [Patch(facecolor=rec_col, edgecolor="none", label="earlier, not 2026"),
                Patch(facecolor=never, edgecolor="none", label="never")]
    fig.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 0.0), ncol=10, frameon=False,
               handlelength=1.2, handletextpad=0.4, columnspacing=0.8, fontsize=7,
               title="First GEBCO release with a directly measured 15″ cell (TID 10–17)",
               title_fontsize=7.5)
    save(fig, "fig01_first_measured_map", formats=("png",))


# ---------------------------------------------------------------- Fig. 2 (per-release shares)

def fig2() -> None:
    g = rows("global_by_release.csv")
    yr = [int(r["release"]) for r in g]
    meas = [100 * float(r["measured_share_fraction"]) for r in g]
    ever = [100 * float(r["ever_measured_share_fraction"]) for r in g]
    off = [100 * float(r["official_seabed2030_share_fraction"]) for r in g]

    fig, ax = plt.subplots(figsize=(4.7, 3.0))
    ax.plot(yr, ever, color=OI["black"], lw=1.1, ls="--", marker="o", ms=3.2, mfc="white",
            label="Measured in this or any earlier release")
    ax.plot(yr, meas, color=OI["blue"], lw=1.6, marker="o", ms=4, label="Measured in this release (TID 10–17)")
    ax.plot(yr, off, color=OI["orange"], lw=1.6, marker="s", ms=4, label="Seabed 2030 announced figure")
    for series, col, dy in ((ever, OI["black"], 2), (meas, OI["blue"], -3), (off, OI["orange"], -9)):
        ax.annotate(f"{series[-1]:.1f}", (yr[-1], series[-1]), textcoords="offset points", xytext=(5, dy),
                    fontsize=7, color=col, va="center")
    ax.annotate(f"{meas[0]:.1f}", (yr[0], meas[0]), textcoords="offset points", xytext=(-5, -2), fontsize=7,
                color=OI["blue"], ha="right", va="center")
    ax.annotate(f"{off[0]:.1f}", (yr[0], off[0]), textcoords="offset points", xytext=(-5, 2), fontsize=7,
                color=OI["orange"], ha="right", va="center")
    ax.set_xlim(2018.1, 2026.8)
    ax.set_xticks(yr, [f"{y}" for y in yr])
    ax.set_xlabel("GEBCO grid release")
    ax.set_ylabel("Share of the ocean area (%)")
    ax.set_ylim(0, 36)
    ax.grid(axis="y", color="0.9", lw=0.5)
    ax.legend(frameon=False, loc="lower right")
    save(fig, "fig02_share_by_release")


# ---------------------------------------------------------------- Fig. 3 (re-coded away by destination)

def fig3() -> None:
    d = rows("recoded_away_by_destination_tid.csv")
    groups = [("40", "40 satellite-gravity prediction", OI["blue"]),
              ("41", "41 interpolation", OI["sky"]),
              ("44", "44 gridded, gravity-guided", OI["green"]),
              ("70", "70 pre-generated grid", OI["purple"]),
              ("other", "other (0, 42, 43, 45, 47, 48, 71, 72)", OI["grey"])]
    trans = sorted({(int(r["from_release"]), int(r["to_release"])) for r in d})
    area = defaultdict(float)
    for r in d:
        key = r["destination_tid"] if r["destination_tid"] in {"40", "41", "44", "70"} else "other"
        area[(int(r["from_release"]), key)] += float(r["area_km2"]) / 1e6
    x = np.arange(len(trans))
    fig, ax = plt.subplots(figsize=(6.3, 3.0))
    bottom = np.zeros(len(trans))
    for key, label, col in groups:
        v = np.array([area[(a, key)] for a, _ in trans])
        ax.bar(x, v, bottom=bottom, color=col, width=0.7, label=label, edgecolor="white", linewidth=0.3)
        bottom += v
    for xi, tot in zip(x, bottom):
        ax.text(xi, tot + 0.06, f"{tot:.2f}", ha="center", va="bottom", fontsize=7)
    ax.set_xticks(x, [f"{a}\n→ {b}" for a, b in trans])
    ax.set_xlabel("Release transition")
    ax.set_ylabel("Area re-coded away (million km²)")
    ax.set_ylim(0, 5.0)
    ax.grid(axis="y", color="0.9", lw=0.5)
    ax.set_axisbelow(True)
    ax.legend(frameon=False, loc="upper left", bbox_to_anchor=(1.0, 1.0), title="TID code in the later release",
              title_fontsize=7.5, fontsize=7, alignment="left")
    save(fig, "fig03_recoded_by_destination")


# ---------------------------------------------------------------- Fig. 4 (cell-size sensitivity)

def fig4() -> None:
    import cmocean

    c = rows("cellsize_sensitivity_2026.csv")
    bands = defaultdict(list)
    glob = {}
    for r in c:
        if r["scope"] == "band":
            if float(r["ocean_area_km2"]) < 1000:  # drops 80-85 S (32 km2 of ocean)
                continue
            bands[r["variant"]].append((float(r["lat_south_deg"]), float(r["lat_north_deg"]),
                                        100 * float(r["measured_share_fraction"])))
        else:
            glob[r["variant"]] = (float(r["nominal_block_size_m"]), 100 * float(r["measured_share_fraction"]))
    size_col = {"ew1": cmocean.cm.deep(0.35), "ew2": cmocean.cm.deep(0.62), "ew4": cmocean.cm.deep(0.9)}
    size_lab = {"ew1": "~463 m", "ew2": "~926 m", "ew4": "~1853 m"}

    fig, (a, b) = plt.subplots(1, 2, figsize=(7.0, 3.7), gridspec_kw={"width_ratios": [1.55, 1], "wspace": 0.32})
    nat = sorted(bands["native"])
    lat_c = [(s + n) / 2 for s, n, _ in nat]
    a.plot([v for *_, v in nat], lat_c, color="black", lw=1.6, label="native 15″ cells", zorder=5)
    for fam in ("ew1", "ew2", "ew4"):
        for rule, ls in (("any", "-"), ("majority", "--")):
            if fam != "ew1" and rule == "majority":
                continue  # majority variants nearly coincide; shown in panel (b)
            s = sorted(bands[f"{fam}_{rule}"])
            a.plot([v for *_, v in s], [(p + q) / 2 for p, q, _ in s], color=size_col[fam], lw=1.2, ls=ls,
                   label=f"{size_lab[fam]} blocks, {rule} rule")
    a.set_ylim(-80, 90)  # southernmost band shown: 75-80 S
    a.set_yticks(range(-75, 91, 15), [f"{abs(t)}°{'N' if t > 0 else ('S' if t < 0 else '')}"
                                       for t in range(-75, 91, 15)])
    a.set_xlim(0, 80)
    a.set_xlabel("Measured share of the band's ocean area (%)")
    a.set_ylabel("Latitude (5° band centre)")
    a.grid(color="0.9", lw=0.5)
    a.legend(frameon=False, loc="upper center", bbox_to_anchor=(0.75, -0.16), ncol=2, fontsize=7)
    panel(a, "a", x=-0.16)

    sizes = [glob[f"{f}_any"][0] for f in ("ew1", "ew2", "ew4")]
    b.axhline(glob["native"][1], color="black", lw=1.0, label="native 15″ cells")
    b.plot(sizes, [glob[f"{f}_any"][1] for f in ("ew1", "ew2", "ew4")], color=OI["blue"], marker="o",
           ms=4, lw=1.4, label="any rule")
    b.plot(sizes, [glob[f"{f}_majority"][1] for f in ("ew1", "ew2", "ew4")], color=OI["sky"], marker="s",
           ms=4, lw=1.4, ls="--", label="majority rule")
    for f in ("ew1", "ew2", "ew4"):
        for rule, dy in (("any", 6), ("majority", -9)):
            sz, v = glob[f"{f}_{rule}"]
            b.annotate(f"{v:.1f}", (sz, v), textcoords="offset points", xytext=(0, dy), ha="center", fontsize=7)
    b.set_xscale("log")
    b.set_xticks(sizes, ["463", "926", "1853"])
    b.minorticks_off()
    b.set_xlim(380, 2300)
    b.set_ylim(0, 40)
    b.set_xlabel("Nominal block size (m)")
    b.set_ylabel("Global measured share (%)")
    b.grid(axis="y", color="0.9", lw=0.5)
    b.legend(frameon=False, loc="lower right", fontsize=7)
    panel(b, "b", x=-0.24)
    save(fig, "fig04_cellsize_latitude")


# ---------------------------------------------------------------- Fig. 5 (depth bins, 2019 vs 2026)

def fig5() -> None:
    d = rows("by_depth_bin_by_release.csv")
    by = defaultdict(dict)
    for r in d:
        by[int(r["release"])][(float(r["depth_min_m"]), float(r["depth_max_m"]))] = (
            float(r["ocean_area_km2"]), float(r["measured_area_km2"]))
    keys = sorted(by[2026])
    tot = sum(v[0] for v in by[2026].values())
    top = np.array([k[0] for k in keys]) / 1000
    h = np.array([k[1] - k[0] for k in keys]) / 1000
    area_pct = np.array([100 * by[2026][k][0] / tot for k in keys])

    fig, (a, b) = plt.subplots(1, 2, figsize=(5.6, 3.6), sharey=True, gridspec_kw={"width_ratios": [1, 1.5],
                                                                                    "wspace": 0.12})
    a.barh(top, area_pct, height=h, align="edge", color="0.6", edgecolor="white", linewidth=0.2)
    a.set_xlabel("Share of the ocean area (%)")
    a.set_ylabel("Depth (km), GEBCO_2026 1′ cell")
    a.set_ylim(11, 0)
    a.grid(axis="x", color="0.9", lw=0.5)
    panel(a, "a", x=-0.3)
    for yr, col, ls in ((2019, OI["black"], "--"), (2026, OI["blue"], "-")):
        share = np.array([100 * by[yr][k][1] / by[yr][k][0] if by[yr][k][0] > 0 else np.nan for k in keys])
        ys = np.column_stack([top, top + h]).ravel()           # one vertical segment per bin, joined
        b.plot(np.repeat(share, 2), ys, color=col, lw=1.3, ls=ls, label=f"GEBCO_{yr}")
    b.set_xlabel("Measured share of the depth bin (%)")
    b.set_xlim(0, 100)
    b.grid(axis="x", color="0.9", lw=0.5)
    b.legend(frameon=False, loc="upper right")
    panel(b, "b", x=-0.08)
    save(fig, "fig05_depth_2019_2026")


FIGS = {"fig1": fig1, "fig2": fig2, "fig3": fig3, "fig4": fig4, "fig5": fig5}

if __name__ == "__main__":
    for name in (sys.argv[1:] or list(FIGS)):
        FIGS[name]()
        print("done", name)
