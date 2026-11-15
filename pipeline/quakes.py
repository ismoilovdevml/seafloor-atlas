"""USGS ComCat earthquakes (public domain) -> web/public/data/quakes.json (columnar, not GeoJSON).

Historical catalogue: every event of type "earthquake" with M >= 5.0 from 1900-01-01 to today, fetched
from the USGS FDSN event web service (https://earthquake.usgs.gov/fdsnws/event/1/query, CSV) one
calendar year per request, so no request comes near the service's 20,000-event limit (the largest
year, 2011, has about 2,900 M5+ events). Raw CSVs are cached in data/raw/quakes/<year>.csv (the
current year is always re-fetched; --refresh re-fetches all).

The browser file keeps M >= OUT_MINMAG (5.5 by default; see docs/data-contract.md for the size
trade-off), sorted by magnitude descending (biggest first, for label priority). It is columnar JSON:
one array per field (lon, lat, time [Unix ms, as in the USGS feeds], mag, depth_km, id, place), which
is 3.2 MB instead of 7.8 MB as GeoJSON for the same 39,650 events; the viewer zips the arrays into
GeoJSON features. Coordinates rounded to 0.01 degree (about 1 km; ComCat epicentre errors are larger
before the 1960s), depth to 1 km.

--update (weekly CI): reads the existing quakes.json, re-queries the FDSN service from
UPDATE_OVERLAP_DAYS before the newest event to now (so recent magnitude/location revisions are
picked up), merges by event id (new rows replace old ones), re-sorts and rewrites. Needs no raw cache.
Events deleted from ComCat and revisions older than the overlap are only picked up by a full rebuild.

Checks (full build only, written to metadata.stats and printed): the three largest instrumental
earthquakes, the share of M >= 6 events within 100 km of a PB2002 plate boundary (any type, and
subduction only) against the share of Earth's surface within the same distance, and the depth vs
distance-from-trench profile of the Tonga slab (Wadati-Benioff zone).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/quakes"
OUT = ROOT / "web/public/data/quakes.json"
COLUMNS = ("lon", "lat", "time", "mag", "depth_km", "id", "place")
PLATES = ROOT / "web/public/data/plates.geojson"
FDSN = "https://earthquake.usgs.gov/fdsnws/event/1/query"
UA = "seafloor-atlas-data-prep/0.1 (open-data ocean map; https://github.com/ismoilovdevml/seafloor-atlas)"
FETCH_MINMAG = 5.0
OUT_MINMAG = 5.5
FIRST_YEAR = 1900
UPDATE_OVERLAP_DAYS = 30
R_KM = 6371.0088

SOURCE = ("U.S. Geological Survey, Earthquake Hazards Program (2017) Advanced National Seismic System (ANSS) "
          "Comprehensive Catalog of Earthquake Events and Products (ComCat), doi:10.5066/F7MS3QZH; FDSN event "
          "web service https://earthquake.usgs.gov/fdsnws/event/1/")
LICENCE = "Public domain (U.S. Government work); USGS asks for acknowledgement"
ATTRIBUTION = "Earthquakes: USGS ANSS ComCat (public domain)"
LIVE_FEEDS = {
    "past_day_all": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
    "past_week_2.5": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson",
    "past_month_2.5": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson",
    "past_month_4.5": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson",
    "past_month_significant": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson",
}


def get(url: str, tries: int = 4) -> str:
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read().decode("utf-8")
        except Exception as e:  # noqa: BLE001 - network: retry then re-raise
            if i == tries - 1:
                raise
            print(f"  retry {i + 1} after {e}")
            time.sleep(5 * (i + 1))
    raise RuntimeError("unreachable")


def query(start: str, end: str, minmag: float) -> list[dict]:
    q = {"format": "csv", "starttime": start, "endtime": end, "minmagnitude": minmag, "orderby": "time-asc",
         "limit": 20000}
    text = get(FDSN + "?" + urllib.parse.urlencode(q))
    rows = list(csv.DictReader(io.StringIO(text)))
    if len(rows) >= 20000:
        raise RuntimeError(f"{start}..{end}: hit the 20,000-event limit, split the window")
    return rows


def fetch_years(refresh: bool) -> list[dict]:
    RAW.mkdir(parents=True, exist_ok=True)
    this_year = dt.datetime.now(dt.timezone.utc).year
    rows: list[dict] = []
    for y in range(FIRST_YEAR, this_year + 1):
        f = RAW / f"{y}.csv"
        if refresh or y == this_year or not f.exists():
            got = query(f"{y}-01-01", f"{y + 1}-01-01", FETCH_MINMAG)
            with f.open("w", newline="") as fh:
                if got:
                    w = csv.DictWriter(fh, fieldnames=list(got[0].keys()))
                    w.writeheader()
                    w.writerows(got)
            print(f"  {y}: {len(got)} events (fetched)")
        with f.open() as fh:
            rows.extend(csv.DictReader(fh))
    return rows


def iso_ms(s: str) -> int:
    return int(round(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000))


def to_feature(r: dict) -> dict | None:
    if r.get("type") != "earthquake" or not r.get("mag"):
        return None
    lon, lat = float(r["longitude"]), float(r["latitude"])
    depth = float(r["depth"]) if r.get("depth") else None
    p = {"id": r["id"], "time": iso_ms(r["time"]), "mag": round(float(r["mag"]), 2),
         "depth_km": None if depth is None else int(round(depth)), "place": r.get("place") or ""}
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 2), round(lat, 2)]},
            "properties": p}


def sort_key(f: dict):
    return (-f["properties"]["mag"], f["properties"]["time"])


def metadata(feats: list[dict], minmag: float, stats: dict | None) -> dict:
    times = [f["properties"]["time"] for f in feats]
    m = {"source": SOURCE, "licence": LICENCE, "attribution": ATTRIBUTION,
         "query": f"{FDSN}?format=csv&minmagnitude={minmag}&eventtype=earthquake (by calendar year)",
         "minmag": minmag, "count": len(feats),
         "first": dt.datetime.fromtimestamp(min(times) / 1000, dt.timezone.utc).isoformat()[:19] + "Z",
         "newest": dt.datetime.fromtimestamp(max(times) / 1000, dt.timezone.utc).isoformat()[:19] + "Z",
         "generated": dt.datetime.now(dt.timezone.utc).isoformat()[:19] + "Z",
         "columns": {"lon": "epicentre longitude, degrees (0.01)", "lat": "epicentre latitude, degrees (0.01)",
                     "time": "origin time, Unix epoch milliseconds UTC", "mag": "preferred magnitude",
                     "depth_km": "hypocentre depth, km, rounded (null if unknown)",
                     "id": "ComCat event id (https://earthquake.usgs.gov/earthquakes/eventpage/<id>)",
                     "place": "USGS region text"},
         "order": "magnitude descending, then time ascending",
         "live_feeds": LIVE_FEEDS}
    if stats:
        m["stats"] = stats
    return m


def write(feats: list[dict], minmag: float, stats: dict | None) -> None:
    feats.sort(key=sort_key)
    doc = {"metadata": metadata(feats, minmag, stats), "n": len(feats)}
    for c in COLUMNS:
        if c in ("lon", "lat"):
            doc[c] = [f["geometry"]["coordinates"][c == "lat"] for f in feats]
        else:
            doc[c] = [f["properties"][c] for f in feats]
    OUT.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {OUT.relative_to(ROOT)}: {len(feats)} events, {OUT.stat().st_size / 1e6:.2f} MB")


# --- analysis ---------------------------------------------------------------------------------------

def unit(lon, lat):
    lon, lat = np.radians(lon), np.radians(lat)
    return np.c_[np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)]


def gc_km(chord):
    return 2 * R_KM * np.arcsin(np.clip(chord / 2, 0, 1))


def boundary_points(types: set[str] | None = None, boundary: str | None = None, step_km: float = 2.0):
    """Densified boundary vertices (lon, lat) so nearest-vertex distance is within step/2 of the line distance."""
    plates = json.loads(PLATES.read_text())
    pts, kinds = [], []
    for f in plates["features"]:
        pr = f["properties"]
        if types and pr["type"] not in types:
            continue
        if boundary and pr["boundary"] != boundary:
            continue
        g = f["geometry"]
        lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for c in lines:
            for (x0, y0), (x1, y1) in zip(c, c[1:]):
                dx = (x1 - x0 + 540) % 360 - 180
                km = math.hypot(dx * math.cos(math.radians((y0 + y1) / 2)), y1 - y0) * 111.2
                n = max(1, math.ceil(km / step_km))
                t = np.arange(n) / n
                pts.append(np.c_[x0 + dx * t, y0 + (y1 - y0) * t])
                kinds += [pr["type"]] * n
            pts.append(np.array([c[-1]]))
            kinds.append(pr["type"])
    return np.vstack(pts), np.array(kinds)


def dist_to(tree: cKDTree, lon, lat):
    d, i = tree.query(unit(lon, lat))
    return gc_km(d), i


def analyse(feats: list[dict]) -> dict:
    lon = np.array([f["geometry"]["coordinates"][0] for f in feats])
    lat = np.array([f["geometry"]["coordinates"][1] for f in feats])
    mag = np.array([f["properties"]["mag"] for f in feats])
    dep = np.array([np.nan if f["properties"]["depth_km"] is None else f["properties"]["depth_km"] for f in feats])
    stats: dict = {}

    # spot checks: largest events by id-independent search (time window + magnitude)
    checks = {"1960 Valdivia, Chile": ("1960-05-22", -38.1, -73.4), "2004 Sumatra-Andaman": ("2004-12-26", 3.3, 95.9),
              "2011 Tohoku, Japan": ("2011-03-11", 38.3, 142.4), "1964 Alaska": ("1964-03-28", 60.9, -147.3)}
    spot = {}
    for name, (day, la, lo) in checks.items():
        t0 = iso_ms(day + "T00:00:00Z")
        c = [f for f in feats if t0 <= f["properties"]["time"] < t0 + 86400000
             and abs(f["geometry"]["coordinates"][1] - la) < 3 and abs(f["geometry"]["coordinates"][0] - lo) < 3]
        if c:
            b = max(c, key=lambda f: f["properties"]["mag"])
            spot[name] = {**b["properties"], "lon": b["geometry"]["coordinates"][0], "lat": b["geometry"]["coordinates"][1]}
        else:
            spot[name] = None
    stats["spot_checks"] = spot
    stats["top10"] = [{"mag": f["properties"]["mag"], "place": f["properties"]["place"],
                       "date": dt.datetime.fromtimestamp(f["properties"]["time"] / 1000, dt.timezone.utc).date().isoformat()}
                      for f in sorted(feats, key=sort_key)[:10]]

    # plate boundaries: M >= 6
    all_pts, btype = boundary_points()
    sub_pts, _ = boundary_points({"subduction"})
    t_all, t_sub = cKDTree(unit(all_pts[:, 0], all_pts[:, 1])), cKDTree(unit(sub_pts[:, 0], sub_pts[:, 1]))
    m6 = mag >= 6
    d_all, i_all = dist_to(t_all, lon[m6], lat[m6])
    d_sub, _ = dist_to(t_sub, lon[m6], lat[m6])
    rng = np.random.default_rng(0)
    v = rng.normal(size=(400000, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    base_all = gc_km(t_all.query(v)[0])
    base_sub = gc_km(t_sub.query(v)[0])
    near = d_all <= 100
    far_deep = float((dep[m6][~near] > 70).mean())
    types, counts = np.unique(btype[i_all[near]], return_counts=True)
    stats["plate_boundaries"] = {
        "events_m6": int(m6.sum()),
        "within_100km_any": round(float(near.mean()), 4),
        "within_100km_subduction": round(float((d_sub <= 100).mean()), 4),
        "within_200km_any": round(float((d_all <= 200).mean()), 4),
        "earth_area_within_100km_any": round(float((base_all <= 100).mean()), 4),
        "earth_area_within_100km_subduction": round(float((base_sub <= 100).mean()), 4),
        "nearest_type_of_events_within_100km": {str(k): int(n) for k, n in zip(types, counts)},
        "median_distance_km": round(float(np.median(d_all)), 1),
        "beyond_100km_share_deeper_70km": round(far_deep, 4),
        "method": "great-circle distance to PB2002 lines in plates.geojson densified to <= 2 km; Earth area share "
                  "from 400,000 uniform random points on the sphere",
    }

    # Tonga slab: events between 26 S and 15 S, 176 E to 172 W
    lon360 = np.where(lon < 0, lon + 360, lon)
    sel = (lat >= -26) & (lat <= -15) & (lon360 >= 176) & (lon360 <= 188) & np.isfinite(dep)
    tr, _ = boundary_points({"subduction"}, boundary="TO/PA")
    t_tr = cKDTree(unit(tr[:, 0], tr[:, 1]))
    d_tr, i_tr = dist_to(t_tr, lon[sel], lat[sel])
    tr360 = np.where(tr[:, 0] < 0, tr[:, 0] + 360, tr[:, 0])
    sign = np.where(lon360[sel] < tr360[i_tr], 1.0, -1.0)  # west of the trench (towards Fiji) = positive
    x, z = d_tr * sign, dep[sel]
    deep = (z >= 100) & (x > 0)
    slope, icpt = np.polyfit(x[deep], z[deep], 1)
    bins = [0, 70, 300, 500, 800]
    prof = []
    for a, b in zip(bins, bins[1:]):
        k = (z >= a) & (z < b)
        if k.any():
            prof.append({"depth_km": f"{a}-{b}", "n": int(k.sum()), "median_dist_from_trench_km": round(float(np.median(x[k])), 0)})
    stats["tonga_slab"] = {
        "region": "15-26 S, 176 E-172 W", "events": int(sel.sum()), "deepest_km": float(np.nanmax(z)),
        "events_deeper_300km": int((z >= 300).sum()),
        "fit_depth_vs_distance_100km_plus": {"slope_km_per_km": round(float(slope), 3),
                                             "apparent_dip_deg": round(math.degrees(math.atan(slope)), 1),
                                             "intercept_km": round(float(icpt), 1)},
        "by_depth": prof,
        "method": "horizontal distance to the nearest PB2002 TO/PA subduction vertex, positive west (overriding side)",
    }
    stats["tonga_profile"] = {"x_km": np.round(x, 0).astype(int).tolist(), "depth_km": np.round(z, 0).astype(int).tolist(),
                              "mag": mag[sel].tolist()}
    return stats


def build(refresh: bool, minmag: float) -> None:
    rows = fetch_years(refresh)
    seen, feats, other = set(), [], {}
    for r in rows:
        if r.get("id") in seen:
            continue
        seen.add(r.get("id"))
        f = to_feature(r)
        if f is None:
            other[r.get("type")] = other.get(r.get("type"), 0) + 1
            continue
        feats.append(f)
    print(f"{len(rows)} rows M>={FETCH_MINMAG}; {len(feats)} earthquakes; other types dropped: {other}")
    stats = analyse(feats)
    mags = np.array([f["properties"]["mag"] for f in feats])
    stats["counts"] = {"m5_all": len(feats), "m5_5": int((mags >= 5.5).sum()), "m6": int((mags >= 6).sum()),
                       "m7": int((mags >= 7).sum()), "m8": int((mags >= 8).sum()), "other_types_dropped": other}
    years = np.array([dt.datetime.fromtimestamp(f["properties"]["time"] / 1000, dt.timezone.utc).year for f in feats])
    stats["per_decade_m6"] = {int(d): int(((years // 10 * 10) == d)[mags >= 6].sum()) for d in range(1900, 2030, 10)}
    prof = stats.pop("tonga_profile")
    derived = ROOT / "data/derived"
    derived.mkdir(parents=True, exist_ok=True)
    (derived / "quakes_stats.json").write_text(json.dumps({**stats, "tonga_profile": prof}, indent=1))
    keep = [f for f in feats if f["properties"]["mag"] >= minmag]
    write(keep, minmag, stats)
    print(json.dumps({k: v for k, v in stats.items() if k != "top10"}, indent=1))


def read_out() -> tuple[dict, list[dict]]:
    doc = json.loads(OUT.read_text())
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [doc["lon"][i], doc["lat"][i]]},
              "properties": {c: doc[c][i] for c in ("id", "time", "mag", "depth_km", "place")}} for i in range(doc["n"])]
    return doc["metadata"], feats


def update() -> None:
    meta, old = read_out()
    minmag = meta["minmag"]
    stats = meta.get("stats")
    by_id = {f["properties"]["id"]: f for f in old}
    newest = max(f["properties"]["time"] for f in old)
    start = dt.datetime.fromtimestamp(newest / 1000, dt.timezone.utc) - dt.timedelta(days=UPDATE_OVERLAP_DAYS)
    end = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)
    rows = query(start.strftime("%Y-%m-%dT%H:%M:%S"), end.strftime("%Y-%m-%d"), minmag)
    added = changed = 0
    for r in rows:
        f = to_feature(r)
        if f is None:
            continue
        old = by_id.get(f["properties"]["id"])
        if old is None:
            added += 1
        elif old != f:
            changed += 1
        by_id[f["properties"]["id"]] = f
    # an event revised below the threshold within the overlap window drops out
    feats = [f for f in by_id.values() if f["properties"]["mag"] >= minmag]
    print(f"update from {start.isoformat()[:19]}Z: {len(rows)} rows, {added} new, {changed} revised")
    write(feats, minmag, stats)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true", help="only fetch events since the newest one in quakes.json")
    ap.add_argument("--refresh", action="store_true", help="re-fetch every year (full build)")
    ap.add_argument("--minmag", type=float, default=OUT_MINMAG, help="smallest magnitude kept in the browser file")
    a = ap.parse_args()
    update() if a.update else build(a.refresh, a.minmag)


if __name__ == "__main__":
    main()
