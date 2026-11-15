"""Shipwrecks from Wikidata (CC0) -> web/public/data/wrecks.geojson.

One SPARQL query (about 15 s on query.wikidata.org) for every item that is an instance of
shipwreck (Q852190) or a subclass and has a coordinate (P625); one for ships that are not typed as
shipwrecks but whose "significant event: shipwrecking" carries a coordinate (RMS Lusitania, Wilhelm
Gustloff, ...); one small query for the labels of items without an English label. Raw answers are cached in data/raw/wrecks/ (--refresh to re-query).

Kept: points whose GEBCO_2026 1' elevation is < 0 (at sea or in a basin below sea level such as the
Caspian); depth_m = -elevation of that 1' cell (about 1.8 km wide, so wrecks close inshore can read a
shallower or deeper neighbour than the true wreck depth).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/wrecks"
ELEV = ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif"
OUT = ROOT / "web/public/data/wrecks.geojson"
ENDPOINT = "https://query.wikidata.org/sparql"
UA = "seafloor-atlas-data-prep/0.1 (open-data ocean map; https://github.com/ismoilovdevml/seafloor-atlas)"

QUERY = """
SELECT ?item ?label ?coord ?cpart ?crank ?typeLabel ?sunkWreck ?sunkEvent ?sunkEvent2 ?dissolved ?image ?article ?sl WHERE {
  ?item wdt:P31/wdt:P279* wd:Q852190 ; wikibase:sitelinks ?sl ;
        p:P625 ?cst .
  ?cst ps:P625 ?coord ; wikibase:rank ?crank .
  FILTER(?crank != wikibase:DeprecatedRank)
  OPTIONAL { ?cst pq:P518 ?cpart }
  OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) = "en") }
  OPTIONAL { ?item wdt:P31 ?type FILTER(?type != wd:Q852190) ?type rdfs:label ?typeLabel FILTER(LANG(?typeLabel) = "en") }
  OPTIONAL { ?item p:P31 ?s1 . ?s1 ps:P31 wd:Q852190 ; pq:P580 ?sunkWreck }
  OPTIONAL { ?item p:P793 ?s2 . ?s2 ps:P793 wd:Q906512 .
             OPTIONAL { ?s2 pq:P585 ?sunkEvent } OPTIONAL { ?s2 pq:P580 ?sunkEvent2 } }
  OPTIONAL { ?item wdt:P576 ?dissolved }
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
}
"""

# Ships that are not typed as shipwrecks but carry a shipwrecking event (Q906512, or an event item that is
# an instance of it, e.g. "sinking of the Wilhelm Gustloff") with a coordinate qualifier on that event.
# Only the event's coordinate is used: the item's own P625 may be a museum or home port.
EVENT_QUERY = """
SELECT ?item ?label ?coord ?cpart ?crank ?typeLabel ?sunkWreck ?sunkEvent ?sunkEvent2 ?dissolved ?image ?article ?sl WHERE {
  ?item p:P793 ?s ; wikibase:sitelinks ?sl .
  ?s ps:P793 ?ev ; pq:P625 ?coord .
  { VALUES ?ev { wd:Q906512 } } UNION { ?ev wdt:P31/wdt:P279* wd:Q906512 }
  MINUS { ?item wdt:P31/wdt:P279* wd:Q852190 }
  BIND("event" AS ?cpart) BIND(wikibase:NormalRank AS ?crank)
  OPTIONAL { ?s pq:P585 ?d1 } OPTIONAL { ?ev wdt:P585 ?d2 } BIND(COALESCE(?d1, ?d2) AS ?sunkEvent)
  OPTIONAL { ?s pq:P580 ?sunkEvent2 }
  OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) = "en") }
  OPTIONAL { ?item wdt:P31 ?type . ?type rdfs:label ?typeLabel FILTER(LANG(?typeLabel) = "en") }
  OPTIONAL { ?item wdt:P576 ?dissolved }
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
}
"""

LABELS_QUERY = """
SELECT ?item (SAMPLE(?l) AS ?label) WHERE {
  VALUES ?item { %s }
  ?item rdfs:label ?l .
} GROUP BY ?item
"""

# P31 values that say nothing about the vessel itself; used only when nothing better exists
GENERIC_TYPES = {"ship", "archaeological site", "recreational dive site", "offshore dive site", "dive site",
                 "Rijksmonument", "listed building", "historic site", "scheduled monument", "monument",
                 "underwater archaeological site", "wreck", "maritime archaeological site"}


def sparql(query: str, cache: Path, refresh: bool) -> list[dict]:
    if cache.exists() and not refresh:
        text = cache.read_text()
    else:
        req = urllib.request.Request(ENDPOINT, data=urllib.parse.urlencode({"query": query}).encode(),
                                     headers={"User-Agent": UA, "Accept": "text/csv"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    text = r.read().decode("utf-8")
                break
            except Exception as e:  # 429/5xx: back off politely, at most 3 tries
                code = getattr(e, "code", None)
                if attempt == 2 or (code is not None and 400 <= code < 500 and code != 429):
                    raise
                print(f"  query failed ({e}), retrying in 60 s")
                time.sleep(60)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(text)
    return list(csv.DictReader(io.StringIO(text)))


def qid(uri: str) -> str:
    return uri.rsplit("/", 1)[-1]


def parse_point(wkt: str) -> tuple[float, float] | None:
    if wkt.startswith("<"):           # non-Earth globe
        return None
    m = re.match(r"Point\(([-\d.eE+]+) ([-\d.eE+]+)\)", wkt)
    if not m:
        return None
    lon, lat = float(m.group(1)), float(m.group(2))
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        return None
    return lon, lat


def date_fields(rows: list[dict]) -> tuple[str | None, int | None]:
    """Sinking date: shipwreck start-time qualifier > 'shipwrecking' event > dissolved (P576)."""
    for key in ("sunkWreck", "sunkEvent", "sunkEvent2", "dissolved"):
        vals = sorted({r[key] for r in rows if r[key]})
        for v in vals:
            m = re.match(r"(-?\d{1,4})-(\d\d)-(\d\d)", v.lstrip("+"))
            if not m:
                continue                    # blank nodes ("unknown value")
            y, mo, d = int(m.group(1)), m.group(2), m.group(3)
            # SPARQL CSV drops the precision; Jan 1 is almost always a year-only value
            return (None if (mo, d) in (("01", "01"), ("00", "00")) else f"{m.group(1)}-{mo}-{d}"), y
    return None, None


def pick_type(rows: list[dict]) -> str | None:
    types = sorted({r["typeLabel"] for r in rows if r["typeLabel"]})
    specific = [t for t in types if t not in GENERIC_TYPES]
    return (specific or types or [None])[0]


def pick_coord(rows: list[dict]) -> tuple[float, float] | None:
    """Prefer a coordinate qualified 'applies to part: shipwreck', then preferred rank, then the smallest."""
    def key(r):
        return (r["cpart"] != "http://www.wikidata.org/entity/Q852190",
                not r["crank"].endswith("PreferredRank"), r["coord"])
    for r in sorted(rows, key=key):
        p = parse_point(r["coord"])
        if p:
            return p
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-run the SPARQL queries")
    ap.add_argument("--out", type=Path, default=OUT,
                    help="output file (pipeline/refresh_overlays.py stages and validates here)")
    args = ap.parse_args()
    out = args.out
    out.parent.mkdir(parents=True, exist_ok=True)

    rows = sparql(QUERY, RAW / "wikidata_shipwrecks.csv", args.refresh)
    by_item: dict[str, list[dict]] = {}
    for r in rows:
        by_item.setdefault(qid(r["item"]), []).append(r)
    n_typed = len(by_item)
    ev_rows = sparql(EVENT_QUERY, RAW / "wikidata_wreck_events.csv", args.refresh)
    for r in ev_rows:
        if qid(r["item"]) not in by_item or by_item[qid(r["item"])][0]["cpart"] == "event":
            by_item.setdefault(qid(r["item"]), []).append(r)
    print(f"SPARQL rows {len(rows)} + {len(ev_rows)}; items: typed shipwreck {n_typed}, "
          f"shipwrecking event with coordinate {len(by_item) - n_typed}")

    unlabelled = sorted(q for q, rs in by_item.items() if not any(r["label"] for r in rs))
    fallback = {}
    for i in range(0, len(unlabelled), 400):
        chunk = unlabelled[i:i + 400]
        res = sparql(LABELS_QUERY % " ".join(f"wd:{q}" for q in chunk),
                     RAW / f"wikidata_labels_{i // 400}.csv", args.refresh)
        fallback.update({qid(r["item"]): r["label"] for r in res})

    items = []
    for q, rs in by_item.items():
        pt = pick_coord(rs)
        if pt is None:
            continue
        label = next((r["label"] for r in rs if r["label"]), None) or fallback.get(q)
        date, year = date_fields(rs)
        image = next((r["image"] for r in sorted(rs, key=lambda r: r["image"]) if r["image"]), None)
        article = next((r["article"] for r in rs if r["article"]), None)
        items.append({"id": q, "lon": pt[0], "lat": pt[1], "name": label, "date": date, "year": year,
                      "src": "event" if rs[0]["cpart"] == "event" else None,
                      "type": pick_type(rs),
                      "image": urllib.parse.unquote(image.rsplit("/", 1)[-1]) if image else None,
                      "wiki": urllib.parse.unquote(article.rsplit("/wiki/", 1)[-1]) if article else None,
                      "sitelinks": int(rs[0]["sl"] or 0)})

    lon = np.array([i["lon"] for i in items])
    lat = np.array([i["lat"] for i in items])
    with rasterio.open(ELEV) as src:
        a = src.read(1)
        rr, cc = rasterio.transform.rowcol(src.transform, lon, lat)
        rr = np.clip(np.asarray(rr), 0, src.height - 1)
        cc = np.asarray(cc) % src.width
        elev = a[rr, cc].astype(int)
    feats, n_land = [], 0
    for it, e in zip(items, elev):
        if e >= 0:
            n_land += 1
            continue
        props = {k: it[k] for k in ("id", "name", "date", "year", "type", "image", "wiki", "sitelinks", "src")
                 if it[k] is not None}
        props["depth_m"] = int(-e)
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "Point", "coordinates": [round(it["lon"], 4), round(it["lat"], 4)]}})
    # most notable first, so the viewer can label the top of the list
    feats.sort(key=lambda f: (-f["properties"]["sitelinks"], f["properties"]["id"]))
    meta = {"source": "Wikidata: instances of shipwreck (Q852190) with a coordinate, plus ships whose "
                      "shipwrecking event (Q906512) has a coordinate (src=event)",
            "sourceUrl": "https://query.wikidata.org/", "licence": "CC0 1.0",
            "attribution": "Shipwrecks: Wikidata (CC0)", "retrieved": time.strftime(
                "%Y-%m-%d", time.gmtime((RAW / "wikidata_shipwrecks.csv").stat().st_mtime)),
            "depth": "GEBCO_2026 1' grid at the point; only points with elevation < 0 kept"}
    out.write_text(json.dumps({"type": "FeatureCollection", "metadata": meta, "features": feats},
                              separators=(",", ":"), ensure_ascii=False))
    print(f"items {len(items)}, on land / above sea level (dropped) {n_land}, kept {len(feats)}; "
          f"{out.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
