"""IHO-IOC GEBCO Gazetteer of Undersea Feature Names -> web/public/data/features.geojson.

Fetches the three ArcGIS layers (points, lines, polygons) published for the gazetteer
(services2.arcgis.com/.../Undersea_Features/FeatureServer, linked from gebco.net), caches the raw
GeoJSON in data/raw/gazetteer/, then writes one labelled Point per named feature with:
  name ("Challenger Deep"), kind ("Deep"), depth_m (GEBCO_2026 1' grid at the label point;
  for Deep/Trench/Trough/Basin the minimum within +-2' since the 1' grid smooths narrow lows),
  rank (bigger = more prominent; extent in km), geom (point|line|polygon), blurb, source.
"""
from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/gazetteer"
OUT = ROOT / "web/public/data/features.geojson"
ELEV = ROOT / "data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif"
SERVICE = "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/Undersea_Features/FeatureServer"
LAYERS = {0: "point", 1: "line", 2: "polygon"}
LOWS = {"Deep", "Deeps", "Trench", "Trough", "Basin", "Hole", "Fracture Zone", "Valley"}

# Short plain-language definitions (paraphrased from the IHO B-6 generic terms).
BLURB = {
    "Deep": "The deepest part of a trench or basin.",
    "Trench": "A long, narrow, deep depression where one plate dives under another.",
    "Seamount": "An underwater volcano rising more than 1,000 m above the seafloor.",
    "Seamounts": "A group of underwater volcanoes.",
    "Guyot": "A flat-topped seamount, eroded at the surface before it subsided.",
    "Ridge": "A long elevation of the seafloor, often volcanic.",
    "Rise": "A broad, gentle elevation of the seafloor.",
    "Fracture Zone": "A long scar on the seafloor left by a transform fault, offsetting a mid-ocean ridge.",
    "Canyon": "A steep-sided valley cut into the continental margin.",
    "Plateau": "A large, flat-topped elevation of the seafloor.",
    "Basin": "A large depression of the seafloor.",
    "Abyssal Plain": "A flat, sediment-covered region of the deep ocean floor.",
    "Bank": "A shallow elevation over which the water is relatively deep enough for navigation.",
    "Knoll": "A rounded elevation rising less than 1,000 m above the seafloor.",
    "Hill": "A small elevation rising less than 1,000 m above the seafloor.",
    "Escarpment": "A long, steep slope separating two flatter areas.",
    "Fan": "A fan-shaped sediment deposit spreading out from a canyon mouth.",
    "Spur": "A ridge projecting from a larger feature.",
    "Trough": "A long depression, generally wider and shallower than a trench.",
    "Valley": "A relatively shallow, wide depression.",
    "Shelf": "The shallow seafloor bordering a continent.",
    "Terrace": "A step-like flat area on a slope.",
    "Saddle": "A low point on a ridge or between seamounts.",
    "Sill": "A sea-floor barrier separating two basins.",
    "Gap": "A narrow break in a ridge or rise.",
    "Passage": "A gap connecting two basins or seas.",
    "Hole": "A small local depression, often steep-sided.",
    "Reef": "A rocky or coral elevation dangerous to surface navigation.",
    "Caldera": "A collapsed volcanic crater.",
    "Mound": "A low, rounded elevation, often formed by gas, mud or carbonate.",
    "Pinnacle": "A tall, slender rock pillar.",
    "Province": "A region of similar seafloor features.",
    "Moat": "A ring-like depression at the base of a seamount or island.",
    "Channel": "A long, shallow depression on the seafloor, often carved by turbidity currents.",
    "Seachannel": "A long, shallow depression on the seafloor, often carved by turbidity currents.",
    "Sea Channel": "A long, shallow depression on the seafloor, often carved by turbidity currents.",
    "Shoal": "A shallow area with depths dangerous to surface navigation.",
    "Seamount Chain": "A line of underwater volcanoes, often traced by a plate moving over a hotspot.",
    "Peak": "The highest point of a seamount or ridge.",
    "Slope": "The steep seafloor between the continental shelf and the deep ocean.",
    "Plain": "A flat, gently sloping area of the seafloor.",
    "Levee": "An embankment of sediment along the side of a seachannel.",
    "Pingos": "Ice-cored mounds on Arctic shelves, formed when the sea was land.",
}


def blurb_for(kind: str) -> str:
    if kind in BLURB:
        return BLURB[kind]
    if kind.endswith("s") and kind[:-1] in BLURB:
        return f"A group of {kind.lower()}. " + BLURB[kind[:-1]]
    return ""


def fetch_layer(layer: int) -> dict:
    cache = RAW / f"layer{layer}_{LAYERS[layer]}.geojson"
    if cache.exists():
        return json.loads(cache.read_text())
    feats, offset = [], 0
    while True:
        q = urllib.parse.urlencode({"where": "1=1", "outFields": "NAME,TYPE,FEATURE_ID", "outSR": 4326,
                                    "f": "geojson", "resultOffset": offset, "resultRecordCount": 1000,
                                    "orderByFields": "OBJECTID"})
        for attempt in range(5):
            try:
                d = json.loads(urllib.request.urlopen(f"{SERVICE}/{layer}/query?{q}", timeout=180).read())
                break
            except Exception:  # transient network errors on a slow link
                time.sleep(3 * (attempt + 1))
        else:
            raise RuntimeError(f"layer {layer} offset {offset} failed")
        batch = d.get("features", [])
        feats += batch
        if len(batch) < 1000 and not d.get("properties", {}).get("exceededTransferLimit"):
            break
        offset += len(batch)
    fc = {"type": "FeatureCollection", "features": feats}
    RAW.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(fc))
    return fc


def flatten(geom: dict) -> list[list[float]]:
    t, c = geom["type"], geom["coordinates"]
    if t == "Point":
        return [c]
    if t in ("MultiPoint", "LineString"):
        return c
    if t in ("MultiLineString", "Polygon"):
        return [p for part in c for p in part]
    if t == "MultiPolygon":
        return [p for poly in c for ring in poly for p in ring]
    return []


def unwrap(pts: np.ndarray) -> np.ndarray:
    """Make longitudes continuous across the antimeridian."""
    lon = pts[:, 0].copy()
    if lon.max() - lon.min() > 180:
        lon[lon < 0] += 360
    return np.column_stack([lon, pts[:, 1]])


def label_and_extent(geom: dict, kind: str) -> tuple[list[float], float]:
    pts = unwrap(np.asarray(flatten(geom), dtype=float))
    if kind == "line":
        mid = pts[len(pts) // 2]
    else:
        mid = pts.mean(axis=0)
    lon = ((mid[0] + 180) % 360) - 180
    lat0 = math.radians(mid[1])
    dx = (pts[:, 0].max() - pts[:, 0].min()) * 111.32 * math.cos(lat0)
    dy = (pts[:, 1].max() - pts[:, 1].min()) * 110.57
    return [round(lon, 5), round(float(mid[1]), 5)], float(math.hypot(dx, dy))


def main() -> None:
    out = []
    with rasterio.open(ELEV) as src:
        elev = src.read(1)
        inv = ~src.transform
        for layer, gkind in LAYERS.items():
            fc = fetch_layer(layer)
            for f in fc["features"]:
                p, g = f["properties"], f["geometry"]
                if not g or not p.get("NAME"):
                    continue
                (lon, lat), extent = label_and_extent(g, gkind)
                col, row = inv * (lon, lat)
                r, c = int(row), int(col) % src.width
                if not (0 <= r < src.height):
                    continue
                typ = (p.get("TYPE") or "").strip()
                if typ in LOWS:
                    win = elev[max(0, r - 2):r + 3, max(0, c - 2):c + 3]
                    depth = int(win.min())
                else:
                    depth = int(elev[r, c])
                out.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {
                        "id": int(p["FEATURE_ID"]),
                        "name": f"{p['NAME']} {typ}".strip(),
                        "kind": typ,
                        "depth_m": depth,
                        "rank": round(extent, 1),
                        "geom": gkind,
                        "blurb": blurb_for(typ),
                        "source": "IHO-IOC GEBCO Gazetteer of Undersea Feature Names",
                    },
                })
    out.sort(key=lambda f: -f["properties"]["rank"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": out,
                               "attribution": "IHO-IOC GEBCO Gazetteer of Undersea Feature Names, www.gebco.net"},
                              separators=(",", ":"), ensure_ascii=False))
    print(f"{len(out)} features, {OUT.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
