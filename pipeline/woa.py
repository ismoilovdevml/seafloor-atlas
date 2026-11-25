"""Ocean water layer: temperature, salinity and potential density from the World Ocean Atlas 2023.

Climatology: WOA23 "decav91C0" = the 1991-2020 climate normal, objectively analysed means (t_an, s_an) only.

  fetch : NCEI THREDDS OPeNDAP subsets (only the variables and depth levels used) -> data/raw/woa23/*.npy
          annual 0.25 deg t_an + s_an at the map depths (11 levels x 2)          ~ 90 MB
          monthly 0.25 deg t_an at 0 m (t01..t12)                               ~ 50 MB
          annual 1 deg t_an + s_an at all 102 standard levels (0-5,500 m)       ~ 53 MB
  build : web/public/woa/ (format in docs/data-contract.md)
          manifest.json                 variables, depths, months, colour ranges, per-layer quantisation
          map/<var>_<depth>.bin         0.25 deg, uint16 at a fixed step per variable, byte planes, zlib
          map/t_m<MM>.bin               monthly surface temperature, same encoding
          col/<i>_<j>.bin               1 deg water columns of a 30 x 30 deg region: int16 T, S, sigma0 at all
                                        102 levels, deflate compressed (lazily fetched by the viewer on click)
  fetch-bottom : annual 0.25 deg t_an + s_an at all 102 levels, in slabs -> data/raw/woa23/levels/  ~ 850 MB
  months : rebuild only map/t_m<MM>.bin from the raw monthly files and merge them into manifest.json
          (despike: 5 x 5 spatial rule per month, then the annual-cycle rule across the 12 months)
  bottom : the "at the seafloor" layers from the deepest level with both T and S in each cell (above any deep-tail
          artefact, see bottom_fields):
          t_bottom = potential temperature theta (TEOS-10 pt0), s_bottom = practical salinity,
          d_bottom = potential density sigma4 (referenced to 4,000 dbar) where that level is >= 2,000 m deep,
          z_bottom = depth of that level; merged into web/public/woa/manifest.json (map.bottom, map.layers)
  check : prints the science spot checks (warm pool, Antarctic shelf, deep water, Atlantic/Bay of Bengal
          surface salinity, Mediterranean outflow tongue at 1,000 m)

Density (TEOS-10, gsw): p = p_from_z(-z, lat); SA = SA_from_SP(SP, p, lon, lat); CT = CT_from_t(SA, t, p);
sigma0 = rho(SA, CT, 0) - 1000 kg/m^3 (potential density anomaly referenced to the sea surface).
At the seafloor, theta and sigma4 replace in-situ T and sigma0: in-situ T at 5,000 m is ~0.4 degC warmer from
compression alone, and sigma0 can rank abyssal waters in the wrong order (Antarctic Bottom Water lighter than
North Atlantic Deep Water in sigma0, heavier in sigma4).

usage: .venv/bin/python pipeline/woa.py [fetch|build|months|fetch-bottom|bottom|check|all]
       fetch options: --months-only (only t01..t12), --source http (NCEI file server instead of THREDDS)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/woa23"
OUT = ROOT / "web/public/woa"

PERIOD = "decav91C0"  # 1991-2020 climate normal
DODS = "https://www.ncei.noaa.gov/thredds-ocean/dodsC/woa23/DATA"
FILE_URL = "https://www.ncei.noaa.gov/data/oceans/woa/WOA23/DATA"
MAP_DEPTHS = [0, 50, 100, 200, 500, 1000, 1500, 2000, 3000, 4000, 5000]
VARS = {"t": "temperature", "s": "salinity"}

# fixed colour ranges (same at every depth so depths are comparable); values outside are clamped in colour only
RANGES = {"t": (-2.0, 32.0), "s": (32.0, 38.0), "d": (20.0, 28.0)}
# map layers: uint16 q, value = lo + (q - 1) * step, q = 0 no data (step per variable)
MAP_STEP = {"t": 0.01, "s": 0.005, "d": 0.005, "z": 1.0}
LEVELS = RAW / "levels"
SLAB = 6                      # levels per OPeNDAP request in fetch_bottom (6 x 720 x 1440 float32 = 25 MB)
BOTTOM_SIGMA4_MIN_Z = 2000.0  # sigma4 is the usual reference for abyssal water; shallower bottoms get no density
DEEP_JUMP_MIN_Z = 1500.0      # deep-tail rule of bottom_fields: jumps between adjacent levels below this depth ...
DEEP_JUMP_T = 2.0             # ... of more than 2 degC ...
DEEP_JUMP_S = 0.2             # ... or 0.2 in salinity end the column for the seafloor layers
# int16 water-column encoding: value = OFFSET + q * SCALE, q = -32768 means no data
COL_SCALE = 0.001
COL_OFFSET = {"t": 10.0, "s": 20.0, "d": 15.0}
COL_FILL = -32768
CHUNK_DEG = 30

CITATIONS = {
    "t": "Locarnini, R.A., A.V. Mishonov, O.K. Baranova, J.R. Reagan, T.P. Boyer, D. Seidov, Z. Wang, H.E. Garcia, "
         "C. Bouchard, S.L. Cross, C.R. Paver, and D. Dukhovskoy (2024). World Ocean Atlas 2023, Volume 1: Temperature. "
         "A. Mishonov Technical Editor, NOAA Atlas NESDIS 89, doi:10.25923/54bh-1613",
    "s": "Reagan, J.R., D. Seidov, Z. Wang, D. Dukhovskoy, T.P. Boyer, R.A. Locarnini, O.K. Baranova, A.V. Mishonov, "
         "H.E. Garcia, C. Bouchard, S.L. Cross, and C.R. Paver (2024). World Ocean Atlas 2023, Volume 2: Salinity. "
         "A. Mishonov Technical Editor, NOAA Atlas NESDIS 90, doi:10.25923/70qt-9574",
    "dataset": "Reagan, J.R. et al. (2024). World Ocean Atlas 2023. NOAA National Centers for Environmental Information. "
               "Dataset: NCEI Accession 0270533",
    "teos10": "IOC, SCOR and IAPSO (2010). The international thermodynamic equation of seawater - 2010 (TEOS-10). "
              "Computed with the gsw Python package",
}


# ---------------------------------------------------------------- fetch

def dods_url(v: str, res: str, tt: str, source: str = "opendap") -> str:
    """OPeNDAP URL of one WOA23 netCDF file, or (source="http") the same file on NCEI's HTTPS file server read
    with netCDF-C byte-range requests ("#mode=bytes"): only the HDF5 chunks that hold the requested slice are
    downloaded (t_an is chunked 19 levels x 240 x 480, so the surface of a 584 MB monthly file costs ~30 MB).
    The file server is a fallback for when the THREDDS server is down (2026-11-24/25: 502, then timeouts)."""
    rr = "04" if res == "0.25" else "01"
    if source == "http":
        return f"{FILE_URL}/{VARS[v]}/netcdf/{PERIOD}/{res}/woa23_{PERIOD}_{v}{tt}_{rr}.nc#mode=bytes"
    return f"{DODS}/{VARS[v]}/netcdf/{PERIOD}/{res}/woa23_{PERIOD}_{v}{tt}_{rr}.nc"


def _read(url: str, var: str, k: int | slice, tries: int = 5) -> np.ndarray:
    import netCDF4  # only needed for fetching

    for attempt in range(tries):
        try:
            with netCDF4.Dataset(url) as ds:
                a = ds.variables[var][0, k, :, :]
            return np.ma.filled(a.astype(np.float32), np.nan)
        except Exception as e:  # network hiccups: retry with backoff
            if attempt == tries - 1:
                raise
            print(f"  retry {attempt + 1}: {e}", flush=True)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("unreachable")


def coords(url: str) -> dict:
    import netCDF4

    with netCDF4.Dataset(url) as ds:
        return {k: ds.variables[k][:].astype(float).tolist() for k in ("lat", "lon", "depth")}


def fetch(months_only: bool = False, source: str = "opendap") -> None:
    """Download the subsets listed in the module docstring (resumable: existing files are kept). months_only: only
    the twelve monthly surface temperatures; source: "opendap" (THREDDS) or "http" (file server, byte ranges)."""
    RAW.mkdir(parents=True, exist_ok=True)
    meta_p = RAW / "coords.json"
    if not meta_p.exists():
        c = {"q": coords(dods_url("t", "0.25", "00", source)), "one": coords(dods_url("t", "1.00", "00", source))}
        meta_p.write_text(json.dumps(c))
    c = json.loads(meta_p.read_text())
    depths = c["q"]["depth"]
    jobs: list[tuple[Path, str, str, int | slice]] = []
    if not months_only:
        for v in VARS:
            for d in MAP_DEPTHS:
                jobs.append((RAW / f"{v}_an_025_annual_{d:04d}m.npy", dods_url(v, "0.25", "00", source), f"{v}_an",
                             depths.index(d)))
    for m in range(1, 13):
        jobs.append((RAW / f"t_an_025_m{m:02d}_0000m.npy", dods_url("t", "0.25", f"{m:02d}", source), "t_an", 0))
    if not months_only:
        for v in VARS:
            jobs.append((RAW / f"{v}_an_1deg_annual_all.npy", dods_url(v, "1.00", "00", source), f"{v}_an", slice(None)))
    for i, (path, url, var, k) in enumerate(jobs, 1):
        if path.exists():
            continue
        t0 = time.time()
        a = _read(url, var, k)
        np.save(path.with_suffix(".tmp.npy"), a)
        path.with_suffix(".tmp.npy").rename(path)
        print(f"[{i}/{len(jobs)}] {path.name} {a.shape} {a.nbytes / 1e6:.1f} MB in {time.time() - t0:.1f} s", flush=True)
    total = sum(p.stat().st_size for p in RAW.glob("*.npy"))
    print(f"raw WOA23 subsets: {total / 1e6:.0f} MB in {RAW}")


# ---------------------------------------------------------------- science

def sigma0(t: np.ndarray, sp: np.ndarray, depth_m: float | np.ndarray, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Potential density anomaly sigma0 (kg/m^3) from in-situ temperature (deg C, ITS-90), practical salinity,
    depth (m, positive down), lon/lat (deg), TEOS-10. All inputs broadcast together."""
    import gsw

    z = -np.asarray(depth_m, dtype=np.float64)
    p = gsw.p_from_z(z, lat)
    sa = gsw.SA_from_SP(sp, p, lon, lat)
    ct = gsw.CT_from_t(sa, t, p)
    return gsw.sigma0(sa, ct)


# ---------------------------------------------------------------- encodings

def quantise_u16(a: np.ndarray, step: float) -> tuple[np.ndarray, float]:
    """uint16 at a fixed physical step: 0 = no data, value = lo + (q - 1) * step, lo = layer minimum
    rounded down to a multiple of the step."""
    ok = np.isfinite(a)
    q = np.zeros(a.shape, np.uint16)
    if not ok.any():
        return q, 0.0
    lo = float(np.floor(np.nanmin(a) / step) * step)
    v = np.rint((a[ok] - lo) / step) + 1
    if v.max() > 65535:
        raise ValueError(f"range {lo}..{np.nanmax(a)} too wide for step {step}")
    q[ok] = v.astype(np.uint16)
    return q, lo


def dequantise_u16(q: np.ndarray, lo: float, step: float) -> np.ndarray:
    out = lo + (q.astype(np.float64) - 1) * step
    out[q == 0] = np.nan
    return out


def byte_planes(q: np.ndarray) -> bytes:
    """uint16 -> all low bytes, then all high bytes (compresses ~25 % better than interleaved)."""
    b = np.frombuffer(q.astype("<u2").tobytes(), np.uint8).reshape(-1, 2)
    return b[:, 0].tobytes() + b[:, 1].tobytes()


def from_byte_planes(raw: bytes, shape: tuple[int, ...]) -> np.ndarray:
    b = np.frombuffer(raw, np.uint8)
    n = b.size // 2
    return (b[:n].astype(np.uint16) | (b[n:].astype(np.uint16) << 8)).reshape(shape)


def encode_i16(a: np.ndarray, offset: float) -> np.ndarray:
    q = np.full(a.shape, COL_FILL, np.int16)
    ok = np.isfinite(a)
    v = np.rint((a[ok] - offset) / COL_SCALE)
    if v.size and (v.min() <= COL_FILL or v.max() > 32767):
        raise ValueError(f"value out of int16 range for offset {offset}: {a[ok].min()}..{a[ok].max()}")
    q[ok] = v.astype(np.int16)
    return q


def decode_i16(q: np.ndarray, offset: float) -> np.ndarray:
    out = offset + q.astype(np.float64) * COL_SCALE
    out[q == COL_FILL] = np.nan
    return out


SPIKE_C = 10.0  # a surface cell this far from the median of its wet 5 x 5 neighbourhood is an extrapolation artefact
HOT_C = 33.0       # ... and so is a cell above this temperature that is more than HOT_SPIKE_C warmer than that median
HOT_SPIKE_C = 4.0


def despike(a: np.ndarray, limit: float = SPIKE_C, hot: float = HOT_C, hot_limit: float = HOT_SPIKE_C) -> tuple[np.ndarray, int]:
    """Blank cells that differ from the median of their wet 5 x 5 neighbourhood by more than `limit`, and cells
    warmer than `hot` that are more than `hot_limit` warmer than that median.

    WOA23's monthly objective analysis leaves a few coastal cells far outside the physical range (44.0 degC in the
    Red Sea in February, a patch of 12-43 degC in 3-5 degC water in the Sea of Okhotsk in October). A 5 x 5 window
    (not 3 x 3) keeps a patch of several bad cells from hiding behind itself, and 10 degC keeps real fronts such as
    the cold upwelling in the Gulf of California's Canal de Ballenas (21 vs 30 degC in August). Neighbourhoods with
    fewer than 6 wet cells are left alone.

    The second, warm-only rule catches hot coastal patches too small for 10 degC to see: a 3-cell patch at the
    Strait of Hormuz in October (35.8-37.1 degC in 30.6 degC water; 36.9 in 32.5 in August) and one cell off Guaymas
    in July (34.4 in 30.4). No monthly climatological mean of open water sits 4 degC above its surroundings at
    more than 33 degC; in the shipped 2026-11 monthly layers this rule blanks those 5 cells and nothing else.
    Returns the cleaned copy and the number of cells blanked."""
    out = a.copy()
    H, W = a.shape
    pad = np.pad(a, 2, constant_values=np.nan)
    nb = np.stack([pad[2 + dy:H + 2 + dy, 2 + dx:W + 2 + dx] for dy in range(-2, 3) for dx in range(-2, 3) if dy or dx])
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            med = np.nanmedian(nb, axis=0)
    wet = np.sum(np.isfinite(nb), axis=0)
    dev = a - med
    bad = np.isfinite(a) & (wet >= 6) & ((np.abs(dev) > limit) | ((a > hot) & (dev > hot_limit)))
    out[bad] = np.nan
    return out, int(bad.sum())


CYCLE_SPIKE_C = 5.0  # a monthly value this far above (or below) BOTH adjacent months of its cell is an artefact ...
CYCLE_GROW_C = 2.5   # ... and so is every same-month cell joined to it through cells more than this far off both


def cycle_despike(stack: np.ndarray, seed: float = CYCLE_SPIKE_C, grow: float = CYCLE_GROW_C) -> tuple[np.ndarray, np.ndarray]:
    """Annual-cycle rule for the twelve monthly surface layers, stack[month, y, x] (January first): blank one-month
    spikes of a cell's own seasonal cycle. excess = how far a month is above both its neighbours (December and
    January are neighbours), or below both, whichever is positive; NaN where either neighbour is missing.

    A seed is a cell whose excess is more than `seed`; all cells of the same month that are 8-connected to a seed
    through cells with an excess of more than `grow` are blanked with it (the rim of the same patch). The case that
    motivated it is a 548-cell patch on the NE Greenland shelf (75.9-80.6 N, 20.9-9.1 W) in January: 3-13 degC
    under sea ice whose December and February values are -1.3 to -1.8 degC (18.125 W 78.625 N: 13.36 degC between
    -1.31 and -1.76), too broad for the 5 x 5 rule of `despike`; after this rule the warmest January cell left
    there is 1.75 degC. On the 2026-11 raw layers the rule blanks 5,503 of 8,133,874 cell-months (0.07 %) in 64
    patches, nearly all at ice edges and in data-poor shelf seas: north of Svalbard in June (892 cells, 3.9 degC
    between -1.9 and -1.8), the Barents Sea off Novaya Zemlya in January, the North Caspian in June-August,
    Hudson Bay in April and July, the Canadian Arctic Archipelago, the Sea of Okhotsk, the Patagonian shelf in
    December (20.7 between 7.3 and 11.6 degC) and, cold, the upper Gulf of California in July (9.7 between 19.2 and
    24.5 degC).

    Why a climatological month cannot do this: a 30-year monthly mean follows a smooth annual cycle; for a
    sinusoid of amplitude a, the warmest month exceeds both neighbours by a (1 - cos 30 deg) = 0.13 a, under 2 degC
    even for the largest seasonal ranges (Bohai, North Caspian). In the shipped 2026-11 layers the largest excess
    in well-sampled seas with strong seasons, fronts or upwelling is 2.5 degC (Gulf Stream), 2.0 (North Sea),
    3.2 (Baltic), 3.3 (Kuroshio), 4.6 (Yellow Sea/Bohai), 4.9 (Black Sea), 4.8 (Mediterranean, Gulf of Gabes
    in August), 4.4 (Peru): all below `seed`; the only cell blanked in those seas is the Gulf of Sirte in
    January (11.5 degC between 20.2 and 17.4).
    Limitation: an artefact that spans two consecutive months is not a one-month spike and is not caught.
    Returns the cleaned copy and the mask of blanked cells."""
    from scipy import ndimage

    prev, nxt = np.roll(stack, 1, axis=0), np.roll(stack, -1, axis=0)
    with np.errstate(invalid="ignore"):
        excess = np.fmax(np.minimum(stack - prev, stack - nxt), np.minimum(prev - stack, nxt - stack))
        excess = np.where(np.isfinite(stack) & np.isfinite(prev) & np.isfinite(nxt), excess, -np.inf)
    bad = np.zeros(stack.shape, bool)
    eight = np.ones((3, 3), bool)
    for m in range(stack.shape[0]):
        lab, _ = ndimage.label(excess[m] > grow, structure=eight)
        seeds = np.unique(lab[excess[m] > seed])
        bad[m] = np.isin(lab, seeds[seeds > 0])
    out = stack.copy()
    out[bad] = np.nan
    return out, bad


def north_up(a: np.ndarray) -> np.ndarray:
    """WOA rows run south -> north; the web files run north -> south (row 0 = northernmost)."""
    return a[..., ::-1, :]


def deflate(b: bytes) -> bytes:
    return zlib.compress(b, 9)


# ---------------------------------------------------------------- build

def load(name: str) -> np.ndarray:
    return np.load(RAW / name)


def write_map_layer(key: str, a: np.ndarray) -> dict:
    """Write map/<key>.bin (south -> north input) and return its manifest entry."""
    step = MAP_STEP[key[0]]
    q, lo = quantise_u16(north_up(a), step)
    blob = deflate(byte_planes(q))
    (OUT / "map").mkdir(parents=True, exist_ok=True)
    (OUT / "map" / f"{key}.bin").write_bytes(blob)
    ok = np.isfinite(a)
    hi = float(np.nanmax(a)) if ok.any() else lo
    pct = np.nanpercentile(a, [2, 98]).tolist() if ok.any() else [lo, hi]
    return {"lo": round(lo, 6), "step": step, "hi": round(hi, 5), "p2": round(pct[0], 4), "p98": round(pct[1], 4),
            "bytes": len(blob), "ocean_cells": int(ok.sum())}


def monthly_sst(m: int) -> np.ndarray:
    sst, nbad = despike(load(f"t_an_025_m{m:02d}_0000m.npy"))
    if nbad:
        print(f"month {m:02d}: {nbad} surface cell(s) blanked as spikes (> {SPIKE_C} degC from their neighbours, "
              f"or > {HOT_C} degC and > {HOT_SPIKE_C} degC warmer)")
    return sst


def monthly_ssts() -> tuple[np.ndarray, dict]:
    """The twelve cleaned monthly surface layers (south -> north) and the number of cells each rule blanked."""
    spatial = []
    layers = []
    for m in range(1, 13):
        raw = load(f"t_an_025_m{m:02d}_0000m.npy")
        sst = monthly_sst(m)
        spatial.append(int((np.isfinite(raw) & ~np.isfinite(sst)).sum()))
        layers.append(sst)
    stack, bad = cycle_despike(np.stack(layers))
    cycle = bad.sum(axis=(1, 2)).astype(int).tolist()
    print(f"annual-cycle rule (> {CYCLE_SPIKE_C} degC off both adjacent months, grown through > {CYCLE_GROW_C} degC): "
          f"{sum(cycle)} cells blanked, per month {cycle}", flush=True)
    return stack, {"spatial_5x5": spatial, "annual_cycle": cycle}


MONTHLY_RULES = (f"blanked: cells more than {SPIKE_C:g} degC off the median of their wet 5 x 5 neighbourhood, or above "
                 f"{HOT_C:g} degC and more than {HOT_SPIKE_C:g} degC warmer than it; then one-month spikes of the "
                 f"annual cycle: more than {CYCLE_SPIKE_C:g} degC above or below both adjacent months, with the "
                 f"same-month cells joined to them through cells more than {CYCLE_GROW_C:g} degC off both")


def months() -> None:
    """Rebuild only the twelve monthly surface-temperature layers and merge them into the existing manifest."""
    man_p = OUT / "manifest.json"
    man = json.loads(man_p.read_text())
    stack, blanked = monthly_ssts()
    for m in range(1, 13):
        key = f"t_m{m:02d}"
        man["map"]["layers"][key] = write_map_layer(key, stack[m - 1])
        print(f"{key}: max {man['map']['layers'][key]['hi']} degC", flush=True)
    man["map"]["monthly"].update({"despike": MONTHLY_RULES, "blanked_cells": blanked})
    man_p.write_text(json.dumps(man, ensure_ascii=False, separators=(",", ":")))
    print(f"merged monthly layers into {man_p}")


def build() -> None:
    c = json.loads((RAW / "coords.json").read_text())
    latq, lonq = np.array(c["q"]["lat"]), np.array(c["q"]["lon"])
    lat1, lon1, dep1 = np.array(c["one"]["lat"]), np.array(c["one"]["lon"]), np.array(c["one"]["depth"])
    (OUT / "map").mkdir(parents=True, exist_ok=True)
    (OUT / "col").mkdir(parents=True, exist_ok=True)
    LON, LAT = np.meshgrid(lonq, latq)
    layers: dict[str, dict] = {}
    sizes = {"map": 0, "col": 0}

    def put_map(key: str, a: np.ndarray) -> None:
        layers[key] = write_map_layer(key, a)
        sizes["map"] += layers[key]["bytes"]

    for d in MAP_DEPTHS:
        t = load(f"t_an_025_annual_{d:04d}m.npy")
        s = load(f"s_an_025_annual_{d:04d}m.npy")
        both = np.isfinite(t) & np.isfinite(s)
        dens = np.full(t.shape, np.nan)
        dens[both] = sigma0(t[both], s[both], d, LON[both], LAT[both])
        put_map(f"t_{d}", t)
        put_map(f"s_{d}", s)
        put_map(f"d_{d}", dens)
        print(f"map {d:>5} m: T {np.nanmin(t):.2f}..{np.nanmax(t):.2f}  S {np.nanmin(s):.2f}..{np.nanmax(s):.2f}  "
              f"sigma0 {np.nanmin(dens):.2f}..{np.nanmax(dens):.2f}", flush=True)
    stack, blanked = monthly_ssts()
    for m in range(1, 13):
        put_map(f"t_m{m:02d}", stack[m - 1])

    # 1 deg water columns, 30 x 30 deg regions
    T = load("t_an_1deg_annual_all.npy")  # (102, 180, 360), south -> north
    S = load("s_an_1deg_annual_all.npy")
    L1, LA1 = np.meshgrid(lon1, lat1)
    both = np.isfinite(T) & np.isfinite(S)
    D = np.full(T.shape, np.nan)
    Z = np.broadcast_to(dep1[:, None, None], T.shape)
    LO = np.broadcast_to(L1, T.shape)
    LA = np.broadcast_to(LA1, T.shape)
    D[both] = sigma0(T[both], S[both], Z[both], LO[both], LA[both])
    # one mask for all three variables: a level counts only where both T and S exist
    T = np.where(both, T, np.nan)
    S = np.where(both, S, np.nan)
    Tn, Sn, Dn = north_up(T), north_up(S), north_up(D)
    n = CHUNK_DEG
    nchunks = 0
    for i in range(180 // n):          # rows, north -> south
        for j in range(360 // n):      # cols, west -> east from 180 W
            sl = (slice(None), slice(i * n, (i + 1) * n), slice(j * n, (j + 1) * n))
            if not np.isfinite(Tn[sl]).any():
                continue
            parts = [encode_i16(Tn[sl], COL_OFFSET["t"]), encode_i16(Sn[sl], COL_OFFSET["s"]),
                     encode_i16(Dn[sl], COL_OFFSET["d"])]
            raw = np.stack(parts).astype("<i2").tobytes()  # [var][level][row][col]
            blob = deflate(raw)
            (OUT / "col" / f"{i}_{j}.bin").write_bytes(blob)
            sizes["col"] += len(blob)
            nchunks += 1

    manifest = {
        "source": "World Ocean Atlas 2023 (NOAA NCEI), objectively analysed climatological mean",
        "period": "1991-2020", "period_code": PERIOD,
        "citations": CITATIONS,
        "licence": "NOAA NCEI data, openly available to the public without restriction (US Government work); "
                   "acknowledge WOA23 as cited",
        "urls": {"opendap": f"{DODS}/", "files": f"{FILE_URL}/"},
        "variables": {
            "t": {"name": "Temperature", "units": "°C", "long": "in-situ temperature (ITS-90)", "range": RANGES["t"],
                  "cmap": "cmocean thermal"},
            "s": {"name": "Salinity", "units": "", "long": "practical salinity (PSS-78, unitless)", "range": RANGES["s"],
                  "cmap": "cmocean haline"},
            "d": {"name": "Density", "units": "kg/m³", "long": "potential density anomaly σ0 = ρ(SA, CT, 0) − 1000 (TEOS-10)",
                  "range": RANGES["d"], "cmap": "cmocean dense"},
        },
        "map": {"res_deg": 0.25, "width": 1440, "height": 720, "north": 90.0, "west": -180.0, "rows": "north_to_south",
                "encoding": "zlib-deflated uint16 as two byte planes (all low bytes, then all high bytes); "
                            "0 = no data; value = lo + (q - 1) * step",
                "depths": MAP_DEPTHS, "monthly": {"var": "t", "depth": 0, "months": list(range(1, 13)),
                                                   "despike": MONTHLY_RULES, "blanked_cells": blanked},
                "layers": layers},
        "columns": {"res_deg": 1.0, "width": 360, "height": 180, "chunk_deg": n, "depths": dep1.tolist(),
                    "encoding": "zlib-deflated little-endian int16 [var t,s,d][level][row][col] per chunk; "
                                "value = offset + q * scale; -32768 = no data",
                    "scale": COL_SCALE, "offset": COL_OFFSET, "fill": COL_FILL, "vars": ["t", "s", "d"],
                    "chunks": nchunks},
        "sizes_bytes": sizes,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
    if (LEVELS / "done.json").exists():
        bottom()  # the manifest was just rewritten: merge the seafloor layers back in
    total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"wrote {OUT}: maps {sizes['map'] / 1e6:.1f} MB, columns {sizes['col'] / 1e6:.1f} MB in {nchunks} chunks, "
          f"total {total / 1e6:.1f} MB")


# ---------------------------------------------------------------- at the seafloor

def ensure_coords() -> dict:
    RAW.mkdir(parents=True, exist_ok=True)
    meta_p = RAW / "coords.json"
    if not meta_p.exists():
        meta_p.write_text(json.dumps({"q": coords(dods_url("t", "0.25", "00")), "one": coords(dods_url("t", "1.00", "00"))}))
    return json.loads(meta_p.read_text())


def fetch_bottom() -> None:
    """All 102 annual levels of t_an and s_an at 0.25 deg, SLAB levels per request, one .npy per slab (resumable)."""
    c = ensure_coords()
    nl = len(c["q"]["depth"])
    LEVELS.mkdir(parents=True, exist_ok=True)
    jobs = [(v, k0) for v in VARS for k0 in range(0, nl, SLAB)]
    for i, (v, k0) in enumerate(jobs, 1):
        path = LEVELS / f"{v}_an_025_annual_L{k0:03d}.npy"
        if path.exists():
            continue
        t0 = time.time()
        a = _read(dods_url(v, "0.25", "00"), f"{v}_an", slice(k0, min(k0 + SLAB, nl)))
        np.save(path.with_suffix(".tmp.npy"), a)
        path.with_suffix(".tmp.npy").rename(path)
        print(f"[{i}/{len(jobs)}] {path.name} {a.shape} in {time.time() - t0:.1f} s", flush=True)
    (LEVELS / "done.json").write_text(json.dumps({"levels": nl, "slab": SLAB, "vars": list(VARS)}))
    total = sum(p.stat().st_size for p in LEVELS.glob("*.npy"))
    print(f"WOA23 0.25 deg levels: {total / 1e6:.0f} MB in {LEVELS}")


def bottom_fields(slabs, depths, jump_min_z: float = DEEP_JUMP_MIN_Z, jump_t: float = DEEP_JUMP_T,
                  jump_s: float = DEEP_JUMP_S) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Deepest level where both T and S exist, per cell, above any deep-tail artefact. `slabs` yields
    (k0, T[l, y, x], S[l, y, x]) in increasing k0 order; returns (T, S, depth) at that level, NaN where no level
    has both, and the mask of cells whose deep tail was cut.

    Deep-tail rule: going down a column, the first pair of adjacent levels whose upper level is >= jump_min_z deep
    and whose temperature differs by more than jump_t or salinity by more than jump_s ends the column for the
    seafloor layers; that level and everything below it are ignored. Below 1,500 m real water changes by
    hundredths of a degree between standard levels (50-100 m apart). The jumps come from WOA23's analysis falling
    back to its first guess in deep levels with no data, which in isolated basins is water from outside the basin:
    Rhodes Basin 14.13 degC / 38.74 at 4,100 m, then 4.68 / 35.75 at 4,200 m and 1.36 / 35.70 at 4,400 m (a fake
    global sigma4 maximum, 46.685); the same in the Ionian and Hellenic trenches, Red Sea, Sulu, Banda and Andaman
    seas, Cayman Trench, and Atlantic-salinity water at the bottom of Pacific trenches and the Molloy Deep.
    2 degC and 0.2 leave alone the smaller (1-1.5 degC) steps at real deep fronts and sills (Walvis Ridge,
    Kerguelen, Bransfield Strait, Romanche Fracture Zone), where WOA's values may be right."""
    tb = sb = zb = cut = pt = ps = None
    for k0, T, S in slabs:
        if tb is None:
            tb = np.full(T.shape[1:], np.nan, np.float32)
            sb = np.full(T.shape[1:], np.nan, np.float32)
            zb = np.full(T.shape[1:], np.nan, np.float32)
            cut = np.zeros(T.shape[1:], bool)
        for j in range(T.shape[0]):
            k = k0 + j
            ok = np.isfinite(T[j]) & np.isfinite(S[j])
            if pt is not None and depths[k - 1] >= jump_min_z:
                with np.errstate(invalid="ignore"):
                    cut |= ok & ((np.abs(T[j] - pt) > jump_t) | (np.abs(S[j] - ps) > jump_s))
            use = ok & ~cut
            tb[use], sb[use], zb[use] = T[j][use], S[j][use], depths[k]
            pt, ps = T[j], S[j]
    return tb, sb, zb, cut


def bottom_properties(t: np.ndarray, sp: np.ndarray, z: np.ndarray, lon: np.ndarray, lat: np.ndarray,
                      min_z_sigma4: float = BOTTOM_SIGMA4_MIN_Z) -> tuple[np.ndarray, np.ndarray]:
    """(theta, sigma4) from in-situ T, practical salinity and depth (m, positive down); sigma4 is NaN where z is
    shallower than min_z_sigma4. TEOS-10: theta = pt0_from_t(SA, t, p), sigma4 = rho(SA, CT, 4000 dbar) - 1000."""
    import gsw

    ok = np.isfinite(t) & np.isfinite(sp) & np.isfinite(z)
    theta = np.full(t.shape, np.nan)
    sig4 = np.full(t.shape, np.nan)
    p = gsw.p_from_z(-z[ok].astype(np.float64), lat[ok])
    sa = gsw.SA_from_SP(sp[ok], p, lon[ok], lat[ok])
    theta[ok] = gsw.pt0_from_t(sa, t[ok], p)
    s4 = gsw.sigma4(sa, gsw.CT_from_t(sa, t[ok], p))
    s4[z[ok] < min_z_sigma4] = np.nan
    sig4[ok] = s4
    return theta, sig4


def deep_percentiles(a: np.ndarray, z: np.ndarray) -> list[float]:
    """2nd and 98th percentile over cells whose bottom level is >= 2,000 m (the "stretch colours" range)."""
    v = a[np.isfinite(a) & (z >= BOTTOM_SIGMA4_MIN_Z)]
    return [round(float(x), 4) for x in np.percentile(v, [2, 98])]


def deep_range(a: np.ndarray, z: np.ndarray, step: float, grain: float | None = None) -> list[float]:
    """Default colour range for a seafloor layer: 2nd-98th percentile over cells whose bottom level is >= 2,000 m
    (the abyssal water this layer is about), widened outward to whole multiples of `grain` (default step x 10;
    temperature uses whole degrees so the legend's end labels are the range itself, not a rounded neighbour)."""
    v = a[np.isfinite(a) & (z >= BOTTOM_SIGMA4_MIN_Z)]
    lo, hi = np.percentile(v, [2, 98])
    g = grain or step * 10
    return [round(float(np.floor(lo / g) * g), 6), round(float(np.ceil(hi / g) * g), 6)]


def bottom() -> None:
    c = ensure_coords()
    if not (LEVELS / "done.json").exists():
        raise SystemExit("run `woa.py fetch-bottom` first")
    latq, lonq, depths = np.array(c["q"]["lat"]), np.array(c["q"]["lon"]), np.array(c["q"]["depth"], float)
    starts = sorted({int(p.stem.split("_L")[1]) for p in LEVELS.glob("t_an_025_annual_L*.npy")})

    def slabs():
        for k0 in starts:
            yield k0, np.load(LEVELS / f"t_an_025_annual_L{k0:03d}.npy"), np.load(LEVELS / f"s_an_025_annual_L{k0:03d}.npy")

    tb, sb, zb, cut = bottom_fields(slabs(), depths)
    print(f"deep-tail rule: {int(cut.sum())} cells end above a jump of > {DEEP_JUMP_T} degC or > {DEEP_JUMP_S} "
          f"between levels below {DEEP_JUMP_MIN_Z:.0f} m", flush=True)
    LON, LAT = np.meshgrid(lonq, latq)
    theta, sig4 = bottom_properties(tb, sb, zb, LON, LAT)
    man_p = OUT / "manifest.json"
    man = json.loads(man_p.read_text())
    layers = man["map"]["layers"]
    for key, a in (("t_bottom", theta), ("s_bottom", sb), ("d_bottom", sig4), ("z_bottom", zb)):
        step = MAP_STEP[key[0]]
        q, lo = quantise_u16(north_up(a), step)
        blob = deflate(byte_planes(q))
        (OUT / "map" / f"{key}.bin").write_bytes(blob)
        ok = np.isfinite(a)
        pct = np.nanpercentile(a, [2, 98]).tolist()
        layers[key] = {"lo": round(lo, 6), "step": step, "hi": round(float(np.nanmax(a)), 5), "p2": round(pct[0], 4),
                       "p98": round(pct[1], 4), "bytes": len(blob), "ocean_cells": int(ok.sum())}
        if key != "z_bottom":
            layers[key]["range"] = deep_range(a, zb, step, 1.0 if key == "t_bottom" else None)
            layers[key]["p2_deep"], layers[key]["p98_deep"] = deep_percentiles(a, zb)
        print(f"{key}: {np.nanmin(a):.3f}..{np.nanmax(a):.3f}, cells {int(ok.sum())}, range {layers[key].get('range')}, "
              f"{len(blob) / 1e6:.2f} MB", flush=True)
    man["map"]["bottom"] = {
        "keys": {"t": "t_bottom", "s": "s_bottom", "d": "d_bottom", "z": "z_bottom"},
        "level": "deepest WOA23 standard level with both temperature and salinity in the 0.25 deg cell, above any "
                 f"jump of more than {DEEP_JUMP_T:g} degC or {DEEP_JUMP_S:g} in salinity between adjacent levels below "
                 f"{DEEP_JUMP_MIN_Z:.0f} m (deeper levels there are WOA23 first-guess artefacts)",
        "deep_tail_cut_cells": int(cut.sum()),
        "t": "potential temperature theta (TEOS-10 pt0_from_t, reference 0 dbar), degC",
        "s": "practical salinity (PSS-78) at that level",
        "d": f"potential density anomaly sigma4 = rho(SA, CT, 4000 dbar) - 1000 kg/m3, only where that level is "
             f">= {BOTTOM_SIGMA4_MIN_Z:.0f} m deep",
        "z": "depth of the level used, m (the WOA23 levels stop at 5,500 m; the seafloor can be deeper or between "
             "levels)",
        "sigma4_min_depth_m": BOTTOM_SIGMA4_MIN_Z,
    }
    man_p.write_text(json.dumps(man, ensure_ascii=False, separators=(",", ":")))
    print(f"merged seafloor layers into {man_p}")


# ---------------------------------------------------------------- check

def column_at(lon: float, lat: float) -> dict:
    """Decode one 1 deg column from the built web files (what the viewer reads)."""
    m = json.loads((OUT / "manifest.json").read_text())["columns"]
    row = int(np.clip(np.floor(90 - lat), 0, 179))
    col = int(np.clip(np.floor(lon + 180), 0, 359))
    n = m["chunk_deg"]
    blob = (OUT / "col" / f"{row // n}_{col // n}.bin").read_bytes()
    nl = len(m["depths"])
    a = np.frombuffer(zlib.decompress(blob), "<i2").reshape(3, nl, n, n)
    r, c = row % n, col % n
    return {v: decode_i16(a[k, :, r, c].copy(), m["offset"][v]) for k, v in enumerate(m["vars"])} | {"depth": np.array(m["depths"])}


def map_value(key: str, lon: float, lat: float) -> float:
    man = json.loads((OUT / "manifest.json").read_text())["map"]
    L = man["layers"][key]
    q = from_byte_planes(zlib.decompress((OUT / "map" / f"{key}.bin").read_bytes()), (720, 1440))
    r = int(np.clip(np.floor((90 - lat) / 0.25), 0, 719))
    c = int(np.clip(np.floor((lon + 180) / 0.25), 0, 1439))
    return float(dequantise_u16(q[r:r + 1, c:c + 1], L["lo"], L["step"])[0, 0])


SPOTS = [
    ("West Pacific warm pool, surface T", "t_0", 150.0, 0.0),
    ("Weddell Sea shelf, surface T (Antarctica)", "t_0", -45.0, -74.0),
    ("Weddell Sea, inner shelf, surface T", "t_0", -40.0, -72.0),
    ("Ross Sea, surface T (Antarctica)", "t_0", 175.0, -76.5),
    ("North Pacific abyss, 4,000 m T", "t_4000", -150.0, 30.0),
    ("South Atlantic, 3,000 m T", "t_3000", -20.0, -30.0),
    ("Subtropical N Atlantic, surface S", "s_0", -45.0, 25.0),
    ("Bay of Bengal, surface S", "s_0", 89.5, 19.5),
    ("Gulf of Cadiz / off Iberia, 1,000 m S (Mediterranean outflow)", "s_1000", -12.0, 37.0),
    ("Western N Atlantic, 1,000 m S (same latitude, no outflow)", "s_1000", -60.0, 37.0),
    ("Red Sea, surface S", "s_0", 38.5, 21.0),
    ("Tropical surface sigma0", "d_0", 150.0, 0.0),
    ("Weddell Sea, 4,000 m sigma0", "d_4000", -30.0, -65.0),
]
# seafloor spots: checked only when the seafloor layers are built
BOTTOM_SPOTS = [
    ("Weddell Sea abyssal plain, seafloor theta (AABW source, expect < 0)", "t_bottom", -30.0, -65.0),
    ("Argentine Basin, seafloor theta (AABW flowing north)", "t_bottom", -45.0, -45.0),
    ("Brazil Basin, seafloor theta", "t_bottom", -30.0, -15.0),
    ("Canary Basin, seafloor theta (eastern N Atlantic, less AABW)", "t_bottom", -25.0, 30.0),
    ("North Pacific, seafloor theta", "t_bottom", -150.0, 30.0),
    ("Norwegian Sea basin, seafloor theta (expect < -0.5)", "t_bottom", 0.0, 69.0),
    ("Weddell Sea, seafloor sigma4", "d_bottom", -30.0, -65.0),
    ("Canary Basin, seafloor sigma4", "d_bottom", -25.0, 30.0),
    ("Weddell Sea, depth of the deepest WOA level", "z_bottom", -30.0, -65.0),
]


def check() -> None:
    for label, key, lon, lat in SPOTS:
        print(f"{label:<66} {key:<7} ({lon:>7.2f}, {lat:>6.2f}): {map_value(key, lon, lat):8.3f}")
    layers = json.loads((OUT / "manifest.json").read_text())["map"]["layers"]
    if "t_bottom" in layers:
        for label, key, lon, lat in BOTTOM_SPOTS:
            print(f"{label:<66} {key:<8} ({lon:>7.2f}, {lat:>6.2f}): {map_value(key, lon, lat):8.3f}")
    c = column_at(-20.5, 30.5)
    ok = np.isfinite(c["t"])
    print("water column 20.5W 30.5N (Canary Basin), selected levels:")
    for z in (0, 100, 500, 1000, 1500, 2000, 3000, 4000, 5000):
        k = int(np.where(c["depth"] == z)[0][0])
        if ok[k]:
            print(f"  {z:>5} m  T {c['t'][k]:7.3f} °C  S {c['s'][k]:7.3f}  sigma0 {c['d'][k]:7.3f} kg/m³")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", nargs="?", default="all",
                    choices=["fetch", "build", "months", "fetch-bottom", "bottom", "check", "all"])
    ap.add_argument("--months-only", action="store_true", help="fetch: only the twelve monthly surface layers")
    ap.add_argument("--source", choices=["opendap", "http"], default="opendap",
                    help="fetch: THREDDS OPeNDAP (default) or the HTTPS file server with byte-range reads")
    args = ap.parse_args()
    step = args.step
    if step in ("fetch", "all"):
        fetch(args.months_only, args.source)
    if step in ("fetch-bottom", "all"):
        fetch_bottom()
    if step in ("build", "all"):
        build()  # merges the seafloor layers too when the levels are fetched
    if step == "months":
        months()
    if step == "bottom":
        bottom()
    if step in ("check", "all"):
        check()
    sys.exit(0)
