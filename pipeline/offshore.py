"""Offshore infrastructure from OpenStreetMap (ODbL) -> web/public/data/{platforms,pipelines,windfarms}.geojson.

Three Overpass API queries (cached in data/raw/offshore/, --refresh to re-query):
  platforms  nwr[man_made=offshore_platform] + nwr[seamark:type=platform]      (out center)
  pipelines  way[man_made=pipeline][location=underwater]                      (out geom)
  windfarms  nwr[power=plant][plant:source=wind]                              (out center)

"At sea" test, used by all three layers: GEBCO_2026 TID (15") != 0 (not land) AND 1' elevation < 0.
  platforms: kept if any cell of the 3x3 15" neighbourhood is at sea (tolerates coastline offsets);
  pipelines: an underwater way is kept if at least one vertex is at sea (drops river crossings);
  windfarms: OSM has no reliable offshore tag, so a wind plant is offshore when its centre is at sea
             AND inside an EEZ polygon (TID is not 0 on some polders and marshes).
Country = Marine Regions World EEZ v12 polygon containing the point (data/raw/regions/eez, fetched by
pipeline/regions.py), else the nearest one within 0.1 deg; none inside the Caspian or internal waters.

Why OSM and not the preferred sources (checked 2026-11-14):
  Global Fishing Watch / SkyTruth offshore infrastructure (Sentinel-1/2 detections) needs a GFW account
  token (the download API answers 401 without one); Global Energy Monitor trackers (gas/oil
  infrastructure, wind power) are behind a download request form.
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import gzip
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from scipy.spatial import cKDTree
from shapely import STRtree
from shapely.geometry import LineString, MultiLineString, Point, shape
from shapely.ops import linemerge

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/offshore"
ELEV = ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif"
TID = ROOT / "data/raw/gebco_2026/gebco_2026_tid.tif"
EEZ_DIR = ROOT / "data/raw/regions/eez"
OUT = ROOT / "web/public/data"
# Overpass instances, tried in order (OVERPASS_URLS, comma-separated, overrides). The main one is often at capacity
# and the mirrors come and go: a tiny probe query picks one that answers before the real query is sent to it.
OVERPASS_URLS = [u for u in os.environ.get("OVERPASS_URLS", "").split(",") if u] or [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
OVERPASS = OVERPASS_URLS[0]
PROBE = '[out:json][timeout:10];node(1);out ids;'
PROBE_TIMEOUT = 30
# Client read timeout for one real query, and the server-side [timeout:N] it is sent with (never above this).
# Observed: the four layers answer in 50-100 s each, processing included (refresh run 2026-11-16).
QUERY_TIMEOUT = 300
MIN_QUERY_S = 60  # do not start a query with less time than this left before the deadline
# rounds over all instances, and the pause before each next round (seconds)
ROUND_WAITS = [0, 120, 300]
# Unix time after which no new Overpass request starts (set by refresh_overlays.py for all its Overpass layers
# together, so a slow Overpass cannot use up the workflow's time). Unset: no deadline.
DEADLINE_ENV = "OVERPASS_DEADLINE"
# A complete answer has thousands of elements; far fewer is a broken mirror, so the next instance is tried.
MIN_ELEMENTS = {"platforms": 1000, "pipelines": 500, "windfarms": 100, "cables": 100}
UNAVAILABLE = 75  # exit status (EX_TEMPFAIL) when no Overpass instance answered: the caller keeps the old file


class OverpassUnavailable(SystemExit):
    """No Overpass instance answered after every round; exits with status UNAVAILABLE when not caught."""

    def __init__(self, msg: str):
        print(f"  {msg}", file=sys.stderr)
        super().__init__(UNAVAILABLE)
        self.msg = msg
UA = "seafloor-atlas-data-prep/0.1 (open-data ocean map; https://github.com/ismoilovdevml/seafloor-atlas)"
YEAR_NOW: int | None = None   # None = the current UTC year; set an int to pin it (tests)


def year_now() -> int:
    return YEAR_NOW if YEAR_NOW is not None else dt.datetime.now(dt.timezone.utc).year


def wind_status(tags: dict, start_year: int | None, now: int | None = None) -> str:
    """'construction' if construction=* is set or the start year is after the current year, else 'operating'."""
    now = year_now() if now is None else now
    return "construction" if (tags.get("construction") or (start_year and start_year > now)) else "operating"

QUERIES = {
    "platforms": '[out:json][timeout:600];(nwr["man_made"="offshore_platform"];nwr["seamark:type"="platform"];);'
                 "out center tags;",
    "pipelines": '[out:json][timeout:600];way["man_made"="pipeline"]["location"="underwater"];out geom tags;',
    "windfarms": '[out:json][timeout:600];nwr["power"="plant"]["plant:source"="wind"];out center tags;',
}
CACHE = {"platforms": "osm_platforms.json", "pipelines": "osm_pipelines_underwater.json",
         "windfarms": "osm_wind_plants.json"}
META_COMMON = {"licence": "ODbL 1.0", "licenceUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
               "attribution": "© OpenStreetMap contributors (ODbL)"}

HYDROCARBON = {"gas": "gas", "natural_gas": "gas", "oil": "oil", "crude_oil": "oil", "fuel": "oil",
               "petroleum": "oil", "oil;gas": "oil_gas", "gas;oil": "oil_gas", "hydrocarbons": "oil_gas",
               "condensate": "oil_gas", "y-grade": "oil_gas", "catalytic_rich_gas": "gas", "lpg": "gas",
               "lng": "gas", "ngl": "oil_gas", "multiphase": "oil_gas"}


# ---------------------------------------------------------------- fetching / helpers
def _post(url: str, query: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": query}).encode(), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def overpass_answer_ok(body: bytes, min_elements: int = 1) -> str | None:
    """None if body is a complete Overpass JSON answer with at least `min_elements` elements, else why not (a 200
    can still carry a timeout remark, and a mirror with a broken database answers an empty list)."""
    try:
        d = json.loads(body)
    except ValueError:
        return "not JSON (an HTML error page?)"
    if not isinstance(d, dict) or not isinstance(d.get("elements"), list):
        return "no 'elements' in the answer"
    remark = str(d.get("remark", ""))
    if "error" in remark.lower() or "timed out" in remark.lower() or "out of memory" in remark.lower():
        return f"incomplete answer: {remark[:160]}"
    if len(d["elements"]) < min_elements:
        return f"only {len(d['elements'])} elements (expected at least {min_elements})"
    return None


def env_deadline() -> float | None:
    v = os.environ.get(DEADLINE_ENV)
    return float(v) if v else None


def with_server_timeout(query: str, seconds: int) -> str:
    """The query with its [timeout:N] lowered to `seconds` (Overpass schedules short queries more readily)."""
    return re.sub(r"\[timeout:(\d+)\]", lambda m: f"[timeout:{min(int(m.group(1)), seconds)}]", query, count=1)


def overpass_query(query: str, urls: list[str] | None = None, waits: list[int] | None = None,
                   post=_post, sleep=time.sleep, *, min_elements: int = 1, deadline: float | None = None,
                   clock=time.time) -> bytes:
    """The answer to `query` from the first Overpass instance that answers a probe and then the query in full.

    Rounds over every instance with pauses between rounds. Only HTTP 400 (our query's syntax) is raised at once;
    403, 404, 429, 5xx, network errors, timeouts and incomplete or near-empty answers move on to the next instance.
    No request starts after `deadline` (default: env OVERPASS_DEADLINE), and the query's client and server timeouts
    are cut to the time left. Raises OverpassUnavailable when nothing answered in time."""
    urls = urls or OVERPASS_URLS
    waits = ROUND_WAITS if waits is None else waits
    deadline = env_deadline() if deadline is None else deadline

    def left() -> float:
        return math.inf if deadline is None else deadline - clock()

    tried: list[str] = []
    out_of_time = False
    for rnd, wait in enumerate(waits):
        if wait:
            if left() < wait + PROBE_TIMEOUT + MIN_QUERY_S:
                out_of_time = True
                break
            print(f"  no Overpass instance answered; round {rnd + 1} in {wait} s", flush=True)
            sleep(wait)
        for url in urls:
            budget = min(QUERY_TIMEOUT, left() - PROBE_TIMEOUT)
            if budget < MIN_QUERY_S:
                out_of_time = True
                break
            host = urllib.parse.urlparse(url).netloc
            probing = True
            try:
                if overpass_answer_ok(post(url, PROBE, PROBE_TIMEOUT), 0):
                    raise ValueError("probe answer not usable")
                probing = False
                body = post(url, with_server_timeout(query, int(budget)), budget)
                why = overpass_answer_ok(body, min_elements)
                if why:
                    raise ValueError(why)
                print(f"  overpass: {host}", flush=True)
                return body
            except urllib.error.HTTPError as e:
                if e.code == 400 and not probing:
                    raise  # the query itself is wrong: no instance will answer it
                tried.append(f"{host}: HTTP {e.code}")  # 403/404 (mirror moved or blocks us), 429, 5xx
            except Exception as e:  # network down, timeouts, 5xx pages, incomplete answers
                tried.append(f"{host}: {str(e)[:120]}")
        if out_of_time:
            break
    why = "time budget spent" if out_of_time else "unavailable on every instance"
    raise OverpassUnavailable(f"Overpass {why}: " + " | ".join(tried[-len(urls):] or ["no request made"]))


def overpass(layer: str, refresh: bool) -> tuple[list[dict], str]:
    p = RAW / CACHE[layer]
    if refresh or not p.exists():
        body = overpass_query(QUERIES[layer], min_elements=MIN_ELEMENTS.get(layer, 1))
        RAW.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body)
    d = json.loads(p.read_text())
    # "out center" gives no centre for a relation without located members: nothing to place
    els = [e for e in d["elements"] if e["type"] == "way" and "geometry" in e or "center" in e or "lat" in e]
    return els, d["osm3s"]["timestamp_osm_base"]


def lonlat(e: dict) -> tuple[float, float]:
    if "center" in e:
        return e["center"]["lon"], e["center"]["lat"]
    return e["lon"], e["lat"]


class Sea:
    """GEBCO lookups: 1' elevation (in memory) and 15" TID (sampled from the tiled GeoTIFF)."""

    def __init__(self):
        with rasterio.open(ELEV) as s:
            self.elev, self.et = s.read(1), s.transform
        self.tid = rasterio.open(TID)

    def elevation(self, lon, lat) -> np.ndarray:
        r, c = rasterio.transform.rowcol(self.et, lon, lat)
        r = np.clip(np.asarray(r), 0, self.elev.shape[0] - 1)
        c = np.asarray(c) % self.elev.shape[1]
        return self.elev[r, c].astype(int)

    def tid_at(self, lon, lat) -> np.ndarray:
        lon = ((np.asarray(lon, float) + 180) % 360) - 180
        lat = np.clip(np.asarray(lat, float), -89.999, 89.999)
        return np.array([v[0] for v in self.tid.sample(zip(lon, lat))], dtype=int)

    def at_sea(self, lon, lat, neighbourhood: bool = False) -> np.ndarray:
        lon, lat = np.asarray(lon, float), np.asarray(lat, float)
        elev_ok = self.elevation(lon, lat) < 0
        if not neighbourhood:
            return elev_ok & (self.tid_at(lon, lat) != 0)
        d = 15 / 3600
        tid_ok = np.zeros(lon.shape, bool)
        for dx in (-d, 0, d):
            for dy in (-d, 0, d):
                tid_ok |= self.tid_at(lon + dx, lat + dy) != 0
        near = np.zeros(lon.shape, bool)
        for dx in (-1 / 60, 0, 1 / 60):
            for dy in (-1 / 60, 0, 1 / 60):
                near |= self.elevation(lon + dx, lat + dy) < 0
        return tid_ok & near


class EEZ:
    def __init__(self):
        geoms, props = [], []
        for f in sorted(glob.glob(str(EEZ_DIR / "*.geojson.gz"))):
            for ft in json.load(gzip.open(f))["features"]:
                if ft.get("geometry"):
                    geoms.append(shape(ft["geometry"]))
                    props.append(ft["properties"])
        self.geoms, self.props, self.tree = geoms, props, STRtree(geoms)
        print(f"EEZ pieces {len(geoms)}")

    def inside(self, lon: float, lat: float) -> bool:
        return len(self.tree.query(Point(lon, lat), predicate="intersects")) > 0

    def lookup(self, lon: float, lat: float) -> dict | None:
        pt = Point(lon, lat)
        for i in self.tree.query(pt, predicate="intersects"):
            return self.props[i]
        i = self.tree.query_nearest(pt, max_distance=0.1)
        return self.props[i[0]] if len(i) else None

    def fields(self, lon: float, lat: float) -> dict:
        p = self.lookup(lon, lat)
        if not p:
            return {}
        if p.get("pol_type") == "200NM":
            return {"country": p.get("territory1"), "iso": p.get("iso_ter1")}
        return {"country": p.get("geoname")}   # overlapping claim / joint regime


def year_of(s: str | None) -> int | None:
    m = re.search(r"(1[89]\d\d|20\d\d)", s or "")
    return int(m.group(1)) if m else None


def capacity_mw(s: str | None) -> float | None:
    """OSM plant:output:electricity -> MW. A comma or space followed by exactly three digits is a thousands
    separator ("1,200 MW", "1 200 MW"); any other comma is a decimal comma ("7,5 MW")."""
    m = re.match(r"\s*(\d{1,3}(?:[ ,]\d{3})+(?![\d,])|[\d.,]+)\s*(GW|MW|kW)?", s or "", re.I)
    if not m:
        return None
    num = m.group(1)
    num = re.sub(r"[ ,](?=\d{3}(?:[ ,]|$))", "", num) if re.fullmatch(r"\d{1,3}(?:[ ,]\d{3})+", num) else num.replace(",", ".")
    try:
        v = float(num)
    except ValueError:
        return None
    unit = (m.group(2) or "MW").upper()
    return round(v * {"GW": 1000, "MW": 1, "KW": 0.001}[unit], 1)


def clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if v not in (None, "", [])}


def write(name: str, feats: list, meta: dict) -> None:
    p = OUT / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"type": "FeatureCollection", "metadata": {**meta, **META_COMMON}, "features": feats},
                            separators=(",", ":"), ensure_ascii=False))
    print(f"  {name}: {len(feats)} features, {p.stat().st_size / 1e6:.2f} MB")


# ---------------------------------------------------------------- layers
def platform_type(t: dict) -> str:
    if t.get("power") in ("substation", "transformer") or t.get("seamark:platform:category") == "substation" \
            or "wind" in (t.get("name", "") + t.get("operator", "")).lower():
        return "wind"
    sub = (t.get("substance") or "").lower()
    cat = (t.get("seamark:platform:category") or "").lower()
    if sub in HYDROCARBON:
        return HYDROCARBON[sub]
    if cat in ("oil", "gas"):
        return cat
    if cat in ("oil;gas", "production", "fpso", "drilling") or t.get("industrial") in ("oil", "oil_rig", "wellsite"):
        return "oil_gas"
    if cat in ("observation", "research", "accommodation", "island") or t.get("aeroway"):
        return "other"
    return "unknown"


R_EARTH_KM = 6371.0088
DUPLICATE_KM = 0.111  # 0.001 deg of great-circle arc, the north-south radius the old lon/lat metric used


def unit_vectors(lonlat: np.ndarray) -> np.ndarray:
    """(n, 2) lon/lat degrees -> (n, 3) points on the unit sphere (no latitude scaling, no antimeridian seam)."""
    lon, lat = np.radians(lonlat[:, 0]), np.radians(lonlat[:, 1])
    return np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])


def seamark_duplicates(lonlat: np.ndarray, seamark_only: np.ndarray, radius_km: float = DUPLICATE_KM) -> np.ndarray:
    """The same structure is often mapped twice (man_made way + seamark node): flag a seamark-only element when a
    man_made=offshore_platform element lies within `radius_km` great-circle distance. Distances are chords between
    unit vectors, so the radius is the same at every latitude and across the antimeridian (a fixed cos(55 deg)
    longitude scale merged up to 1.7x too far east-west at the equator and too little at high latitude)."""
    drop = np.zeros(len(lonlat), bool)
    if len(lonlat) < 2:
        return drop
    chord = 2 * math.sin(radius_km / R_EARTH_KM / 2)
    for i, j in cKDTree(unit_vectors(np.asarray(lonlat, float))).query_pairs(chord):
        for a, b in ((i, j), (j, i)):
            if seamark_only[a] and not seamark_only[b]:
                drop[a] = True
    return drop


def platforms(sea: Sea, eez: EEZ, refresh: bool) -> None:
    els, ts = overpass("platforms", refresh)
    ll = np.array([lonlat(e) for e in els])
    seamark_only = np.array([e.get("tags", {}).get("man_made") != "offshore_platform" for e in els])
    drop = seamark_duplicates(ll, seamark_only)
    keep = ~drop & sea.at_sea(ll[:, 0], ll[:, 1], neighbourhood=True)
    depth = sea.elevation(ll[:, 0], ll[:, 1])
    feats = []
    for e, (lon, lat), k, z in zip(els, ll, keep, depth):
        if not k:
            continue
        t = e.get("tags", {})
        abandoned = t.get("abandoned") == "yes" or "abandoned:man_made" in t or t.get("disused") == "yes"
        props = clean({"id": f"{e['type'][0]}{e['id']}", "name": t.get("name") or t.get("seamark:name"),
                       "type": platform_type(t), "status": "abandoned" if abandoned else None,
                       "operator": t.get("operator"), "start": t.get("start_date"),
                       **eez.fields(lon, lat), "depth_m": int(-z) if z < 0 else None,
                       "wikidata": t.get("wikidata")})
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]}})
    print(f"platforms: {len(els)} OSM elements, {int(drop.sum())} seamark duplicates, "
          f"{int((~drop & ~keep).sum())} not at sea, kept {len(feats)}")
    write("platforms.geojson", feats, {
        "source": "OpenStreetMap via Overpass: man_made=offshore_platform and seamark:type=platform",
        "osmTimestamp": ts, "note": "type from OSM tags (substance, seamark:platform:category, industrial, power); "
                                    "coverage follows OSM mappers (US Gulf of Mexico from a BOEM-based import; North Sea, Caspian, Persian Gulf well mapped)"})


def geodesic_km(coords) -> float:
    a = np.radians(np.asarray(coords, float))
    lon, lat = a[:, 0], a[:, 1]
    h = np.sin(np.diff(lat) / 2) ** 2 + np.cos(lat[:-1]) * np.cos(lat[1:]) * np.sin(np.diff(lon) / 2) ** 2
    return float((2 * R_EARTH_KM * np.arcsin(np.sqrt(h))).sum())


def pipelines(sea: Sea, eez: EEZ, refresh: bool, tol: float) -> None:
    els, ts = overpass("pipelines", refresh)
    kept, n_sub, n_land, n_short = [], 0, 0, 0
    for e in els:
        t = e.get("tags", {})
        coords = [(p["lon"], p["lat"]) for p in e.get("geometry", []) if p]
        if len(coords) < 2:
            continue
        sub = HYDROCARBON.get((t.get("substance") or "").lower())
        if sub is None and t.get("substance"):
            n_sub += 1                       # water, sewage, ...
            continue
        a = np.array(coords)
        if not sea.at_sea(a[:, 0], a[:, 1]).any():
            n_land += 1
            continue
        km = geodesic_km(coords)
        if sub is None and km < 10:          # unknown substance: drop short outfalls/intakes
            n_short += 1
            continue
        kept.append((e, t, sub or "unknown", coords, km))
    # one feature per named pipeline (+ substance); unnamed ways merged per (substance, operator) and
    # split into connected pieces
    groups: dict[tuple, list] = {}
    for e, t, sub, coords, km in kept:
        name = t.get("name") or t.get("name:en")
        key = (name, sub) if name else (None, sub, t.get("operator"))
        groups.setdefault(key, []).append((e, t, coords, km))
    feats = []
    for key, items in groups.items():
        merged = linemerge([LineString(c) for _, _, c, _ in items])
        parts = list(merged.geoms) if isinstance(merged, MultiLineString) else [merged]
        pieces = [parts] if key[0] else [[p] for p in parts]
        for ps in pieces:
            km = sum(geodesic_km(p.coords) for p in ps)
            simp = [p.simplify(tol, preserve_topology=False) for p in ps]
            geom = [[[round(x, 5), round(y, 5)] for x, y in p.coords] for p in simp if len(p.coords) >= 2]
            t0 = items[0][1]
            # EEZs crossed, in order along the (first) line: sample every ~5 km of the simplified geometry
            crossed = []
            for p in simp:
                n = max(2, int(geodesic_km(p.coords) / 5))
                for k in range(n + 1):
                    q = p.interpolate(k / n, normalized=True)
                    c = eez.fields(q.x, q.y).get("country")
                    if c and c not in crossed:
                        crossed.append(c)
            status = "disused" if any(i[1].get("disused") == "yes" or "disused:man_made" in i[1]
                                      for i in items) else None
            props = clean({"name": key[0], "substance": key[1], "operator": t0.get("operator"),
                           "status": status, "diameter": t0.get("diameter"), "length_km": round(km, 1),
                           "countries": crossed, "osm": sorted({f"w{i[0]['id']}" for i in items})[:20]
                           if key[0] else None, "wikidata": t0.get("wikidata")})
            feats.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "MultiLineString", "coordinates": geom}})
    feats.sort(key=lambda f: -f["properties"]["length_km"])
    print(f"pipelines: {len(els)} underwater ways; {n_sub} other substances, {n_land} never at sea, "
          f"{n_short} unknown-substance < 10 km; kept {len(kept)} ways -> {len(feats)} features, "
          f"{sum(f['properties']['length_km'] for f in feats):.0f} km")
    write("pipelines.geojson", feats, {
        "source": "OpenStreetMap via Overpass: man_made=pipeline + location=underwater, hydrocarbon substances "
                  "(+ unknown substance >= 10 km)", "osmTimestamp": ts,
        "simplifyToleranceDeg": tol, "note": "length_km from the unsimplified OSM geometry; underwater part only"})


def windfarms(sea: Sea, eez: EEZ, refresh: bool) -> None:
    els, ts = overpass("windfarms", refresh)
    ll = np.array([lonlat(e) for e in els])
    # TID is not 0 on some coastal lowland (Dutch polders, German Elbe marshes), so also require the
    # centre to lie inside a Marine Regions EEZ polygon (seaward of the coastline, no nearest fallback)
    off = sea.at_sea(ll[:, 0], ll[:, 1]) & np.array([eez.inside(x, y) for x, y in ll])
    depth = sea.elevation(ll[:, 0], ll[:, 1])
    feats = []
    for e, (lon, lat), o, z in zip(els, ll, off, depth):
        if not o:
            continue
        t = e.get("tags", {})
        y = year_of(t.get("start_date"))
        status = wind_status(t, y)
        props = clean({"id": f"{e['type'][0]}{e['id']}", "name": t.get("name"),
                       "capacity_mw": capacity_mw(t.get("plant:output:electricity")), "status": status,
                       "start": t.get("start_date"), "operator": t.get("operator"),
                       "turbines": t.get("turbines"), **eez.fields(lon, lat), "depth_m": int(-z),
                       "wikidata": t.get("wikidata")})
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]}})
    feats.sort(key=lambda f: -(f["properties"].get("capacity_mw") or 0))
    print(f"windfarms: {len(els)} OSM wind plants, offshore {len(feats)}, "
          f"capacity {sum(f['properties'].get('capacity_mw') or 0 for f in feats) / 1000:.1f} GW")
    write("windfarms.geojson", feats, {
        "source": "OpenStreetMap via Overpass: power=plant + plant:source=wind whose centre is at sea "
                  "(GEBCO TID != land, elevation < 0, inside a Marine Regions EEZ polygon)", "osmTimestamp": ts,
        "note": f"status is a heuristic: construction if start_date is after {year_now()} or construction=* is set"})


def main() -> None:
    global OUT
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-run the Overpass queries")
    ap.add_argument("--only", choices=["platforms", "pipelines", "windfarms"])
    ap.add_argument("--tolerance", type=float, default=0.0005, help="pipeline simplification, degrees")
    ap.add_argument("--out-dir", type=Path, default=OUT,
                    help="where to write the GeoJSON (pipeline/refresh_overlays.py stages and validates here)")
    args = ap.parse_args()
    OUT = args.out_dir
    sea, eez = Sea(), EEZ()
    if args.only in (None, "platforms"):
        platforms(sea, eez, args.refresh)
    if args.only in (None, "pipelines"):
        pipelines(sea, eez, args.refresh, args.tolerance)
    if args.only in (None, "windfarms"):
        windfarms(sea, eez, args.refresh)


if __name__ == "__main__":
    main()
