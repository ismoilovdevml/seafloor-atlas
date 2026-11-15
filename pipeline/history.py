"""Mapping history: which seafloor was directly measured in each GEBCO release 2019-2026.

Steps (see docs/data-contract.md, "Mapping history"):

  python pipeline/history.py fetch  [YEAR ...]   download gebco_<year>_tid.zip from CEDA (resumable, curl -C -)
  python pipeline/history.py convert [YEAR ...]  zip -> data/raw/gebco_<year>/gebco_<year>_tid.tif (Int8, tiled,
                                                deflate); the .nc and .zip are deleted after a successful check
  python pipeline/history.py build              per-year statistics + the 1' history grids
  python pipeline/history.py tiles              Web Mercator RGBA tiles z0-5 from the 1' grids
  python pipeline/history.py figure             figures/fig13_mapping_history.png
  python pipeline/history.py check              decode the published files and re-check them against the stats

One ocean mask for every year: TID != 0 in GEBCO_2026 AND the GEBCO_2026 1' elevation < 0 (the same mask as
pipeline/coverage.py), so year-to-year differences come only from the TID codes. "Measured" = TID 10-17.
Areas use the exact spherical area of each 15" cell (authalic sphere, R = 6371.0072 km), as in pipeline/change.py.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw"
DERIVED = ROOT / "data/derived"
OUT = ROOT / "web/public/history"
ELEV = RAW / "gebco_2026/gebco_2026_elev_1arcmin.tif"
YEARS = list(range(2019, 2027))
LATEST = YEARS[-1]
R_KM = 6371.0072
H15, W15 = 43200, 86400
H1, W1 = 10800, 21600
RECODED = 100  # first-measured code + 100 = measured in that release but NOT in the latest one
CEDA = "https://dap.ceda.ac.uk/bodc/gebco/global/gebco_{y}/type_identifier_grid/netcdf/gebco_{y}_tid.zip?download=1"

# Seabed 2030 / GEBCO announced share of the seafloor "mapped to modern standards", per grid release.
# Every number was read on the cited page on 2026-11-15.
OFFICIAL = {
    2019: {"percent": 15.0, "date": "2019-06-13",
           "quote": "coverage of the world's ocean floor has now increased from 6 per cent to 15 per cent",
           "url": "https://www.gebco.net/news/international-project-chart-worlds-ocean-floor-announces-doubling-data-available-definitive"},
    2020: {"percent": 19.0, "date": "2020-06-21",
           "quote": "Over the past year, coverage of the seabed has risen to 19% from 15%.",
           "url": "https://en.nippon-foundation.or.jp/news/articles/2020/20200621-45318.html"},
    2021: {"percent": 20.6, "date": "2021-08-01",
           "quote": "it is estimated that 20.6% of seafloor has now been mapped",
           "url": "https://www.gebco.net/news/new-version-gebco-global-bathymetric-grid-now-available"},
    2022: {"percent": 23.4, "date": "2022-09-22",
           "quote": "it is estimated that 23.4% of seafloor has now been mapped",
           "url": "https://www.gebco.net/news/new-version-gebco-global-bathymetric-grid"},
    2023: {"percent": 24.9, "date": "2023-05-02",
           "quote": "with 24.9 per cent of the seabed now mapped",
           "url": "https://seabed2030.org/2023/05/02/hsh-prince-albert-ii-of-monaco-announces-a-quarter-of-the-ocean-now-mapped/"},
    2024: {"percent": 26.1, "date": "2024-07-24",
           "quote": "with 26.1% of the seabed now mapped",
           "url": "https://www.gebco.net/news/release-gebco2024-grid"},
    2025: {"percent": 27.3, "date": "2025-08-06",
           "quote": "27.3% of the world's ocean floor has now been mapped to modern standards",
           "url": "https://gebco.net/news/release-gebco2025-grid"},
    2026: {"percent": 28.7, "date": "2026-04-27",
           "quote": "28.7% of the world's ocean floor has now been mapped to modern standards",
           "url": "https://www.gebco.net/news/release-gebco2026-grid"},
}

# GEBCO grid DOIs (BODC), from each release's netCDF `references` attribute / the GEBCO historical data sets page
DOIS = {
    2019: "10.5285/836f016a-33be-6ddc-e053-6c86abc0788e",
    2020: "10.5285/a29c5465-b138-234d-e053-6c86abc040b9",
    2021: "10.5285/c6612cbe-50b3-0cff-e053-6c86abc09f8f",
    2022: "10.5285/e0f0bb80-ab44-2739-e053-6c86abc0289c",
    2023: "10.5285/f98b053b-0cbc-6c23-e053-6c86abc0af7b",
    2024: "10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f",
    2025: "10.5285/37c52e96-24ea-67ce-e063-7086abc05f29",
    2026: "10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa",
}


def tid_path(y: int) -> Path:
    return RAW / f"gebco_{y}/gebco_{y}_tid.tif"


# ---------------------------------------------------------------- fetch / convert

def fetch(years: list[int]) -> None:
    for y in years:
        d = RAW / f"gebco_{y}"
        d.mkdir(parents=True, exist_ok=True)
        if tid_path(y).exists():
            print(y, "tif exists, skip")
            continue
        z = d / f"gebco_{y}_tid.zip"
        for _ in range(40):
            r = subprocess.run(["curl", "-sL", "-C", "-", "--retry", "3", "--speed-limit", "20000",
                                "--speed-time", "60", "-o", str(z), CEDA.format(y=y)])
            if r.returncode == 0:
                break
        print(y, z.stat().st_size, "bytes")


def convert(years: list[int]) -> None:
    """zip -> Int8 GeoTIFF on the same 15" grid as gebco_2026_tid.tif; deletes the .nc and the .zip afterwards."""
    import rasterio

    for y in years:
        d = RAW / f"gebco_{y}"
        out = tid_path(y)
        if out.exists():
            print(y, "tif exists, skip")
            continue
        z = d / f"gebco_{y}_tid.zip"
        nc_name = subprocess.run(["unzip", "-Z1", str(z)], capture_output=True, text=True,
                                 check=True).stdout.split()
        nc_name = [n for n in nc_name if n.lower().endswith(".nc")][0]
        subprocess.run(["unzip", "-o", "-q", str(z), nc_name, "-d", str(d)], check=True)
        nc = d / nc_name
        tmp = out.with_suffix(".tmp.tif")
        # GDAL flips the south-up netCDF to north-up; Int8 keeps the TID codes (max 72) exactly
        subprocess.run(["gdal_translate", "-q", "-ot", "Int8", "-a_srs", "EPSG:4326",
                        "-co", "TILED=YES", "-co", "BLOCKXSIZE=512", "-co", "BLOCKYSIZE=512",
                        "-co", "COMPRESS=DEFLATE", "-co", "NUM_THREADS=ALL_CPUS", "-co", "BIGTIFF=IF_SAFER",
                        f"NETCDF:{nc}:tid", str(tmp)], check=True)
        info = json.loads(subprocess.run(["gdalinfo", "-json", f"NETCDF:{nc}:tid"], capture_output=True,
                                         text=True, check=True).stdout)
        md = info.get("metadata", {}).get("", {})
        (d / f"gebco_{y}_tid_meta.json").write_text(json.dumps(
            {k: v for k, v in md.items() if k.startswith("NC_GLOBAL#") and "comment" not in k}, indent=1))
        with rasterio.open(tmp) as s, rasterio.open(tid_path(LATEST)) as ref:
            assert s.shape == (H15, W15), s.shape
            assert all(abs(a - b) < 1e-9 for a, b in zip(s.transform, ref.transform)), (s.transform, ref.transform)
            # orientation check on one row at 45 N: inner Asia must be land (0), the North Pacific ocean (!= 0)
            row = s.read(1, window=rasterio.windows.Window(0, int((90 - 45) * 240), W15, 1))[0]
            lon = -180 + (np.arange(W15) + 0.5) / 240
            asia = (lon > 80) & (lon < 110)        # 45 N, 80-110 E: Mongolia/Xinjiang, all land
            assert (row[asia] == 0).mean() > 0.99, "orientation check failed (45 N 80-110 E should be land)"
            pac = (lon > -170) & (lon < -150)      # 45 N, 170-150 W: open North Pacific
            assert (row[pac] != 0).mean() > 0.99, "orientation check failed (45 N 170-150 W should be ocean)"
        tmp.rename(out)
        nc.unlink()
        z.unlink()
        print(y, "->", out, out.stat().st_size, "bytes")


# ---------------------------------------------------------------- build

def row_area_km2(r0: int, n: int) -> np.ndarray:
    """Exact spherical area of one 15" cell in each of rows r0 .. r0+n-1 (row 0 = north edge)."""
    d = np.radians(1 / 240)
    phi_top = np.radians(90 - (r0 + np.arange(n)) / 240)
    return (R_KM ** 2) * d * (np.sin(phi_top) - np.sin(phi_top - d))


def direct(t: np.ndarray) -> np.ndarray:
    return (t >= 10) & (t <= 17)


def block_any(m: np.ndarray) -> np.ndarray:
    n = m.shape[0] // 4
    return m.reshape(n, 4, m.shape[1] // 4, 4).any(axis=(1, 3))


def block_sum(m: np.ndarray) -> np.ndarray:
    n = m.shape[0] // 4
    return m.reshape(n, 4, m.shape[1] // 4, 4).sum(axis=(1, 3), dtype=np.uint8)


def first_code(mask: np.ndarray) -> np.ndarray:
    """year bitmask (bit i = YEARS[i] measured) -> first-measured code.

    0 = never measured in any release; YY (19..26) = first release in which the cell was measured, and it is still
    measured in the latest release; 100 + YY = first measured in 20YY but NOT measured in the latest release.
    """
    mask = np.asarray(mask, dtype=np.uint8)
    out = np.zeros(mask.shape, dtype=np.uint8)
    done = np.zeros(mask.shape, dtype=bool)
    for i, y in enumerate(YEARS):
        hit = ~done & ((mask >> i) & 1).astype(bool)
        out[hit] = y - 2000
        done |= hit
    latest = ((mask >> (len(YEARS) - 1)) & 1).astype(bool)
    out[done & ~latest] += RECODED
    return out


def build(band_rows_1m: int = 120) -> dict:
    import rasterio

    paths = {y: tid_path(y) for y in YEARS}
    missing = [y for y, p in paths.items() if not p.exists()]
    assert not missing, f"missing TID grids: {missing} (run fetch + convert)"
    srcs = {y: rasterio.open(p) for y, p in paths.items()}
    elev = rasterio.open(ELEV)
    for y, s in srcs.items():
        assert s.shape == (H15, W15), (y, s.shape)
        assert all(abs(a - b) < 1e-9 for a, b in zip(s.transform, srcs[LATEST].transform)), y
    assert elev.shape == (H1, W1)
    ny = len(YEARS)

    mask1 = np.zeros((H1, W1), dtype=np.uint8)       # year bitmask per 1' cell (any 15" sub-cell measured)
    frac1 = np.zeros((H1, W1), dtype=np.uint8)       # number of measured 15" sub-cells in LATEST (0..16)
    ocean1 = np.zeros((H1, W1), dtype=np.uint8)      # number of ocean 15" sub-cells (0..16)
    ocean_km2 = 0.0
    meas = np.zeros(ny)                              # same-mask measured area per year
    own_ocean = np.zeros(ny)                         # each year's own mask (its TID != 0, 2026 elev < 0)
    own_meas = np.zeros(ny)
    new = np.zeros(ny)                               # vs previous release (same mask)
    lost = np.zeros(ny)
    ever = np.zeros(ny)                              # measured in this or any earlier release
    first_area = np.zeros(ny)                        # area whose first measured release is this one
    lat_edges = np.arange(-90, 91, 10)
    lat_ocean = np.zeros(len(lat_edges) - 1)
    lat_meas = np.zeros((ny, len(lat_edges) - 1))
    # re-coding: measured in year i, not measured in year j (same mask): what code does it get in j?
    lost_to = {y: np.zeros(128) for y in YEARS[1:]}

    for r0 in range(0, H1, band_rows_1m):
        n1 = min(band_rows_1m, H1 - r0)
        win15 = rasterio.windows.Window(0, 4 * r0, W15, 4 * n1)
        h = elev.read(1, window=rasterio.windows.Window(0, r0, W1, n1))
        sea15 = np.repeat(np.repeat(h < 0, 4, axis=0), 4, axis=1)
        t26 = srcs[LATEST].read(1, window=win15)
        ocean = sea15 & (t26 != 0)
        a = row_area_km2(4 * r0, 4 * n1)[:, None]
        A = np.broadcast_to(a, ocean.shape)
        ocean_km2 += A[ocean].sum()
        ocean1[r0:r0 + n1] = block_sum(ocean)
        lat_c = 90 - (4 * r0 + np.arange(4 * n1) + 0.5) / 240
        lb = np.clip(np.digitize(lat_c, lat_edges) - 1, 0, len(lat_edges) - 2)
        np.add.at(lat_ocean, lb, (ocean * a).sum(axis=1))
        prev = None
        ever15 = np.zeros(ocean.shape, dtype=bool)
        for i, y in enumerate(YEARS):
            t = t26 if y == LATEST else srcs[y].read(1, window=win15)
            m = ocean & direct(t)
            meas[i] += A[m].sum()
            own = sea15 & (t != 0)
            own_ocean[i] += A[own].sum()
            own_meas[i] += A[own & direct(t)].sum()
            np.add.at(lat_meas[i], lb, (m * a).sum(axis=1))
            fresh = m & ~ever15
            first_area[i] += A[fresh].sum()
            ever15 |= m
            ever[i] += A[ever15].sum()
            if prev is not None:
                new[i] += A[m & ~prev].sum()
                gone = prev & ~m
                lost[i] += A[gone].sum()
                lost_to[y] += np.bincount((t[gone].astype(np.int16) & 127), weights=A[gone], minlength=128)[:128]
            mask1[r0:r0 + n1] |= (block_any(m).astype(np.uint8) << i)
            if y == LATEST:
                frac1[r0:r0 + n1] = block_sum(m)
            prev = m
        print(f"\r1' rows {r0 + n1}/{H1}", end="", file=sys.stderr)
    print(file=sys.stderr)
    for s in srcs.values():
        s.close()
    elev.close()

    DERIVED.mkdir(parents=True, exist_ok=True)
    np.save(DERIVED / "history_mask_1arcmin.npy", mask1)
    np.save(DERIVED / "history_frac_latest_1arcmin.npy", frac1)
    np.save(DERIVED / "history_ocean_1arcmin.npy", ocean1)

    years = []
    for i, y in enumerate(YEARS):
        lt = lost_to.get(y)
        years.append({
            "year": y,
            "grid": f"GEBCO_{y}",
            "doi": DOIS[y],
            "measured_km2": round(meas[i]),
            "measured_frac": meas[i] / ocean_km2,
            "measured_frac_own_mask": own_meas[i] / own_ocean[i],
            "own_mask_ocean_km2": round(own_ocean[i]),
            "ever_measured_km2": round(ever[i]),
            "ever_measured_frac": ever[i] / ocean_km2,
            "first_measured_km2": round(first_area[i]),
            "new_vs_previous_km2": None if i == 0 else round(new[i]),
            "no_longer_measured_vs_previous_km2": None if i == 0 else round(lost[i]),
            "no_longer_measured_now_coded": None if lt is None else {
                str(c): round(lt[c]) for c in np.argsort(lt)[::-1] if lt[c] > 1e3},
            "official_percent": OFFICIAL[y]["percent"],
            "official_date": OFFICIAL[y]["date"],
            "official_quote": OFFICIAL[y]["quote"],
            "official_url": OFFICIAL[y]["url"],
            "lat_measured_frac": [None if lat_ocean[k] == 0 else lat_meas[i][k] / lat_ocean[k]
                                  for k in range(len(lat_ocean))],
        })
    stats = {
        "ocean_km2": round(ocean_km2),
        "ocean_mask": "GEBCO_2026 TID != 0 and GEBCO_2026 1' elevation < 0 (same mask for every year)",
        "measured_definition": "TID 10-17 (direct measurement)",
        "area": "exact spherical area of each 15\" cell, authalic sphere R = 6371.0072 km",
        "lat_edges": lat_edges.tolist(),
        "lat_ocean_km2": [round(v) for v in lat_ocean],
        "years": years,
    }
    (DERIVED / "history_stats.json").write_text(json.dumps(stats, indent=1))
    write_web(mask1, frac1, ocean1, stats)
    return stats


# ---------------------------------------------------------------- web files

def deflate(b: bytes) -> bytes:
    return zlib.compress(b, 9)


def write_web(mask1: np.ndarray, frac1: np.ndarray, ocean1: np.ndarray, stats: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    first = first_code(mask1)
    first[ocean1 == 0] = 0
    # The full per-year bitmask at 1' is another 17 MB deflated; it ships only inside the tiles (G channel) and
    # stays in data/derived/history_mask_1arcmin.npy, so the web download is one 14 MB grid.
    files = {"first-measured_1arcmin.bin": first}
    sizes = {}
    for name, a in files.items():
        raw = deflate(np.ascontiguousarray(a).tobytes())
        (OUT / name).write_bytes(raw)
        sizes[name] = len(raw)
    # 1' cell counts per code (cells, not area), so a decoder can check itself
    codes, counts = np.unique(first, return_counts=True)
    manifest = {
        "title": "Seafloor mapping history: GEBCO releases 2019-2026",
        "grid": {"ncol": W1, "nrow": H1, "cell_deg": 1 / 60, "row0": "north edge (89.99167 N cell centre)",
                 "col0": "179.99167 W cell centre", "order": "row-major", "dtype": "uint8",
                 "compression": "zlib (one byte plane)"},
        "files": {
            "first-measured_1arcmin.bin": {
                "meaning": "first GEBCO release in which any ocean 15\" sub-cell of this 1' cell is TID 10-17",
                "codes": {"0": "land, outside the ocean mask, or never measured in 2019-2026",
                          "19..26": "first measured in GEBCO_2019..GEBCO_2026 and still measured in GEBCO_2026",
                          "119..125": "first measured in GEBCO_2019..GEBCO_2025 (code - 100), but NOT measured in "
                                      "GEBCO_2026 (TID re-coded to an indirect / unknown class)"},
                "cells_per_code": {str(int(c)): int(n) for c, n in zip(codes, counts)},
                "bytes": sizes["first-measured_1arcmin.bin"]},
        },
        "rule_1arcmin": "a 1' cell counts as measured in a year if ANY of its 16 15\" ocean sub-cells is TID 10-17 "
                        "(keeps single-beam tracks, 1 cell wide, visible); the area statistics below are exact "
                        "15\" sums, not 1' counts",
        "stats": stats,
        "citation": "GEBCO Compilation Group (2019-2026) GEBCO_<year> Grid; one DOI per release in stats.years[].doi",
        "licence": "GEBCO Grid terms of use: public domain-like, free to use with attribution (GEBCO Compilation "
                   "Group); derived files here under the same terms",
        "attribution": "Mapping history from the GEBCO_2019-GEBCO_2026 Type Identifier grids (GEBCO Compilation "
                       "Group); official percentages from Seabed 2030 / GEBCO announcements",
        "caveats": [
            "Our share uses TID 10-17 at 15\" cells; the official Seabed 2030 figure counts cells with data at "
            "depth-dependent resolution (100 m to 800 m), so the two are not expected to match.",
            "TID codes change between releases for reasons other than new surveys (re-gridding, a data set "
            "re-classified as pre-generated grid or interpolation); cells can stop being 'measured'.",
            "One ocean mask (GEBCO_2026) for every year: coastline / ice-shelf changes between releases are ignored.",
            "1' cells count as measured if any 15\" sub-cell is; this overstates area if used for sums, so use stats.",
        ],
    }
    manifest["sizes_bytes"] = sizes
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(json.dumps(sizes))


def load_bin(name: str) -> np.ndarray:
    return np.frombuffer(zlib.decompress((OUT / name).read_bytes()), dtype=np.uint8).reshape(H1, W1)


# ---------------------------------------------------------------- tiles

TILE = 512
MAXZOOM = 5


def merc_row_lat_edges(size: int) -> np.ndarray:
    y = np.arange(size + 1) / size
    return np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y))))


def to_merc(mask1: np.ndarray, frac1: np.ndarray, ocean1: np.ndarray, size: int):
    """plate carree (global, row 0 = north) -> Web Mercator base level. Bitmask: OR; latest measured share: sums.

    Every Mercator pixel takes all source rows/columns it overlaps, even partly (at least one), so thin tracks are
    never dropped and a cell straddling a pixel edge lights both pixels.
    """
    nrow, ncol = mask1.shape
    assert size <= ncol, "each pixel column must cover at least one source column"
    rows_per_deg = nrow / 180
    edges = merc_row_lat_edges(size)
    c_edges = np.floor(np.arange(size) * ncol / size).astype(np.int64)  # first source column of each pixel column
    # last source column each pixel column overlaps (reduceat stops one short when a column straddles the edge)
    c_last = np.minimum(np.ceil(np.arange(1, size + 1) * ncol / size).astype(np.int64) - 1, ncol - 1)
    out_m = np.zeros((size, size), dtype=np.uint8)
    out_f = np.zeros((size, size), dtype=np.float32)
    for r in range(size):
        top, bot = edges[r], edges[r + 1]
        s0 = min(nrow - 1, int(np.floor((90 - top) * rows_per_deg)))
        s1 = max(s0 + 1, int(np.ceil((90 - bot) * rows_per_deg)))
        mk = np.bitwise_or.reduce(mask1[s0:s1], axis=0)
        out_m[r] = np.bitwise_or.reduceat(mk, c_edges) | mk[c_last]
        fsum = frac1[s0:s1].sum(axis=0, dtype=np.int64)
        osum = ocean1[s0:s1].sum(axis=0, dtype=np.int64)
        straddle = c_last >= np.append(c_edges[1:], ncol)       # partial column not inside reduceat's range
        fs = np.add.reduceat(fsum, c_edges) + np.where(straddle, fsum[c_last], 0)
        os_ = np.add.reduceat(osum, c_edges) + np.where(straddle, osum[c_last], 0)
        out_f[r] = np.where(os_ > 0, fs / np.maximum(os_, 1), np.nan)
    return out_m, out_f


def encode_tile(m: np.ndarray, f: np.ndarray) -> np.ndarray:
    """RGBA: R = first-measured code, G = year bitmask, B = 0, A = 255 over ocean (f = NaN outside the ocean).

    B is left empty on purpose: a measured-share channel tripled the tile size (tested on z5 tiles: 159 kB -> 51 kB
    without it) and the viewer already has that number in tiles/coverage/.
    """
    out = np.zeros(m.shape + (4,), dtype=np.uint8)
    ocean = ~np.isnan(f)
    out[..., 0] = np.where(ocean, first_code(m), 0)
    out[..., 1] = np.where(ocean, m, 0)
    out[..., 3] = np.where(ocean, 255, 0)
    return out


def down2_or(m: np.ndarray) -> np.ndarray:
    h, w = m.shape
    b = m.reshape(h // 2, 2, w // 2, 2)
    return b[:, 0, :, 0] | b[:, 0, :, 1] | b[:, 1, :, 0] | b[:, 1, :, 1]


def tiles() -> int:
    from PIL import Image

    from tiles import down2

    mask1 = np.load(DERIVED / "history_mask_1arcmin.npy")
    frac1 = np.load(DERIVED / "history_frac_latest_1arcmin.npy")
    ocean1 = np.load(DERIVED / "history_ocean_1arcmin.npy")
    size = TILE * 2 ** MAXZOOM
    m, f = to_merc(mask1, frac1, ocean1, size)
    del mask1, frac1, ocean1
    out = OUT / "tiles"
    count = 0
    nbytes = 0
    for z in range(MAXZOOM, -1, -1):
        n = 2 ** z
        assert m.shape == (n * TILE, n * TILE)
        for y in range(n):
            for x in range(n):
                sl = (slice(y * TILE, (y + 1) * TILE), slice(x * TILE, (x + 1) * TILE))
                p = out / str(z) / str(x)
                p.mkdir(parents=True, exist_ok=True)
                fn = p / f"{y}.webp"
                Image.fromarray(encode_tile(m[sl], f[sl]), "RGBA").save(fn, lossless=True, quality=100, method=4,
                                                                        exact=True)
                nbytes += fn.stat().st_size
                count += 1
        if z:
            m, f = down2_or(m), down2(f)
        print(f"z{z} done, {count} tiles, {nbytes / 1e6:.1f} MB", file=sys.stderr)
    man = json.loads((OUT / "manifest.json").read_text())
    man["tiles"] = {"url": "tiles/{z}/{x}/{y}.webp", "minzoom": 0, "maxzoom": MAXZOOM, "tileSize": TILE,
                    "projection": "Web Mercator XYZ", "format": "lossless WebP RGBA (exact)",
                    "R": "first-measured code (same codes as first-measured_1arcmin.bin)",
                    "G": "year bitmask (same as years-mask_1arcmin.bin), OR over the pixel",
                    "B": "0 (unused; the measured share per pixel is in tiles/coverage/)",
                    "A": "255 = ocean (inside the mask), 0 = land / outside the mask",
                    "aggregation": "R/G: OR of all 1' cells under the pixel (z5 pixel ~1.3' at the equator; z0 "
                                   "pixel ~42'): at low zoom almost every pixel touched by one track lights up; "
                                   "combine with the coverage layer (mean measured share) for opacity",
                    "count": count, "bytes": nbytes}
    (OUT / "manifest.json").write_text(json.dumps(man, indent=1))
    return count


# ---------------------------------------------------------------- figure

# map colours: 2019 = muted baseline, 2020-2026 = viridis steps (ordered, readable), re-coded = red, never = grey
BASE_2019 = "#a9b8c9"
LATER = ["#440154", "#443983", "#31688e", "#21918c", "#35b779", "#90d743", "#fde725"]  # 2020 .. 2026
RECODED_RGB = "#e34948"
NEVER = "#dedede"


def figure() -> Path:
    """figures/fig13_mapping_history.png: measured share per release (ours vs official) + first-measured map."""
    import cartopy.crs as ccrs
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap
    from matplotlib.patches import Patch

    from figures import FIG, globe_axes

    stats = json.loads((DERIVED / "history_stats.json").read_text())
    ys = stats["years"]
    yr = [y["year"] for y in ys]
    ours = [100 * y["measured_frac"] for y in ys]
    ever = [100 * y["ever_measured_frac"] for y in ys]
    off = [y["official_percent"] for y in ys]

    mask = np.load(DERIVED / "history_mask_1arcmin.npy")
    ocean = np.load(DERIVED / "history_ocean_1arcmin.npy")
    k = 4  # 1' -> 4'
    h, w = mask.shape
    mb = mask.reshape(h // k, k, w // k, k)
    m4 = np.bitwise_or.reduce(np.bitwise_or.reduce(mb, axis=3), axis=1)
    o4 = ocean.reshape(h // k, k, w // k, k).max(axis=(1, 3)) > 0
    code = first_code(m4)
    del mask, mb

    fig = plt.figure(figsize=(12, 11.5))
    gs = fig.add_gridspec(2, 1, height_ratios=[1, 1.6], hspace=0.16, bottom=0.15, top=0.97)
    ax = fig.add_subplot(gs[0])
    ax.plot(yr, ours, color="#2a78d6", lw=2, marker="o", ms=6, label="This project: TID 10-17, same ocean mask")
    ax.plot(yr, off, color="#eb6834", lw=2, marker="s", ms=6, label="Seabed 2030 / GEBCO announced figure")
    ax.plot(yr, ever, color="#52514e", lw=1.5, ls="--", marker="o", ms=4,
            label="Measured in this or any earlier release")
    for i, dx, ha in ((0, -10, "right"), (len(yr) - 1, 10, "left")):  # direct labels only at the ends
        ax.annotate(f"{ours[i]:.1f}%", (yr[i], ours[i]), textcoords="offset points", xytext=(dx, -4), fontsize=9,
                    color="#0b0b0b", ha=ha)
        ax.annotate(f"{off[i]:.1f}%", (yr[i], off[i]), textcoords="offset points", xytext=(dx, -4), fontsize=9,
                    color="#52514e", ha=ha)
    ax.annotate(f"{ever[-1]:.1f}%", (yr[-1], ever[-1]), textcoords="offset points", xytext=(10, -4), fontsize=9,
                color="#52514e")
    ax.set_xlim(yr[0] - 0.7, yr[-1] + 0.7)
    ax.set_xticks(yr, [f"GEBCO_{y}" for y in yr], fontsize=8)
    ax.set_ylabel("Share of the seafloor directly measured (%)")
    ax.set_ylim(0, 36)
    ax.grid(axis="y", color="0.88", lw=0.6)
    ax.legend(frameon=False, loc="upper left", fontsize=9)
    ax.set_title("(a) Directly measured share of the seafloor in each GEBCO release", fontsize=12, loc="left")

    gx = globe_axes(fig, gs[1])
    to = matplotlib.colors.to_rgb
    rgb = np.full(code.shape + (3,), 0.985, dtype=np.float32)       # land / outside mask
    rgb[o4] = to(NEVER)                                             # ocean, never measured
    colours = [BASE_2019] + LATER
    for i, y in enumerate(YEARS):
        rgb[o4 & (code == y - 2000)] = to(colours[i])
    rgb[o4 & (code >= RECODED)] = to(RECODED_RGB)
    gx.imshow(rgb, extent=[-180, 180, -90, 90], transform=ccrs.PlateCarree(), origin="upper",
              regrid_shape=(2700, 5400), interpolation="nearest")
    handles = [Patch(color=colours[i], label=str(y)) for i, y in enumerate(YEARS)]
    handles += [Patch(color=RECODED_RGB, label="earlier, not in 2026"), Patch(color=NEVER, label="never")]
    fig.legend(handles=handles, loc="center", bbox_to_anchor=(0.5, 0.125), ncol=10, frameon=False,
               fontsize=8.5, handlelength=1.4, columnspacing=1.0,
               title="First GEBCO release in which the cell is directly measured", title_fontsize=9)
    gx.set_title("(b) When each part of the seafloor first appears as measured (4\u2032 cells, any measured "
                 "15\u2033 sub-cell)", fontsize=12, loc="left")
    last = ys[-1]
    fig.text(0.5, 0.06,
             f"Ocean mask fixed to GEBCO_2026 (TID \u2260 0 and elevation < 0): {stats['ocean_km2'] / 1e6:.1f} M km\u00b2. "
             f"Measured in at least one release by 2026: {100 * last['ever_measured_frac']:.1f}%, in GEBCO_2026 itself: "
             f"{100 * last['measured_frac']:.1f}%;\nthe gap is cells re-coded to indirect classes between releases. "
             "Seabed 2030 computes its figure on its own depth-dependent grid, so it is not expected to equal a TID share.",
             ha="center", fontsize=8, color="0.25")
    fig.text(0.5, 0.025, "Data: GEBCO Compilation Group (2019-2026) GEBCO_2019 ... GEBCO_2026 Type Identifier "
             "grids (DOIs in web/public/history/manifest.json); official figures: GEBCO / Seabed 2030 / Nippon "
             "Foundation announcements", ha="center", fontsize=7, color="0.35")
    out = FIG / "fig13_mapping_history.png"
    fig.savefig(out)
    plt.close(fig)
    return out

# ---------------------------------------------------------------- check

def check() -> None:
    man = json.loads((OUT / "manifest.json").read_text())
    first = load_bin("first-measured_1arcmin.bin")
    mask = np.load(DERIVED / "history_mask_1arcmin.npy")
    ocean = np.load(DERIVED / "history_ocean_1arcmin.npy")
    assert np.array_equal(first, np.where(ocean > 0, first_code(mask), 0)), "first-measured != f(year mask)"
    codes, counts = np.unique(first, return_counts=True)
    assert {str(int(c)): int(n) for c, n in zip(codes, counts)} == man["files"]["first-measured_1arcmin.bin"][
        "cells_per_code"]
    ok = set(range(19, 27)) | set(range(119, 126)) | {0}
    assert set(int(c) for c in codes) <= ok, codes
    ys = man["stats"]["years"]
    for a, b in zip(ys, ys[1:]):
        # bookkeeping: m(b) = m(a) + new - lost
        assert abs(b["measured_km2"] - (a["measured_km2"] + b["new_vs_previous_km2"]
                                        - b["no_longer_measured_vs_previous_km2"])) < 5, (a["year"], b["year"])
        assert b["ever_measured_km2"] >= a["ever_measured_km2"]
    assert abs(sum(y["first_measured_km2"] for y in ys) - ys[-1]["ever_measured_km2"]) < 5
    # spot checks on the 1' grid
    def at(lon, lat):
        return int(first[int((90 - lat) * 60), int((lon + 180) * 60)])
    print("Mongolia (100E, 46N):", at(100, 46))
    for y in ys:
        print(y["year"], f"ours {100 * y['measured_frac']:.2f}%  own-mask {100 * y['measured_frac_own_mask']:.2f}%"
              f"  official {y['official_percent']}%  new {y['new_vs_previous_km2']}  lost "
              f"{y['no_longer_measured_vs_previous_km2']}")
    tdir = OUT / "tiles"
    if tdir.exists():
        from PIL import Image
        n = 2 ** MAXZOOM
        rng = np.random.default_rng(0)
        meas = np.argwhere(mask > 0)
        sample = meas[rng.choice(len(meas), 2000, replace=False)]
        bad = 0
        for r, c in sample:
            lat = 90 - (r + 0.5) / 60
            lon = -180 + (c + 0.5) / 60
            if abs(lat) > 85.05:
                continue
            X = (lon + 180) / 360 * n * TILE
            Y = (1 - np.log(np.tan(np.radians(45 + lat / 2))) / np.pi) / 2 * n * TILE
            tx, ty = int(X // TILE), int(Y // TILE)
            px = np.asarray(Image.open(tdir / f"{MAXZOOM}/{tx}/{ty}.webp").convert("RGBA"))[int(Y) % TILE, int(X) % TILE]
            # the pixel ORs every 1' cell it touches, so it holds at least this cell's years
            bad += int((int(px[1]) & int(mask[r, c])) != int(mask[r, c]) or px[3] != 255
                       or px[0] != first_code(np.array([px[1]], dtype=np.uint8))[0])
        print(f"tiles: {bad} of {len(sample)} sampled measured 1' cells disagree with their z5 pixel")
        assert bad == 0
    print("check ok")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["fetch", "convert", "build", "tiles", "figure", "check"])
    ap.add_argument("years", nargs="*", type=int)
    a = ap.parse_args()
    years = a.years or [y for y in YEARS if y < 2025]
    if a.step == "fetch":
        fetch(years)
    elif a.step == "convert":
        convert(years)
    elif a.step == "build":
        s = build()
        for y in s["years"]:
            print(y["year"], f"{100 * y['measured_frac']:.2f}%", "official", y["official_percent"])
    elif a.step == "tiles":
        print(tiles(), "tiles")
    elif a.step == "figure":
        print(figure())
    else:
        check()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
