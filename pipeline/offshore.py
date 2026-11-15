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
import glob
import gzip
import json
import math
import re
import time
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
OVERPASS = "https://overpass-api.de/api/interpreter"
UA = "seafloor-atlas-data-prep/0.1 (open-data ocean map; https://github.com/ismoilovdevml/seafloor-atlas)"
YEAR_NOW = 2026

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
def overpass(layer: str, refresh: bool) -> tuple[list[dict], str]:
    p = RAW / CACHE[layer]
    if refresh or not p.exists():
        req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": QUERIES[layer]}).encode(),
                                     headers={"User-Agent": UA})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=900) as r:
                    body = r.read()
                break
            except Exception as e:
                code = getattr(e, "code", None)
                if attempt == 2 or (code is not None and 400 <= code < 500 and code != 429):
                    raise
                print(f"  overpass failed ({e}); retrying in 60 s")
                time.sleep(60)
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
    m = re.match(r"\s*([\d.,]+)\s*(GW|MW|kW)?", s or "", re.I)
    if not m:
        return None
    try:
        v = float(m.group(1).replace(",", "."))
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


def platforms(sea: Sea, eez: EEZ, refresh: bool) -> None:
    els, ts = overpass("platforms", refresh)
    ll = np.array([lonlat(e) for e in els])
    seamark_only = np.array([e.get("tags", {}).get("man_made") != "offshore_platform" for e in els])
    # the same structure is often mapped twice (man_made way + seamark node): drop a seamark-only
    # element when a man_made=offshore_platform element lies within ~100 m
    tree = cKDTree(ll * [math.cos(math.radians(55)), 1])
    drop = np.zeros(len(els), bool)
    for i, j in tree.query_pairs(0.001):
        for a, b in ((i, j), (j, i)):
            if seamark_only[a] and not seamark_only[b]:
                drop[a] = True
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
    return float((2 * 6371.0088 * np.arcsin(np.sqrt(h))).sum())


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
        status = "construction" if (t.get("construction") or (y and y > YEAR_NOW)) else "operating"
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
        "note": "status is a heuristic: construction if start_date is after 2026 or construction=* is set"})


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
