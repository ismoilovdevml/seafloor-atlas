"""Atlantic Meridional Overturning Circulation (AMOC) observed at 26.5 N by the RAPID-MOCHA-WBTS array.

Source: Moat B.I. et al. (2026). Atlantic meridional overturning circulation observed by the RAPID-MOCHA-WBTS array
at 26N from 2004 to 2024 (v2024-2). NERC EDS British Oceanographic Data Centre NOC.
doi:10.5285/5c39bf4e-5140-5546-e063-7086abc027bc. UK Open Government Licence v3.0.

  fetch : BODC Published Data Library download API (prepare -> check -> zip, no account) -> data/raw/amoc/
          RAPID_transports_v2024-2.nc (monthly AMOC, heat transport) and RAPID_layers_v2024-2.nc (layer transports)
  build : web/public/data/amoc.json (format in docs/data-contract.md, "AMOC at 26.5 N")
  check : prints the long-term means next to the values the RAPID papers report (AMOC ~17 Sv, heat ~1.2 PW)

Units: Sv = 10^6 m^3/s, positive northward; PW = 10^15 W. The AMOC is the maximum of the overturning streamfunction
in depth coordinates (amoc_depth_1m). Layer transports are the array's own decomposition: Florida Current, Ekman,
upper mid-ocean (UMO) and the depth classes thermocline (< 800 m), intermediate (800-1100 m), upper deep
(1100-3000 m), lower deep (3000-5000 m) and bottom water (> 5000 m). Florida Current + Ekman + UMO is the
northward limb down to the time-varying depth of the overturning maximum, so it is not a fixed-depth layer; the
fixed-depth classes thermocline + intermediate (0-1100 m) are what balance the deep classes (sum ~0 every month).
Annual means only for complete years.

usage: .venv/bin/python pipeline/amoc.py [fetch|build|check|all]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import time
import zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/amoc"
OUT = ROOT / "web/public/data/amoc.json"
DOI = "10.5285/5c39bf4e-5140-5546-e063-7086abc027bc"
API = "https://www.bodc.ac.uk/data/published_data_library/api/download"
PAGE = f"https://www.bodc.ac.uk/data/published_data_library/catalogue/{DOI}"
FILES = ("RAPID_transports_v2024-2.nc", "RAPID_layers_v2024-2.nc")
CITATION = ("Moat B.I.; Petit T.; Smeed D.; Rayner D.; Johns W.E.; Smith R.H.; Volkov D.L.; Elipot S.; Baringer M.O.; "
            "Collins J. (2026). Atlantic meridional overturning circulation observed by the RAPID-MOCHA-WBTS array at "
            f"26N from 2004 to 2024 (v2024-2). NERC EDS British Oceanographic Data Centre NOC. doi:{DOI}")
# the array runs along 26.5 N from the Florida Straits (cable) and the Bahamas to the African shelf east of the Canary
# Islands; drawn as a straight parallel, which is approximate at the two ends
LINE = [[-80.05, 26.5], [-13.6, 26.5]]
LAYERS = {  # output key: (variable in RAPID_layers, label)
    "florida_current": ("trans_FC_1m", "Florida Current"),
    "ekman": ("trans_ekm_1m", "Ekman (wind-driven surface layer)"),
    "upper_mid_ocean": ("trans_UMO_1m", "Upper mid-ocean (gyre interior, down to the time-varying depth of the "
                                        "overturning maximum, about 1,100 m)"),
    "thermocline": ("trans_the_1m", "Thermocline, < 800 m"),
    "intermediate": ("trans_aiw_1m", "Intermediate water, 800-1,100 m"),
    "upper_deep": ("trans_ud_1m", "Upper North Atlantic Deep Water, 1,100-3,000 m"),
    "lower_deep": ("trans_ld_1m", "Lower North Atlantic Deep Water, 3,000-5,000 m"),
    "bottom": ("trans_bw_1m", "Antarctic Bottom Water, > 5,000 m"),
}


def _post(url: str) -> str:
    return subprocess.run(["curl", "-s", "-X", "POST", "-H", "Content-Length: 0", url], capture_output=True, text=True,
                          check=True).stdout


def fetch() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    if all((RAW / f).exists() for f in FILES):
        print("RAPID files present")
        return
    _post(f"{API}/prepare/{DOI}")
    status: dict = {}
    for _ in range(60):
        status = json.loads(_post(f"{API}/check/{DOI}") or "{}")
        if status.get("status") == "ready":
            break
        time.sleep(10)
    if status.get("status") != "ready":
        raise SystemExit(f"BODC download not ready: {status}")
    zpath = RAW / "rapid_v2024-2.zip"
    subprocess.run(["curl", "-fL", "--retry", "5", "-C", "-", "-o", str(zpath), f"{PAGE}/{status['filename']}"], check=True)
    with zipfile.ZipFile(zpath) as z:
        for f in FILES:
            z.extract(f, RAW)
    print(f"extracted {', '.join(FILES)} to {RAW}")


def annual_means(months: list[str], values: np.ndarray) -> list[dict]:
    """Calendar-year means for years with all 12 months present (NaN months count as missing)."""
    out = []
    years = sorted({m[:4] for m in months})
    for y in years:
        v = np.array([values[i] for i, m in enumerate(months) if m.startswith(y)], dtype=float)
        if v.size == 12 and np.isfinite(v).all():
            out.append({"year": int(y), "mean": round(float(v.mean()), 2)})
    return out


def summary(months: list[str], amoc: np.ndarray) -> dict:
    ok = np.isfinite(amoc)
    lo, hi = int(np.nanargmin(amoc)), int(np.nanargmax(amoc))
    return {"mean_sv": round(float(np.nanmean(amoc)), 2), "sd_sv": round(float(np.nanstd(amoc)), 2),
            "min": {"sv": round(float(amoc[lo]), 2), "month": months[lo]},
            "max": {"sv": round(float(amoc[hi]), 2), "month": months[hi]}, "n_months": int(ok.sum())}


def build() -> None:
    import netCDF4

    T = netCDF4.Dataset(RAW / FILES[0])
    L = netCDF4.Dataset(RAW / FILES[1])
    tt = netCDF4.num2date(T["time_1m"][:], T["time_1m"].units)
    tl = netCDF4.num2date(L["time_1m"][:], L["time_1m"].units)
    months = [f"{t.year:04d}-{t.month:02d}" for t in tt]
    if months != [f"{t.year:04d}-{t.month:02d}" for t in tl]:
        raise SystemExit("transport and layer files have different months")
    get = lambda ds, k: np.ma.filled(ds[k][:].astype(float), np.nan)  # noqa: E731
    amoc, heat = get(T, "amoc_depth_1m"), get(T, "heat_trans_1m")
    r2 = lambda a: [None if not np.isfinite(x) else round(float(x), 2) for x in a]  # noqa: E731
    layers = {k: get(L, v) for k, (v, _) in LAYERS.items()}
    doc = {
        "title": "Atlantic Meridional Overturning Circulation at 26.5 N (RAPID-MOCHA-WBTS)",
        "source": "RAPID-MOCHA-WBTS moored array, v2024-2 (NOC, University of Miami RSMAS, NOAA AOML)",
        "doi": DOI, "citation": CITATION, "licence": "UK Open Government Licence v3.0",
        "units": {"transport": "Sv (10^6 m3/s), positive northward", "heat": "PW (10^15 W), northward"},
        "definition": "AMOC = maximum of the overturning streamfunction in depth coordinates (amoc_depth_1m)",
        "line": {"coordinates": LINE, "note": "approximate route of the array along 26.5 N"},
        "months": {"first": months[0], "last": months[-1], "n": len(months)},
        "monthly": {"amoc": r2(amoc), "heat_pw": r2(heat), **{k: r2(v) for k, v in layers.items()}},
        "layer_labels": {k: lab for k, (_, lab) in LAYERS.items()},
        "stats": {**summary(months, amoc), "heat_mean_pw": round(float(np.nanmean(heat)), 2),
                  "annual": annual_means(months, amoc),
                  "layer_means_sv": {k: round(float(np.nanmean(v)), 2) for k, v in layers.items()}},
        "generated_by": "pipeline/amoc.py",
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    s = doc["stats"]
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e3:.0f} kB): {len(months)} months {months[0]}..{months[-1]}, "
          f"AMOC {s['mean_sv']} +- {s['sd_sv']} Sv, heat {s['heat_mean_pw']} PW, {len(s['annual'])} complete years")


def check() -> None:
    d = json.loads(OUT.read_text())
    s = d["stats"]
    print(f"mean AMOC {s['mean_sv']} Sv (RAPID papers: about 17 Sv); heat {s['heat_mean_pw']} PW (about 1.2 PW)")
    print("layer means (Sv):", s["layer_means_sv"])
    print("annual means:", [(a["year"], a["mean"]) for a in s["annual"]])


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", nargs="?", default="all", choices=["fetch", "build", "check", "all"])
    step = ap.parse_args().step
    if step in ("fetch", "all"):
        fetch()
    if step in ("build", "all"):
        build()
    if step in ("check", "all"):
        check()
