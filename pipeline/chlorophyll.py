"""Phytoplankton layer: surface chlorophyll-a monthly climatology from NASA MODIS-Aqua (OBPG, reprocessing R2022.0).

Source: NASA OB.DAAC Level-3 Standard Mapped Image (L3m) chlor_a, 9 km (1/12 deg, 4320 x 2160) climatologies:
  MC = monthly climatology (the mean of all Januaries, all Februaries, ... of the mission), one file per month;
  CU = cumulative climatology (all days of the mission) = the annual layer.
For each month the newest MC granule is used (start/end years in manifest.json; they differ by month because the
mission started in July 2002 and the archive is updated month by month).

  fetch : CMR granule search (public) -> newest MC per month + newest CU, downloaded with Earthdata Login
          (~/.netrc) from the OB.DAAC getfile endpoint -> data/raw/chl/*.nc  (13 files, ~190 MB)
  build : 3 x 3 block mean of log10(chlor_a) (geometric mean, >= 3 valid of 9 pixels) -> 0.25 deg, 1440 x 720
          web/public/chl/01.bin .. 12.bin, annual.bin, manifest.json (format in docs/data-contract.md)
  check : prints spot values (upwelling zones, North Atlantic spring bloom, oligotrophic gyres)

usage: .venv/bin/python pipeline/chlorophyll.py [fetch|build|check|all]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from earthdata import Session, cmr_granules  # noqa: E402
from woa import byte_planes, from_byte_planes  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/chl"
OUT = ROOT / "web/public/chl"

SHORT_NAME, VERSION = "MODISA_L3m_CHL", "2022.0"
DOI = "10.5067/AQUA/MODIS/L3M/CHL/2022.0"
BLOCK = 3                    # 9 km (1/12 deg) -> 0.25 deg
MIN_VALID = 3                # of 9 source pixels
# uint16, same formula as web/public/woa: q = 0 no data, log10(chl) = LO + (q - 1) * STEP
LO, STEP = -3.0, 0.001       # 0.001 mg/m^3 .. 10^(-3 + 65534 * 0.001); MODIS chlor_a valid range is 0.001..100
RANGE = (0.01, 20.0)         # default colour range, mg/m^3, log scale (values outside are clamped in colour only)
GETFILE = "https://oceandata.sci.gsfc.nasa.gov/getfile"
NAME_RE = re.compile(r"AQUA_MODIS\.(\d{8})_(\d{8})\.L3m\.(MC|CU)\.CHL\.chlor_a\.9km\.nc")

CITATIONS = {
    "dataset": "NASA Ocean Biology Processing Group (2022). MODIS-Aqua Level-3 Global Mapped Chlorophyll (CHL) Data, "
               "version R2022.0. NASA Ocean Biology Distributed Active Archive Center (OB.DAAC), Greenbelt, MD, USA. "
               f"doi:{DOI}",
    "algorithm": "Hu, C., Feng, L., Lee, Z., Franz, B.A., Bailey, S.W., Werdell, P.J. and Proctor, C.W. (2019). "
                 "Improving satellite global chlorophyll a data products through algorithm refinement and data "
                 "recovery. J. Geophys. Res. Oceans 124, 1524-1543, doi:10.1029/2019JC014941; O'Reilly, J.E. and "
                 "Werdell, P.J. (2019). Chlorophyll algorithms for ocean color sensors - OC4, OC5 & OC6. Remote Sens. "
                 "Environ. 229, 32-47, doi:10.1016/j.rse.2019.04.021",
}
LICENCE = ("NASA Earth science data: free and open, no restrictions on use or redistribution (NASA Earth Science "
           "Data and Information Policy); cite the dataset DOI")
ATTRIBUTION = "Chlorophyll-a: NASA OBPG, MODIS-Aqua R2022.0 climatology (doi:10.5067/AQUA/MODIS/L3M/CHL/2022.0)"


# ---------------------------------------------------------------- fetch

def pick_granules() -> dict[str, dict]:
    """Newest monthly climatology per calendar month and the newest cumulative one (cloud HTTPS links)."""
    best: dict[str, dict] = {}
    for kind in ("MC", "CU"):
        for e in cmr_granules(SHORT_NAME, VERSION, pattern=f"*L3m.{kind}.CHL.chlor_a.9km*"):
            name = e["producer_granule_id"]
            m = NAME_RE.fullmatch(name)
            if not m:
                continue
            # the OB.DAAC getfile endpoint (EDL login); the cloud (obdaac-tea) links in CMR additionally require the
            # MERIS and Sentinel EULAs to be accepted in the Earthdata profile, getfile does not
            url = f"{GETFILE}/{name}"
            key = m.group(1)[4:6] if kind == "MC" else "annual"
            if key not in best or m.group(2) > best[key]["end"]:
                best[key] = {"name": name, "url": url, "start": m.group(1), "end": m.group(2),
                             "mb": round(float(e.get("granule_size", 0)), 1)}
    missing = [k for k in [f"{i:02d}" for i in range(1, 13)] + ["annual"] if k not in best]
    if missing:
        raise RuntimeError(f"no granule for {missing}")
    return dict(sorted(best.items()))


def fetch() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    files = pick_granules()
    (RAW / "files.json").write_text(json.dumps(files, indent=1))
    with Session() as s:
        for key, g in files.items():
            dest = RAW / g["name"]
            if dest.exists():
                continue
            n = s.get(g["url"], dest)
            print(f"{key}: {g['name']} {n / 1e6:.1f} MB", flush=True)
    for p in RAW.glob("*.nc"):  # drop superseded granules from earlier runs
        if p.name not in {g["name"] for g in files.values()}:
            p.unlink()
    total = sum(p.stat().st_size for p in RAW.glob("*.nc"))
    print(f"raw chlorophyll: {total / 1e6:.0f} MB in {RAW}")


# ---------------------------------------------------------------- build

def read_chl(path: Path) -> tuple[np.ndarray, dict]:
    import netCDF4

    with netCDF4.Dataset(path) as ds:
        v = ds.variables["chlor_a"]
        v.set_auto_maskandscale(True)
        a = np.ma.filled(v[:].astype(np.float32), np.nan)
        lat = ds.variables["lat"][:]
        meta = {k: str(ds.getncattr(k)) for k in ("title", "processing_version", "time_coverage_start",
                                                   "time_coverage_end", "map_projection", "spatialResolution")
                if k in ds.ncattrs()}
    if lat[0] < lat[-1]:      # make row 0 the northernmost
        a = a[::-1]
    return a, meta


def block_log_mean(chl: np.ndarray, k: int = BLOCK, min_valid: int = MIN_VALID) -> np.ndarray:
    """Geometric-mean block average: mean of log10(chl) over the valid pixels of each k x k block."""
    h, w = chl.shape
    lg = np.where(np.isfinite(chl) & (chl > 0), np.log10(np.where(chl > 0, chl, 1.0)), np.nan)
    b = lg.reshape(h // k, k, w // k, k)
    n = np.isfinite(b).sum(axis=(1, 3))
    s = np.nansum(b, axis=(1, 3))
    with np.errstate(invalid="ignore", divide="ignore"):
        out = s / n
    out[n < min_valid] = np.nan
    return out.astype(np.float32)


def encode_log(lg: np.ndarray) -> np.ndarray:
    q = np.zeros(lg.shape, np.uint16)
    ok = np.isfinite(lg)
    q[ok] = np.clip(np.rint((lg[ok] - LO) / STEP) + 1, 1, 65535).astype(np.uint16)
    return q


def decode_log(q: np.ndarray) -> np.ndarray:
    out = LO + (q.astype(np.float64) - 1) * STEP
    out[q == 0] = np.nan
    return out


def build() -> None:
    files = json.loads((RAW / "files.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    layers: dict[str, dict] = {}
    for key, g in files.items():
        chl, meta = read_chl(RAW / g["name"])
        lg = block_log_mean(chl)
        q = encode_log(lg)
        blob = zlib.compress(byte_planes(q), 9)
        (OUT / f"{key}.bin").write_bytes(blob)
        ok = np.isfinite(lg)
        p2, p50, p98 = (float(x) for x in np.nanpercentile(lg, [2, 50, 98]))
        layers[key] = {"source_file": g["name"], "period": f"{g['start'][:4]}-{g['end'][:4]}",
                       "time_coverage": [meta.get("time_coverage_start", ""), meta.get("time_coverage_end", "")],
                       "bytes": len(blob), "ocean_cells": int(ok.sum()),
                       "log10_p2": round(p2, 3), "log10_p50": round(p50, 3), "log10_p98": round(p98, 3)}
        print(f"{key:>6}: {g['name']}  cells {ok.sum():>7}  median {10 ** p50:.3f} mg/m3  "
              f"p2..p98 {10 ** p2:.3f}..{10 ** p98:.2f}  {len(blob) / 1e6:.2f} MB", flush=True)
    manifest = {
        "source": "NASA MODIS-Aqua Level-3 mapped chlorophyll-a (OCI algorithm), reprocessing R2022.0, "
                  "9 km monthly (MC) and cumulative (CU) mission climatologies",
        "product": f"{SHORT_NAME} v{VERSION}", "doi": DOI,
        "citations": CITATIONS, "licence": LICENCE, "attribution": ATTRIBUTION,
        "variable": {"name": "Chlorophyll-a", "units": "mg/m³", "long": "near-surface chlorophyll-a concentration "
                     "(satellite estimate, first optical depth)", "scale": "log10", "range": list(RANGE),
                     "cmap": "cmocean algae"},
        "grid": {"res_deg": 0.25, "width": 1440, "height": 720, "north": 90.0, "west": -180.0, "rows": "north_to_south",
                 "encoding": "zlib-deflated uint16 as two byte planes (all low bytes, then all high bytes); "
                             "q = 0 no data (land, ice, persistent cloud or polar night); "
                             "log10(chl mg/m^3) = lo + (q - 1) * step",
                 "lo": LO, "step": STEP,
                 "aggregation": f"{BLOCK} x {BLOCK} block mean of log10(chlor_a) from the 9 km grid "
                                f"(>= {MIN_VALID} valid pixels of 9)"},
        "months": [f"{i:02d}" for i in range(1, 13)], "annual": "annual",
        "layers": layers,
        "caveats": [
            "Satellite chlorophyll is an estimate from ocean colour, not a measurement in the water; uncertainty is "
            "about 30-35 % in the open ocean and larger in coastal water, where sediment and dissolved organic "
            "matter (rivers, Baltic, Black Sea, Rio de la Plata) make it read too high.",
            "It sees only the top optical depth (roughly 10-60 m); deep chlorophyll maxima in the gyres are invisible.",
            "High latitudes have no data in their winter (polar night, sea ice), so a monthly map has seasonal holes "
            "and the annual (CU) layer is biased towards the sunlit season there.",
            "Monthly climatologies start in different years (the mission started in July 2002): see layers[].period.",
        ],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
    total = sum(p.stat().st_size for p in OUT.iterdir() if p.is_file())
    print(f"wrote {OUT}: {total / 1e6:.1f} MB")


# ---------------------------------------------------------------- check

def value_at(key: str, lon: float, lat: float, radius: int = 0) -> float:
    """chl (mg/m^3) at a point from the built web files; radius > 0 = geometric mean over (2r+1)^2 cells."""
    q = from_byte_planes(zlib.decompress((OUT / f"{key}.bin").read_bytes()), (720, 1440))
    r = int(np.clip(np.floor((90 - lat) / 0.25), 0, 719))
    c = int(np.clip(np.floor((lon + 180) / 0.25), 0, 1439))
    win = decode_log(q[max(r - radius, 0):r + radius + 1, max(c - radius, 0):c + radius + 1])
    return float(10 ** np.nanmean(win)) if np.isfinite(win).any() else float("nan")


SPOTS = [
    ("Peru upwelling (annual)", "annual", -78.0, -10.0),
    ("Benguela upwelling, Namibia (annual)", "annual", 13.5, -23.0),
    ("Arabian Sea, Oman coast, August (SW monsoon)", "08", 58.0, 19.0),
    ("Arabian Sea, Oman coast, April (inter-monsoon)", "04", 58.0, 19.0),
    ("North Atlantic 50N 25W, May (spring bloom)", "05", -25.0, 50.0),
    ("North Atlantic 50N 25W, January", "01", -25.0, 50.0),
    ("South Pacific gyre 25S 120W (annual)", "annual", -120.0, -25.0),
    ("North Atlantic gyre (Sargasso) 25N 50W (annual)", "annual", -50.0, 25.0),
    ("North Pacific gyre 25N 150W (annual)", "annual", -150.0, 25.0),
    ("Indian Ocean gyre 25S 80E (annual)", "annual", 80.0, -25.0),
    ("Equatorial Pacific 0N 140W (annual, upwelling tongue)", "annual", -140.0, 0.0),
]


def check() -> None:
    for label, key, lon, lat in SPOTS:
        print(f"{label:<56} {key:>6} ({lon:>7.1f}, {lat:>6.1f}): {value_at(key, lon, lat, radius=4):7.3f} mg/m3 "
              f"(1 deg mean)")


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
    sys.exit(0)
