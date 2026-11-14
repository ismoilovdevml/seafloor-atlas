"""How deep are the deepest places on the GEBCO_2026 15" grid, vs published surveys? And the ocean's volume.

Trenches: the published depths and positions of 14 deep places are taken from Hotham (2026),
"How Deep Is the Sea?", Zenodo doi:10.5281/zenodo.23850291 (CC BY 4.0), file trenches.csv, which cites
Greenaway et al. 2021, Bongiovanni, Stewart & Jamieson 2022, Stewart & Jamieson 2019 and Wikipedia.
For each place we take the deepest 15" GEBCO cell within +-BOX degrees of the published point, its
TID code (was it measured?), and set it beside the published depth and Hotham's 10 km grid value.

Ocean volume / mean depth: 15" grid, ocean = TID != 0 and elevation < 0, Caspian box excluded,
true spherical cell areas (R = 6371.0072 km). Compared with Charette & Smith (2010), Oceanography 23(2).

Outputs: data/derived/trenches.json, docs/trenches.md, figures/fig9_trenches.png
"""
from __future__ import annotations

import csv
import io
import json
import urllib.request
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from rasterio.windows import Window  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ELEV15 = ROOT / "data/raw/gebco_2026/GEBCO_2026_15s.tif"
TID15 = ROOT / "data/raw/gebco_2026/gebco_2026_tid.tif"
RAW = ROOT / "data/raw/hotham/trenches.csv"
URL = "https://zenodo.org/records/23850291/files/trenches.csv?download=1"
BOX = 0.25           # degrees around the published point
R_KM = 6371.0072
CASPIAN = (46.0, 55.5, 36.0, 47.5)  # lon0, lon1, lat0, lat1


def load_table() -> list[dict]:
    if not RAW.exists():
        RAW.parent.mkdir(parents=True, exist_ok=True)
        RAW.write_bytes(urllib.request.urlopen(URL, timeout=120).read())
    return list(csv.DictReader(io.StringIO(RAW.read_text())))


def deepest_near(e, t, lon: float, lat: float) -> dict:
    inv = ~e.transform
    c0, r0 = inv * (lon - BOX, lat + BOX)
    c1, r1 = inv * (lon + BOX, lat - BOX)
    c0, r0, c1, r1 = int(np.floor(c0)), int(np.floor(r0)), int(np.ceil(c1)), int(np.ceil(r1))
    win = Window(c0, r0, c1 - c0, r1 - r0)
    z = e.read(1, window=win).astype(float)
    tid = t.read(1, window=win)
    i = np.unravel_index(np.argmin(z), z.shape)
    x, y = e.transform * (c0 + i[1] + 0.5, r0 + i[0] + 0.5)
    pc, pr = inv * (lon, lat)
    at_point = float(e.read(1, window=Window(int(pc), int(pr), 1, 1))[0, 0])
    return {"gebco_min_m": -float(z[i]), "gebco_min_lon": round(x, 4), "gebco_min_lat": round(y, 4),
            "gebco_min_tid": int(tid[i]), "gebco_at_point_m": -at_point,
            "measured_share_box": float(((tid >= 10) & (tid <= 17)).mean())}


def ocean_volume(e, t) -> dict:
    d = np.radians(1 / 240)
    vol = area = 0.0
    hist = np.zeros(12)
    for r0 in range(0, e.height, 1200):
        n = min(1200, e.height - r0)
        z = e.read(1, window=Window(0, r0, e.width, n)).astype(np.float64)
        tid = t.read(1, window=Window(0, r0, t.width, n))
        lat_top = 90 - r0 / 240
        phi = np.radians(lat_top - np.arange(n) / 240)
        a = (R_KM ** 2) * d * (np.sin(phi) - np.sin(phi - d))  # km2 per cell in each row
        ocean = (tid != 0) & (z < 0)
        lat_c = lat_top - (np.arange(n) + 0.5) / 240
        lon_c = -180 + (np.arange(e.width) + 0.5) / 240
        rows = (lat_c > CASPIAN[2]) & (lat_c < CASPIAN[3])
        if rows.any():
            cols = (lon_c > CASPIAN[0]) & (lon_c < CASPIAN[1])
            ocean[np.ix_(rows, cols)] = False
        A = np.broadcast_to(a[:, None], z.shape)
        area += A[ocean].sum()
        vol += (A[ocean] * (-z[ocean]) / 1000.0).sum()  # km3
        hist += np.bincount(np.clip((-z[ocean] // 1000).astype(int), 0, 11), weights=A[ocean], minlength=12)
    return {"ocean_area_km2": area, "volume_km3": vol, "mean_depth_m": 1000 * vol / area,
            "area_by_km_band": (hist / area).tolist(),
            "reference": "Charette & Smith (2010): mean depth 3,682 m, volume 1.332e9 km3"}


def main() -> None:
    rows = load_table()
    out = []
    with rasterio.open(ELEV15) as e, rasterio.open(TID15) as t:
        for r in rows:
            g = deepest_near(e, t, float(r["point_lon"]), float(r["point_lat"]))
            pub = float(r["published_depth_m"])
            out.append({"trench": r["trench"], "place": r["deepest_point"], "ocean": r["ocean"],
                        "published_m": pub, "published_unc_m": r["published_uncertainty_m"] or None,
                        "published_source": r["source"], "point_is_published": r["point_is_published"] == "1",
                        "hotham_10km_m": float(r["deepest_grid_cell_m"]), **g,
                        "published_minus_gebco_m": pub - g["gebco_min_m"],
                        "published_minus_10km_m": pub - float(r["deepest_grid_cell_m"])})
        vol = ocean_volume(e, t)
    res = {"box_deg": BOX, "trenches": out, "ocean": vol,
           "source_table": "Hotham (2026) How Deep Is the Sea?, doi:10.5281/zenodo.23850291, CC BY 4.0"}
    (ROOT / "data/derived/trenches.json").write_text(json.dumps(res, indent=1))

    d15 = np.array([o["published_minus_gebco_m"] for o in out])
    d10 = np.array([o["published_minus_10km_m"] for o in out])
    lines = ["# The deepest places: GEBCO_2026 15″ vs published depths", "",
             f"Deepest GEBCO_2026 15″ cell within ±{BOX}° of each published point, beside the published depth and the 10 km grid "
             "value of Hotham (2026). Published depths and positions: Hotham (2026), *How Deep Is the Sea?*, "
             "[doi:10.5281/zenodo.23850291](https://doi.org/10.5281/zenodo.23850291) (CC BY 4.0), who cites the original surveys "
             "(Greenaway et al. 2021; Bongiovanni, Stewart & Jamieson 2022; Stewart & Jamieson 2019; Wikipedia).", "",
             "| Place | Published (m) | GEBCO 15″ (m) | Diff (m) | 10 km grid (m) | Diff (m) | Deepest cell measured? |",
             "|---|---:|---:|---:|---:|---:|---|"]
    for o in out:
        meas = "yes (TID %d)" % o["gebco_min_tid"] if 10 <= o["gebco_min_tid"] <= 17 else "no (TID %d)" % o["gebco_min_tid"]
        lines.append(f"| {o['place']}, {o['trench']} | {o['published_m']:,.0f} | {o['gebco_min_m']:,.0f} | "
                     f"{o['published_minus_gebco_m']:+,.0f} | {o['hotham_10km_m']:,.0f} | {o['published_minus_10km_m']:+,.0f} | {meas} |")
    unpub = [o["place"] + ", " + o["trench"] for o in out if not o["point_is_published"]]
    lines += ["", "Notes: for " + "; ".join(unpub) + " the source gives a depth but no position; the reference point is "
              "Hotham's 10 km grid cell, so the true deepest spot may lie outside our search box, and Wikipedia-sourced depths "
              "are often older soundings. Where the deepest cell is not measured (TID 40 = satellite-gravity estimate), "
              "a large difference is expected."]
    lines += ["", f"Median |published − grid|: **{np.median(np.abs(d15)):.0f} m** on GEBCO_2026 15″ vs "
              f"**{np.median(np.abs(d10)):.0f} m** on the 10 km grid (max {np.abs(d15).max():.0f} vs {np.abs(d10).max():.0f} m).", "",
              "## Ocean volume and mean depth (GEBCO_2026 15″)", "",
              f"* Ocean area {vol['ocean_area_km2'] / 1e6:.1f} million km², mean depth **{vol['mean_depth_m']:,.0f} m**, "
              f"volume **{vol['volume_km3'] / 1e9:.3f} billion km³**.",
              "* Charette & Smith (2010): 3,682 m and 1.332 billion km³. Hotham (2026, 10 km grid): 3,675 m and 1.33 billion km³.",
              "* Ocean = TID ≠ 0 and below sea level, Caspian excluded. Water under floating ice shelves is not counted "
              "(the grid holds the ice surface there), which makes our area and volume slightly smaller."]
    (ROOT / "docs/trenches.md").write_text("\n".join(lines) + "\n")

    fig, ax = plt.subplots(figsize=(9, 6.2))
    yy = np.arange(len(out))[::-1]
    ax.scatter([o["published_m"] for o in out], yy, marker="|", s=260, color="k", label="published survey", zorder=3)
    ax.scatter([o["gebco_min_m"] for o in out], yy, s=36, color="#1f77b4", label="GEBCO_2026 15″ (this project)", zorder=4)
    ax.scatter([o["hotham_10km_m"] for o in out], yy, s=36, facecolors="none", edgecolors="#d62728",
               label="10 km grid (Hotham 2026)", zorder=4)
    ax.set_yticks(yy, [f"{o['place']} ({o['trench'].split(',')[0]})" for o in out], fontsize=8)
    ax.set_xlabel("Depth (m)")
    ax.invert_xaxis()
    ax.grid(axis="x", alpha=0.3)
    ax.legend(loc="lower left", fontsize=8, frameon=False)
    ax.set_title(f"Deepest places: median error {np.median(np.abs(d15)):.0f} m at 15″ vs {np.median(np.abs(d10)):.0f} m at 10 km")
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    fig.text(0.5, -0.01, "Published depths/positions via Hotham (2026) doi:10.5281/zenodo.23850291 (CC BY 4.0). "
             "GEBCO Compilation Group (2026) GEBCO_2026 Grid.", ha="center", fontsize=7, color="0.35")
    fig.tight_layout()
    fig.savefig(ROOT / "figures/fig9_trenches.png", dpi=200, bbox_inches="tight")
    print(json.dumps({"median_abs_15s": float(np.median(np.abs(d15))), "median_abs_10km": float(np.median(np.abs(d10))),
                      **{k: vol[k] for k in ("ocean_area_km2", "volume_km3", "mean_depth_m")}}, indent=1))


if __name__ == "__main__":
    main()
