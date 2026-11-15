"""Submarine telecom cables from OpenStreetMap (ODbL) -> web/public/data/cables-osm.geojson + docs/cables-osm.md.

A supplement to the TeleGeography layer (pipeline/cables.py), whose open data is frozen at 2022-11-14.

One Overpass query (cached in data/raw/offshore/osm_cables_telecom.json, --refresh to re-query), out geom:
  way[communication=line]   + location=underwater|submarine, or submarine=yes, or seamark:type=cable_submarine
  way[telecom=line]         + location=underwater|submarine
  way[seamark:type=cable_submarine] + seamark:cable_submarine:category = telephone|fibre_optic|...
Tagging checked on taginfo and with Overpass counts on 2026-11-15: communication=line is the telecom key
(telecom=line is almost unused); seamark:type=cable_submarine is the nautical-chart key and carries power
cables too, so a seamark cable counts only with a telecom category. Excluded: power=cable and the power /
transmission categories; seamark cables with no category (about 5,700 ways, mostly a Finnish fairway
import, cannot be told apart from power cables).

Kept when at least one vertex is at sea (the GEBCO test of pipeline/offshore.py: TID != land and 1'
elevation < 0), so lake and river crossings drop out. Ways with the same name are merged into one feature;
unnamed ways are line-merged per operator into connected pieces and kept from 1 km. Simplified with a
0.0005 deg tolerance, coordinates rounded to 1e-5 deg.

Matching to the 2022 snapshot (web/public/data/cables.geojson): names are normalised (accents, case,
punctuation, "cable system" / "submarine cable" words, segment / branch / direction suffixes dropped,
parenthesised acronyms tried on their own) and compared exactly. A cable that is not in the snapshot is
"newer" only when its OSM start_date is after 2022-11-14; otherwise it may be retired before 2022 (TAT-10,
PTAT), domestic, or just named differently, and the report says so.

OSM mappers rarely draw long-haul cables (their routes are not verifiable on the ground), so this layer is
mostly coastal and North Sea / Baltic cables from nautical charts; see docs/cables-osm.md for the numbers.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge

sys.path.insert(0, str(Path(__file__).resolve().parent))
import offshore  # noqa: E402  (shared Overpass client, GEBCO "at sea" test, geodesic length)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web/public/data/cables-osm.geojson"
REPORT = ROOT / "docs/cables-osm.md"
TG = ROOT / "web/public/data/cables.geojson"
SNAPSHOT_DATE = "2022-11-14"
TOLERANCE = 0.0005
MIN_UNNAMED_KM = 1.0

TELECOM_CATS = {"telephone", "telecommunication", "telecom", "fibre_optic", "fiber_optic", "communication",
                "telegraph", "data"}
POWER_CATS = {"power", "transmission"}
offshore.QUERIES["cables"] = (
    '[out:json][timeout:600];('
    'way["communication"="line"]["location"~"^(underwater|submarine)"];'
    'way["communication"="line"]["submarine"="yes"];'
    'way["communication"="line"]["seamark:type"="cable_submarine"];'
    'way["telecom"="line"]["location"~"^(underwater|submarine)"];'
    'way["seamark:type"="cable_submarine"]["seamark:cable_submarine:category"~"^(' + "|".join(sorted(TELECOM_CATS))
    + ')$"];);out geom tags;')
offshore.CACHE["cables"] = "osm_cables_telecom.json"

# Cables completed or announced after the 2022 snapshot, checked by name in the report
SPOT_CHECK = ["2Africa", "Equiano", "Grace Hopper", "Amitié", "Firmina", "Bifrost", "Echo", "Apricot",
              "Dunant", "MAREA", "Havfrue", "EllaLink", "Peace", "Blue", "Raman", "Topaz"]

QUALIFIER = re.compile(
    r"\b(seg(ment)?\.?\s*[\w.]+|branch\b.*|phase\s*\d+|section\b.*|(north|south|east|west)(ern)?\b.*|"
    r"(bu|fc?|s)\d+[\w.,\s-]*$)", re.I)
FILLER = re.compile(r"\b(submarine|undersea|telecom(munications?)?|fib(re|er)(\s*optic)?|optical|cable|cables|"
                    r"system|network|the)\b", re.I)


def ascii_lower(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def name_keys(name: str, strip_qualifiers: bool) -> set[str]:
    """Normalised spellings of one cable name; two names match when their key sets intersect."""
    s = ascii_lower(name)
    variants = {s, re.sub(r"\(.*?\)", " ", s)}
    variants |= {m for m in re.findall(r"\(([^)]+)\)", s)}          # "Asia-America Gateway (AAG)" -> "aag"
    variants |= {p for v in list(variants) for p in v.split("/")}    # "Havfrue/AEC-2"
    if strip_qualifiers:
        variants |= {QUALIFIER.sub(" ", v) for v in list(variants)}
    keys = set()
    for v in variants:
        k = re.sub(r"[^a-z0-9]", "", FILLER.sub(" ", v))
        if len(k) >= 3:
            keys.add(k)
    return keys


def classify(t: dict) -> str | None:
    cat = (t.get("seamark:cable_submarine:category") or "").lower()
    if t.get("power") == "cable" or cat in POWER_CATS:
        return None
    if t.get("communication") == "line" or t.get("telecom") == "line" or cat in TELECOM_CATS:
        return "telecom"
    return None


def cable_name(t: dict) -> str | None:
    for k in ("name", "name:en", "seamark:cable_submarine:name", "seamark:name"):
        if t.get(k):
            return t[k].strip()
    return None


def year_of(s: str | None) -> int | None:
    m = re.search(r"(1[89]\d\d|20\d\d)", s or "")
    return int(m.group(1)) if m else None


def after_snapshot(start: str | None) -> bool:
    m = re.search(r"(20\d\d)(?:-(\d\d))?(?:-(\d\d))?", start or "")
    if not m:
        return False
    # partial dates count from their earliest day, so "newer" means certainly after the snapshot
    return (m.group(1), m.group(2) or "01", m.group(3) or "01") > tuple(SNAPSHOT_DATE.split("-"))


def tg_index(path: Path) -> dict[str, dict]:
    idx: dict[str, dict] = {}
    for f in json.loads(path.read_text())["features"]:
        p = f["properties"]
        for k in name_keys(p["name"], strip_qualifiers=False):
            idx.setdefault(k, p)
    return idx


def build(sea: offshore.Sea, refresh: bool, out: Path, report: Path) -> dict:
    els, ts = offshore.overpass("cables", refresh)
    n_power = n_land = n_short = 0
    kept = []
    for e in els:
        t = e.get("tags", {})
        coords = [(p["lon"], p["lat"]) for p in e.get("geometry", []) if p]
        if len(coords) < 2:
            continue
        if classify(t) is None:
            n_power += 1
            continue
        a = np.array(coords)
        if not sea.at_sea(a[:, 0], a[:, 1]).any():
            n_land += 1
            continue
        kept.append((e, t, coords))

    groups: dict[tuple, list] = {}
    for e, t, coords in kept:
        name = cable_name(t)
        groups.setdefault((name,) if name else (None, t.get("operator")), []).append((e, t, coords))

    tg = tg_index(TG)
    feats = []
    for key, items in groups.items():
        merged = linemerge([LineString(c) for _, _, c in items])
        parts = list(merged.geoms) if isinstance(merged, MultiLineString) else [merged]
        pieces = [parts] if key[0] else [[p] for p in parts]
        for ps in pieces:
            km = sum(offshore.geodesic_km(p.coords) for p in ps)
            if not key[0] and km < MIN_UNNAMED_KM:
                n_short += 1
                continue
            simp = [p.simplify(TOLERANCE, preserve_topology=False) for p in ps]
            geom = [[[round(x, 5), round(y, 5)] for x, y in p.coords] for p in simp if len(p.coords) >= 2]
            tags = [i[1] for i in items]
            first = lambda k: next((x[k] for x in tags if x.get(k)), None)  # noqa: E731
            starts = sorted({x["start_date"] for x in tags if x.get("start_date")})
            match = None
            if key[0]:
                match = next((tg[k] for k in sorted(name_keys(key[0], strip_qualifiers=True)) if k in tg), None)
            ids = sorted({f"w{i[0]['id']}" for i in items}, key=lambda s: int(s[1:]))
            props = offshore.clean({
                "name": key[0], "operator": first("operator") or first("owner"),
                "start_date": starts[0] if starts else None,
                "status": "disused" if any(x.get("disused") == "yes" or "disused:communication" in x
                                           or x.get("seamark:cable_submarine:condition") == "disused"
                                           for x in tags) else None,
                "length_km": round(km, 1), "osm": ids[:20], "osm_ways": len(ids) if len(ids) > 20 else None,
                "in_tg2022": bool(match), "tg_id": match["id"] if match else None,
                "tg_name": match["name"] if match and match["name"] != key[0] else None,
                "wikidata": first("wikidata")})
            feats.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "MultiLineString", "coordinates": geom}})
    feats.sort(key=lambda f: (-f["properties"]["length_km"], f["properties"]["osm"][0]))
    named = [f for f in feats if f["properties"].get("name")]
    matched = [f for f in named if f["properties"]["in_tg2022"]]
    newer = [f for f in named if not f["properties"]["in_tg2022"]
             and after_snapshot(f["properties"].get("start_date"))]
    stats = {"osmWays": len(els), "excludedPower": n_power, "excludedNotAtSea": n_land,
             "excludedUnnamedUnder1km": n_short, "features": len(feats), "named": len(named),
             "matchedToSnapshot": len(matched), "newerThanSnapshot": len(newer),
             "lengthKm": round(sum(f["properties"]["length_km"] for f in feats))}
    meta = {"source": "OpenStreetMap via Overpass: submarine telecom cables (communication=line or telecom=line "
                      "underwater / submarine, seamark:type=cable_submarine with a telecom category)",
            "osmTimestamp": ts, "comparedWith": f"TeleGeography snapshot {SNAPSHOT_DATE} (cables.geojson)",
            "simplifyToleranceDeg": TOLERANCE, "stats": stats,
            "note": "routes as drawn by OSM mappers (mostly nautical-chart cables near coasts); long-haul cables are "
                    "rarely mapped; in_tg2022 = the name matches a cable of the 2022 TeleGeography snapshot",
            **offshore.META_COMMON}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"type": "FeatureCollection", "metadata": meta, "features": feats},
                              separators=(",", ":"), ensure_ascii=False))
    print(f"cables-osm: {len(els)} OSM ways; {n_power} power/uncategorised, {n_land} never at sea, "
          f"{n_short} unnamed pieces < {MIN_UNNAMED_KM:g} km; {len(feats)} features ({len(named)} named, "
          f"{len(matched)} in the 2022 snapshot, {len(newer)} started after it), {stats['lengthKm']:,} km, "
          f"{out.stat().st_size / 1e6:.2f} MB")
    write_report(report, feats, stats, ts, tg)
    return stats


def write_report(path: Path, feats: list, stats: dict, ts: str, tg: dict) -> None:
    named = [f["properties"] for f in feats if f["properties"].get("name")]
    by_name: dict[str, dict] = {}
    for p in named:
        q = by_name.setdefault(p["name"], {**p, "length_km": 0.0})
        q["length_km"] += p["length_km"]
    rows = sorted(by_name.values(), key=lambda p: -p["length_km"])
    newer = [p for p in rows if not p["in_tg2022"] and after_snapshot(p.get("start_date"))]
    other = [p for p in rows if not p["in_tg2022"] and not after_snapshot(p.get("start_date"))]
    matched = [p for p in rows if p["in_tg2022"]]

    def line(p: dict) -> str:
        osm = p["osm"][0]
        return (f"| {p['name'].replace('|', '/')} | {p.get('operator', '').replace('|', '/')} | "
                f"{p.get('start_date', '')} | {p['length_km']:,.0f} | "
                f"[{osm}](https://www.openstreetmap.org/way/{osm[1:]}) |")

    head = "| OSM name | Operator | start_date | km (OSM) | OSM way |\n|---|---|---|---:|---|"
    osm_keys = {k: p["name"] for p in rows for k in name_keys(p["name"], strip_qualifiers=True)}
    spot = []
    for n in SPOT_CHECK:
        ks = name_keys(n, strip_qualifiers=False)
        in_tg = next((tg[k] for k in ks if k in tg), None)
        in_osm = next((osm_keys[k] for k in ks if k in osm_keys), None)
        tg_txt = (f"yes ({'planned' if in_tg.get('planned') else 'in service'}, RFS {in_tg.get('rfs', '?')})"
                  if in_tg else "no")
        spot.append(f"| {n} | {tg_txt} | {in_osm or 'no'} |")
    md = [
        "# Submarine cables in OpenStreetMap vs the 2022 TeleGeography snapshot",
        "",
        f"Generated by `pipeline/cables_osm.py` (OSM data as of {ts}). Layer: `web/public/data/cables-osm.geojson`, "
        "© OpenStreetMap contributors (ODbL). Do not edit by hand.",
        "",
        "| | |", "|---|---:|",
        f"| OSM ways returned by the query | {stats['osmWays']:,} |",
        f"| excluded: power cables or no telecom category | {stats['excludedPower']:,} |",
        f"| excluded: no vertex at sea (lakes, rivers) | {stats['excludedNotAtSea']:,} |",
        f"| excluded: unnamed pieces under 1 km | {stats['excludedUnnamedUnder1km']:,} |",
        f"| features in the layer (named + unnamed pieces) | {stats['features']:,} |",
        f"| distinct named cables | {len(rows):,} |",
        f"| named cables that match a 2022 snapshot cable | {len(matched):,} |",
        f"| named cables not in the snapshot, OSM start_date after 2022-11-14 | {len(newer):,} |",
        f"| named cables not in the snapshot, older or no start_date | {len(other):,} |",
        f"| total length in the layer | {stats['lengthKm']:,} km |",
        "",
        "OSM mappers rarely draw long-haul cables, because their routes cannot be checked on the ground; most of this "
        "layer is coastal and North Sea / Baltic cables from nautical charts. It therefore cannot replace the "
        "TeleGeography routes; it adds cables near coasts and shows which ones OSM knows that the frozen 2022 data "
        "does not.",
        "",
        "## Known post-2022 cables",
        "",
        "| Cable | In the 2022 snapshot | In OSM (name) |", "|---|---|---|", *spot,
        "",
        "## Not in the snapshot, started after 2022-11-14 (likely newer)",
        "", head, *(map(line, newer) if newer else ["| (none) | | | | |"]),
        "",
        "## Not in the snapshot, older or no start_date",
        "",
        "Retired before 2022 (TeleGeography lists only active and planned systems), domestic, or named differently.",
        "", head, *map(line, other),
        "",
        "## Matched to the snapshot",
        "",
        "| OSM name | Snapshot name | km (OSM) |", "|---|---|---:|",
        *(f"| {p['name'].replace('|', '/')} | {p.get('tg_name') or p['name']} | {p['length_km']:,.0f} |"
          for p in matched),
        "",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(md))
    print(f"  report {path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-run the Overpass query")
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--report", type=Path, default=REPORT)
    args = ap.parse_args()
    build(offshore.Sea(), args.refresh, args.out, args.report)


if __name__ == "__main__":
    main()
