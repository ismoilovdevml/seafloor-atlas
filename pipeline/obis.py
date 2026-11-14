"""Marine life layers from OBIS (Ocean Biodiversity Information System) + AquaMaps -> web/public/data/obis/.

Three questions, three kinds of layer (format in docs/data-contract.md, "Marine life"):

  where have people looked?   records per geohash-4 cell (~39 x 20 km) from the OBIS API, ocean cells with
                              no record kept explicit (the biological analogue of the unmapped seafloor)
  where are species recorded? species per geohash-3 cell (1.40625 deg) and ES50 (Hurlbert's expected number of
                              species in 50 random records, the OBIS diversity indicator, which corrects for the
                              number of records), from the OBIS speciesgrids product (H3 res 7, OBIS + GBIF)
  where should they live?     AquaMaps predicted species richness (0.5 deg, computer-generated ranges)

plus charismatic groups (whales, sharks, turtles, corals, ...: records + species per geohash-3 cell, top species)
and per-cell species lists for click info.

Sources
  OBIS API v3  https://api.obis.org/v3  (no key): occurrence/grid, checklist, statistics; cached in
               data/raw/obis/api/ (gzip JSON). About 60 requests, sequential, with a pause.
  speciesgrids s3://obis-products/speciesgrids/20261014/h3_7/data.parquet (public bucket, CC BY-NC 4.0):
               read with column projection (no geometry/year columns, ~730 of 1,525 MB) into
               data/raw/obis/speciesgrids/rgNNN.parquet, one file per row group (resumable).
  AquaMaps     Global species richness map for all marine species, version 10/2019, probability > 0.5,
               0.5 deg C-squares (CC BY-NC 3.0), mirrored by SPREP; data/raw/obis/aquamaps/.

usage: .venv/bin/python pipeline/obis.py [fetch-api|fetch-sg|fetch-aquamaps|build|check|figure|all]
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
import time
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/obis"
API_CACHE = RAW / "api"
SG_DIR = RAW / "speciesgrids"
AQ_CSV = RAW / "aquamaps/Global_2020_MarineSpeciesRichness_AquaMaps.csv"
ELEV = ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif"
OUT = ROOT / "web/public/data/obis"
FIG = ROOT / "figures/fig10_obis.png"

API = "https://api.obis.org/v3"
UA = "seafloor-atlas-pipeline (+https://github.com/ismoilovdevml/seafloor-atlas)"
SG_S3 = "obis-products/speciesgrids/20261014/h3_7/data.parquet"
SG_COLS = ["cell", "AphiaID", "species", "records", "source_obis", "source_gbif",
           "kingdom", "phylum", "class", "order", "family", "genus"]
AQ_URL = ("https://vanuatu-data.sprep.org/system/files/fe383bc7-bd3d-4654-bb61-17d3d75f9f58/"
          "Global_2020_MarineSpeciesRichness_AquaMaps.csv")

# geohash grids: precision 4 = 0.3515625 x 0.17578125 deg, precision 3 = 1.40625 x 1.40625 deg
GH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"
FINE = {"name": "gh4", "ncol": 1024, "nrow": 1024, "dlon": 360 / 1024, "dlat": 180 / 1024}
COARSE = {"name": "gh3", "ncol": 256, "nrow": 128, "dlon": 360 / 256, "dlat": 180 / 128}
AQ = {"name": "csquare_0p5", "ncol": 720, "nrow": 360, "dlon": 0.5, "dlat": 0.5}
R_KM = 6371.0072
ES_N = 50                     # ES50
FISH_TAXA = "10194,1517375,10189,843662,843665"   # Actinopterygii, Chondrichthyes, Myxini, Petromyzonti, Coelacanthi
TOP_SPECIES = 25              # per group
CELL_TOP = 10                 # per click cell

GROUPS = [
    # id, title, OBIS taxonid(s), extra API filters, short note
    ("whales", "Whales & dolphins", "2688", {}, "Infraorder Cetacea"),
    ("sharks", "Sharks & rays", "10193", {}, "Class Elasmobranchii"),
    ("turtles", "Sea turtles", "136999,137000", {}, "Families Cheloniidae + Dermochelyidae (leatherback)"),
    ("corals", "Stony corals", "1363", {}, "Order Scleractinia (reef-building and deep-water stony corals)"),
    ("tunas", "Tunas", "126065,126059,126058,126057,206507", {},
     "Tribe Thunnini: genera Thunnus, Katsuwonus, Euthynnus, Auxis, Allothunnus"),
    ("penguins", "Penguins", "196034", {}, "Family Spheniscidae"),
    ("seals", "Seals & sea lions", "148736", {}, "Infraorder Pinnipedia"),
    ("cephalopods", "Octopus & squid", "11707", {}, "Class Cephalopoda"),
    ("deepfish", "Deep-sea fish", FISH_TAXA, {"startdepth": 1000},
     "Fish records with a depth of 1,000 m or more (Actinopterygii, Chondrichthyes, hagfish, lampreys, coelacanths)"),
]

CITATION_OBIS = ("OBIS (2026) Ocean Biodiversity Information System. Intergovernmental Oceanographic Commission "
                 "of UNESCO. www.obis.org")
CITATION_SG = ("OBIS (2025). speciesgrids: gridded dataset of marine species occurrence (H3 resolution 7). "
               "Ocean Biodiversity Information System. Intergovernmental Oceanographic Commission of UNESCO. "
               "Available at s3://obis-products/speciesgrids/h3_7/ ; build 20261014. Provoost, P. (2026). speciesgrids: "
               "build pipeline and documentation for a gridded dataset of marine species occurrence. Zenodo. "
               "https://doi.org/10.5281/zenodo.19392660 ; GBIF.org (1 May 2024) GBIF Occurrence Data "
               "https://doi.org/10.15468/dl.ubwn8z ; World Register of Marine Species, doi:10.14284/170")
CITATION_AQ = ("Kaschner, K., K. Kesner-Reyes, C. Garilao, J. Segschneider, J. Rius-Barile, T. Rees, and R. Froese. "
               "2019. AquaMaps: Predicted range maps for aquatic species. www.aquamaps.org, version 10/2019. "
               "Global Species Richness Map for All Marine Species (probability > 0.5).")
ATTR_OBIS = "Marine life records: OBIS (2026), www.obis.org"
ATTR_SG = "Species and ES50: OBIS speciesgrids (OBIS + GBIF), CC BY-NC 4.0"
ATTR_AQ = "Predicted richness: AquaMaps (www.aquamaps.org, version 10/2019), CC BY-NC 3.0"


# --------------------------------------------------------------------------------------------- utilities

def log(*a) -> None:
    print(*a, flush=True)


def api_get(path: str, params: dict, cache_name: str, refresh: bool = False):
    """GET api.obis.org/v3/<path>?params, cached as gzip JSON. Sequential and polite (1 s pause after a miss)."""
    f = API_CACHE / f"{cache_name}.json.gz"
    if f.exists() and not refresh:
        return json.loads(gzip.decompress(f.read_bytes()))
    url = f"{API}/{path}" + ("?" + urllib.parse.urlencode(params) if params else "")
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=900) as r:
                body = r.read()
            break
        except Exception as e:  # noqa: BLE001
            log(f"  retry {attempt + 1} {url}: {e}")
            time.sleep(10 * (attempt + 1))
    else:
        raise RuntimeError(f"failed: {url}")
    data = json.loads(body)
    API_CACHE.mkdir(parents=True, exist_ok=True)
    f.write_bytes(gzip.compress(body))
    log(f"  GET {url} -> {len(body) / 1e6:.2f} MB in {time.time() - t0:.1f}s")
    time.sleep(1.0)
    return data


def gh_encode(lat: float, lon: float, prec: int) -> str:
    lat_r, lon_r = [-90.0, 90.0], [-180.0, 180.0]
    bits, out, even, ch, nb = 0, [], True, 0, 0
    while len(out) < prec:
        r, v = (lon_r, lon) if even else (lat_r, lat)
        mid = (r[0] + r[1]) / 2
        if v >= mid:
            ch = (ch << 1) | 1
            r[0] = mid
        else:
            ch <<= 1
            r[1] = mid
        even = not even
        nb += 1
        if nb == 5:
            out.append(GH_BASE32[ch])
            ch, nb = 0, 0
    return "".join(out)


def cell_center(g: dict, row: int, col: int) -> tuple[float, float]:
    return 90 - (row + 0.5) * g["dlat"], -180 + (col + 0.5) * g["dlon"]


def latlon_to_rc(g: dict, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    r = np.clip(np.floor((90 - np.asarray(lat)) / g["dlat"]).astype(np.int64), 0, g["nrow"] - 1)
    c = np.clip(np.floor((np.asarray(lon) + 180) / g["dlon"]).astype(np.int64), 0, g["ncol"] - 1)
    return r, c


def grid_features_to_array(feats: list, g: dict) -> np.ndarray:
    """OBIS occurrence/grid GeoJSON (geohash polygons, property n) -> counts on grid g (row 0 = north)."""
    a = np.zeros((g["nrow"], g["ncol"]), np.int64)
    for f in feats:
        ring = f["geometry"]["coordinates"][0]
        lon0 = min(p[0] for p in ring)
        lat1 = max(p[1] for p in ring)
        c = int(round((lon0 + 180) / g["dlon"]))
        r = int(round((90 - lat1) / g["dlat"]))
        if 0 <= r < g["nrow"] and 0 <= c < g["ncol"]:
            a[r, c] += int(f["properties"]["n"])
    return a


def row_area_km2(g: dict) -> np.ndarray:
    top = 90 - np.arange(g["nrow"]) * g["dlat"]
    return R_KM ** 2 * math.radians(g["dlon"]) * np.abs(np.sin(np.radians(top)) - np.sin(np.radians(top - g["dlat"])))


def planes(q: np.ndarray) -> bytes:
    """unsigned int array -> byte planes (all byte 0, then all byte 1, ...), little-endian, zlib level 9."""
    nbytes = q.dtype.itemsize
    b = np.frombuffer(q.astype(f"<u{nbytes}").tobytes(), np.uint8).reshape(-1, nbytes)
    return zlib.compress(b"".join(b[:, k].tobytes() for k in range(nbytes)), 9)


def unplanes(raw: bytes, shape: tuple[int, int], nbytes: int) -> np.ndarray:
    b = np.frombuffer(zlib.decompress(raw), np.uint8)
    n = b.size // nbytes
    v = np.zeros(n, np.uint64)
    for k in range(nbytes):
        v |= b[k * n:(k + 1) * n].astype(np.uint64) << np.uint64(8 * k)
    return v.astype(f"u{nbytes}").reshape(shape)


# --------------------------------------------------------------------------------------------- fetch

def fetch_api(refresh: bool = False) -> None:
    log("OBIS API: global statistics")
    api_get("statistics", {}, "statistics_global", refresh)
    log("OBIS API: records per geohash-4 cell, one request per geohash-1 region (32)")
    for ch in GH_BASE32:
        api_get(f"occurrence/grid/4", {"geometry": ch}, f"grid4_{ch}", refresh)
    log("OBIS API: records per geohash-3 cell for fish (all depths)")
    api_get("occurrence/grid/3", {"taxonid": FISH_TAXA}, "grid3_fish", refresh)
    for gid, _title, taxa, extra, _note in GROUPS:
        log(f"OBIS API: group {gid}")
        api_get("occurrence/grid/3", {"taxonid": taxa, **extra}, f"grid3_{gid}", refresh)
        api_get("checklist", {"taxonid": taxa, "size": 5000, **extra}, f"checklist_{gid}", refresh)
        api_get("statistics", {"taxonid": taxa, **extra}, f"statistics_{gid}", refresh)
    deep_share_stats(refresh)
    # spot checks
    log("OBIS API: spot checks")
    api_get("occurrence/grid/3", {"taxonid": 137090}, "grid3_blue_whale", refresh)        # Balaenoptera musculus
    api_get("occurrence/grid/3", {"taxonid": 137209}, "grid3_leatherback", refresh)       # Dermochelys coriacea
    for name, wkt in SPOT_BOXES.items():
        api_get("statistics", {"geometry": wkt}, f"statistics_box_{name}", refresh)


DEEP_CHECK = 100        # deep-sea fish: check the all-depth record count of the top species
DEEP_MIN_SHARE = 0.2    # species with less than this share of records at >= 1,000 m are flagged "mostly shallow"


def deep_share_stats(refresh: bool = False) -> dict[int, float]:
    """Share of each top deep-fish species' OBIS records that are at >= 1,000 m (catches surface fish whose
    'depth' is a bottom or gear depth, e.g. swordfish on longlines)."""
    chk = api_get("checklist", {"taxonid": FISH_TAXA, "size": 5000, "startdepth": 1000}, "checklist_deepfish", refresh)
    spp = sorted((r for r in chk["results"] if r.get("taxonRank") == "Species"), key=lambda r: -r["records"])[:DEEP_CHECK]
    out = {}
    for r in spp:
        st = api_get("statistics", {"taxonid": r["taxonID"]}, f"statistics_taxon_{r['taxonID']}", refresh)
        out[r["taxonID"]] = r["records"] / max(st["records"], 1)
    return out


SPOT_BOXES = {  # WKT boxes for spot checks (counter-clockwise)
    "great_barrier_reef": "POLYGON((142 -25,154 -25,154 -10,142 -10,142 -25))",
    "coral_triangle": "POLYGON((115 -10,135 -10,135 8,115 8,115 -10))",
    "north_sea": "POLYGON((-4 51,9 51,9 61,-4 61,-4 51))",
    "central_pacific_gyre": "POLYGON((-160 10,-130 10,-130 30,-160 30,-160 10))",
}


def fetch_sg() -> None:
    import pyarrow.fs as pafs
    import pyarrow.parquet as pq
    SG_DIR.mkdir(parents=True, exist_ok=True)
    fs = pafs.S3FileSystem(anonymous=True, region="us-east-1")
    pf = pq.ParquetFile(SG_S3, filesystem=fs)
    n = pf.metadata.num_row_groups
    log(f"speciesgrids: {pf.metadata.num_rows:,} rows in {n} row groups")
    for i in range(n):
        f = SG_DIR / f"rg{i:03d}.parquet"
        if f.exists():
            continue
        t0 = time.time()
        t = pf.read_row_group(i, columns=SG_COLS)
        tmp = f.with_suffix(".tmp")
        pq.write_table(t, tmp, compression="zstd")
        tmp.rename(f)
        log(f"  row group {i + 1}/{n}: {t.num_rows:,} rows, {time.time() - t0:.0f}s")


def fetch_aquamaps() -> None:
    AQ_CSV.parent.mkdir(parents=True, exist_ok=True)
    if AQ_CSV.exists():
        return
    req = urllib.request.Request(AQ_URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=600) as r:
        AQ_CSV.write_bytes(r.read())
    log(f"wrote {AQ_CSV} ({AQ_CSV.stat().st_size / 1e6:.1f} MB)")


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    return json.loads(body) if body.strip() else None


def fetch_vernaculars(species: list[tuple[int, str]]) -> dict[int, str]:
    """English common names for the group top-species lists only (cached in data/raw/obis/common_names.json).

    iNaturalist's preferred English name for an exact scientific-name match first (WoRMS lists vernaculars
    alphabetically with no preferred flag, which gives "bunch whale" for the humpback), else the first English
    WoRMS vernacular, else empty.
    """
    f = RAW / "common_names.json"
    have = json.loads(f.read_text()) if f.exists() else {}
    for aphia, name in species:
        if str(aphia) in have:
            continue
        common, src = "", ""
        try:
            d = _get_json("https://api.inaturalist.org/v1/taxa?" + urllib.parse.urlencode(
                {"q": name, "rank": "species", "per_page": 5, "locale": "en"}))
            for r in (d or {}).get("results", []):
                if r.get("name") == name and r.get("preferred_common_name"):
                    common, src = r["preferred_common_name"], "iNaturalist"
                    break
            time.sleep(1.0)
            if not common:
                rows = _get_json(f"https://www.marinespecies.org/rest/AphiaVernacularsByAphiaID/{aphia}") or []
                eng = [v["vernacular"] for v in rows if v.get("language_code") == "eng"]
                if eng:
                    common, src = eng[0], "WoRMS"
                time.sleep(0.3)
        except urllib.error.HTTPError as e:
            if e.code not in (204, 404):
                continue
        except Exception:  # noqa: BLE001
            continue
        have[str(aphia)] = {"common": common, "source": src}
        f.write_text(json.dumps(have, indent=0, ensure_ascii=False))
    return {int(k): v["common"] for k, v in have.items()}


# --------------------------------------------------------------------------------------------- build

def ocean_fraction(g: dict) -> np.ndarray:
    """Share of each grid cell that is ocean in this repo's sense (GEBCO TID != 0 and elevation < 0)."""
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject
    with rasterio.open(ROOT / "data/derived/coverage_1arcmin.tif") as src:
        a = (src.read(1) > 0).astype(np.float32)
        dst = np.zeros((g["nrow"], g["ncol"]), np.float32)
        reproject(a, dst, src_transform=src.transform, src_crs=src.crs, dst_transform=from_origin(-180, 90, g["dlon"], g["dlat"]),
                  dst_crs=src.crs, resampling=Resampling.average)
    return dst


def es_n(cell: np.ndarray, ni: np.ndarray, ncell: int, n: int = ES_N) -> tuple[np.ndarray, np.ndarray]:
    """Hurlbert (1971) expected species in n random records, per cell.

    cell[k], ni[k] = cell index and record count of one species in that cell. Returns (es, N) with es = NaN where
    the cell has fewer than n records. ES_n = sum_i [1 - C(N - N_i, n) / C(N, n)], via log-gamma.
    """
    from scipy.special import gammaln
    ni = ni.astype(np.float64)
    N = np.bincount(cell, weights=ni, minlength=ncell)
    Nk = N[cell]
    ok = Nk >= n
    rest = Nk - ni
    with np.errstate(invalid="ignore", divide="ignore"):
        lp = (gammaln(rest + 1) - gammaln(rest - n + 1)) - (gammaln(Nk + 1) - gammaln(Nk - n + 1))
        term = np.where(rest >= n, 1.0 - np.exp(lp), 1.0)
    es = np.bincount(cell[ok], weights=term[ok], minlength=ncell)
    es[N < n] = np.nan
    return es, N


def load_sg_aggregates() -> dict:
    """speciesgrids H3-7 rows -> per-(gh3 cell, species) sums, per-gh4 species counts. Cached as npz."""
    cache = RAW / "sg_aggregates.npz"
    files = sorted(SG_DIR.glob("rg*.parquet"))
    if cache.exists() and cache.stat().st_mtime > max(f.stat().st_mtime for f in files):
        z = np.load(cache, allow_pickle=True)
        return {k: z[k] for k in z.files}
    import duckdb
    import h3
    con = duckdb.connect()
    con.execute("SET threads TO 8")
    src = f"read_parquet('{SG_DIR}/rg*.parquet')"
    cells = con.execute(f"select distinct cell from {src}").fetchnumpy()["cell"]
    log(f"speciesgrids: {len(cells):,} distinct H3 res-7 cells")
    ll = np.array([h3.cell_to_latlng(c) for c in cells])
    fr, fc = latlon_to_rc(FINE, ll[:, 0], ll[:, 1])
    cr, cc = latlon_to_rc(COARSE, ll[:, 0], ll[:, 1])
    import pyarrow as pa
    m = pa.table({"cell": cells, "fidx": (fr * FINE["ncol"] + fc).astype(np.int32),
                  "cidx": (cr * COARSE["ncol"] + cc).astype(np.int32)})
    con.register("m", m)
    con.execute(f"create table t as select s.AphiaID, s.records, s.source_obis, s.source_gbif, s.class, "
                f"s.kingdom, m.fidx, m.cidx, s.cell from {src} s join m using (cell)")
    tot = con.execute("select count(*), sum(records), sum((not source_obis)::int), sum((not source_gbif)::int), "
                  "count(distinct AphiaID) from t").fetchone()
    log(f"  rows {tot[0]:,}, records {tot[1]:,}, GBIF-only rows {tot[2]:,}, OBIS-only rows {tot[3]:,}, species {tot[4]:,}")
    fish = "('Teleostei','Elasmobranchii','Holocephali','Myxini','Petromyzonti','Holostei','Chondrostei','Cladistii','Coelacanthi')"
    # per (gh3 cell, species): records, OBIS flag, number of H3-7 cells occupied (incidence), fish / bird flags
    cs = con.execute(f"""select cidx, AphiaID, sum(records)::bigint rec, bool_or(source_obis) obis, count(*)::int inc,
                     max((class in {fish})::int)::int8 fish, max((class = 'Aves')::int)::int8 bird
                     from t group by cidx, AphiaID""").fetchnumpy()
    fsp = con.execute("select fidx, count(distinct AphiaID)::int sp, "
                  "count(distinct case when source_obis then AphiaID end)::int sp_obis from t group by fidx").fetchnumpy()
    names = con.execute("select AphiaID, any_value(species) species, any_value(class) class from "
                    f"{src} group by AphiaID").fetchnumpy()
    out = {"cs_cidx": cs["cidx"], "cs_aphia": cs["AphiaID"], "cs_rec": cs["rec"], "cs_obis": cs["obis"],
           "cs_inc": cs["inc"], "cs_fish": cs["fish"], "cs_bird": cs["bird"],
           "f_idx": fsp["fidx"], "f_sp": fsp["sp"], "f_sp_obis": fsp["sp_obis"],
           "n_aphia": names["AphiaID"], "n_species": names["species"].astype(object), "n_class": names["class"].astype(object),
           "totals": np.array(tot, dtype=np.int64)}
    np.savez_compressed(cache, **out)
    return out


def api_records_fine() -> np.ndarray:
    a = np.zeros((FINE["nrow"], FINE["ncol"]), np.int64)
    for ch in GH_BASE32:
        d = api_get("occurrence/grid/4", {"geometry": ch}, f"grid4_{ch}")
        # the geohash filter also returns cells touching the region edge: keep only cells inside it (no double count)
        inside = []
        for f in d["features"]:
            ring = f["geometry"]["coordinates"][0]
            lat = (min(p[1] for p in ring) + max(p[1] for p in ring)) / 2
            lon = (min(p[0] for p in ring) + max(p[0] for p in ring)) / 2
            if gh_encode(lat, lon, 1) == ch:
                inside.append(f)
        a += grid_features_to_array(inside, FINE)
    return a


def coarse_from_fine(a: np.ndarray) -> np.ndarray:
    return a.reshape(COARSE["nrow"], 8, COARSE["ncol"], 4).sum(axis=(1, 3))


def area_share(mask: np.ndarray, ocean_km2: np.ndarray) -> float:
    return float(ocean_km2[mask].sum() / ocean_km2.sum())


def build() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "grid").mkdir(exist_ok=True)
    stats: dict = {"obisGlobal": api_get("statistics", {}, "statistics_global")}

    # ---- B. records (OBIS API, geohash 4) and ocean
    rec_f = api_records_fine()
    rec_c = coarse_from_fine(rec_f)
    stats["recordsOnGrid"] = int(rec_f.sum())
    oc_f, oc_c = ocean_fraction(FINE), ocean_fraction(COARSE)
    ocean_km2_f = oc_f * row_area_km2(FINE)[:, None]
    ocean_km2_c = oc_c * row_area_km2(COARSE)[:, None]
    gap = {}
    for gname, rec, okm in (("gh4", rec_f, ocean_km2_f), ("gh3", rec_c, ocean_km2_c)):
        sel = okm > 0
        gap[gname] = {f"lt{t}": round(area_share(sel & (rec < t), okm), 4) for t in (1, 10, 50, 100, 1000, 10000)}
    stats["dataGap"] = {"definition": "share of ocean area (GEBCO ocean mask, area-weighted) in cells with fewer than T "
                                      "OBIS records; gh4 = 0.35 x 0.18 deg (~39 x 20 km at the equator), gh3 = 1.41 deg (~156 km)",
                        **gap}
    log("data gap", json.dumps(gap))

    # ---- A. species, ES50 (speciesgrids)
    sg = load_sg_aggregates()
    nC = COARSE["nrow"] * COARSE["ncol"]
    cidx, rec_sg = sg["cs_cidx"].astype(np.int64), sg["cs_rec"]
    sp_c = np.bincount(cidx, minlength=nC)
    fish = sg["cs_fish"].astype(bool)
    sp_fish_c = np.bincount(cidx[fish], minlength=nC)
    es_all, n_sg = es_n(cidx, rec_sg, nC)
    es_fish, n_fish = es_n(cidx[fish], rec_sg[fish], nC)
    # sensitivity variants
    obis = sg["cs_obis"].astype(bool)
    es_obis, _ = es_n(cidx[obis], rec_sg[obis], nC)
    nob = ~sg["cs_bird"].astype(bool)
    es_nobird, _ = es_n(cidx[nob], rec_sg[nob], nC)
    es_inc, _ = es_n(cidx, sg["cs_inc"], nC)
    sp_f = np.zeros(FINE["nrow"] * FINE["ncol"], np.int64)
    sp_f[sg["f_idx"]] = sg["f_sp"]
    sp_f = sp_f.reshape(FINE["nrow"], FINE["ncol"])
    shape_c = (COARSE["nrow"], COARSE["ncol"])
    sp_c, sp_fish_c = sp_c.reshape(shape_c), sp_fish_c.reshape(shape_c)
    es_all, es_fish, es_obis, es_nobird, es_inc, n_sg = (x.reshape(shape_c) for x in (es_all, es_fish, es_obis, es_nobird, es_inc, n_sg))
    tot = sg["totals"]
    stats["speciesgrids"] = {"rows": int(tot[0]), "records": int(tot[1]), "gbifOnlyRows": int(tot[2]),
                             "obisOnlyRows": int(tot[3]), "species": int(tot[4]),
                             "speciesFineCells": int((sp_f > 0).sum()), "speciesCoarseCells": int((sp_c > 0).sum())}
    sel = ocean_km2_c > 0
    stats["es50"] = {"oceanAreaWithES50": round(area_share(sel & np.isfinite(es_all), ocean_km2_c), 4),
                     "oceanAreaWithES50fish": round(area_share(sel & np.isfinite(es_fish), ocean_km2_c), 4),
                     "cells": int(np.isfinite(es_all).sum())}

    # correlations records vs species
    from scipy.stats import pearsonr, spearmanr
    corr = {}
    for gname, r, s in (("gh4", rec_f, sp_f), ("gh3", rec_c, sp_c)):
        ok = (r > 0) & (s > 0)
        corr[gname] = {"cells": int(ok.sum()),
                       "pearsonLog10": round(float(pearsonr(np.log10(r[ok]), np.log10(s[ok]))[0]), 3),
                       "spearman": round(float(spearmanr(r[ok], s[ok])[0]), 3)}
    ok = np.isfinite(es_all) & (rec_c > 0)
    corr["gh3_es50_vs_records"] = {"cells": int(ok.sum()), "spearman": round(float(spearmanr(rec_c[ok], es_all[ok])[0]), 3)}
    ok = np.isfinite(es_all) & (sp_c > 0)
    corr["gh3_es50_vs_species"] = {"cells": int(ok.sum()), "spearman": round(float(spearmanr(sp_c[ok], es_all[ok])[0]), 3)}
    for nm, v in (("obisFlaggedOnly", es_obis), ("withoutBirds", es_nobird), ("incidenceBased", es_inc)):
        ok = np.isfinite(es_all) & np.isfinite(v)
        corr[f"es50_vs_{nm}"] = {"cells": int(ok.sum()), "spearman": round(float(spearmanr(es_all[ok], v[ok])[0]), 3),
                                 "medianAbsDiff": round(float(np.median(np.abs(es_all[ok] - v[ok]))), 2)}
    stats["correlation"] = corr
    log("correlation", json.dumps(corr))

    # ---- C. AquaMaps
    aq = load_aquamaps()

    # ---- write grids
    layers = {}

    def put(key: str, q: np.ndarray, g: dict, meta: dict) -> None:
        raw = planes(q)
        (OUT / "grid" / f"{key}.bin").write_bytes(raw)
        layers[key] = {"file": f"grid/{key}.bin", "grid": g["name"], "dtype": f"uint{q.dtype.itemsize * 8}",
                       "bytes": len(raw), **meta}

    put("records_gh4", np.clip(rec_f, 0, 2 ** 32 - 1).astype(np.uint32), FINE,
        {"value": "OBIS occurrence records in the cell (all taxonomic ranks); 0 = none", "source": "OBIS API occurrence/grid/4"})
    put("ocean_gh4", np.rint(oc_f * 255).astype(np.uint8), FINE, {"value": "ocean share of the cell = q / 255 (0 = land)"})
    put("species_gh4", np.clip(sp_f, 0, 65535).astype(np.uint16), FINE,
        {"value": "species recorded in the cell (OBIS speciesgrids, OBIS + GBIF); 0 = none"})
    put("records_gh3", np.clip(rec_c, 0, 2 ** 32 - 1).astype(np.uint32), COARSE, {"value": "OBIS records (sum of gh4)"})
    put("ocean_gh3", np.rint(oc_c * 255).astype(np.uint8), COARSE, {"value": "ocean share = q / 255"})
    put("species_gh3", sp_c.astype(np.uint16), COARSE, {"value": "species recorded (speciesgrids); 0 = none"})
    put("species_fish_gh3", sp_fish_c.astype(np.uint16), COARSE, {"value": "fish species recorded (speciesgrids)"})
    put("records_sg_gh3", np.clip(n_sg, 0, 2 ** 32 - 1).astype(np.uint32), COARSE,
        {"value": "species-level records in speciesgrids (OBIS + GBIF), the N behind ES50"})
    for key, v in (("es50_gh3", es_all), ("es50_fish_gh3", es_fish)):
        put(key, np.where(np.isfinite(v), np.rint(v * 100) + 1, 0).clip(0, 65535).astype(np.uint16), COARSE,
            {"value": "ES50 = (q - 1) / 100; q = 0: fewer than 50 records (not enough data)"})
    put("aquamaps_richness", aq.astype(np.uint16), AQ,
        {"value": "AquaMaps predicted number of species (probability > 0.5); 0 = no prediction (land or outside)"})

    # ---- groups
    groups_index = group_products(sg, nC)

    # ---- click lists
    cells_info = click_lists(sg, rec_c, sp_c, es_all)

    # ---- comparisons and spot checks
    stats["regions"] = region_compare(sp_c, es_all, rec_c, aq)
    stats["spotChecks"] = spot_checks()
    stats["spotChecks"]["richestCells"] = richest(sp_c, es_all, rec_c, aq)

    manifest = {
        "title": "Marine life (OBIS)",
        "generated": time.strftime("%Y-%m-%d"),
        "grids": {g["name"]: {"ncol": g["ncol"], "nrow": g["nrow"], "dlon": g["dlon"], "dlat": g["dlat"],
                              "west": -180, "north": 90, "rowOrder": "row 0 = north", "colOrder": "col 0 = 180 W"}
                  for g in (FINE, COARSE, AQ)},
        "encoding": "zlib-deflated little-endian unsigned ints stored as byte planes (all byte-0s, then all byte-1s, ...), "
                    "row-major ncol x nrow",
        "layers": layers,
        "scales": SCALES,
        "groups": groups_index,
        "cells": cells_info,
        "liveApi": {
            "checklist": "https://api.obis.org/v3/checklist?geometry={geohash3}&size=20",
            "statistics": "https://api.obis.org/v3/statistics?geometry={geohash3}",
            "cors": "Access-Control-Allow-Origin: * (checked 2026-11-14 with Origin https://ismoilovdevml.github.io; preflight 204)",
            "note": "checklist results are taxa of all ranks sorted by OBIS record count; filter taxonRank == 'Species'",
        },
        "sources": {
            "obis": {"citation": CITATION_OBIS, "url": "https://obis.org", "api": API,
                     "terms": "OBIS data policy: cite OBIS and, where practical, the datasets; each dataset carries its own "
                              "licence (CC0, CC BY or CC BY-NC)", "snapshot": time.strftime("%Y-%m-%d")},
            "speciesgrids": {"citation": CITATION_SG, "licence": "CC BY-NC 4.0", "build": "20261014",
                             "url": "https://github.com/iobis/speciesgrids"},
            "aquamaps": {"citation": CITATION_AQ, "licence": "CC BY-NC 3.0", "url": "https://www.aquamaps.org",
                         "mirror": AQ_URL,
                         "terms": "non-commercial use; clearly identify maps as coming from AquaMaps with a link back to "
                                  "www.aquamaps.org"},
        },
        "licence": "CC BY-NC 4.0 (most restrictive input: speciesgrids CC BY-NC 4.0, AquaMaps CC BY-NC 3.0)",
        "attribution": f"{ATTR_OBIS} · {ATTR_SG} · {ATTR_AQ}",
        "attributionByLayer": {"records": ATTR_OBIS, "species": ATTR_SG, "es50": ATTR_SG, "aquamaps": ATTR_AQ,
                               "groups": f"{ATTR_OBIS} · {ATTR_SG}"},
        "caveats": CAVEATS,
        "stats": stats,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    log(f"wrote {OUT}: {total / 1e6:.2f} MB")
    return manifest


SCALES = {  # suggested colour scales (also used by the figure)
    "records": {"scale": "log10", "log10Min": 0, "log10Max": 6, "cmap": "matplotlib magma",
                "noRecordsColor": "#3a3f4b", "note": "ocean cells with 0 records drawn in noRecordsColor"},
    "species": {"scale": "log10", "log10Min": 0, "log10Max": 4, "cmap": "matplotlib viridis"},
    "es50": {"scale": "linear", "min": 1, "max": 50, "cmap": "matplotlib viridis",
             "maskedColor": "#3a3f4b", "maskedLabel": "fewer than 50 records: not enough data"},
    "aquamaps": {"scale": "log10", "log10Min": 1, "log10Max": 4, "cmap": "matplotlib viridis",
                 "note": "median ocean cell ~325 species, 95th percentile ~1,200, Coral Triangle up to ~9,900"},
    "groupRecords": {"scale": "log10", "log10Min": 0, "log10Max": 5},
}

CAVEATS = [
    "Sampling bias: records and raw species counts show where people looked (coasts, rich countries, research "
    "stations, shipping lanes) as much as where species live. Records and species per cell correlate strongly (see stats).",
    "ES50 corrects for the number of records, not for where sampling happened or which groups were sampled: a cell "
    "sampled only for plankton or only for birds gets the ES50 of that group. Cells with fewer than 50 records have no ES50.",
    "speciesgrids merges OBIS and GBIF records; datasets published to both can be counted twice, and GBIF bird "
    "observations (eBird) make up a large share of coastal records.",
    "Taxonomy follows the World Register of Marine Species at build time; names change (synonyms are merged into the "
    "accepted name), and misidentified or mislocated records are not removed beyond OBIS quality flags.",
    "Records include museum specimens and observations from 1700s to 2026; a record is not proof the species lives "
    "there today. Absence of records is not absence of species.",
    "AquaMaps richness is a model (environmental envelopes + expert ranges), not observations; it is smooth by "
    "construction and excludes species with fewer than 10 good occurrence cells.",
]


def load_aquamaps() -> np.ndarray:
    import csv
    a = np.zeros((AQ["nrow"], AQ["ncol"]), np.int64)
    with open(AQ_CSV, newline="") as f:
        rd = csv.reader(f)
        head = next(rd)
        assert head == ["C-Square Code", "Latitude", "Longitude", "Species Count"], head
        n = 0
        for _code, lat, lon, cnt in rd:
            r, c = latlon_to_rc(AQ, float(lat), float(lon))
            assert a[r, c] == 0, ("duplicate C-square", lat, lon)
            a[r, c] = int(cnt)
            n += 1
    log(f"AquaMaps: {n:,} half-degree cells, max {a.max():,} species")
    return a


def coarse_api(name: str) -> np.ndarray:
    d = api_get("occurrence/grid/3", {}, name)   # cached by fetch_api
    return grid_features_to_array(d["features"], COARSE)


def group_products(sg: dict, nC: int) -> list[dict]:
    (OUT / "groups").mkdir(exist_ok=True)
    index = []
    cidx, aphia = sg["cs_cidx"].astype(np.int64), sg["cs_aphia"]
    for gid, title, taxa, extra, note in GROUPS:
        chk = api_get("checklist", {"taxonid": taxa, "size": 5000, **extra}, f"checklist_{gid}")
        st = api_get("statistics", {"taxonid": taxa, **extra}, f"statistics_{gid}")
        spp = [r for r in chk["results"] if r.get("taxonRank") == "Species"]
        spp.sort(key=lambda r: -r.get("records", 0))
        deep = {}
        if gid == "deepfish":
            deep = deep_share_stats()
            checked = [r for r in spp if r["taxonID"] in deep]
            shallow = [r for r in checked if deep[r["taxonID"]] < DEEP_MIN_SHARE]
            extra_stats = {"checkedSpecies": len(checked), "flaggedMostlyShallow": len(shallow),
                           "recordsOfFlagged": sum(r["records"] for r in shallow),
                           "flaggedExamples": [r["scientificName"] for r in shallow[:8]]}
            spp = [r for r in spp if deep.get(r["taxonID"], 1.0) >= DEEP_MIN_SHARE]
        top = spp[:TOP_SPECIES]
        common = fetch_vernaculars([(r["taxonID"], r["scientificName"]) for r in top])
        rec = coarse_api(f"grid3_{gid}")
        if gid == "deepfish" and shallow:
            # remove the records of species flagged "mostly shallow" (one extra grid request for those species)
            ids = ",".join(str(r["taxonID"]) for r in shallow)
            d = api_get("occurrence/grid/3", {"taxonid": ids, "startdepth": 1000}, "grid3_deepfish_flagged")
            flagged = grid_features_to_array(d["features"], COARSE)
            assert (flagged <= rec).all()
            extra_stats["recordsRemovedFromGrid"] = int(flagged.sum())
            rec = rec - flagged
        has_species = not extra    # speciesgrids has no depth: no per-cell species for depth-filtered groups
        if has_species:
            ids = np.array([r["taxonID"] for r in spp], np.int64)
            m = np.isin(aphia, ids)
            sp = np.bincount(cidx[m], minlength=nC).reshape(COARSE["nrow"], COARSE["ncol"])
        else:
            sp = np.zeros_like(rec)
        rows, cols = np.nonzero((rec > 0) | (sp > 0))
        data = [[int(c), int(r), int(rec[r, c]), int(sp[r, c])] for r, c in zip(rows, cols)]
        doc = {
            "id": gid, "title": title, "taxa": note, "obisTaxonId": taxa, "filters": extra,
            "grid": "gh3",
            "stats": {"records": st["records"], "species": st["species"], "datasets": st["datasets"],
                      "yearRange": st["yearrange"], "cellsWithRecords": int((rec > 0).sum()),
                      "recordsOnGrid": int(rec.sum()), **(extra_stats if deep else {})},
            "top": [{"aphiaId": r["taxonID"], "name": r["scientificName"], "common": common.get(r["taxonID"], ""),
                     "records": r["records"], "iucn": r.get("category"),
                     **({"deepShare": round(deep[r["taxonID"]], 3)} if r["taxonID"] in deep else {})} for r in top],
            "cells": {"fields": ["col", "row", "records", "species"], "data": data,
                      "note": "records: OBIS API (OBIS only); species: speciesgrids (OBIS + GBIF), species of the group "
                              "known to OBIS" + ("" if has_species else "; species per cell not available for this "
                                                                     "group (depth filter), 0")},
            "source": ATTR_OBIS if not has_species else f"{ATTR_OBIS} · {ATTR_SG}",
        }
        f = OUT / "groups" / f"{gid}.json"
        f.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
        index.append({"id": gid, "title": title, "taxa": note, "file": f"groups/{gid}.json", "bytes": f.stat().st_size,
                      "records": st["records"], "species": st["species"], "cells": len(data),
                      "speciesPerCell": has_species, "topSpecies": top[0]["scientificName"] if top else None})
        log(f"  group {gid}: {st['records']:,} records, {st['species']} species, {len(data)} cells, top "
            f"{[t['scientificName'] for t in top[:3]]}")
    (OUT / "groups" / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))
    return index


def click_lists(sg: dict, rec_c: np.ndarray, sp_c: np.ndarray, es: np.ndarray) -> dict:
    """cells/<geohash2>.json: for each geohash-3 cell in that block, OBIS records, species, ES50 and the top species."""
    d = OUT / "cells"
    d.mkdir(exist_ok=True)
    for f in d.glob("*.json"):
        f.unlink()
    name = dict(zip(sg["n_aphia"].tolist(), sg["n_species"].tolist()))
    cidx, aphia, rec = sg["cs_cidx"].astype(np.int64), sg["cs_aphia"], sg["cs_rec"]
    order = np.lexsort((-rec, cidx))
    cidx, aphia, rec = cidx[order], aphia[order], rec[order]
    starts = np.r_[0, np.nonzero(np.diff(cidx))[0] + 1]
    ends = np.r_[starts[1:], len(cidx)]
    top = {int(cidx[s]): [[int(aphia[k]), name.get(int(aphia[k]), "?"), int(rec[k])] for k in range(s, min(e, s + CELL_TOP))]
           for s, e in zip(starts, ends)}
    blocks: dict[str, dict] = {}
    nrow, ncol = COARSE["nrow"], COARSE["ncol"]
    for r in range(nrow):
        for c in range(ncol):
            k = r * ncol + c
            if rec_c[r, c] == 0 and sp_c[r, c] == 0:
                continue
            lat, lon = cell_center(COARSE, r, c)
            g3 = gh_encode(lat, lon, 3)
            blocks.setdefault(g3[:2], {})[g3] = {
                "r": int(rec_c[r, c]), "s": int(sp_c[r, c]),
                "e": None if not np.isfinite(es[r, c]) else round(float(es[r, c]), 1),
                "top": top.get(k, [])}
    nbytes = 0
    for g2, cells in blocks.items():
        f = d / f"{g2}.json"
        f.write_text(json.dumps(cells, separators=(",", ":"), ensure_ascii=False))
        nbytes += f.stat().st_size
    log(f"  click lists: {sum(len(v) for v in blocks.values()):,} cells in {len(blocks)} files, {nbytes / 1e6:.2f} MB")
    return {"dir": "cells/", "file": "cells/{geohash2}.json", "key": "geohash-3 of the cell (precision 3)",
            "fields": {"r": "OBIS records (API)", "s": "species recorded (speciesgrids)", "e": "ES50 or null",
                       "top": f"up to {CELL_TOP} species with most records: [AphiaID, name, records (speciesgrids, OBIS + GBIF)]"},
            "files": len(blocks), "bytes": nbytes,
            "speciesUrl": "https://www.marinespecies.org/aphia.php?p=taxdetails&id={AphiaID}",
            "obisTaxonUrl": "https://obis.org/taxon/{AphiaID}"}


REGION_BOXES = {  # lon0, lat0, lon1, lat1
    "North Sea": (-4, 51, 9, 61),
    "Western Mediterranean": (-5, 35, 15, 44),
    "Coral Triangle": (115, -10, 135, 8),
    "Great Barrier Reef": (142, -25, 154, -10),
    "Caribbean": (-88, 9, -60, 22),
    "Central North Pacific gyre": (-160, 10, -130, 30),
    "Southern Ocean (Indian sector)": (30, -65, 120, -50),
}


def box_mask(g: dict, box) -> np.ndarray:
    lat = 90 - (np.arange(g["nrow"]) + 0.5) * g["dlat"]
    lon = -180 + (np.arange(g["ncol"]) + 0.5) * g["dlon"]
    return ((lat[:, None] >= box[1]) & (lat[:, None] <= box[3]) & (lon[None, :] >= box[0]) & (lon[None, :] <= box[2]))


def region_compare(sp_c, es, rec_c, aq) -> dict:
    oc_c = ocean_fraction(COARSE) > 0.5
    out = {}
    for name, box in REGION_BOXES.items():
        m = box_mask(COARSE, box) & oc_c
        ma = box_mask(AQ, box) & (aq > 0)
        e = es[m][np.isfinite(es[m])]
        out[name] = {"box": box, "cells": int(m.sum()),
                     "medianRecords": float(np.median(rec_c[m])),
                     "medianSpecies": float(np.median(sp_c[m])),
                     "medianES50": round(float(np.median(e)), 1) if e.size else None,
                     "cellsWithES50": int(e.size),
                     "medianAquaMaps": float(np.median(aq[ma])) if ma.any() else None}
    for key in ("medianRecords", "medianSpecies", "medianES50", "medianAquaMaps"):
        ranked = sorted((v[key] for v in out.values() if v[key] is not None), reverse=True)
        for v in out.values():
            v[key.replace("median", "rank")] = ranked.index(v[key]) + 1 if v[key] is not None else None
    return out


def richest(sp_c, es, rec_c, aq, n: int = 10) -> dict:
    out = {}
    for key, a, g in (("bySpecies", sp_c.astype(float), COARSE), ("byES50", np.nan_to_num(es, nan=-1), COARSE),
                      ("byAquaMaps", aq.astype(float), AQ)):
        idx = np.argsort(a, axis=None)[::-1][:n]
        rows = []
        for k in idx:
            r, c = divmod(int(k), g["ncol"])
            lat, lon = cell_center(g, r, c)
            item = {"lat": round(lat, 2), "lon": round(lon, 2), "value": round(float(a[r, c]), 1)}
            if g is COARSE:
                item.update(gh3=gh_encode(lat, lon, 3), records=int(rec_c[r, c]), species=int(sp_c[r, c]))
            rows.append(item)
        out[key] = rows
    return out


def spot_checks() -> dict:
    out = {}
    bw = coarse_api("grid3_blue_whale")
    lat = 90 - (np.arange(COARSE["nrow"]) + 0.5) * COARSE["dlat"]
    lon = -180 + (np.arange(COARSE["ncol"]) + 0.5) * COARSE["dlon"]
    tot = bw.sum()
    so = bw[lat < -50].sum()
    nep = bw[(lat >= 20) & (lat <= 60)][:, (lon >= -170) & (lon <= -110)].sum()
    out["blueWhale"] = {"aphiaId": 137090, "records": int(tot), "southernOceanSouthOf50S": int(so),
                        "northeastPacific20to60N170to110W": int(nep), "cells": int((bw > 0).sum())}
    lb = coarse_api("grid3_leatherback")
    w = lb.sum(axis=1)
    cum = np.cumsum(w[::-1]) / w.sum()          # from south
    lat_s = lat[::-1]
    occ = lat[w > 0]
    out["leatherback"] = {"aphiaId": 137209, "records": int(w.sum()), "cells": int((lb > 0).sum()),
                          "northmostCellLat": round(float(occ.max()), 2), "southmostCellLat": round(float(occ.min()), 2),
                          "recordWeightedLat1to99pct": [round(float(lat_s[np.searchsorted(cum, 0.01)]), 2),
                                                        round(float(lat_s[np.searchsorted(cum, 0.99)]), 2)]}
    out["boxes"] = {k: api_get("statistics", {"geometry": v}, f"statistics_box_{k}") for k, v in SPOT_BOXES.items()}
    return out


# --------------------------------------------------------------------------------------------- read back, figure

def read_layer(key: str) -> np.ndarray:
    m = json.loads((OUT / "manifest.json").read_text())
    L = m["layers"][key]
    g = m["grids"][L["grid"]]
    return unplanes((OUT / L["file"]).read_bytes(), (g["nrow"], g["ncol"]), int(L["dtype"][4:]) // 8)


def figure() -> None:
    import cartopy.crs as ccrs
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LogNorm
    m = json.loads((OUT / "manifest.json").read_text())
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.spines.top": False,
                         "axes.spines.right": False, "savefig.dpi": 200, "savefig.bbox": "tight"})
    rec4 = read_layer("records_gh4").astype(float)
    oc4 = read_layer("ocean_gh4") / 255
    sp3 = read_layer("species_gh3").astype(float)
    oc3 = read_layer("ocean_gh3") / 255
    es3 = read_layer("es50_gh3").astype(float)
    rec3 = read_layer("records_gh3").astype(float)
    aq = read_layer("aquamaps_richness").astype(float)
    pc = ccrs.PlateCarree()
    fig = plt.figure(figsize=(13, 12.4))
    grey = "#a9b1bb"   # ocean with no data
    recmap = matplotlib.colors.ListedColormap(matplotlib.colormaps["magma_r"](np.linspace(0.12, 1, 256)))

    def edges(g):
        return (np.linspace(-180, 180, g["ncol"] + 1), np.linspace(90, -90, g["nrow"] + 1))

    def mapax(pos, title):
        ax = fig.add_axes(pos, projection=ccrs.EqualEarth(central_longitude=150))
        ax.set_global()
        ax.set_facecolor("white")
        ax.set_title(title, loc="left", fontsize=10, fontweight="bold")
        return ax

    def land(ax, oc, g):
        lx, ly = edges(g)
        ax.pcolormesh(lx, ly, np.ma.masked_where(oc > 0.02, np.ones_like(oc)), cmap=matplotlib.colors.ListedColormap(["#ece8e0"]),
                      transform=pc, shading="flat", rasterized=True)

    def cbar(im, ax, label, **kw):
        cb = fig.colorbar(im, ax=ax, orientation="horizontal", fraction=0.05, pad=0.02, aspect=45, shrink=0.85, **kw)
        cb.set_label(label, fontsize=8)
        cb.ax.tick_params(labelsize=7)

    g4, g3, ga = m["grids"]["gh4"], m["grids"]["gh3"], m["grids"]["csquare_0p5"]
    st = m["stats"]
    # a: records
    ax = mapax([0.02, 0.70, 0.47, 0.27], "a  OBIS records per cell (~39 × 20 km)")
    land(ax, oc4, g4)
    lx, ly = edges(g4)
    ax.pcolormesh(lx, ly, np.ma.masked_where(~((oc4 > 0) & (rec4 == 0)), np.ones_like(rec4)),
                  cmap=matplotlib.colors.ListedColormap([grey]), transform=pc, shading="flat", rasterized=True)
    im = ax.pcolormesh(lx, ly, np.ma.masked_where(rec4 <= 0, rec4), cmap=recmap, norm=LogNorm(1, 1e6),
                       transform=pc, shading="flat", rasterized=True)
    gap = st["dataGap"]["gh4"]
    cbar(im, ax, f"records (log); grey = ocean with no record: {gap['lt1']:.0%} of ocean area, "
                 f"< 50 records: {gap['lt50']:.0%}")
    # b: species
    ax = mapax([0.51, 0.70, 0.47, 0.27], "b  Species recorded per 1.4° cell (raw count)")
    land(ax, oc3, g3)
    lx, ly = edges(g3)
    ax.pcolormesh(lx, ly, np.ma.masked_where(~((oc3 > 0) & (sp3 == 0)), np.ones_like(sp3)),
                  cmap=matplotlib.colors.ListedColormap([grey]), transform=pc, shading="flat", rasterized=True)
    im = ax.pcolormesh(lx, ly, np.ma.masked_where(sp3 <= 0, sp3), cmap="viridis", norm=LogNorm(1, 1e4),
                       transform=pc, shading="flat", rasterized=True)
    cbar(im, ax, "species (log; grey = none recorded): shows where people sampled as much as where species live")
    # c: ES50
    ax = mapax([0.02, 0.375, 0.47, 0.27], "c  ES50: expected species in 50 random records")
    land(ax, oc3, g3)
    esv = np.where(es3 > 0, (es3 - 1) / 100, np.nan)
    ax.pcolormesh(lx, ly, np.ma.masked_where(~((oc3 > 0) & np.isnan(esv)), np.ones_like(esv)),
                  cmap=matplotlib.colors.ListedColormap([grey]), transform=pc, shading="flat", rasterized=True)
    im = ax.pcolormesh(lx, ly, np.ma.masked_invalid(esv), cmap="viridis", vmin=1, vmax=50, transform=pc,
                       shading="flat", rasterized=True)
    cbar(im, ax, f"ES50 (corrects for the number of records); grey = fewer than 50 records "
                 f"({1 - st['es50']['oceanAreaWithES50']:.0%} of ocean area)")
    # d: AquaMaps
    ax = mapax([0.51, 0.375, 0.47, 0.27], "d  AquaMaps predicted species richness (model, 0.5°)")
    lx, ly = edges(ga)
    oca = ocean_fraction(AQ)
    land(ax, oca, ga)
    im = ax.pcolormesh(lx, ly, np.ma.masked_where(aq <= 0, aq), cmap="viridis", norm=LogNorm(10, 1e4), transform=pc,
                       shading="flat", rasterized=True)
    cbar(im, ax, "species with probability > 0.5 (log; AquaMaps 10/2019): a model, not observations")
    # e: records vs species
    ax = fig.add_axes([0.06, 0.05, 0.38, 0.24])
    ok = (rec3 > 0) & (sp3 > 0)
    ax.hexbin(np.log10(rec3[ok]), np.log10(sp3[ok]), gridsize=60, bins="log", cmap="Greys", mincnt=1)
    c = st["correlation"]["gh3"]
    ax.set_xlabel("log10 OBIS records per 1.4° cell")
    ax.set_ylabel("log10 species per cell")
    ax.set_title(f"e  More records, more species (Spearman ρ = {c['spearman']:.2f}, n = {c['cells']:,})",
                 loc="left", fontsize=10, fontweight="bold")
    # f: regions
    ax = fig.add_axes([0.58, 0.05, 0.39, 0.24])
    reg = st["regions"]
    names = list(reg)
    oc = oc3 > 0.5
    spv, esv2 = sp3[oc], esv[oc]
    aqo = aq[aq > 0]

    def pct(v, arr):
        arr = arr[np.isfinite(arr)]
        return 100 * (arr < v).mean() if v is not None else np.nan

    y = np.arange(len(names))
    for k, (key, arr, col, lab) in enumerate((("medianSpecies", spv, "#9aa0a6", "raw species"),
                                              ("medianES50", esv2, "#1f77b4", "ES50"),
                                              ("medianAquaMaps", aqo, "#2ca02c", "AquaMaps (model)"))):
        ax.barh(y + (k - 1) * 0.27, [pct(reg[n][key], arr) for n in names], height=0.25, color=col, label=lab)
    ax.set_yticks(y, names, fontsize=8)
    ax.invert_yaxis()
    ax.set_xlim(0, 100)
    ax.set_xlabel("percentile of the region's median cell among all ocean cells")
    ax.legend(fontsize=7, loc="lower right", frameon=False)
    ax.set_title("f  Same regions, three measures", loc="left", fontsize=10, fontweight="bold")
    fig.text(0.02, 0.005, "Data: OBIS (2026) www.obis.org; OBIS speciesgrids build 20261014 (OBIS + GBIF, CC BY-NC 4.0); "
                          "AquaMaps 10/2019 (Kaschner et al. 2019, CC BY-NC 3.0). Ocean mask: GEBCO_2026.", fontsize=7, color="#555")
    FIG.parent.mkdir(exist_ok=True)
    fig.savefig(FIG)
    log(f"wrote {FIG}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["fetch-api", "fetch-sg", "fetch-aquamaps", "build", "figure", "all"])
    ap.add_argument("--refresh", action="store_true", help="re-query the OBIS API instead of the cache")
    a = ap.parse_args()
    if a.step in ("fetch-api", "all"):
        fetch_api(a.refresh)
    if a.step in ("fetch-sg", "all"):
        fetch_sg()
    if a.step in ("fetch-aquamaps", "all"):
        fetch_aquamaps()
    if a.step in ("build", "all"):
        m = build()
        print(json.dumps(m["stats"], indent=1))
    if a.step in ("figure", "all"):
        figure()


if __name__ == "__main__":
    main()
