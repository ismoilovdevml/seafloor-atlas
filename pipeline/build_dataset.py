"""Citable dataset: the per-cell record of directly measured seafloor in GEBCO releases 2019-2026.

Steps (see dataset/README.md):

  python pipeline/build_dataset.py build    dataset/build/seafloor_measured_record_2019_2026.nc (CF-1.8, ACDD-1.3,
                                            15" grid) + dataset/build/summary_cube.npz (area sums for the tables)
  python pipeline/build_dataset.py tables   dataset/tables/*.csv from the cube, history.OFFICIAL and
                                            data/derived/sensitivity_cellsize.json
  python pipeline/build_dataset.py verify   recompute the global numbers FROM THE NETCDF FILE and assert they equal
                                            data/derived/history_stats.json (<= 1 km2, <= 1e-9 fraction)
  python pipeline/build_dataset.py checksums  dataset/checksums.sha256

Everything follows pipeline/history.py: one ocean mask for every release (GEBCO_2026 TID != 0 AND GEBCO_2026 1'
elevation < 0), measured = TID 10-17 (history.direct), exact spherical 15" cell areas on the authalic sphere
(history.row_area_km2, R = 6371.0072 km). The 15" grid is processed in row strips of STRIP rows by a process pool.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import coverage  # noqa: E402
import history  # noqa: E402

ROOT = history.ROOT
DATASET = ROOT / "dataset"
BUILD = DATASET / "build"
TABLES = DATASET / "tables"
NC = BUILD / "seafloor_measured_record_2019_2026.nc"
CUBE = BUILD / "summary_cube.npz"
REGIONS_1M = BUILD / "regions_1arcmin.npy"
REGIONS_LABELS = BUILD / "regions_labels.json"
HISTORY_STATS = history.DERIVED / "history_stats.json"
SENS_JSON = history.DERIVED / "sensitivity_cellsize.json"
REGIONS_JSON = history.DERIVED / "regions.json"

YEARS = history.YEARS
NY = len(YEARS)
LATEST = history.LATEST
H15, W15 = history.H15, history.W15
H1, W1 = history.H1, history.W1
STRIP = 720                       # 15" rows per strip: multiple of 4 (1' rows) and = the netCDF chunk height
CHUNK = (720, 1440)               # 3 x 6 degrees
FILL16 = np.int16(-1)
FILL8 = np.int8(-1)
LAT_EDGES = coverage.LAT_EDGES    # 5 degree bands
NBANDS = len(LAT_EDGES) - 1
DEPTH_EDGES = coverage.DEPTH_EDGES  # 250 m bins of the GEBCO_2026 1' elevation, -11000 .. 0 m
NDEPTH = len(DEPTH_EDGES) - 1
ZONES = ["caspian_box_excluded", "eez", "high_seas", "neither"]   # zone code 0..3
Q_NAMES = ["measured", "ever_measured", "first_measured", "new_vs_previous", "recoded_away_vs_previous"]
VERSION = "1.0.0"
ORCID = "https://orcid.org/0009-0008-2785-3691"

TID_MEANING = {  # GEBCO grid documentation (GEBCO_2026), Table 2
    0: "land", 10: "single beam", 11: "multibeam", 12: "seismic", 13: "isolated sounding", 14: "ENC sounding",
    15: "lidar", 16: "optical light sensor", 17: "combination of direct measurement methods",
    40: "predicted from satellite-derived gravity", 41: "interpolated by a computer algorithm",
    42: "digital bathymetric contours from charts", 43: "digital bathymetric contours from ENCs",
    44: "multiple sources in a gridded data set guided by satellite gravity", 45: "predicted from airborne gravity",
    46: "grounded-iceberg draft", 47: "grounded Argo float", 48: "animal-borne data logger",
    70: "pre-generated grid", 71: "unknown source", 72: "steering points",
}


# ---------------------------------------------------------------- per-cell record (pure, tested)

def _luts() -> dict[str, np.ndarray]:
    """Lookup tables bitmask (bit i = measured in YEARS[i]) -> per-cell record values, for all 256 bitmasks."""
    b = np.arange(256)
    first = np.full(256, FILL16, np.int16)
    last = np.full(256, FILL16, np.int16)
    for i in reversed(range(NY)):          # lowest set bit assigned last -> wins
        first[(b >> i) & 1 == 1] = YEARS[i]
    for i in range(NY):                    # highest set bit assigned last -> wins
        last[(b >> i) & 1 == 1] = YEARS[i]
    n = sum(((b >> i) & 1) for i in range(NY)).astype(np.int8)
    latest = ((b >> (NY - 1)) & 1).astype(np.int8)
    recoded = (((b & ((1 << (NY - 1)) - 1)) != 0) & (latest == 0)).astype(np.int8)
    return {"first": first, "last": last, "n": n, "latest": latest, "recoded": recoded}


LUT = _luts()


def record_from_bits(bits: np.ndarray, ocean: np.ndarray) -> dict[str, np.ndarray]:
    """Per-cell record from the year bitmask; cells outside the ocean mask get the fill value (-1)."""
    bits = np.asarray(bits, dtype=np.uint8)
    out = {k: v[bits] for k, v in LUT.items()}
    land = ~np.asarray(ocean, dtype=bool)
    for k, v in out.items():
        v[land] = FILL16 if v.dtype == np.int16 else FILL8
    return out


def area_from_lat_bnds(lat_bnds: np.ndarray, dlon_deg: float) -> np.ndarray:
    """Exact cell area (km2) per row from latitude bounds (degrees), authalic sphere."""
    s = np.sin(np.radians(lat_bnds))
    return history.R_KM ** 2 * np.radians(dlon_deg) * np.abs(s[:, 1] - s[:, 0])


def global_sums(bits: np.ndarray, ocean: np.ndarray, area_row: np.ndarray) -> dict[str, np.ndarray]:
    """Area sums (km2) of a strip, per release: measured, ever, first, new, re-coded away vs previous release."""
    a = np.asarray(area_row, dtype=np.float64)
    bits = np.where(ocean, bits, 0).astype(np.uint8)
    res = {"ocean": float(ocean.sum(axis=1) @ a), **{q: np.zeros(NY) for q in Q_NAMES}}
    ever = np.zeros(bits.shape, bool)
    prev = None
    for i in range(NY):
        m = ((bits >> i) & 1).astype(bool)
        res["measured"][i] = m.sum(axis=1) @ a
        res["first_measured"][i] = (m & ~ever).sum(axis=1) @ a
        ever |= m
        res["ever_measured"][i] = ever.sum(axis=1) @ a
        if prev is not None:
            res["new_vs_previous"][i] = (m & ~prev).sum(axis=1) @ a
            res["recoded_away_vs_previous"][i] = (prev & ~m).sum(axis=1) @ a
        prev = m
    return res


# ---------------------------------------------------------------- regions (1' ids, as pipeline/regions.py)

def build_regions() -> dict:
    """Burn GOaS / EEZ / high seas onto the 1' grid exactly as regions.compute() does; one uint16 code per cell:
    code = goas_index * 4 + zone. goas_index 0 = outside all GOaS polygons, 1..n = polygons, n+1 = Caspian box."""
    import rasterio

    import regions

    if REGIONS_1M.exists() and REGIONS_LABELS.exists():
        return json.loads(REGIONS_LABELS.read_text())
    with rasterio.open(history.ELEV) as s:
        transform, shape = s.transform, s.shape
    assert shape == (H1, W1)
    print("rasterise goas / eez / high_seas (cached GeoJSON tiles in data/raw/regions/)", file=sys.stderr)
    gid, _, gtab = regions.burn("goas", lambda p: p["name"], shape, transform, "uint8")
    is_joint = lambda p: p.get("pol_type") == "Joint regime"  # noqa: E731
    eid, _, _ = regions.burn("eez", lambda p: p["mrgid"], shape, transform, "uint16", select=lambda p: not is_joint(p))
    jid, _, _ = regions.burn("eez", lambda p: p["mrgid"], shape, transform, "uint16", select=is_joint)
    hid, _, _ = regions.burn("high_seas", lambda p: p.get("name") or "high seas", shape, transform, "uint8")
    in_eez = (eid > 0) | (jid > 0)
    del eid, jid
    zone = np.full(shape, 3, np.uint16)
    zone[in_eez] = 1
    zone[(hid > 0) & ~in_eez] = 2
    del hid, in_eez
    casp = regions.box_mask(shape, transform, regions.CASPIAN_BOX)
    ng = len(gtab)
    goas = gid.astype(np.uint16)
    goas[casp] = ng + 1
    zone[casp] = 0
    code = goas * 4 + zone
    BUILD.mkdir(parents=True, exist_ok=True)
    np.save(REGIONS_1M, code)
    names = ["Outside all GOaS polygons"] + [""] * ng + ["Caspian Sea box (excluded)"]
    for name, (i, _) in gtab.items():
        names[i] = name.replace("Easter Archipelagic", "Eastern Archipelagic")  # as regions.py
    labels = {"goas": names, "zones": ZONES, "n_codes": int(4 * (ng + 2)),
              "caspian_box": list(regions.CASPIAN_BOX), "sources": {k: v["cite"] for k, v in regions.SOURCES.items()},
              "licence": regions.LICENCE}
    REGIONS_LABELS.write_text(json.dumps(labels, indent=1))
    return labels


# ---------------------------------------------------------------- build (worker)

_SRC: dict = {}


def _open():
    if not _SRC:
        import rasterio
        _SRC["tid"] = {y: rasterio.open(history.tid_path(y)) for y in YEARS}
        _SRC["elev"] = rasterio.open(history.ELEV)
        _SRC["reg"] = np.load(REGIONS_1M, mmap_mode="r")
        _SRC["ncode"] = json.loads(REGIONS_LABELS.read_text())["n_codes"]
    return _SRC


def _work(r0: int) -> tuple[int, np.ndarray, np.ndarray, dict]:
    """One strip of 15" rows r0 .. r0+STRIP-1 (north-up, row 0 = 90 N edge)."""
    import rasterio

    src = _open()
    n = min(STRIP, H15 - r0)
    n1 = n // 4
    win15 = rasterio.windows.Window(0, r0, W15, n)
    h = src["elev"].read(1, window=rasterio.windows.Window(0, r0 // 4, W1, n1))
    sea15 = np.repeat(np.repeat(h < 0, 4, axis=0), 4, axis=1)
    t26 = src["tid"][LATEST].read(1, window=win15)
    ocean = sea15 & (t26 != 0)                                       # history.build mask
    area = history.row_area_km2(r0, n)
    lat = 90 - (r0 + np.arange(n) + 0.5) / 240
    band = np.clip(np.digitize(lat, LAT_EDGES) - 1, 0, NBANDS - 1)

    reg = np.asarray(src["reg"][r0 // 4: r0 // 4 + n1]).astype(np.int32)
    ncode = src["ncode"]
    dbin = np.clip(np.digitize(h, DEPTH_EDGES) - 1, 0, NDEPTH - 1)
    combo1 = reg * NDEPTH + dbin                                     # region code x depth bin, per 1' cell
    ncombo = ncode * NDEPTH
    key = np.repeat(np.repeat(combo1, 4, axis=0), 4, axis=1) + (np.arange(n, dtype=np.int32) * ncombo)[:, None]
    del combo1, reg, dbin

    def per_band(sel: np.ndarray) -> np.ndarray:
        cnt = np.bincount(key[sel], minlength=n * ncombo).reshape(n, ncombo)
        acc = np.zeros((NBANDS, ncombo))
        np.add.at(acc, band, cnt * area[:, None])
        return acc

    out = {"ocean": per_band(ocean), "q": np.zeros((NY, len(Q_NAMES), NBANDS, ncombo)),
           "lost_to": np.zeros((NY, 128)), "own_ocean": np.zeros(NY), "own_meas": np.zeros(NY)}
    bits = np.zeros(ocean.shape, np.uint8)
    ever = np.zeros(ocean.shape, bool)
    prev = None
    rows = np.arange(n)[:, None]
    for i, y in enumerate(YEARS):
        t = t26 if y == LATEST else src["tid"][y].read(1, window=win15)
        d = history.direct(t)
        m = ocean & d
        bits |= m.astype(np.uint8) << i
        own = sea15 & (t != 0)
        out["own_ocean"][i] = own.sum(axis=1) @ area
        out["own_meas"][i] = (own & d).sum(axis=1) @ area
        out["q"][i, 0] = per_band(m)
        out["q"][i, 2] = per_band(m & ~ever)
        ever |= m
        out["q"][i, 1] = per_band(ever)
        if prev is not None:
            out["q"][i, 3] = per_band(m & ~prev)
            gone = prev & ~m
            k = (np.broadcast_to(rows, gone.shape)[gone] * 128 + (t[gone].astype(np.int16) & 127))
            out["lost_to"][i] = np.bincount(k, minlength=n * 128).reshape(n, 128).T @ area
            out["q"][i, 4] = per_band(gone)
        prev = m
    return r0, bits, ocean, out


# ---------------------------------------------------------------- build (main)

def _attrs_global(now: str) -> dict:
    src = "; ".join(f"GEBCO Compilation Group ({y}) GEBCO_{y} Grid, Type Identifier (TID) grid, doi:{history.DOIS[y]}"
                    for y in YEARS)
    return {
        "Conventions": "CF-1.8, ACDD-1.3",
        "title": "Record of directly measured seafloor in the GEBCO grid releases 2019-2026 (15 arc-second)",
        "summary": (
            "For every 15 arc-second cell of the global ocean, which of the eight GEBCO grid releases GEBCO_2019 to "
            "GEBCO_2026 code the cell as directly measured (Type Identifier TID 10-17: single beam, multibeam, "
            "seismic, isolated sounding, ENC sounding, lidar, optical, combination of direct methods). Variables: "
            "the per-release bitmask, the first and last release in which the cell is measured, the number of "
            "releases in which it is measured, whether it is measured in GEBCO_2026, whether it was measured in an "
            "earlier release but is no longer measured in GEBCO_2026 (re-coded away), and the fixed ocean mask. "
            "One ocean mask is used for every release, so release-to-release differences come only from the TID "
            "codes. Measured share of the seafloor: 12.43 % in GEBCO_2019, 30.81 % in GEBCO_2026; measured in at "
            "least one release by 2026: 33.04 %."),
        "keywords": ("bathymetry, seafloor mapping, GEBCO, Seabed 2030, type identifier, ocean mapping coverage, "
                     "EARTH SCIENCE > OCEANS > BATHYMETRY/SEAFLOOR TOPOGRAPHY > BATHYMETRY"),
        "keywords_vocabulary": "GCMD Science Keywords (last keyword only)",
        "id": "seafloor_measured_record_2019_2026",
        "product_version": VERSION,
        "processing_level": "Derived product (Level 4 equivalent): per-cell classification of GEBCO TID grids",
        "source": src,
        "history": (f"{now} created by pipeline/build_dataset.py (Seafloor Atlas, "
                    "https://github.com/ismoilovdevml/seafloor-atlas) from the eight GEBCO TID grids (converted to "
                    "north-up Int8 GeoTIFF by pipeline/history.py convert, values unchanged) and the GEBCO_2026 1' "
                    "elevation grid (block mean of GEBCO_2026 15\" elevation)"),
        "comment": ("Values outside the ocean mask are _FillValue (-1) for every variable except ocean_mask and "
                    "measured_release_flags (0 outside the mask). Latitude is ascending (south to north), the "
                    "same orientation and cell registration as the GEBCO netCDF grids, so index (i, j) here is "
                    "index (i, j) in GEBCO_<year>_TID.nc."),
        "measured_definition": ("A cell is 'measured' in a release if its GEBCO TID code in that release is 10-17 "
                                "(direct measurement) and it lies inside the ocean mask."),
        "ocean_mask_definition": ("GEBCO_2026 TID != 0 AND GEBCO_2026 1 arc-minute elevation < 0 (the 1' cell "
                                  "containing the 15\" cell). The same mask is used for every release. It excludes "
                                  "the Antarctic ice sheet and grounded ice above sea level; it keeps lake beds below "
                                  "sea level (e.g. the Caspian Sea)."),
        "area_method": ("Exact spherical area of each 15\" cell on the authalic sphere, R = 6371.0072 km: "
                        "A = R^2 * dlon * (sin(lat_north) - sin(lat_south)), dlon = 15\" in radians. The ocean mask "
                        "covers 361,694,058 km2."),
        "gebco_2023_tid_version": ("The GEBCO_2023 TID grid used is the January 2024 re-issue (zip on CEDA, "
                                   "GEBCO_2023_TID.nc dated 2024-02-12) that corrects TID coding in the central "
                                   "Mediterranean and North Pacific; the original April 2023 file gives 25.89 % "
                                   "instead of 26.27 % for 2023. Both carry DOI 10.5285/f98b053b-0cbc-6c23-e053-"
                                   "6c86abc0af7b. See docs/gebco2023_tid_version.md in the Seafloor Atlas "
                                   "repository."),
        "first_measured_note": ("'First measured in GEBCO_YYYY' is the first release that codes the cell TID 10-17, "
                                "not the survey year: a release can add surveys collected years earlier."),
        "references": ("GEBCO Compilation Group (2019-2026) GEBCO_<year> Grid, DOIs listed in 'source'; "
                       "GEBCO grid documentation, Table 2 (TID codes), https://www.gebco.net/data-products/gridded-"
                       "bathymetry-data; Mayer, L. et al. (2018) The Nippon Foundation-GEBCO Seabed 2030 Project, "
                       "Geosciences 8, 63, doi:10.3390/geosciences8020063; Seafloor Atlas, doi:10.5281/zenodo.24228190"),
        "license": "CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/). Derived from the GEBCO Grid, which is "
                   "free to use with attribution to the GEBCO Compilation Group (GEBCO Grid terms of use).",
        "acknowledgement": "Contains data from the GEBCO_2019 to GEBCO_2026 Grids, GEBCO Compilation Group.",
        "creator_name": "Otabek Ismoilov",
        "creator_type": "person",
        "creator_url": ORCID,
        "creator_institution": "Independent researcher",
        "institution": "Independent researcher",
        "project": "Seafloor Atlas",
        "naming_authority": "org.seaflooratlas",
        "standard_name_vocabulary": "CF Standard Name Table v84",
        "cdm_data_type": "Grid",
        "date_created": now,
        "date_metadata_modified": now,
        "time_coverage_start": "2019",
        "time_coverage_end": "2026",
        "geospatial_lat_min": -90.0,
        "geospatial_lat_max": 90.0,
        "geospatial_lat_units": "degrees_north",
        "geospatial_lat_resolution": "15 arc-seconds (0.004166667 degree)",
        "geospatial_lon_min": -180.0,
        "geospatial_lon_max": 180.0,
        "geospatial_lon_units": "degrees_east",
        "geospatial_lon_resolution": "15 arc-seconds (0.004166667 degree)",
        "geospatial_bounds": "POLYGON ((-180 -90, 180 -90, 180 90, -180 90, -180 -90))",
        "geospatial_bounds_crs": "EPSG:4326",
    }


def _create_nc(path: Path, now: str):
    import netCDF4

    ds = netCDF4.Dataset(path, "w", format="NETCDF4")
    ds.setncatts(_attrs_global(now))
    ds.createDimension("lat", H15)
    ds.createDimension("lon", W15)
    ds.createDimension("nv", 2)
    lat = ds.createVariable("lat", "f8", ("lat",))
    lat.setncatts({"standard_name": "latitude", "long_name": "latitude of cell centre", "units": "degrees_north",
                   "axis": "Y", "bounds": "lat_bnds", "coverage_content_type": "coordinate"})
    lon = ds.createVariable("lon", "f8", ("lon",))
    lon.setncatts({"standard_name": "longitude", "long_name": "longitude of cell centre", "units": "degrees_east",
                   "axis": "X", "bounds": "lon_bnds", "coverage_content_type": "coordinate"})
    latb = ds.createVariable("lat_bnds", "f8", ("lat", "nv"))
    lonb = ds.createVariable("lon_bnds", "f8", ("lon", "nv"))
    i = np.arange(H15)
    j = np.arange(W15)
    lat[:] = -90 + (i + 0.5) / 240
    latb[:] = np.stack([-90 + i / 240, -90 + (i + 1) / 240], axis=1)
    lon[:] = -180 + (j + 0.5) / 240
    lonb[:] = np.stack([-180 + j / 240, -180 + (j + 1) / 240], axis=1)
    crs = ds.createVariable("crs", "i4")
    crs.setncatts({"grid_mapping_name": "latitude_longitude", "semi_major_axis": 6378137.0,
                   "inverse_flattening": 298.257223563, "longitude_of_prime_meridian": 0.0,
                   "crs_wkt": 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],'
                              'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]',
                   "comment": "GEBCO grids are referenced to WGS84; cell areas are computed on the authalic sphere"})
    comp = {"zlib": True, "complevel": 4, "shuffle": True, "chunksizes": CHUNK}
    years = np.array(YEARS, dtype=np.int16)
    rel = " ".join(f"gebco_{y}" for y in YEARS)

    def var(name, dtype, fill, attrs):
        v = ds.createVariable(name, dtype, ("lat", "lon"), fill_value=fill, **comp)
        v.setncatts({"grid_mapping": "crs", **attrs})
        return v

    # short, not ubyte: CF-1.8 (sect. 2.2) does not list the netCDF-4 unsigned types; shuffle + zlib make the
    # always-zero high byte nearly free
    var("measured_release_flags", "i2", False, {
        "long_name": "GEBCO releases in which the cell is directly measured (TID 10-17), bitmask",
        "flag_masks": np.array([1 << k for k in range(NY)], dtype=np.int16),
        "valid_min": np.int16(0), "valid_max": np.int16((1 << NY) - 1),
        "flag_meanings": " ".join(f"measured_in_gebco_{y}" for y in YEARS),
        "comment": "bit k (value 2**k) set = measured in GEBCO_(2019 + k); 0 outside the ocean mask",
        "coverage_content_type": "thematicClassification"})
    var("first_measured_release", "i2", FILL16, {
        "long_name": "first GEBCO release in which the cell is directly measured (TID 10-17)",
        "flag_values": years, "flag_meanings": rel, "valid_min": years[0], "valid_max": years[-1],
        "comment": "release year; _FillValue = never measured in 2019-2026, or outside the ocean mask",
        "coverage_content_type": "thematicClassification"})
    var("last_measured_release", "i2", FILL16, {
        "long_name": "last GEBCO release in which the cell is directly measured (TID 10-17)",
        "flag_values": years, "flag_meanings": rel, "valid_min": years[0], "valid_max": years[-1],
        "comment": "release year; _FillValue = never measured in 2019-2026, or outside the ocean mask",
        "coverage_content_type": "thematicClassification"})
    var("n_releases_measured", "i1", FILL8, {
        "long_name": "number of GEBCO releases 2019-2026 in which the cell is directly measured (TID 10-17)",
        "units": "1", "valid_min": np.int8(0), "valid_max": np.int8(NY),
        "comment": "_FillValue outside the ocean mask", "coverage_content_type": "auxiliaryInformation"})
    var("measured_in_2026", "i1", FILL8, {
        "long_name": "cell is directly measured (TID 10-17) in GEBCO_2026",
        "flag_values": np.array([0, 1], np.int8), "flag_meanings": "not_measured measured",
        "comment": "_FillValue outside the ocean mask", "coverage_content_type": "thematicClassification"})
    var("recoded_away", "i1", FILL8, {
        "long_name": "cell was directly measured in at least one release 2019-2025 but is not measured in "
                     "GEBCO_2026 (TID re-coded to a non-direct class)",
        "flag_values": np.array([0, 1], np.int8), "flag_meanings": "not_recoded_away recoded_away",
        "comment": "_FillValue outside the ocean mask", "coverage_content_type": "thematicClassification"})
    var("ocean_mask", "i1", False, {
        "long_name": "fixed ocean mask: GEBCO_2026 TID != 0 and GEBCO_2026 1 arc-minute elevation < 0",
        "flag_values": np.array([0, 1], np.int8), "flag_meanings": "outside_mask ocean",
        "coverage_content_type": "auxiliaryInformation"})
    return ds


def build(workers: int, limit: int | None = None) -> dict:
    import rasterio

    for y in YEARS:
        with rasterio.open(history.tid_path(y)) as s:
            assert s.shape == (H15, W15), (y, s.shape)
            assert all(abs(a - b) < 1e-12 for a, b in zip(s.transform, (1 / 240, 0, -180, 0, -1 / 240, 90))), y
    labels = build_regions()
    ncode = labels["n_codes"]
    BUILD.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    tmp = NC.with_suffix(".tmp.nc")
    ds = _create_nc(tmp, now)
    starts = list(range(0, H15, STRIP))[:limit]
    tot = None
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=workers) as ex:
        pending = {}
        it = iter(starts)
        for r0 in [next(it, None) for _ in range(workers + 1)]:
            if r0 is not None:
                pending[r0] = ex.submit(_work, r0)
        done = 0
        while pending:
            r0 = min(pending)
            _, bits, ocean, out = pending.pop(r0).result()
            nxt = next(it, None)
            if nxt is not None:
                pending[nxt] = ex.submit(_work, nxt)
            rec = record_from_bits(bits, ocean)
            n = bits.shape[0]
            sl = slice(H15 - r0 - n, H15 - r0)                     # north-up strip -> ascending latitude
            ds["measured_release_flags"][sl, :] = bits[::-1]
            ds["first_measured_release"][sl, :] = rec["first"][::-1]
            ds["last_measured_release"][sl, :] = rec["last"][::-1]
            ds["n_releases_measured"][sl, :] = rec["n"][::-1]
            ds["measured_in_2026"][sl, :] = rec["latest"][::-1]
            ds["recoded_away"][sl, :] = rec["recoded"][::-1]
            ds["ocean_mask"][sl, :] = ocean[::-1].astype(np.int8)
            if tot is None:
                tot = out
            else:
                for k in tot:
                    tot[k] = tot[k] + out[k]
            done += 1
            print(f"\rstrips {done}/{len(starts)}  {time.time() - t0:.0f} s", end="", file=sys.stderr)
    print(file=sys.stderr)
    ds.close()
    tmp.rename(NC)
    runtime = time.time() - t0
    assert tot["ocean"].shape[1] == ncode * NDEPTH
    np.savez_compressed(CUBE, ocean=tot["ocean"], q=tot["q"], lost_to=tot["lost_to"], own_ocean=tot["own_ocean"],
                        own_meas=tot["own_meas"], q_names=np.array(Q_NAMES), years=np.array(YEARS),
                        lat_edges=LAT_EDGES, depth_edges=DEPTH_EDGES, n_codes=ncode)
    info = {"nc": str(NC.relative_to(ROOT)), "bytes": NC.stat().st_size, "runtime_s": round(runtime, 1),
            "workers": workers, "strips": len(starts), "date_created": now}
    (BUILD / "build_info.json").write_text(json.dumps(info, indent=1))
    return info


# ---------------------------------------------------------------- tables

def _w(path: Path, header: list[str], rows: list[list]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        for r in rows:
            w.writerow(["" if v is None else (f"{v:.3f}" if isinstance(v, float) and abs(v) >= 1 else
                                              (repr(float(v)) if isinstance(v, float) else v)) for v in r])


def _share(a: float, b: float):
    return None if b <= 0 else float(a / b)


def tables() -> list[Path]:
    c = np.load(CUBE)
    labels = json.loads(REGIONS_LABELS.read_text())
    hist = json.loads(HISTORY_STATS.read_text())
    ocean = c["ocean"]                       # (band, combo)
    q = c["q"]                               # (year, q, band, combo)
    ng = len(labels["goas"])
    O = ocean.sum()
    out = []

    # ---- global per release (and a check against history_stats.json)
    Qg = q.sum(axis=(2, 3))                  # (year, q)
    rows = []
    for i, y in enumerate(YEARS):
        h = hist["years"][i]
        assert abs(Qg[i, 0] - h["measured_km2"]) <= 1 and abs(Qg[i, 1] - h["ever_measured_km2"]) <= 1, y
        assert abs(Qg[i, 0] / O - h["measured_frac"]) <= 1e-9, y
        if i:
            assert abs(Qg[i, 4] - h["no_longer_measured_vs_previous_km2"]) <= 1, y
            assert abs(Qg[i, 3] - h["new_vs_previous_km2"]) <= 1, y
        off = history.OFFICIAL[y]
        rows.append([y, f"GEBCO_{y}", f"https://doi.org/{history.DOIS[y]}", float(O), float(Qg[i, 0]),
                     _share(Qg[i, 0], O), float(c["own_meas"][i] / c["own_ocean"][i]), float(c["own_ocean"][i]),
                     float(Qg[i, 1]), _share(Qg[i, 1], O), float(Qg[i, 2]),
                     None if i == 0 else float(Qg[i, 3]), None if i == 0 else float(Qg[i, 4]),
                     float(Qg[i, 1] - Qg[i, 0]), off["percent"] / 100, off["date"], off["url"]])
    assert abs(O - hist["ocean_km2"]) <= 1
    p = TABLES / "global_by_release.csv"
    _w(p, ["release", "gebco_grid", "gebco_doi", "ocean_area_km2", "measured_area_km2", "measured_share_fraction",
           "measured_share_own_mask_fraction", "own_mask_ocean_area_km2", "ever_measured_area_km2",
           "ever_measured_share_fraction", "first_measured_area_km2", "new_vs_previous_km2",
           "recoded_away_vs_previous_km2", "measured_earlier_not_in_this_release_km2",
           "official_seabed2030_share_fraction", "official_announcement_date", "official_source_url"], rows)
    out.append(p)

    # ---- re-coded away, by destination TID code (long format)
    rows = []
    for i, y in enumerate(YEARS[1:], start=1):
        lt = c["lost_to"][i]
        for code in np.nonzero(lt > 0)[0]:
            rows.append([YEARS[i - 1], y, int(code), TID_MEANING.get(int(code), "other"), float(lt[code]),
                         _share(lt[code], lt.sum())])
        assert abs(lt.sum() - Qg[i, 4]) <= 1, y
    p = TABLES / "recoded_away_by_destination_tid.csv"
    _w(p, ["from_release", "to_release", "destination_tid", "destination_tid_meaning", "area_km2",
           "share_of_transition_fraction"], rows)
    out.append(p)

    def block(name_cols, key_rows, ocean_of, q_of):
        rows = []
        for key, names in key_rows:
            o = float(ocean_of(key))
            if o <= 0:
                continue
            for i, y in enumerate(YEARS):
                v = q_of(key, i)
                rows.append([*names, y, o, float(v[0]), _share(v[0], o), float(v[1]), _share(v[1], o), float(v[2]),
                             None if i == 0 else float(v[3]), None if i == 0 else float(v[4])])
        return rows

    qcols = ["release", "ocean_area_km2", "measured_area_km2", "measured_share_fraction", "ever_measured_area_km2",
             "ever_measured_share_fraction", "first_measured_area_km2", "new_vs_previous_km2",
             "recoded_away_vs_previous_km2"]

    # ---- 5 degree latitude bands
    ob = ocean.sum(axis=1)
    qb = q.sum(axis=3)                       # (year, q, band)
    rows = block(["lat_south_deg", "lat_north_deg"],
                 [(b, [int(LAT_EDGES[b]), int(LAT_EDGES[b + 1])]) for b in range(NBANDS - 1, -1, -1)],
                 lambda b: ob[b], lambda b, i: qb[i, :, b])
    p = TABLES / "by_latitude_band_by_release.csv"
    _w(p, ["lat_south_deg", "lat_north_deg"] + qcols, rows)
    out.append(p)
    # cross-check with history's 10 degree bands
    for i, h in enumerate(hist["years"]):
        for k in range(18):
            o = ob[2 * k] + ob[2 * k + 1]
            if o > 0:
                assert abs((qb[i, 0, 2 * k] + qb[i, 0, 2 * k + 1]) / o - h["lat_measured_frac"][k]) < 1e-9

    # ---- 250 m depth bins of the GEBCO_2026 1' elevation
    od = ocean.sum(axis=0).reshape(-1, NDEPTH).sum(axis=0)
    qd = q.sum(axis=2).reshape(NY, len(Q_NAMES), -1, NDEPTH).sum(axis=2)
    rows = block(["depth_min_m", "depth_max_m"],
                 [(d, [int(-DEPTH_EDGES[d + 1]), int(-DEPTH_EDGES[d])]) for d in range(NDEPTH - 1, -1, -1)],
                 lambda d: od[d], lambda d, i: qd[i, :, d])
    p = TABLES / "by_depth_bin_by_release.csv"
    _w(p, ["depth_min_m", "depth_max_m"] + qcols, rows)
    out.append(p)

    # ---- ocean (GOaS) and zone (EEZ / high seas)
    oc = ocean.sum(axis=0).reshape(ng, 4, NDEPTH).sum(axis=2)          # (goas, zone)
    qc = q.sum(axis=2).reshape(NY, len(Q_NAMES), ng, 4, NDEPTH).sum(axis=4)
    rows = block(["ocean_name"], [(g, [labels["goas"][g]]) for g in np.argsort(-oc.sum(axis=1))],
                 lambda g: oc[g].sum(), lambda g, i: qc[i, :, g].sum(axis=1))
    p = TABLES / "by_ocean_by_release.csv"
    _w(p, ["ocean_name"] + qcols, rows)
    out.append(p)
    rows = block(["zone"], [(z, [ZONES[z]]) for z in (1, 2, 3, 0)],
                 lambda z: oc[:, z].sum(), lambda z, i: qc[i, :, :, z].sum(axis=1))
    p = TABLES / "by_zone_by_release.csv"
    _w(p, ["zone"] + qcols, rows)
    out.append(p)

    # ---- cell-size sensitivity (from data/derived/sensitivity_cellsize.json)
    s = json.loads(SENS_JSON.read_text())
    edges = s["lat_edges"]
    rows = []
    for name, v in s["variants"].items():
        rule = "native" if name == "native" else name.split("_")[1]
        base = name.split("_")[0]
        rows.append([name, base, rule, float(v["nominal_size_m"]), "global", None, None, float(s["ocean_km2"]),
                     float(v["measured_km2"]), float(v["measured_frac"]), None])
        for b in range(len(edges) - 2, -1, -1):
            o = s["band_ocean_km2"][b]
            if o <= 0:
                continue
            rows.append([name, base, rule, float(v["nominal_size_m"]), "band", edges[b], edges[b + 1], float(o),
                         float(v["band_measured_km2"][b]), v["band_measured_frac"][b],
                         float(v["band_block_ew_m_mean"][b])])
    p = TABLES / "cellsize_sensitivity_2026.csv"
    _w(p, ["variant", "block_family", "block_rule", "nominal_block_size_m", "scope", "lat_south_deg",
           "lat_north_deg", "ocean_area_km2", "measured_area_km2", "measured_share_fraction",
           "mean_block_ew_width_m"], rows)
    out.append(p)

    # ---- TID code list (for the destination table)
    p = TABLES / "tid_codes.csv"
    grp = {c: ("land" if c == 0 else "direct" if 10 <= c <= 17 else "indirect" if 40 <= c <= 48 else "unknown")
           for c in TID_MEANING}
    _w(p, ["tid", "group", "meaning"], [[k, grp[k], v] for k, v in TID_MEANING.items()])
    out.append(p)

    # regions.json (1' quantised f) vs this exact 15" sum, 2026 -- report only
    if REGIONS_JSON.exists():
        rj = json.loads(REGIONS_JSON.read_text())
        i = NY - 1
        for z, key in ((1, "all_eez"), (2, "high_seas")):
            ours = qc[i, 0, :, z].sum() / oc[:, z].sum()
            print(f"{key}: {100 * ours:.3f} % here (15\") vs {100 * rj['zones'][key]['measured_fraction']:.3f} % "
                  "regions.json (1' quantised)")
    return out


# ---------------------------------------------------------------- verify (from the netCDF file only)

def _verify_strip(args) -> dict:
    import netCDF4

    path, i0, i1 = args
    with netCDF4.Dataset(path) as ds:
        ds.set_auto_mask(False)
        bits = ds["measured_release_flags"][i0:i1, :]
        ocean = ds["ocean_mask"][i0:i1, :] == 1
        area = area_from_lat_bnds(ds["lat_bnds"][i0:i1, :], float(np.diff(ds["lon_bnds"][0, :])[0]))
        res = global_sums(bits, ocean, area)
        rec = record_from_bits(bits, ocean)
        mism = 0
        for var, k in (("first_measured_release", "first"), ("last_measured_release", "last"),
                       ("n_releases_measured", "n"), ("measured_in_2026", "latest"), ("recoded_away", "recoded")):
            v = ds[var][i0:i1, :]
            mism += int((v != rec[k]).sum())
            if var == "first_measured_release":
                res["first_from_var"] = np.array([((v == y).sum(axis=1)) @ area for y in YEARS])
            if var == "n_releases_measured":
                res["ever_from_n"] = float(((v > 0) & ocean).sum(axis=1) @ area)
            if var == "recoded_away":
                res["recoded_from_var"] = float((v == 1).sum(axis=1) @ area)
            if var == "measured_in_2026":
                res["m26_from_var"] = float((v == 1).sum(axis=1) @ area)
        res["mismatch"] = mism
        res["bits_outside_mask"] = int((bits[~ocean] != 0).sum())
        res["area_all"] = float(area.sum() * bits.shape[1])
    return res


def source_windows_check(nwin: int = 40, size: int = 512, seed: int = 0) -> tuple[int, int, int]:
    """Orientation / content check against the SOURCE GeoTIFFs (global sums are symmetric about the equator, so
    they cannot catch a latitude flip): in random 512 x 512 windows, the netCDF bitmask and ocean mask must equal
    the ones recomputed from the eight TID grids and the 1' elevation, cell by cell, located via the netCDF lat/lon.
    Returns (cells compared, measured bits compared, mismatching cells)."""
    import netCDF4
    import rasterio

    rng = np.random.default_rng(seed)
    cells = nbits = bad = 0
    srcs = {y: rasterio.open(history.tid_path(y)) for y in YEARS}
    elev = rasterio.open(history.ELEV)
    with netCDF4.Dataset(NC) as ds:
        ds.set_auto_mask(False)
        wins = [(0, 0), (H15 // 2 - size, W15 // 2)]                     # north edge + one at the equator
        wins += [(4 * int(rng.integers(0, (H15 - size) // 4)), int(rng.integers(0, W15 - size))) for _ in range(nwin)]
        for r0, c0 in wins:
            r0 -= r0 % 4
            c0 -= c0 % 4
            # netCDF index of tif row r0 .. r0+size-1, located from the lat coordinate
            lat_top = 90 - (r0 + 0.5) / 240
            i_top = int(np.argmin(np.abs(ds["lat"][:] - lat_top)))
            j0 = int(np.argmin(np.abs(ds["lon"][:] - (-180 + (c0 + 0.5) / 240))))
            nb = ds["measured_release_flags"][i_top - size + 1:i_top + 1, j0:j0 + size][::-1]
            no = ds["ocean_mask"][i_top - size + 1:i_top + 1, j0:j0 + size][::-1] == 1
            w15 = rasterio.windows.Window(c0, r0, size, size)
            h = elev.read(1, window=rasterio.windows.Window(c0 // 4, r0 // 4, size // 4, size // 4))
            sea = np.repeat(np.repeat(h < 0, 4, axis=0), 4, axis=1)
            ocean = sea & (srcs[LATEST].read(1, window=w15) != 0)
            bits = np.zeros(ocean.shape, np.uint8)
            for i, y in enumerate(YEARS):
                bits |= (ocean & history.direct(srcs[y].read(1, window=w15))).astype(np.uint8) << i
            bad += int(((nb != bits) | (no != ocean)).sum())
            cells += bits.size
            nbits += int(np.unpackbits(bits[:, :, None], axis=2).sum())
    for s in [*srcs.values(), elev]:
        s.close()
    return cells, nbits, bad


def verify(workers: int) -> dict:
    import netCDF4

    with netCDF4.Dataset(NC) as ds:
        nlat = ds.dimensions["lat"].size
        lat = ds["lat"][:]
        assert np.all(np.diff(lat) > 0)
    jobs = [(str(NC), i, min(i + STRIP, nlat)) for i in range(0, nlat, STRIP)]
    tot: dict = {}
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for k, r in enumerate(ex.map(_verify_strip, jobs), 1):
            for key, v in r.items():
                tot[key] = tot.get(key, 0) + v
            print(f"\rverify strips {k}/{len(jobs)}  {time.time() - t0:.0f} s", end="", file=sys.stderr)
    print(file=sys.stderr)
    hist = json.loads(HISTORY_STATS.read_text())
    O = tot["ocean"]
    lines = []
    worst_km2 = worst_frac = 0.0

    def cmp(label, mine, ref, frac=False):
        nonlocal worst_km2, worst_frac
        d = abs(mine - ref)
        if frac:
            worst_frac = max(worst_frac, d)
            ok = d <= 1e-9
            lines.append(f"{label:44s} nc {mine:.12f}  history {ref:.12f}  |diff| {d:.1e}  {'OK' if ok else 'FAIL'}")
        else:
            worst_km2 = max(worst_km2, d)
            ok = d <= 1
            lines.append(f"{label:44s} nc {mine:16,.3f}  history {ref:14,}  |diff| {d:.3f}  {'OK' if ok else 'FAIL'}")
        return ok

    ok = cmp("ocean_km2", O, hist["ocean_km2"])
    ok &= abs(tot["area_all"] / (4 * np.pi * history.R_KM ** 2) - 1) < 1e-9
    for i, (y, h) in enumerate(zip(YEARS, hist["years"])):
        ok &= cmp(f"{y} measured_km2", tot["measured"][i], h["measured_km2"])
        ok &= cmp(f"{y} measured_frac", tot["measured"][i] / O, h["measured_frac"], True)
        ok &= cmp(f"{y} ever_measured_km2", tot["ever_measured"][i], h["ever_measured_km2"])
        ok &= cmp(f"{y} ever_measured_frac", tot["ever_measured"][i] / O, h["ever_measured_frac"], True)
        ok &= cmp(f"{y} first_measured_km2 (bitmask)", tot["first_measured"][i], h["first_measured_km2"])
        ok &= cmp(f"{y} first_measured_km2 (first_measured_release)", tot["first_from_var"][i],
                  h["first_measured_km2"])
        if i:
            ok &= cmp(f"{y} new_vs_previous_km2", tot["new_vs_previous"][i], h["new_vs_previous_km2"])
            ok &= cmp(f"{y} recoded_away_vs_previous_km2", tot["recoded_away_vs_previous"][i],
                      h["no_longer_measured_vs_previous_km2"])
    last = hist["years"][-1]
    ok &= cmp("2026 ever_measured_km2 (n_releases_measured>0)", tot["ever_from_n"], last["ever_measured_km2"])
    ok &= cmp("2026 measured_km2 (measured_in_2026)", tot["m26_from_var"], last["measured_km2"])
    ok &= cmp("recoded_away flag area (ever - measured 2026)", tot["recoded_from_var"],
              last["ever_measured_km2"] - last["measured_km2"])
    lines.append(f"derived-variable cells disagreeing with the bitmask: {tot['mismatch']}")
    lines.append(f"bitmask bits set outside the ocean mask: {tot['bits_outside_mask']}")
    ok &= tot["mismatch"] == 0 and tot["bits_outside_mask"] == 0
    if all(history.tid_path(y).exists() for y in YEARS):
        cells, nbits, bad = source_windows_check()
        lines.append(f"source GeoTIFF window check (orientation): {cells:,} cells, {nbits:,} measured bits, "
                     f"{bad} mismatching cells")
        ok &= bad == 0 and nbits > 0
    else:
        lines.append("source GeoTIFF window check skipped: data/raw/gebco_<year>/ not present")
    lines.append(f"worst |diff|: {worst_km2:.3f} km2, {worst_frac:.1e} (fraction); runtime {time.time() - t0:.0f} s")
    lines.append("VERIFY OK" if ok else "VERIFY FAILED")
    text = "\n".join(lines)
    print(text)
    (BUILD / "verify.log").write_text(text + "\n")
    assert ok, "verify failed"
    return tot


# ---------------------------------------------------------------- checksums

def checksums() -> Path:
    files = sorted(p for p in DATASET.rglob("*") if p.is_file() and p.name != "checksums.sha256"
                   and p.suffix in {".nc", ".csv", ".md", ".txt", ".log", ".sha256"} and "regions_" not in p.name)
    lines = []
    for p in files:
        h = hashlib.sha256()
        with p.open("rb") as f:
            for blk in iter(lambda: f.read(1 << 24), b""):
                h.update(blk)
        lines.append(f"{h.hexdigest()}  {p.relative_to(DATASET)}")
    out = DATASET / "checksums.sha256"
    out.write_text("\n".join(lines) + "\n")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("step", choices=["build", "tables", "verify", "checksums", "all"])
    ap.add_argument("--workers", type=int, default=max(1, min(5, (os.cpu_count() or 2) // 2)))
    ap.add_argument("--limit", type=int, default=None, help="build only the first N strips (timing test)")
    a = ap.parse_args()
    if a.step in ("build", "all"):
        print(json.dumps(build(a.workers, a.limit), indent=1))
    if a.step in ("tables", "all"):
        for p in tables():
            print(p.relative_to(ROOT), p.stat().st_size, "bytes")
    if a.step in ("verify", "all"):
        verify(a.workers)
    if a.step in ("checksums", "all"):
        print(checksums())


if __name__ == "__main__":
    main()
