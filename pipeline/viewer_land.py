"""Viewer-only land mask on the 15" GEBCO grid: below-sea-level cells the viewer should draw as land.

The paper's ocean mask (TID != 0 and elevation < 0) also holds two kinds of dry or enclosed ground:
  1. inland basins below sea level that are not connected to the world ocean (Dead Sea, Caspian, Death
     Valley, Qattara, Turpan ...): flagged in the published record as inland_below_sea_level == 1;
  2. reclaimed land below sea level that GEBCO fills from a pre-generated grid (TID 44) and that touches the
     world ocean through a dammed lake, so the connectivity test cannot flag it (Flevoland and the
     Noordoostpolder reach the Wadden Sea through the IJsselmeer at 15").
Kind 2 is a cell that is dry ground on two independent maps:
  * its centre is on the OpenStreetMap land polygons one cell (~460 m) inside the coastline (land = the land
    side of the OSM coastline, so lagoons, deltas and dammed lakes such as the IJsselmeer still count as land),
    or GEBCO itself codes it as land (TID 0) with a 15" height below 0;
  * the JRC Global Surface Water occurrence (Pekel et al. 2016, v1.4, 1984-2021, 30 m) averaged over the cell
    is below DRY_OCCURRENCE percent, which removes those lagoons, rivers and lakes again.
The TID is not used to keep cells: polders hold singlebeam-coded (TID 10/11) cells too, and measured lakes are
already kept by the JRC test. Where the JRC tile is missing (poleward of ~80 N, Antarctica) nothing is flipped,
and coastline differences of one cell never flip open sea.

The record and the paper's statistics are unchanged; only the viewer's coverage tiles use this mask
(pipeline/coverage.py viewer, pipeline/tiles_hires.py).

Input : data/raw/gebco_2026/gebco_2026_tid.tif, data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif,
        dataset/build/seafloor_measured_record_2019_2026.nc (inland_below_sea_level, south-first rows),
        data/raw/osm_land/land-polygons-complete-4326/land_polygons.shp (osmdata.openstreetmap.de, ODbL)
        JRC GSW occurrence tiles, read by HTTP range over the candidate 1 deg blocks only
        (storage.googleapis.com/global-surface-water, free use with attribution; block means cached in
        data/raw/jrc_gsw/)
Inland basins are split by the same JRC occurrence: water (lakes such as the Caspian, Dead Sea, Great Lakes beds)
keeps its bed relief in the viewer, dry ground (Death Valley, Qattara, Turpan) is drawn as land.

Output: data/derived/viewer_land_15s.tif  (UInt8, 1 = draw as land in the viewer, 0 = no change)
        data/derived/viewer_lake_15s.tif  (UInt8, 1 = the inland-basin part of it that is water)
        data/derived/viewer_land.json     (areas inside the paper's ocean mask, by reason)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw"
OUT = ROOT / "data/derived"
TID = RAW / "gebco_2026/gebco_2026_tid.tif"
ELEV1 = RAW / "gebco_2026/gebco_2026_elev_1arcmin.tif"
ELEV15 = RAW / "gebco_2026/GEBCO_2026_15s.tif"
RECORD = ROOT / "dataset/build/seafloor_measured_record_2019_2026.nc"
OSM_LAND = RAW / "osm_land/land-polygons-complete-4326/land_polygons.shp"
STRIP = 960                                   # 15" rows per strip (4 deg)
BLOCK = 240                                   # 15" cells per 1 deg block
DRY_OCCURRENCE = 25                           # mean JRC water occurrence (%) below which a cell counts as dry
GSW_URL = "https://storage.googleapis.com/global-surface-water/downloads2021/occurrence/occurrence_{}v1_4_2021.tif"
GSW_CACHE = RAW / "jrc_gsw"
R_KM = 6371.0072
CHECK_BOXES = {                               # (west, south, east, north): areas reported in the JSON
    "flevoland_noordoostpolder": (5.15, 52.25, 6.0, 52.85),
    "dead_sea": (35.3, 31.0, 35.7, 31.8),
    "caspian": (46.5, 36.5, 55.0, 47.5),
}


def direct(tid: np.ndarray) -> np.ndarray:
    return (tid >= 10) & (tid <= 17)


def erode1(a: np.ndarray) -> np.ndarray:
    """3 x 3 binary erosion; columns wrap (the grid spans 360 deg), the first and last rows are kept as given."""
    out = a.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            s = np.roll(a, dx, axis=1)
            if dy:
                s = np.roll(s, dy, axis=0)
                s[0 if dy > 0 else -1] = a[0 if dy > 0 else -1]
            out &= s
    return out


def candidates(tid: np.ndarray, inland: np.ndarray, osm_land_eroded: np.ndarray,
               h15: np.ndarray | None = None) -> np.ndarray:
    """Cells that may be dry ground below sea level, not already inland: in the ocean mask's TID and on OSM land,
    or GEBCO land (TID 0) with a 15" height below 0."""
    c = osm_land_eroded & (tid != 0)
    if h15 is not None:
        c |= (tid == 0) & (h15 < 0)
    return c & (inland != 1)


def viewer_land(tid: np.ndarray, inland: np.ndarray, osm_land_eroded: np.ndarray,
                occurrence: np.ndarray, h15: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """(land, reason): reason 1 = dry inland basin, 3 = inland basin under water (JRC occurrence >= DRY_OCCURRENCE),
    2 = OSM land (or GEBCO land below 0 m) and JRC dry. occurrence = mean JRC water occurrence per cell in percent,
    NaN where unknown (an inland cell then counts as dry; an OSM candidate is never flipped)."""
    a = inland == 1
    with np.errstate(invalid="ignore"):
        dry = occurrence < DRY_OCCURRENCE
        wet = occurrence >= DRY_OCCURRENCE
    b = candidates(tid, inland, osm_land_eroded, h15) & dry
    reason = np.zeros(tid.shape, np.uint8)
    reason[a] = 1
    reason[a & wet] = 3
    reason[b] = 2
    return a | b, reason


def gsw_tile_name(west: int, north: int) -> str:
    """JRC tile holding the 1 deg block with this west and north edge: tiles are 10 deg, named by their
    west and north edges ("60W_0N" covers 60-50 W, 10 S-0)."""
    tw, tn = (west // 10) * 10, -((-north) // 10) * 10
    return f"{abs(tw)}{'E' if tw >= 0 else 'W'}_{abs(tn)}{'N' if tn >= 0 else 'S'}"


def gsw_block(west: int, north: int) -> np.ndarray | None:
    """Mean JRC water occurrence (%) on the 240 x 240 15" cells of one 1 deg block; None without a JRC tile."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.errors import RasterioIOError
    from rasterio.windows import from_bounds
    cache = GSW_CACHE / f"{west}_{north}.npy"
    if cache.exists():
        a = np.load(cache)
        return None if a.size == 0 else a
    try:
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MAX_RETRY="5", GDAL_HTTP_RETRY_DELAY="3"):
            with rasterio.open("/vsicurl/" + GSW_URL.format(gsw_tile_name(west, north))) as d:
                w = from_bounds(west, north - 1, west + 1, north, transform=d.transform)
                a = d.read(1, window=w, out_shape=(BLOCK, BLOCK), resampling=Resampling.average).astype(np.float32)
                a[a > 100] = np.nan
    except RasterioIOError as e:
        if "404" not in str(e) and "not recognized" not in str(e) and "No such file" not in str(e):
            raise
        a = None
    GSW_CACHE.mkdir(parents=True, exist_ok=True)
    np.save(cache, np.zeros(0, np.float32) if a is None else a)
    return a


def occurrence_strip(cand: np.ndarray, north_deg: int, pool) -> np.ndarray:
    """JRC mean occurrence for the strip's candidate blocks (NaN elsewhere); blocks are fetched in parallel."""
    n, W = cand.shape
    occ = np.full((n, W), np.nan, np.float32)
    jobs = []
    for bi in range(n // BLOCK):
        for bj in range(W // BLOCK):
            if cand[bi * BLOCK:(bi + 1) * BLOCK, bj * BLOCK:(bj + 1) * BLOCK].any():
                jobs.append((bi, bj, -180 + bj, north_deg - bi))
    for (bi, bj, _, _), a in zip(jobs, pool.map(lambda j: gsw_block(j[2], j[3]), jobs)):
        if a is not None:
            occ[bi * BLOCK:(bi + 1) * BLOCK, bj * BLOCK:(bj + 1) * BLOCK] = a
    return occ


def load_land(path: Path):
    import pyogrio
    import shapely
    wkb = pyogrio.raw.read(path, columns=[])[2]
    geoms = shapely.from_wkb(wkb)
    return geoms, shapely.STRtree(geoms)


def rasterize_strip(geoms, tree, transform, r0: int, n: int, width: int) -> np.ndarray:
    import shapely
    from rasterio.features import rasterize
    from rasterio.transform import Affine
    west, north = transform.c, transform.f + r0 * transform.e
    south = north + n * transform.e
    idx = tree.query(shapely.box(west, south, west + width * transform.a, north))
    if len(idx) == 0:
        return np.zeros((n, width), bool)
    clipped = shapely.clip_by_rect(geoms[idx], west, south - 1e-6, west + width * transform.a, north + 1e-6)
    clipped = clipped[~shapely.is_empty(clipped)]
    t = Affine(transform.a, 0, west, 0, transform.e, north)
    return rasterize(((g, 1) for g in clipped), out_shape=(n, width), transform=t, fill=0, dtype="uint8").astype(bool)


def run() -> dict:
    from concurrent.futures import ThreadPoolExecutor

    import netCDF4
    import rasterio
    from rasterio.windows import Window

    geoms, tree = load_land(OSM_LAND)
    print(f"OSM land polygons: {len(geoms):,}", file=sys.stderr)
    ds = netCDF4.Dataset(RECORD)
    inl_var = ds["inland_below_sea_level"]
    inl_var.set_auto_maskandscale(False)
    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "viewer_land_15s.tif"
    area = {"inland_basin": 0.0, "inland_lake": 0.0, "osm_land_dry_not_direct": 0.0, "osm_land_wet_kept": 0.0, "ocean_mask": 0.0}
    pool = ThreadPoolExecutor(16)
    boxes = {k: 0.0 for k in CHECK_BOXES}
    with rasterio.open(TID) as t, rasterio.open(ELEV1) as e, rasterio.open(ELEV15) as e15:
        H, W = t.height, t.width
        assert inl_var.shape == (H, W) and float(ds["lat"][0]) < 0
        prof = t.profile.copy()
        prof.update(dtype="uint8", nodata=None, compress="deflate", tiled=True, blockxsize=512, blockysize=512)
        cell_deg = t.transform.a
        with rasterio.open(out_path, "w", **prof) as dst, \
                rasterio.open(OUT / "viewer_lake_15s.tif", "w", **prof) as lake_dst:
            for r0 in range(0, H, STRIP):
                n = min(STRIP, H - r0)
                p0, p1 = max(0, r0 - 1), min(H, r0 + n + 1)          # one padding row each side for the erosion
                land = rasterize_strip(geoms, tree, t.transform, p0, p1 - p0, W)
                land = erode1(land)[r0 - p0:r0 - p0 + n]
                tid = t.read(1, window=Window(0, r0, W, n)).astype(np.int16)
                inland = np.asarray(inl_var[H - r0 - n:H - r0])[::-1]
                h15 = e15.read(1, window=Window(0, r0, W, n))
                cand = candidates(tid, inland, land, h15)
                occ = occurrence_strip(cand | (inland == 1), round(90 - r0 / BLOCK), pool)
                vl, reason = viewer_land(tid, inland, land, occ, h15)
                dst.write(vl.astype(np.uint8), 1, window=Window(0, r0, W, n))
                lake_dst.write((reason == 3).astype(np.uint8), 1, window=Window(0, r0, W, n))

                # areas inside the paper's ocean mask (TID != 0 and the 1' elevation < 0), cos(lat) weighted
                h1 = e.read(1, window=Window(0, r0 // 4, W // 4, n // 4))
                sea = np.repeat(np.repeat(h1 < 0, 4, axis=0), 4, axis=1) & (tid != 0)
                lat = t.transform.f + (np.arange(r0, r0 + n) + 0.5) * t.transform.e
                cell_km2 = (np.radians(cell_deg) * R_KM) ** 2 * np.cos(np.radians(lat))[:, None]
                area["ocean_mask"] += float((sea * cell_km2).sum())
                area["inland_basin"] += float((((reason == 1) & sea) * cell_km2).sum())
                area["inland_lake"] += float((((reason == 3) & sea) * cell_km2).sum())
                area["osm_land_dry_not_direct"] += float((((reason == 2) & sea) * cell_km2).sum())
                area["osm_land_wet_kept"] += float(((cand & (reason != 2) & sea) * cell_km2).sum())
                lon = t.transform.c + (np.arange(W) + 0.5) * t.transform.a
                for k, (w0, s0, e0, n0) in CHECK_BOXES.items():
                    rows = (lat >= s0) & (lat <= n0)
                    cols = (lon >= w0) & (lon <= e0)
                    if rows.any():
                        sub = (vl & sea)[np.ix_(rows, cols)] * cell_km2[rows]
                        boxes[k] += float(sub.sum())
                print(f"\rrows {r0 + n}/{H}", end="", file=sys.stderr)
    print(file=sys.stderr)
    summary = {
        "source": "record inland_below_sea_level == 1, or OSM land polygon (cell centre, eroded by one 15\" cell) "
                  f"and JRC GSW mean occurrence < {DRY_OCCURRENCE} % (or GEBCO TID 0 with a 15\" height < 0)",
        "osm_land": "OpenStreetMap land polygons (osmdata.openstreetmap.de), ODbL 1.0",
        "surface_water": "JRC Global Surface Water occurrence v1.4 (1984-2021), Pekel et al. 2016, doi:10.1038/nature20584",
        "area_km2_inside_paper_ocean_mask": {k: round(v) for k, v in area.items()},
        "share_of_paper_ocean_mask": {k: area[k] / area["ocean_mask"] for k in ("inland_basin", "inland_lake", "osm_land_dry_not_direct")},
        "check_boxes_km2": {k: round(v) for k, v in boxes.items()},
    }
    (OUT / "viewer_land.json").write_text(json.dumps(summary, indent=1))
    return summary


if __name__ == "__main__":
    print(json.dumps(run(), indent=1))
