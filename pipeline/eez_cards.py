"""Per-EEZ "report card" data for the website: web/public/data/eez.json.

Input
  data/derived/regions.json           per-EEZ ocean area, measured area and share for GEBCO_2026 (pipeline/regions.py)
  data/raw/regions/eez/*.geojson.gz   Marine Regions EEZ v12 polygons as 30x30 degree WMS tiles (generalised; see regions.py)

Output
  web/public/data/eez.json   one record per EEZ: id (MRGID), name, sovereign, territory, ISO codes, ocean and measured area,
                              measured share, rank among EEZs >= 10,000 km2, a representative point (lon, lat) inside the
                              largest polygon piece (for the "open on the globe" link) and a zoom level from the piece size.

The representative point is a display aid only; it is not used for any statistic.
    python pipeline/eez_cards.py
"""
from __future__ import annotations

import gzip
import json
import math
from collections import defaultdict
from pathlib import Path

from shapely.geometry import shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
REGIONS = ROOT / "data/derived/regions.json"
TILES = ROOT / "data/raw/regions/eez"
OUT = ROOT / "web/public/data/eez.json"
MIN_RANK_KM2 = 10_000  # small EEZs carry rasterisation errors of a few percent (docs/regions.md), so they are not ranked


def slug(name: str, mrgid: int) -> str:
    s = "".join(c.lower() if c.isalnum() else "-" for c in name)
    while "--" in s:
        s = s.replace("--", "-")
    return f"{s.strip('-')}-{mrgid}"


def representative_points() -> dict[int, tuple[float, float, float]]:
    """MRGID -> (lon, lat, extent_deg) of the largest connected piece, from the WMS tiles."""
    pieces: dict[int, list] = defaultdict(list)
    for f in sorted(TILES.glob("*.geojson.gz")):
        with gzip.open(f) as fh:
            d = json.load(fh)
        for feat in d.get("features", []):
            p = feat.get("properties", {})
            mrgid = p.get("mrgid") or p.get("MRGID")
            if mrgid is None or not feat.get("geometry"):
                continue
            g = shape(feat["geometry"])
            if not g.is_valid:
                g = g.buffer(0)
            pieces[int(mrgid)].append(g)
    out = {}
    for mrgid, gs in pieces.items():
        u = unary_union(gs)
        parts = list(u.geoms) if hasattr(u, "geoms") else [u]
        big = max(parts, key=lambda g: g.area)
        pt = big.representative_point()
        minx, miny, maxx, maxy = big.bounds
        out[mrgid] = (round(pt.x, 3), round(pt.y, 3), max(maxx - minx, maxy - miny))
    return out


def zoom_for(extent_deg: float) -> float:
    return round(max(1.6, min(7.0, math.log2(360 / max(extent_deg, 0.5)) - 0.3)), 2)


def main() -> None:
    reg = json.loads(REGIONS.read_text())
    pts = representative_points()
    rows = []
    for e in reg["eez"]:
        mrgid = int(e["mrgid"])
        lon, lat, ext = pts.get(mrgid, (None, None, None))
        rows.append({
            "id": mrgid, "slug": slug(e["name"], mrgid), "name": e["name"], "geoname": e.get("geoname"),
            "sovereign": e.get("sovereign1"), "territory": e.get("territory1"), "iso_ter": e.get("iso_ter1"),
            "iso_sov": e.get("iso_sov1"), "type": e.get("pol_type"),
            "ocean_km2": round(e["ocean_area_km2"] or 0, 1), "measured_km2": round(e["measured_area_km2"] or 0, 1),
            "share": round(e["measured_fraction"], 5) if e.get("measured_fraction") is not None else None,
            "lon": lon, "lat": lat, "zoom": zoom_for(ext) if ext else None,
        })
    ranked = sorted((r for r in rows if r["share"] is not None and r["ocean_km2"] >= MIN_RANK_KM2), key=lambda r: -r["share"])
    for i, r in enumerate(ranked, 1):
        r["rank"] = i
    meta = {"source": "Seafloor Atlas, pipeline/eez_cards.py from data/derived/regions.json (GEBCO_2026 TID 10-17; "
                      "Marine Regions World EEZ v12, CC BY 4.0)",
            "ranked_min_km2": MIN_RANK_KM2, "n_ranked": len(ranked), "n": len(rows),
            "missing_point": sum(1 for r in rows if r["lon"] is None)}
    OUT.write_text(json.dumps({"meta": meta, "eez": rows}, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
