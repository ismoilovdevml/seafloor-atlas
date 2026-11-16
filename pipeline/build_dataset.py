"""Citable dataset: the per-cell record of directly measured seafloor in GEBCO releases 2019-2026.

Steps (see dataset/README.md), in this order:

  python pipeline/build_dataset.py inputs        dataset/inputs.sha256 (sha256 of every external input file)
  python pipeline/build_dataset.py connectivity  dataset/build/inland_labels.npz: connected components of the ocean
                                                 mask on the 15" grid (for inland_below_sea_level)
  python pipeline/build_dataset.py build    dataset/build/seafloor_measured_record_2019_2026.nc (CF-1.8, ACDD-1.3,
                                            15" grid) + dataset/build/summary_cube.npz (area sums for the tables)
  python pipeline/build_dataset.py tables   dataset/tables/*.csv from the cube, history.OFFICIAL and
                                            data/derived/sensitivity_cellsize.json
  python pipeline/build_dataset.py verify   recompute the global numbers FROM THE NETCDF FILE and assert they equal
                                            data/derived/history_stats.json (<= 1 km2, <= 1e-9 fraction); compare
                                            every cell with the source GeoTIFFs; sphere vs WGS84 ellipsoid areas;
                                            log in dataset/build/verify.log
  python pipeline/build_dataset.py checksums  dataset/checksums.sha256 (deposit files except logs)

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
INLAND = BUILD / "inland_labels.npz"
# full-resolution GEBCO_2026 elevation (local copy of the Source Cooperative COG mirror, level 0); used only to
# decide connectivity of the ocean mask, never to change the mask
ELEV15 = history.RAW / "gebco_2026/GEBCO_2026_15s.tif"
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
ZONES = ["caspian_sea_box", "eez", "high_seas", "neither"]   # zone code 0..3 (Caspian box: in the global figures)
CASPIAN_LABEL = "Caspian Sea box"
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


# ---------------------------------------------------------------- connectivity of the ocean mask (pure, tested)
#
# The fixed ocean mask keeps every cell whose GEBCO_2026 TID is not land and whose 1' elevation is below 0. That
# includes basins below sea level that are not connected to the world ocean (the Caspian Sea and the lowland around
# it, the Qattara Depression, ...). They are flagged, not removed: the mask and the published numbers stay as
# defined. Connectivity is computed on the 15" grid with 8-connectivity and longitude wrap, strip by strip (labels
# per strip with scipy.ndimage.label, then the labels touching across strip edges and across 180 deg are merged with
# a sparse-graph connected-components step). The component with the largest area is the world ocean; every other
# component is "inland".

STRUCT8 = np.ones((3, 3), bool)


def label_strip(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """8-connected labels of one strip (no wrap; label 0 = outside the mask)."""
    from scipy import ndimage

    lab, n = ndimage.label(np.asarray(mask, bool), structure=STRUCT8)
    return lab.astype(np.int32, copy=False), int(n)


def strip_info(mask: np.ndarray, r0: int, area_row: np.ndarray) -> dict:
    """What the merge step needs from one strip: label count, first/last row labels, the label pairs that touch
    across the 180 deg meridian inside the strip, and per-label area and extent (rows global, columns local)."""
    from scipy import ndimage

    lab, n = label_strip(mask)
    w = lab.shape[1]
    left, right = lab[:, 0], lab[:, -1]
    pairs = []
    for d in (-1, 0, 1):                      # left[i] touches right[i + d]
        a = left[max(0, -d): len(left) - max(0, d)]
        b = right[max(0, d): len(right) - max(0, -d)]
        k = (a > 0) & (b > 0)
        pairs.append(np.stack([a[k], b[k]], axis=1))
    area = np.bincount(lab.ravel(), weights=np.broadcast_to(np.asarray(area_row, float)[:, None], lab.shape).ravel(),
                       minlength=n + 1)
    sl = ndimage.find_objects(lab)
    ext = np.array([[s[0].start + r0, s[0].stop - 1 + r0, s[1].start, s[1].stop - 1] for s in sl],
                   dtype=np.int64).reshape(-1, 4)
    return {"r0": r0, "n": n, "w": w, "top": lab[0].copy(), "bottom": lab[-1].copy(),
            "wrap": np.concatenate(pairs).astype(np.int64), "area": area, "ext": ext}


def merge_strips(infos: list[dict]) -> dict:
    """Merge per-strip labels (strips in north-to-south order, contiguous) into global components.
    Returns offsets (global label = local label + offset), comp (component of every global label, index 0 unused),
    per-component area and extent, and the id of the world-ocean component (largest area)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    infos = sorted(infos, key=lambda i: i["r0"])
    offs = np.cumsum([0] + [i["n"] for i in infos])[:-1]
    total = int(sum(i["n"] for i in infos))
    edges = []
    for k, inf in enumerate(infos):
        if len(inf["wrap"]):
            edges.append(inf["wrap"] + offs[k])
        if k + 1 < len(infos):                  # bottom row of strip k touches the top row of strip k + 1
            a, b = inf["bottom"], infos[k + 1]["top"]
            for d in (-1, 0, 1):
                bb = np.roll(b, d)               # bb[j] = b[j - d], wrapping across 180 deg
                m = (a > 0) & (bb > 0)
                edges.append(np.stack([a[m] + offs[k], bb[m] + offs[k + 1]], axis=1))
    e = np.concatenate(edges) if edges else np.zeros((0, 2), np.int64)
    g = coo_matrix((np.ones(len(e), np.int8), (e[:, 0], e[:, 1])), shape=(total + 1, total + 1))
    ncomp, comp = connected_components(g, directed=False)
    area_l = np.concatenate([[0.0]] + [i["area"][1:] for i in infos])
    ext_l = np.concatenate([np.zeros((1, 4), np.int64)] + [i["ext"] for i in infos])
    area_c = np.bincount(comp[1:], weights=area_l[1:], minlength=ncomp)
    if all("ocean_area" in i for i in infos):    # area of the ocean-mask cells only (connect mask may be larger)
        oa = np.concatenate([[0.0]] + [i["ocean_area"][1:] for i in infos])
        ocean_c = np.bincount(comp[1:], weights=oa[1:], minlength=ncomp)
    else:
        ocean_c = area_c
    ext_c = np.zeros((ncomp, 4), np.int64)
    ext_c[:, 0] = ext_c[:, 2] = np.iinfo(np.int64).max
    ext_c[:, 1] = ext_c[:, 3] = -1
    np.minimum.at(ext_c[:, 0], comp[1:], ext_l[1:, 0])
    np.maximum.at(ext_c[:, 1], comp[1:], ext_l[1:, 1])
    np.minimum.at(ext_c[:, 2], comp[1:], ext_l[1:, 2])
    np.maximum.at(ext_c[:, 3], comp[1:], ext_l[1:, 3])
    main = int(np.argmax(np.where(np.arange(ncomp) == comp[0], -1, area_c)))   # comp[0] = background node
    return {"offsets": offs, "comp": comp, "area": area_c, "ocean_area": ocean_c, "ext": ext_c, "main": main,
            "background": int(comp[0])}


def inland_components(merged: dict) -> np.ndarray:
    """Component ids of the inland components that hold ocean-mask cells, largest ocean-mask area first."""
    area = merged["ocean_area"]
    order = np.argsort(-area, kind="stable")
    return np.array([c for c in order if c not in (merged["main"], merged["background"]) and area[c] > 0],
                    dtype=np.int64)


def inland_rank(merged: dict) -> np.ndarray:
    """Global label -> inland component rank (1 = largest inland component, ...); 0 = world ocean or background."""
    inland = inland_components(merged)
    rank_of_comp = np.zeros(len(merged["area"]), np.int32)
    rank_of_comp[inland] = np.arange(1, len(inland) + 1, dtype=np.int32)
    return rank_of_comp[merged["comp"]]


def inland_cells(lab: np.ndarray, offset: int, rank_of_label: np.ndarray) -> np.ndarray:
    """Inland component rank of every cell of a strip (0 = world ocean or outside the mask)."""
    g = np.where(lab > 0, lab.astype(np.int64) + offset, 0)
    return rank_of_label[g]


def inland_from_mask(mask: np.ndarray, strip: int, area_row: np.ndarray | None = None) -> np.ndarray:
    """In-memory version of the whole procedure (tests): inland rank of every cell of a small global mask."""
    h = mask.shape[0]
    area_row = np.ones(h) if area_row is None else area_row
    infos = [strip_info(mask[r0:r0 + strip], r0, area_row[r0:r0 + strip]) for r0 in range(0, h, strip)]
    merged = merge_strips(infos)
    rank = inland_rank(merged)
    out = np.zeros(mask.shape, np.int32)
    for k, r0 in enumerate(range(0, h, strip)):
        lab, _ = label_strip(mask[r0:r0 + strip])
        out[r0:r0 + strip] = inland_cells(lab, int(merged["offsets"][k]), rank)
    return out


# ---------------------------------------------------------------- regions (1' ids, as pipeline/regions.py)

def build_regions() -> dict:
    """Burn GOaS / EEZ / high seas onto the 1' grid exactly as regions.compute() does; one uint16 code per cell:
    code = goas_index * 4 + zone. goas_index 0 = outside all GOaS polygons, 1..n = polygons, n+1 = Caspian box."""
    import rasterio

    import regions

    if REGIONS_1M.exists() and REGIONS_LABELS.exists():
        labels = json.loads(REGIONS_LABELS.read_text())
        if labels["goas"][-1] != CASPIAN_LABEL or labels["zones"] != ZONES:   # labels of the 1.0.0 draft cache
            labels["goas"][-1], labels["zones"] = CASPIAN_LABEL, ZONES
            REGIONS_LABELS.write_text(json.dumps(labels, indent=1))
        return labels
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
    names = ["Outside all GOaS polygons"] + [""] * ng + [CASPIAN_LABEL]
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
        _SRC["elev15"] = rasterio.open(ELEV15)
        z = np.load(INLAND)
        _SRC["inl_off"] = dict(zip(z["strips"].tolist(), z["offsets"].tolist()))
        _SRC["inl_rank"] = z["rank_of_label"]
        _SRC["inl_k"] = len(z["comp_area_km2"])
        _SRC["reg"] = np.load(REGIONS_1M, mmap_mode="r")
        _SRC["ncode"] = json.loads(REGIONS_LABELS.read_text())["n_codes"]
    return _SRC


def _ocean_strip(src: dict, r0: int):
    """The fixed ocean mask of one strip of 15" rows (history.build mask), with the inputs it is made from."""
    import rasterio

    n = min(STRIP, H15 - r0)
    n1 = n // 4
    win15 = rasterio.windows.Window(0, r0, W15, n)
    h = src["elev"].read(1, window=rasterio.windows.Window(0, r0 // 4, W1, n1))
    sea15 = np.repeat(np.repeat(h < 0, 4, axis=0), 4, axis=1)
    t26 = src["tid"][LATEST].read(1, window=win15)
    return n, n1, win15, h, sea15, t26, sea15 & (t26 != 0)


def connect_mask(ocean: np.ndarray, t26: np.ndarray, elev15: np.ndarray) -> np.ndarray:
    """Cells through which connectivity is traced: the ocean mask, plus cells that are not land in the GEBCO_2026
    TID grid and lie below sea level in the 15" GEBCO_2026 elevation. The second term restores narrow straits
    (e.g. the Bosporus) that the 1' elevation of the mask closes; it never adds cells to the ocean mask."""
    return ocean | ((t26 != 0) & (elev15 < 0))


def _conn_strip(src: dict, r0: int):
    import rasterio

    n, n1, win15, h, sea15, t26, ocean = _ocean_strip(src, r0)
    e15 = src["elev15"].read(1, window=win15)
    return n, ocean, connect_mask(ocean, t26, e15)


def _conn_work(r0: int) -> dict:
    import rasterio

    src = {"elev": rasterio.open(history.ELEV), "tid": {LATEST: rasterio.open(history.tid_path(LATEST))},
           "elev15": rasterio.open(ELEV15)}
    n, ocean, conn = _conn_strip(src, r0)
    info = strip_info(conn, r0, history.row_area_km2(r0, n))
    lab, _ = label_strip(conn)                     # area of the OCEAN-MASK cells of every label
    info["ocean_area"] = np.bincount(lab[ocean], weights=np.broadcast_to(
        history.row_area_km2(r0, n)[:, None], lab.shape)[ocean], minlength=info["n"] + 1)
    return info


def connectivity(workers: int) -> dict:
    """Pass 1: connected components of the fixed ocean mask on the 15" grid -> dataset/build/inland_labels.npz."""
    starts = list(range(0, H15, STRIP))
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=workers) as ex:
        infos = list(ex.map(_conn_work, starts))
    merged = merge_strips(infos)
    rank = inland_rank(merged)
    inl = inland_components(merged)
    BUILD.mkdir(parents=True, exist_ok=True)
    np.savez(INLAND, offsets=merged["offsets"], rank_of_label=rank.astype(np.int32),
             comp_area_km2=merged["ocean_area"][inl], comp_ext=merged["ext"][inl],
             main_area_km2=merged["ocean_area"][merged["main"]], strips=np.array(starts))
    info = {"labels": int(len(rank) - 1), "components": int(len(merged["area"]) - 1),
            "inland_components": len(inl), "inland_area_km2": float(merged["ocean_area"][inl].sum()),
            "world_ocean_area_km2": float(merged["ocean_area"][merged["main"]]),
            "runtime_s": round(time.time() - t0, 1)}
    print(json.dumps(info, indent=1), file=sys.stderr)
    return info


def _work(r0: int) -> tuple[int, np.ndarray, np.ndarray, dict]:
    """One strip of 15" rows r0 .. r0+STRIP-1 (north-up, row 0 = 90 N edge)."""
    import rasterio

    src = _open()
    n, n1, win15, h, sea15, t26, ocean = _ocean_strip(src, r0)
    area = history.row_area_km2(r0, n)
    conn = connect_mask(ocean, t26, src["elev15"].read(1, window=win15))
    lab, _ = label_strip(conn)
    comp = np.where(ocean, inland_cells(lab, src["inl_off"][r0], src["inl_rank"]), 0)   # inland rank, 0 = none
    del conn, lab
    inland = comp > 0
    nk = src["inl_k"] + 1
    rowk = (np.arange(n, dtype=np.int32)[:, None] * nk + comp).astype(np.int32)        # row x inland component

    def per_comp(sel: np.ndarray) -> np.ndarray:
        return np.bincount(rowk[sel], minlength=n * nk).reshape(n, nk).T @ area
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
           "lost_to": np.zeros((NY, 128)), "own_ocean": np.zeros(NY), "own_meas": np.zeros(NY),
           "tid_area": np.zeros((NY, 128)), "comp_ocean": per_comp(ocean), "comp_meas": np.zeros((NY, nk))}
    rowt = np.broadcast_to(np.arange(n, dtype=np.int32)[:, None] * 128, ocean.shape)
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
        out["tid_area"][i] = np.bincount((rowt + (t.astype(np.int32) & 127))[ocean],
                                         minlength=n * 128).reshape(n, 128).T @ area
        out["comp_meas"][i] = per_comp(m)
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
    return r0, bits, ocean, inland, out


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
                    "north-up Int8 GeoTIFF by pipeline/history.py convert, values unchanged) and the GEBCO_2026 elevation "
                    "grid as served by the cloud-optimised GeoTIFF mirror s3://us-west-2.opendata.source.coop/"
                    "ausantarctic/gebco/GEBCO_2026.tif (Australian Antarctic Division, Source Cooperative): its "
                    "overview level 1 (1', GDAL average of 4 x 4 15\" cells) for the mask and depth bins, its full "
                    "15\" level for the connectivity behind inland_below_sea_level"),
        "comment": ("Values outside the ocean mask are _FillValue (-1) for every variable except ocean_mask and "
                    "measured_release_flags (0 outside the mask). Latitude is ascending (south to north), the "
                    "same orientation and cell registration as the GEBCO netCDF grids, so index (i, j) here is "
                    "index (i, j) in GEBCO_<year>_TID.nc."),
        "measured_definition": ("A cell is 'measured' in a release if its GEBCO TID code in that release is 10-17 "
                                "(direct measurement) and it lies inside the ocean mask."),
        "ocean_mask_definition": ("GEBCO_2026 TID != 0 AND GEBCO_2026 1 arc-minute elevation < 0 (the 1' cell "
                                  "containing the 15\" cell). The same mask is used for every release. It excludes "
                                  "the Antarctic ice sheet and grounded ice above sea level. It keeps areas below sea "
                                  "level that are not connected to the world ocean (e.g. the Caspian Sea and the "
                                  "lowland around it); these are flagged by inland_below_sea_level and included in "
                                  "all published areas."),
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
        "time_coverage_start": history.OFFICIAL[YEARS[0]]["date"],     # release announcement of GEBCO_2019
        "time_coverage_end": history.OFFICIAL[YEARS[-1]]["date"],      # release announcement of GEBCO_2026
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
    var("inland_below_sea_level", "i1", FILL8, {
        "long_name": "cell is in the ocean mask but not connected to the world ocean",
        "flag_values": np.array([0, 1], np.int8), "flag_meanings": "connected_to_world_ocean inland_below_sea_level",
        "comment": ("1 = inside the fixed ocean mask but in a connected component (8-connectivity, longitude wrap, "
                    "15 arc-second grid) other than the world ocean: basins below sea level such as the Caspian Sea "
                    "and the lowland around it, the Qattara Depression and Lake Eyre, lake beds stored below 0 m, "
                    "and lagoons or inlets whose link to the sea is not resolved by the grid. Connectivity is traced "
                    "through the ocean mask and through cells with GEBCO_2026 TID != 0 and 15 arc-second GEBCO_2026 "
                    "elevation < 0. Included in the ocean mask and in all published areas; _FillValue outside the "
                    "ocean mask"),
        "coverage_content_type": "auxiliaryInformation"})
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
            _, bits, ocean, inland, out = pending.pop(r0).result()
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
            ds["inland_below_sea_level"][sl, :] = np.where(ocean, inland, FILL8)[::-1].astype(np.int8)
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
                        own_meas=tot["own_meas"], tid_area=tot["tid_area"], comp_ocean=tot["comp_ocean"],
                        comp_meas=tot["comp_meas"], q_names=np.array(Q_NAMES), years=np.array(YEARS),
                        lat_edges=LAT_EDGES, depth_edges=DEPTH_EDGES, n_codes=ncode)
    info = {"nc": str(NC.relative_to(ROOT)), "bytes": NC.stat().st_size, "runtime_s": round(runtime, 1),
            "workers": workers, "strips": len(starts), "date_created": now}
    (BUILD / "build_info.json").write_text(json.dumps(info, indent=1))
    return info


# ---------------------------------------------------------------- tables

INLAND_MIN_KM2 = 100
# Names of the larger inland_below_sea_level components, for orientation only: a component is named when the centre
# of its bounding box falls inside one of these boxes (lon0, lat0, lon1, lat1); the smallest matching box wins.
INLAND_NAMES = [
    ("Caspian Sea and Caspian Depression", (44.0, 36.0, 56.0, 50.0)),
    ("Lake Superior", (-92.5, 46.3, -84.3, 49.1)),
    ("Qattara Depression", (26.0, 28.5, 29.5, 30.6)),
    ("Lake Baikal", (103.5, 51.3, 110.0, 56.0)),
    ("Lake Eyre (Kati Thanda)", (136.5, -29.8, 138.4, -27.3)),
    ("Lake Ontario", (-80.0, 43.1, -75.9, 44.4)),
    ("Danakil Depression", (39.8, 12.8, 41.5, 15.0)),
    ("Chott Melrhir", (5.5, 33.6, 7.25, 34.8)),
    ("Lake Michigan", (-88.0, 41.5, -84.7, 46.2)),
    ("Dead Sea and Jordan Valley", (35.0, 30.4, 35.9, 33.1)),
    ("Salton Trough", (-116.5, 32.5, -115.0, 34.0)),
    ("Lagoa Mirim", (-54.0, -33.7, -52.4, -31.9)),
    ("Lagoa Mangueira", (-53.0, -33.4, -52.6, -32.9)),
    ("Turpan Depression", (88.5, 42.3, 90.1, 43.1)),
    ("Aftout es Saheli", (-16.2, 18.2, -15.4, 19.2)),
    ("Sabkhat Ghuzayyil", (20.6, 29.6, 21.6, 30.6)),
    ("Lower Yenisei", (82.0, 69.8, 84.0, 71.8)),
    ("Lake Tai", (119.8, 30.8, 120.7, 31.6)),
    ("Curonian Lagoon", (20.4, 54.7, 21.6, 55.8)),
    ("Lake Okeechobee", (-81.2, 26.6, -80.5, 27.3)),
    ("Salina del Gualicho", (-66.0, -40.6, -64.7, -40.1)),
    ("Chott el Gharsa", (7.3, 33.9, 8.3, 34.3)),
    ("Lake Huron", (-82.5, 42.9, -81.2, 45.1)),
    ("Sacramento-San Joaquin Delta", (-121.9, 37.8, -121.3, 38.4)),
    ("Siwa Depression", (25.2, 29.0, 26.2, 29.4)),
    ("Lake MacLeod", (113.4, -24.5, 114.1, -23.7)),
    ("Faiyum Depression (Lake Qarun)", (30.2, 29.1, 31.2, 29.7)),
    ("Lac Saint-Jean", (-72.4, 48.4, -71.7, 48.8)),
    ("Death Valley", (-117.3, 35.7, -116.4, 36.8)),
    ("Vistula Lagoon", (18.8, 53.9, 19.9, 54.6)),
    ("Sechura Desert depression (Bayovar)", (-80.9, -6.7, -80.1, -6.0)),
]


def inland_name(box: tuple[float, float, float, float]) -> str:
    """Name of an inland component from the centre of its bounding box (lat0, lat1, lon0, lon1); '' if unknown."""
    lat = (box[0] + box[1]) / 2
    lon = (box[2] + box[3]) / 2
    hits = [(abs((b[2] - b[0]) * (b[3] - b[1])), n) for n, b in INLAND_NAMES
            if b[0] <= lon <= b[2] and b[1] <= lat <= b[3]]
    return min(hits)[1] if hits else ""


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
    Oin = float(c["comp_ocean"][1:].sum())   # inland_below_sea_level area (component 0 = world ocean)
    Min = c["comp_meas"][:, 1:].sum(axis=1)  # measured inland area per release
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
                     float(Qg[i, 1] - Qg[i, 0]), off["percent"] / 100, off["date"], off["url"],
                     Oin, float(Min[i]), float(O - Oin), float(Qg[i, 0] - Min[i]), _share(Qg[i, 0] - Min[i], O - Oin)])
    assert abs(O - hist["ocean_km2"]) <= 1
    p = TABLES / "global_by_release.csv"
    _w(p, ["release", "gebco_grid", "gebco_doi", "ocean_area_km2", "measured_area_km2", "measured_share_fraction",
           "measured_share_own_mask_fraction", "own_mask_ocean_area_km2", "ever_measured_area_km2",
           "ever_measured_share_fraction", "first_measured_area_km2", "new_vs_previous_km2",
           "recoded_away_vs_previous_km2", "measured_earlier_not_in_this_release_km2",
           "official_seabed2030_share_fraction", "official_announcement_date", "official_source_url",
           "inland_below_sea_level_area_km2", "inland_below_sea_level_measured_area_km2",
           "ocean_area_excluding_inland_km2", "measured_area_excluding_inland_km2",
           "measured_share_excluding_inland_fraction"], rows)
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

    # ---- inland_below_sea_level components (see connectivity()); components >= INLAND_MIN_KM2 one row each
    z = np.load(INLAND)
    area_k, ext_k = z["comp_area_km2"], z["comp_ext"]
    assert np.allclose(area_k, c["comp_ocean"][1:], rtol=1e-9, atol=1e-6)
    i19, i26 = 0, NY - 1
    rows = []
    for k in range(len(area_k)):
        if area_k[k] < INLAND_MIN_KM2:
            continue
        r0, r1, c0, c1 = (int(v) for v in ext_k[k])
        box = (90 - (r1 + 1) / 240, 90 - r0 / 240, -180 + c0 / 240, -180 + (c1 + 1) / 240)
        mk = c["comp_meas"][:, k + 1]
        rows.append([k + 1, inland_name(box), *(round(v, 4) for v in box), float(area_k[k]), float(mk[i19]),
                     float(mk[i26]), _share(mk[i26], area_k[k])])
    small = area_k < INLAND_MIN_KM2
    ms = c["comp_meas"][:, 1:][:, small].sum(axis=1)
    rows.append(["", f"{int(small.sum())} smaller components (< {INLAND_MIN_KM2} km2 each)", None, None, None, None,
                 float(area_k[small].sum()), float(ms[i19]), float(ms[i26]), _share(ms[i26], area_k[small].sum())])
    p = TABLES / "inland_components.csv"
    _w(p, ["rank", "name", "lat_min_deg", "lat_max_deg", "lon_min_deg", "lon_max_deg", "ocean_area_km2",
           "measured_area_2019_km2", "measured_area_2026_km2", "measured_share_2026_fraction"], rows)
    out.append(p)

    # ---- area of every TID code inside the fixed ocean mask, per release
    grp = {k: ("land" if k == 0 else "direct" if 10 <= k <= 17 else "indirect" if 40 <= k <= 48 else "unknown")
           for k in TID_MEANING}
    rows = []
    for i, y in enumerate(YEARS):
        ta = c["tid_area"][i]
        assert abs(ta.sum() - O) <= 1e-6 * O and abs(ta[10:18].sum() - Qg[i, 0]) <= 1, y
        for code in np.nonzero(ta > 0)[0]:
            rows.append([y, int(code), grp.get(int(code), "other"), TID_MEANING.get(int(code), "other"),
                         float(ta[code]), _share(ta[code], O)])
    p = TABLES / "by_tid_code_by_release.csv"
    _w(p, ["release", "tid", "group", "meaning", "area_km2", "share_of_ocean_fraction"], rows)
    out.append(p)

    # ---- TID code list (for the destination table)
    p = TABLES / "tid_codes.csv"
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

WGS84_A, WGS84_F = 6378.137, 1 / 298.257223563     # km


def ellipsoid_area_from_lat_bnds(lat_bnds: np.ndarray, dlon_deg: float) -> np.ndarray:
    """Exact cell area (km2) per row on the WGS84 ellipsoid, for geodetic latitude bounds (degrees)."""
    e2 = WGS84_F * (2 - WGS84_F)
    e = np.sqrt(e2)
    b2 = (WGS84_A * (1 - WGS84_F)) ** 2

    def q(phi):
        s = np.sin(np.radians(phi))
        return s / (1 - e2 * s * s) + np.log((1 + e * s) / (1 - e * s)) / (2 * e)

    return b2 / 2 * np.radians(dlon_deg) * np.abs(q(lat_bnds[:, 1]) - q(lat_bnds[:, 0]))


def _verify_strip(args) -> dict:
    """Everything verify() needs from netCDF rows i0 .. i1-1, including a cell-by-cell comparison of the bitmask
    and the ocean mask with values recomputed from the source GeoTIFFs (rows located through the lat coordinate)."""
    import netCDF4
    import rasterio

    path, i0, i1, with_sources = args
    with netCDF4.Dataset(path) as ds:
        ds.set_auto_mask(False)
        bits = ds["measured_release_flags"][i0:i1, :]
        ocean = ds["ocean_mask"][i0:i1, :] == 1
        lat = ds["lat"][i0:i1]
        lon = ds["lon"][:]
        latb = ds["lat_bnds"][i0:i1, :]
        dlon = float(np.diff(ds["lon_bnds"][0, :])[0])
        area = area_from_lat_bnds(latb, dlon)
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
        inl = ds["inland_below_sea_level"][i0:i1, :]
        res["inland_bad"] = int(((inl == FILL8) != ~ocean).sum() + ((inl != 0) & (inl != 1) & ocean).sum())
        inland = inl == 1
        res["inland_area"] = float(inland.sum(axis=1) @ area)
        res["inland_meas"] = np.array([((((bits >> i) & 1) == 1) & inland).sum(axis=1) @ area for i in range(NY)])
        res["mismatch"] = mism
        res["bits_outside_mask"] = int((bits[~ocean] != 0).sum())
        res["area_all"] = float(area.sum() * bits.shape[1])
        # per-row counts for the sphere vs WGS84 ellipsoid comparison (kept in row order, keyed by i0)
        res["rows"] = {i0: {"lat_bnds": latb, "ocean": ocean.sum(axis=1),
                            "meas": np.stack([(((bits >> i) & 1) == 1).sum(axis=1) for i in range(NY)])}}
        res["dlon"] = {i0: dlon}
    if not with_sources:
        return res
    # ---- every cell against the sources: GeoTIFF row r <-> latitude 90 - (r + 0.5) / 240
    r = np.rint((90 - lat) * 240 - 0.5).astype(int)
    assert np.allclose(90 - (r + 0.5) / 240, lat) and np.all(np.diff(r) == -1)
    c = np.rint((lon + 180) * 240 - 0.5).astype(int)
    assert np.array_equal(c, np.arange(W15))
    r_top, n = int(r[-1]), len(r)
    assert r_top % 4 == 0 and n % 4 == 0
    win = rasterio.windows.Window(0, r_top, W15, n)
    with rasterio.open(history.ELEV) as e:
        h = e.read(1, window=rasterio.windows.Window(0, r_top // 4, W1, n // 4))
    sea = np.repeat(np.repeat(h < 0, 4, axis=0), 4, axis=1)[::-1]
    with rasterio.open(history.tid_path(LATEST)) as t:
        ocean_src = sea & (t.read(1, window=win)[::-1] != 0)
    bits_src = np.zeros(ocean_src.shape, np.uint8)
    for i, y in enumerate(YEARS):
        with rasterio.open(history.tid_path(y)) as t:
            bits_src |= (ocean_src & history.direct(t.read(1, window=win)[::-1])).astype(np.uint8) << i
    res["src_cells"] = bits.size
    res["src_bits"] = int(np.unpackbits(bits_src[:, :, None].astype(np.uint8), axis=2).sum())
    res["src_bad"] = int(((bits != bits_src) | (ocean != ocean_src)).sum())
    return res


def verify(workers: int) -> dict:
    import netCDF4

    with netCDF4.Dataset(NC) as ds:
        nlat = ds.dimensions["lat"].size
        lat = ds["lat"][:]
        assert np.all(np.diff(lat) > 0)
    with_sources = all(history.tid_path(y).exists() for y in YEARS) and history.ELEV.exists()
    jobs = [(str(NC), i, min(i + STRIP, nlat), with_sources) for i in range(0, nlat, STRIP)]
    tot: dict = {}
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for k, r in enumerate(ex.map(_verify_strip, jobs), 1):
            for key, v in r.items():
                tot[key] = {**tot.get(key, {}), **v} if isinstance(v, dict) else tot.get(key, 0) + v
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

    # ---- inland_below_sea_level: valid values, and area equal to the connectivity pass and the table
    z = np.load(INLAND)
    a_conn = float(z["comp_area_km2"].sum())
    lines.append(f"inland_below_sea_level: cells with invalid value or fill not matching the mask: "
                 f"{tot['inland_bad']}; area {tot['inland_area']:,.3f} km2 (connectivity pass {a_conn:,.3f} km2, "
                 f"{len(z['comp_area_km2'])} components)")
    ok &= tot["inland_bad"] == 0 and abs(tot["inland_area"] - a_conn) <= 1e-6 * a_conn
    for i in (0, NY - 1):
        sh = (tot["measured"][i] - tot["inland_meas"][i]) / (O - tot["inland_area"])
        lines.append(f"{YEARS[i]} measured share excluding inland_below_sea_level: {100 * sh:.4f} % "
                     f"(all of the mask: {100 * tot['measured'][i] / O:.4f} %)")

    # ---- every cell against the source GeoTIFFs
    if with_sources:
        lines.append(f"source GeoTIFF check, every cell: {tot['src_cells']:,} cells, {tot['src_bits']:,} measured bits, "
                     f"{tot['src_bad']} mismatching cells")
        ok &= tot["src_bad"] == 0 and tot["src_bits"] > 0 and tot["src_cells"] == H15 * W15
    else:
        lines.append("source GeoTIFF check skipped: data/raw/gebco_<year>/ not present")

    # ---- provenance of the 1' elevation: overview level 1 of the 15" mirror copy, cell for cell
    if history.ELEV.exists() and ELEV15.exists():
        import rasterio

        bad = 0
        with rasterio.open(ELEV15, overview_level=1) as s, rasterio.open(history.ELEV) as t:
            assert s.shape == t.shape == (H1, W1)
            for r0 in range(0, H1, 1200):
                w = rasterio.windows.Window(0, r0, W1, min(1200, H1 - r0))
                bad += int((s.read(1, window=w) != t.read(1, window=w)).sum())
        lines.append(f"1' elevation vs overview level 1 of {ELEV15.name}: {bad} differing cells of {H1 * W1:,}")
        ok &= bad == 0

    # ---- authalic sphere (geodetic latitude used as is) vs WGS84 ellipsoid
    keys = sorted(tot["rows"])
    latb = np.concatenate([tot["rows"][k]["lat_bnds"] for k in keys])
    oc = np.concatenate([tot["rows"][k]["ocean"] for k in keys]).astype(float)
    me = np.concatenate([tot["rows"][k]["meas"] for k in keys], axis=1).astype(float)
    dlon = tot["dlon"][keys[0]]
    a_s, a_e = area_from_lat_bnds(latb, dlon), ellipsoid_area_from_lat_bnds(latb, dlon)
    lines.append(f"sphere vs WGS84 ellipsoid: whole Earth {a_s.sum() * W15:,.0f} vs {a_e.sum() * W15:,.0f} km2")
    ocean_s, ocean_e = oc @ a_s, oc @ a_e
    lines.append(f"sphere vs WGS84 ellipsoid: ocean mask {ocean_s:,.0f} vs {ocean_e:,.0f} km2 "
                 f"(sphere - ellipsoid = {ocean_s - ocean_e:,.0f} km2, {100 * (ocean_s / ocean_e - 1):+.4f} %)")
    band = np.floor((latb[:, 0] + 90) / 5 + 1e-9).astype(int)
    rel = []
    for b in range(36):
        sel = band == b
        if (oc[sel] @ a_e[sel]) > 0:
            rel.append(100 * ((oc[sel] @ a_s[sel]) / (oc[sel] @ a_e[sel]) - 1))
    lines.append(f"sphere vs WGS84 ellipsoid, ocean area per 5 deg band: {min(rel):+.3f} % to {max(rel):+.3f} %")
    for i in range(NY):
        d = (me[i] @ a_s) / ocean_s - (me[i] @ a_e) / ocean_e
        lines.append(f"{YEARS[i]} measured share sphere {100 * (me[i] @ a_s) / ocean_s:.4f} % vs ellipsoid "
                     f"{100 * (me[i] @ a_e) / ocean_e:.4f} % ({100 * d:+.4f} percentage points)")

    lines.append(f"worst |diff|: {worst_km2:.3f} km2, {worst_frac:.1e} (fraction)")
    lines.append("VERIFY OK" if ok else "VERIFY FAILED")
    text = "\n".join(lines)
    print(text)
    print(f"runtime {time.time() - t0:.0f} s", file=sys.stderr)
    (BUILD / "verify.log").write_text(text + "\n")
    assert ok, "verify failed"
    return tot


# ---------------------------------------------------------------- checksums

def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for blk in iter(lambda: f.read(1 << 24), b""):
            h.update(blk)
    return h.hexdigest()


def dataset_files() -> list[Path]:
    """The files of the deposit that checksums.sha256 covers: the netCDF file, the tables, the README and
    inputs.sha256. The two reports (build/verify.log, build/compliance_checker.txt) are part of the deposit but not
    checksummed: they are logs that are not byte-reproducible (the compliance report carries its run time)."""
    return sorted([NC, DATASET / "README.md", DATASET / "inputs.sha256", *TABLES.glob("*.csv")])


def checksums() -> Path:
    lines = [f"{_sha256(p)}  {p.relative_to(DATASET)}" for p in dataset_files()]
    out = DATASET / "checksums.sha256"
    out.write_text("\n".join(lines) + "\n")
    return out


def input_files() -> list[Path]:
    """Every external input file that the dataset is computed from (paths relative to the repository root)."""
    import regions

    tiles = [regions.tile_path(layer, b) for layer in ("goas", "eez", "high_seas") for b in regions.tile_bounds()]
    return [*(history.tid_path(y) for y in YEARS), history.ELEV, ELEV15, *tiles]


def inputs() -> Path:
    files = input_files()
    missing = [str(p) for p in files if not p.exists()]
    assert not missing, missing[:5]
    out = DATASET / "inputs.sha256"
    out.write_text("".join(f"{_sha256(p)}  {p.relative_to(ROOT)}\n" for p in files))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("step", choices=["inputs", "connectivity", "build", "tables", "verify", "checksums", "all"])
    ap.add_argument("--workers", type=int, default=max(1, min(5, (os.cpu_count() or 2) // 2)))
    ap.add_argument("--limit", type=int, default=None, help="build only the first N strips (timing test)")
    a = ap.parse_args()
    if a.step in ("inputs", "all"):
        print(inputs())
    if a.step in ("connectivity", "all"):
        connectivity(a.workers)
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
