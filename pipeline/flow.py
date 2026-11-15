"""Flow layers for an animated particle view: surface winds and surface ocean currents, monthly climatologies.

Winds:    NCEP/NCAR Reanalysis 1, 10 m u/v, long-term monthly means 1991-2020 (NOAA PSL, public, no key).
          Native T62 Gaussian grid (192 x 94, ~1.9 deg) -> bilinear to a regular 1 deg grid (360 x 180).
Currents: OSCAR v2.0 final (ESR / NASA PO.DAAC), daily 0.25 deg total surface current (top-30 m mean, geostrophic +
          Ekman + buoyancy). Monthly climatology = mean of the days 1, 5, 10, 15, 20 and 25 of every month of
          2015-2024 (10 years x 6 days = 60 snapshots per calendar month, 720 granules), served on the native
          0.25 deg node grid (1440 x 719).

  fetch : winds  : 2 NetCDF files from downloads.psl.noaa.gov -> data/raw/wind/ (~3 MB)
          currents: u, v only via the PO.DAAC OPeNDAP (Hyrax, DAP4) subset of each granule, Earthdata Login (~/.netrc),
                    ~9 MB each (~6.5 GB transferred in total); each granule is added to per-month running sums
                    (data/raw/oscar/accum_MM.npz) and deleted, so the raw footprint stays ~350 MB; resumable
                    (data/raw/oscar/done.json lists the granules already summed)
  build : web/public/flow/{wind,currents}/01.bin .. 12.bin, annual.bin, manifest.json (format in docs/data-contract.md)
  check : prints spot speeds (trade winds, westerlies, monsoon reversal, Gulf Stream, Kuroshio, ACC, NECC)
  figure: figures/fig12_chl_flow.png (annual chlorophyll, wind and current speed with streamlines; needs
          pipeline/chlorophyll.py build first)

usage: .venv/bin/python pipeline/flow.py [fetch|build|check|figure|all] [--only wind|currents]
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from earthdata import Session  # noqa: E402
from woa import byte_planes, from_byte_planes  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RAW_W = ROOT / "data/raw/wind"
RAW_C = ROOT / "data/raw/oscar"
OUT = ROOT / "web/public/flow"

PSL = "https://downloads.psl.noaa.gov/Datasets/ncep.reanalysis.derived/surface_gauss"
WIND_FILES = {"u": "uwnd.10m.mon.ltm.1991-2020.nc", "v": "vwnd.10m.mon.ltm.1991-2020.nc"}
OSCAR_COLL = "C2098858642-POCLOUD"   # OSCAR_L4_OC_FINAL_V2.0
OSCAR_DAP = "https://opendap.earthdata.nasa.gov/collections/{coll}/granules/oscar_currents_final_{d}.dap.nc4?dap4.ce=/u;/v"
OSCAR_YEARS = range(2015, 2025)
OSCAR_DAYS = (1, 5, 10, 15, 20, 25)
FILL = -32768
# int16 q -> m/s: value = q * scale
SCALE = {"wind": 0.01, "currents": 0.001}
# served grids: row 0 = northernmost row, column 0 = westernmost (from 180 W), regular spacing, longitudes wrap.
# wind: 1 deg cell centres; currents: the native OSCAR 0.25 deg nodes (719 rows 89.75 N .. 89.75 S, 1440 columns from 180 W)
GRID = {"wind": {"res_deg": 1.0, "lat0": 89.5, "lon0": -179.5, "width": 360, "height": 180},
        "currents": {"res_deg": 0.25, "lat0": 89.75, "lon0": -180.0, "width": 1440, "height": 719}}

CITATIONS = {
    "wind": "Kalnay, E. et al. (1996). The NCEP/NCAR 40-Year Reanalysis Project. Bull. Amer. Meteor. Soc. 77, 437-471, "
            "doi:10.1175/1520-0477(1996)077<0437:TNYRP>2.0.CO;2. NCEP/NCAR Reanalysis 1 data provided by the "
            "NOAA PSL, Boulder, Colorado, USA, from their website at https://psl.noaa.gov",
    "currents": "ESR (2022). OSCAR Third Degree Resolution Ocean Surface Currents, version 2.0 final "
                "(0.25 degree, daily). PO.DAAC, CA, USA. doi:10.5067/OSCAR-25F20. Dohan, K. (2017). Ocean surface "
                "currents from satellite data. J. Geophys. Res. Oceans 122, 2647-2651, doi:10.1002/2016JC012246",
}
LICENCE = {
    "wind": "NOAA PSL / NCEP data: public, no restrictions on use (US Government work); acknowledge as cited",
    "currents": "NASA Earth science data, free and open (\"OSCAR products are supported by NASA and may be freely "
                "distributed\"); cite the DOI",
}
ATTRIBUTION = {
    "wind": "Winds: NCEP/NCAR Reanalysis 1, 1991-2020 monthly means (NOAA PSL)",
    "currents": "Currents: OSCAR v2.0 (ESR, NASA PO.DAAC), 2015-2024 monthly means",
}


# ---------------------------------------------------------------- encodings

def encode_uv(u: np.ndarray, v: np.ndarray, scale: float) -> bytes:
    """u, v (m/s, NaN = no data) -> int16 q = round(value / scale), FILL where either is NaN; each component as two
    byte planes (low bytes, then high bytes of the little-endian two's complement int16), u then v, zlib."""
    ok = np.isfinite(u) & np.isfinite(v)
    parts = []
    for a in (u, v):
        q = np.full(a.shape, FILL, np.int16)
        x = np.rint(a[ok] / scale)
        if x.size and (x.min() <= FILL or x.max() > 32767):
            raise ValueError(f"value out of int16 range at scale {scale}: {np.nanmin(a)}..{np.nanmax(a)}")
        q[ok] = x.astype(np.int16)
        parts.append(byte_planes(q.view(np.uint16)))
    return zlib.compress(b"".join(parts), 9)


def decode_uv(blob: bytes, shape: tuple[int, int], scale: float) -> tuple[np.ndarray, np.ndarray]:
    raw = zlib.decompress(blob)
    n = shape[0] * shape[1] * 2
    out = []
    for k in range(2):
        q = from_byte_planes(raw[k * n:(k + 1) * n], shape).view(np.int16)
        a = q.astype(np.float64) * scale
        a[q == FILL] = np.nan
        out.append(a)
    return out[0], out[1]


def grid_coords(name: str) -> tuple[np.ndarray, np.ndarray]:
    """Latitudes (row 0 = north) and longitudes (column 0 = west) of the served grid points."""
    g = GRID[name]
    return g["lat0"] - g["res_deg"] * np.arange(g["height"]), g["lon0"] + g["res_deg"] * np.arange(g["width"])


# ---------------------------------------------------------------- winds

def fetch_wind() -> None:
    RAW_W.mkdir(parents=True, exist_ok=True)
    for f in WIND_FILES.values():
        p = RAW_W / f
        if p.exists():
            continue
        with urllib.request.urlopen(f"{PSL}/{f}", timeout=300) as r:
            data = r.read()
        p.write_bytes(data)
        print(f"wind: {f} {len(data) / 1e6:.1f} MB", flush=True)


def regrid_periodic(a: np.ndarray, lat_src: np.ndarray, lon_src: np.ndarray, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Bilinear from a (lat, lon) grid with arbitrary monotonic latitudes and regular 0..360 longitudes to the target
    points (target lat descending, lon -180..180). Latitudes beyond the outermost source row use that row."""
    from scipy.interpolate import RegularGridInterpolator

    order = np.argsort(lat_src)
    la, aa = lat_src[order], a[order]
    lo = np.concatenate([lon_src, [lon_src[0] + 360]])
    aa = np.concatenate([aa, aa[:, :1]], axis=1)
    f = RegularGridInterpolator((la, lo), aa, method="linear", bounds_error=False, fill_value=None)
    LA, LO = np.meshgrid(np.clip(lat, la[0], la[-1]), np.mod(lon, 360), indexing="ij")
    return f((LA, LO))


def wind_grids() -> dict[str, tuple[np.ndarray, np.ndarray]]:
    import netCDF4

    comp = {}
    for c, f in WIND_FILES.items():
        with netCDF4.Dataset(RAW_W / f) as ds:
            var = ds.variables[f"{c}wnd"]
            comp[c] = np.ma.filled(var[:].astype(np.float64), np.nan)  # (12, 94, 192)
            lat_s = ds.variables["lat"][:].astype(float)
            lon_s = ds.variables["lon"][:].astype(float)
    lat, lon = grid_coords("wind")
    out = {}
    for m in range(12):
        out[f"{m + 1:02d}"] = (regrid_periodic(comp["u"][m], lat_s, lon_s, lat, lon),
                               regrid_periodic(comp["v"][m], lat_s, lon_s, lat, lon))
    out["annual"] = (np.mean([out[f"{m:02d}"][0] for m in range(1, 13)], axis=0),
                     np.mean([out[f"{m:02d}"][1] for m in range(1, 13)], axis=0))
    return out


# ---------------------------------------------------------------- currents

def oscar_dates() -> list[str]:
    return [date(y, m, d).strftime("%Y%m%d") for y in OSCAR_YEARS for m in range(1, 13) for d in OSCAR_DAYS]


def _read_oscar(path: Path) -> tuple[np.ndarray, np.ndarray]:
    import netCDF4

    with netCDF4.Dataset(path) as ds:
        u = np.ma.filled(ds.variables["u"][0].astype(np.float32), np.nan).T  # (lon, lat) -> (lat, lon)
        v = np.ma.filled(ds.variables["v"][0].astype(np.float32), np.nan).T
    bad = ~(np.isfinite(u) & np.isfinite(v)) | (np.abs(u) > 5) | (np.abs(v) > 5)
    u[bad] = np.nan
    v[bad] = np.nan
    return u, v


def _accum_path(month: int) -> Path:
    return RAW_C / f"accum_{month:02d}.npz"


def fetch_currents(workers: int = 3) -> None:
    RAW_C.mkdir(parents=True, exist_ok=True)
    done_p = RAW_C / "done.json"
    done = set(json.loads(done_p.read_text())) if done_p.exists() else set()
    todo = [d for d in oscar_dates() if d not in done]
    print(f"currents: {len(done)} granules already summed, {len(todo)} to go", flush=True)
    if not todo:
        return
    acc: dict[int, dict[str, np.ndarray]] = {}

    def accum(m: int) -> dict[str, np.ndarray]:
        if m not in acc:
            p = _accum_path(m)
            if p.exists():
                z = np.load(p)
                acc[m] = {k: z[k] for k in z.files}
            else:
                acc[m] = {"su": np.zeros((719, 1440)), "sv": np.zeros((719, 1440)),
                          "ss2": np.zeros((719, 1440)), "n": np.zeros((719, 1440), np.int32)}
        return acc[m]

    def save() -> None:
        for m, a in acc.items():
            tmp = _accum_path(m).with_suffix(".tmp.npz")
            np.savez(tmp, **a)
            tmp.rename(_accum_path(m))
        tmp = done_p.with_suffix(".tmp")
        tmp.write_text(json.dumps(sorted(done)))
        tmp.rename(done_p)

    tmpdir = Path(tempfile.mkdtemp(prefix="oscar-", dir=RAW_C))
    t0 = time.time()
    with Session() as s, ThreadPoolExecutor(workers) as pool:
        def get(d: str) -> tuple[str, Path]:
            p = tmpdir / f"{d}.nc4"
            s.get(OSCAR_DAP.format(coll=OSCAR_COLL, d=d), p, min_bytes=1_000_000)
            return d, p

        for i, (d, p) in enumerate(pool.map(get, todo), 1):
            u, v = _read_oscar(p)
            p.unlink()
            a = accum(int(d[4:6]))
            ok = np.isfinite(u)
            a["su"][ok] += u[ok]
            a["sv"][ok] += v[ok]
            a["ss2"][ok] += u[ok] ** 2 + v[ok] ** 2
            a["n"][ok] += 1
            done.add(d)
            if i % 12 == 0 or i == len(todo):
                save()
                el = time.time() - t0
                print(f"[{len(done)}/{len(oscar_dates())}] {d}  {el / i:.1f} s/granule, "
                      f"~{el / i * (len(todo) - i) / 60:.0f} min left", flush=True)
    tmpdir.rmdir()


def oscar_coords() -> tuple[np.ndarray, np.ndarray]:
    """OSCAR v2 grid: lat -89.75..89.75 (719 nodes), lon 0..359.75 (1440 nodes), 0.25 deg (from the granule DMR)."""
    return -89.75 + 0.25 * np.arange(719), 0.25 * np.arange(1440)


def to_served(a: np.ndarray) -> np.ndarray:
    """OSCAR node grid (rows south -> north, columns 0..359.75 E) -> served layout (rows north -> south, from 180 W)."""
    return np.roll(a[::-1], -720, axis=1)


def current_grids(min_frac: float = 0.8) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Monthly means on the native 0.25 deg nodes; a node is no data for a month when it is valid in fewer than
    min_frac of the snapshots (sea-ice edge). Annual = mean of the 12 monthly means where all 12 are valid."""
    out = {}
    nmax = len(OSCAR_YEARS) * len(OSCAR_DAYS)
    su_all = np.zeros((719, 1440))
    sv_all = np.zeros((719, 1440))
    nm_all = np.zeros((719, 1440))
    for m in range(1, 13):
        z = np.load(_accum_path(m))
        n = z["n"]
        if n.max() > nmax:
            raise ValueError(f"month {m}: {n.max()} snapshots summed, more than the {nmax} expected")
        with np.errstate(invalid="ignore", divide="ignore"):
            u = z["su"] / n
            v = z["sv"] / n
        keep = n >= min_frac * nmax
        u[~keep] = np.nan
        v[~keep] = np.nan
        su_all += np.where(keep, u, 0)
        sv_all += np.where(keep, v, 0)
        nm_all += keep
        out[f"{m:02d}"] = (to_served(u), to_served(v))
    with np.errstate(invalid="ignore", divide="ignore"):
        ua = np.where(nm_all == 12, su_all / nm_all, np.nan)
        va = np.where(nm_all == 12, sv_all / nm_all, np.nan)
    out["annual"] = (to_served(ua), to_served(va))
    return out


# ---------------------------------------------------------------- build

def write_set(name: str, grids: dict[str, tuple[np.ndarray, np.ndarray]], meta: dict) -> None:
    d = OUT / name
    d.mkdir(parents=True, exist_ok=True)
    lat, lon = grid_coords(name)
    layers = {}
    for key, (u, v) in grids.items():
        blob = encode_uv(u, v, SCALE[name])
        (d / f"{key}.bin").write_bytes(blob)
        sp = np.hypot(u, v)
        ok = np.isfinite(sp)
        w = np.broadcast_to(np.cos(np.radians(lat))[:, None], sp.shape)
        layers[key] = {"bytes": len(blob), "cells": int(ok.sum()), "speed_max": round(float(np.nanmax(sp)), 3),
                       "speed_mean_area": round(float(np.sum(sp[ok] * w[ok]) / np.sum(w[ok])), 3),
                       "speed_p99": round(float(np.nanpercentile(sp, 99)), 3)}
        print(f"{name:>8} {key:>6}: max {layers[key]['speed_max']:6.2f}  p99 {layers[key]['speed_p99']:5.2f}  "
              f"area-mean {layers[key]['speed_mean_area']:5.2f} m/s  {len(blob) / 1e3:7.1f} kB", flush=True)
    manifest = {
        **meta,
        "grid": {**GRID[name], "rows": "north_to_south",
                 "registration": ("cell centres" if name == "wind" else "grid nodes (native OSCAR 0.25 deg points)")
                 + "; row r is at latitude lat0 - r * res_deg, column c at longitude lon0 + c * res_deg; "
                 "longitudes wrap",
                 "encoding": "zlib-deflated; u then v, each little-endian int16 stored as two byte planes (all low "
                             "bytes, then all high bytes); value (m/s) = q * scale; q = -32768 = no data",
                 "scale": SCALE[name], "fill": FILL, "units": "m/s",
                 "components": "u = eastward, v = northward (true north, not grid north)"},
        "months": [f"{i:02d}" for i in range(1, 13)], "annual": "annual",
        "layers": layers,
    }
    (d / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
    total = sum(p.stat().st_size for p in d.iterdir() if p.is_file())
    print(f"wrote {d}: {total / 1e6:.2f} MB")


def build(only: str | None = None) -> None:
    if only in (None, "wind"):
        write_set("wind", wind_grids(), {
            "source": "NCEP/NCAR Reanalysis 1, 10 m wind, long-term monthly means 1991-2020 (NOAA PSL), T62 Gaussian "
                      "grid (192 x 94, ~1.9 deg) bilinearly interpolated to 1 deg",
            "period": "1991-2020", "height": "10 m above the surface (land and sea)",
            "files": [f"{PSL}/{f}" for f in WIND_FILES.values()],
            "citation": CITATIONS["wind"], "licence": LICENCE["wind"], "attribution": ATTRIBUTION["wind"],
            "speed_range": [0, 15], "annual_note": "annual = vector mean of the 12 monthly means",
            "caveats": [
                "A monthly-mean wind is the vector average: where the wind changes direction (monsoons, the ITCZ, storm "
                "tracks) the mean is much weaker than typical winds on any day; mean speed of the instantaneous wind "
                "is higher.",
                "Reanalysis at ~1.9 deg: coastal jets, gap winds and tropical cyclones are smoothed out.",
                "Winds over land are included (it is a global field); mask them in the viewer if only the ocean is wanted.",
            ]})
    if only in (None, "currents"):
        dates = json.loads((RAW_C / "done.json").read_text())
        write_set("currents", current_grids(), {
            "source": "OSCAR v2.0 final (Earth & Space Research, NASA PO.DAAC), daily 0.25 deg total surface current "
                      "(mean of the top 30 m: geostrophic + Ekman + buoyancy), monthly means of days "
                      f"{', '.join(map(str, OSCAR_DAYS))} of each month 2015-2024, native 0.25 deg grid",
            "period": "2015-2024", "depth": "top 30 m mean (nominal 15 m)",
            "product": "OSCAR_L4_OC_FINAL_V2.0", "doi": "10.5067/OSCAR-25F20",
            "sampling": {"years": [OSCAR_YEARS[0], OSCAR_YEARS[-1]], "days_of_month": list(OSCAR_DAYS),
                         "snapshots_per_month": len(OSCAR_YEARS) * len(OSCAR_DAYS), "granules": len(dates)},
            "citation": CITATIONS["currents"], "licence": LICENCE["currents"], "attribution": ATTRIBUTION["currents"],
            "speed_range": [0, 1.5],
            "annual_note": "annual = mean of the 12 monthly means, only where all 12 months have open water",
            "caveats": [
                "OSCAR is a diagnostic model driven by satellite sea level (DUACS), ERA5 winds and SST, not a "
                "measurement; it is a top-30 m mean, so it is weaker than the surface skin current and than drifters "
                "in narrow jets.",
                "Averaging 60 daily snapshots smooths eddies and meanders: the climatological Gulf Stream and Kuroshio are "
                "broader and slower than on any given day.",
                "Within ~1 deg of the equator the geostrophic part is ill-defined; OSCAR uses a special equatorial "
                "treatment there.",
                "No data under sea ice: a cell is kept for a month only when >= 80 % of the 60 snapshots are valid; "
                "polar seas and coastal cells inshore of the 0.25 deg grid are empty.",
            ]})


# ---------------------------------------------------------------- check

def speed_at(name: str, key: str, lon: float, lat: float, box: float = 0.0) -> tuple[float, float, float]:
    """(u, v, max speed in the box) from the built web files; box = half-width in degrees around the point."""
    man = json.loads((OUT / name / "manifest.json").read_text())["grid"]
    shape = (man["height"], man["width"])
    u, v = decode_uv((OUT / name / f"{key}.bin").read_bytes(), shape, man["scale"])
    lat_c, lon_c = grid_coords(name)
    rs = np.abs(lat_c - lat) <= max(box, man["res_deg"] / 2)
    cs = np.abs(((lon_c - lon + 180) % 360) - 180) <= max(box, man["res_deg"] / 2)
    uu, vv = u[np.ix_(rs, cs)], v[np.ix_(rs, cs)]
    sp = np.hypot(uu, vv)
    if not np.isfinite(sp).any():
        return float("nan"), float("nan"), float("nan")
    return float(np.nanmean(uu)), float(np.nanmean(vv)), float(np.nanmax(sp))


WIND_SPOTS = [
    ("NE trades, tropical N Atlantic 15N 40W", "annual", -40, 15, 0),
    ("SE trades, tropical S Pacific 15S 120W", "annual", -120, -15, 0),
    ("Southern Ocean westerlies 50S 90E", "annual", 90, -50, 0),
    ("Southern Ocean westerlies 55S 150W", "annual", -150, -55, 0),
    ("Arabian Sea 12N 62E, January (NE monsoon)", "01", 62, 12, 0),
    ("Arabian Sea 12N 62E, July (SW monsoon, Findlater jet)", "07", 62, 12, 0),
    ("Bay of Bengal 15N 88E, January", "01", 88, 15, 0),
    ("Bay of Bengal 15N 88E, July", "07", 88, 15, 0),
]
CURRENT_SPOTS = [
    ("Gulf Stream, Florida Strait to Cape Hatteras (box max)", "annual", -77, 32, 4),
    ("Kuroshio south of Japan + Extension (box max)", "annual", 140, 33, 8),
    ("Kuroshio south of Japan + Extension (box max)", "09", 140, 33, 8),
    ("Agulhas Current (box max)", "annual", 28, -34, 3),
    ("ACC south of Australia 52S 140E (mean u)", "annual", 140, -52, 0),
    ("ACC Drake Passage 58S 65W (mean u)", "annual", -65, -58, 0),
    ("N Equatorial Countercurrent 7N 120W (u, Aug)", "08", -120, 7, 0),
    ("S Equatorial Current 2S 120W (u, annual)", "annual", -120, -2, 0),
    ("Somali Current 8N 51E, July (v)", "07", 51, 8, 1),
    ("Somali Current 8N 51E, January (v)", "01", 51, 8, 1),
]


def check(only: str | None = None) -> None:
    for name, spots in (("wind", WIND_SPOTS), ("currents", CURRENT_SPOTS)):
        if only not in (None, name) or not (OUT / name / "manifest.json").exists():
            continue
        for label, key, lon, lat, box in spots:
            u, v, smax = speed_at(name, key, lon, lat, box)
            print(f"{name:>8} {label:<58} {key:>6}: u {u:6.2f}  v {v:6.2f}  |V| {np.hypot(u, v):5.2f}  "
                  f"max {smax:5.2f} m/s")
    if only in (None, "wind") and (OUT / "wind/manifest.json").exists():
        u, v = decode_uv((OUT / "wind/annual.bin").read_bytes(), (180, 360), SCALE["wind"])
        lat, _ = grid_coords("wind")
        zu = np.nanmean(u, axis=1)
        band = (lat < -40) & (lat > -65)
        k = np.argmax(np.where(band, zu, -99))
        print(f"    wind Southern Ocean westerlies: annual zonal-mean u peaks at {zu[k]:.2f} m/s at {lat[k]:.1f} deg; "
              f"monthly peak {max(np.nanmean(decode_uv((OUT / f'wind/{m:02d}.bin').read_bytes(), (180, 360), SCALE['wind'])[0][band], axis=1).max() for m in range(1, 13)):.2f} m/s")
        sp = np.hypot(u, v)[band]
        print(f"    wind Southern Ocean 40-65 S: annual mean-vector speed p90 {np.percentile(sp, 90):.2f}, "
              f"max {sp.max():.2f} m/s")


# ---------------------------------------------------------------- figure

def figure() -> None:
    import cartopy.crs as ccrs
    import cartopy.feature as cfeature
    import cmocean
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LogNorm

    import chlorophyll as chl

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "savefig.dpi": 200, "savefig.bbox": "tight"})
    pc = ccrs.PlateCarree()
    q = from_byte_planes(zlib.decompress((chl.OUT / "annual.bin").read_bytes()), (720, 1440))
    c = 10 ** chl.decode_log(q)
    wu, wv = decode_uv((OUT / "wind/annual.bin").read_bytes(), (180, 360), SCALE["wind"])
    cu, cv = decode_uv((OUT / "currents/annual.bin").read_bytes(), (719, 1440), SCALE["currents"])
    wman = json.loads((OUT / "wind/manifest.json").read_text())
    cman = json.loads((OUT / "currents/manifest.json").read_text())
    cmeta = json.loads((chl.OUT / "manifest.json").read_text())

    fig = plt.figure(figsize=(11, 16.2))
    axes = [fig.add_axes([0.03, 0.69 - 0.325 * i, 0.94, 0.29], projection=ccrs.EqualEarth(central_longitude=150))
            for i in range(3)]
    for ax in axes:
        ax.set_global()
        ax.set_facecolor("0.82")
        ax.spines["geo"].set_linewidth(0.6)

    ax = axes[0]
    im = ax.imshow(np.ma.masked_invalid(c), extent=[-180, 180, -90, 90], transform=pc, origin="upper",
                   cmap=cmocean.cm.algae, norm=LogNorm(*cmeta["variable"]["range"]), interpolation="nearest",
                   regrid_shape=(1200, 2400))
    ax.add_feature(cfeature.LAND.with_scale("110m"), facecolor="0.72", edgecolor="none", zorder=2)
    cb = fig.colorbar(im, ax=ax, orientation="vertical", fraction=0.025, pad=0.01, shrink=0.8)
    cb.set_label("chlorophyll-a (mg/m³, log scale)")
    ax.set_title("a  Phytoplankton: surface chlorophyll-a, MODIS-Aqua mission climatology "
                 f"({cmeta['layers']['annual']['period']})", loc="left", fontsize=10, fontweight="bold")

    for ax, (u, v), name, smax, dens, title in (
            (axes[1], (wu, wv), "wind", 12, 2.2, "b  Surface winds (10 m), annual mean of 1991-2020 monthly means"),
            (axes[2], (cu, cv), "currents", 1.0, 3.2, "c  Surface ocean currents (top 30 m), annual mean of 2015-2024")):
        lat, lon = grid_coords(name)
        g = GRID[name]
        ext = [g["lon0"] - g["res_deg"] / 2, g["lon0"] + g["res_deg"] * (g["width"] - 0.5),
               g["lat0"] - g["res_deg"] * (g["height"] - 0.5), g["lat0"] + g["res_deg"] / 2]
        sp = np.hypot(u, v)
        im = ax.imshow(np.ma.masked_invalid(sp), extent=ext, transform=pc, origin="upper",
                       cmap=cmocean.cm.speed if name == "currents" else cmocean.cm.amp, vmin=0, vmax=smax,
                       interpolation="bilinear", regrid_shape=(900, 1800))
        ax.add_feature(cfeature.COASTLINE.with_scale("110m"), linewidth=0.4, color="0.25", zorder=3)
        if name == "currents":
            ax.add_feature(cfeature.LAND.with_scale("110m"), facecolor="0.72", edgecolor="none", zorder=2)
        # streamlines on a regular lon/lat grid (rows ascending for matplotlib), sea-ice / land holes as zeros
        uu = np.nan_to_num(u[::-1]); vv = np.nan_to_num(v[::-1])
        ax.streamplot(lon, lat[::-1], uu, vv, transform=pc, density=dens, color="k", linewidth=0.45,
                      arrowsize=0.55, zorder=4)
        cb = fig.colorbar(im, ax=ax, orientation="vertical", fraction=0.025, pad=0.01, shrink=0.8, extend="max")
        cb.set_label("speed of the mean vector (m/s)")
        ax.set_title(title, loc="left", fontsize=10, fontweight="bold")

    fig.text(0.03, 0.035,
             "Sources: (a) NASA OBPG MODIS-Aqua L3m chlor_a R2022.0, 9 km CU climatology, doi:10.5067/AQUA/MODIS/L3M/CHL/2022.0, "
             "shown at 0.25°; (b) NCEP/NCAR Reanalysis 1 10 m wind\n1991-2020 long-term monthly means (NOAA PSL; "
             "Kalnay et al. 1996), ~1.9° on a 1° grid; (c) OSCAR v2.0 final (ESR / NASA PO.DAAC, doi:10.5067/OSCAR-25F20), "
             f"{cman['sampling']['snapshots_per_month']} daily snapshots per month, 0.25°.\n"
             "Speeds are of the climatological mean vector (weaker than typical instantaneous speeds where direction varies). "
             "Grey = land, sea ice or no data. Built by pipeline/flow.py from the web files in web/public/{chl,flow}.",
             fontsize=7, color="0.35", va="top")
    out = ROOT / "figures/fig12_chl_flow.png"
    fig.savefig(out)
    plt.close(fig)
    print(f"wrote {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", nargs="?", default="all", choices=["fetch", "build", "check", "figure", "all"])
    ap.add_argument("--only", choices=["wind", "currents"])
    a = ap.parse_args()
    if a.step in ("fetch", "all"):
        if a.only in (None, "wind"):
            fetch_wind()
        if a.only in (None, "currents"):
            fetch_currents()
    if a.step in ("build", "all"):
        build(a.only)
    if a.step in ("check", "all"):
        check(a.only)
    if a.step in ("figure", "all"):
        figure()
    sys.exit(0)
