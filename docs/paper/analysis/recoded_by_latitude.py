"""Where is the area that was measured (TID 10-17) in an earlier GEBCO release but not in GEBCO_2026?
Also: per release, latitude of the area that left TID 10-17 vs the previous release."""
import json, sys
from pathlib import Path
import numpy as np, rasterio
ROOT = Path(__file__).resolve().parents[3]  # repository root (docs/paper/analysis/ -> root)
RAW = ROOT / "data/raw"
YEARS = list(range(2019, 2027))
R = 6371.0072
H15, W15 = 43200, 86400
srcs = {y: rasterio.open(RAW / f"gebco_{y}/gebco_{y}_tid.tif") for y in YEARS}
elev = rasterio.open(RAW / "gebco_2026/gebco_2026_elev_1arcmin.tif")
edges = np.array([-90, -60, -30, 0, 30, 60, 66.5, 90.0])
nb = len(edges) - 1
ocean_b = np.zeros(nb); ever_b = np.zeros(nb); rec_b = np.zeros(nb)
lost_b = {y: np.zeros(nb) for y in YEARS[1:]}
rec_code = np.zeros(128)
d = np.radians(1 / 240)
step = 480
for r0 in range(0, H15, step):
    n = step
    win = rasterio.windows.Window(0, r0, W15, n)
    h = elev.read(1, window=rasterio.windows.Window(0, r0 // 4, W15 // 4, n // 4))
    sea = np.repeat(np.repeat(h < 0, 4, axis=0), 4, axis=1)
    t26 = srcs[2026].read(1, window=win)
    ocean = sea & (t26 != 0)
    phi = np.radians(90 - (r0 + np.arange(n)) / 240)
    a = (R ** 2) * d * (np.sin(phi) - np.sin(phi - d))
    lat = 90 - (r0 + np.arange(n) + 0.5) / 240
    bi = np.clip(np.digitize(lat, edges) - 1, 0, nb - 1)
    np.add.at(ocean_b, bi, (ocean * a[:, None]).sum(1))
    ever = np.zeros_like(ocean); prev = None
    for y in YEARS:
        t = t26 if y == 2026 else srcs[y].read(1, window=win)
        m = ocean & (t >= 10) & (t <= 17)
        ever |= m
        if prev is not None:
            np.add.at(lost_b[y], bi, ((prev & ~m) * a[:, None]).sum(1))
        prev = m
    now = prev
    rec = ever & ~now
    np.add.at(ever_b, bi, (ever * a[:, None]).sum(1))
    np.add.at(rec_b, bi, (rec * a[:, None]).sum(1))
    A = np.broadcast_to(a[:, None], rec.shape)
    rec_code += np.bincount(t26[rec].astype(np.int16) & 127, weights=A[rec], minlength=128)[:128]
    print(f"\r{r0+n}/{H15}", end="", file=sys.stderr)
out = {"lat_edges": edges.tolist(), "ocean_km2": ocean_b.round().tolist(), "ever_km2": ever_b.round().tolist(),
       "recoded_ever_not_2026_km2": rec_b.round().tolist(),
       "recoded_total_km2": float(rec_b.sum()), "ever_total_km2": float(ever_b.sum()), "ocean_total_km2": float(ocean_b.sum()),
       "recoded_2026_code_km2": {str(c): round(float(rec_code[c])) for c in np.argsort(rec_code)[::-1] if rec_code[c] > 1e3},
       "lost_vs_previous_by_lat_km2": {str(y): v.round().tolist() for y, v in lost_b.items()}}
p = Path(__file__).with_suffix(".json"); p.write_text(json.dumps(out, indent=1)); print(json.dumps(out, indent=1))
