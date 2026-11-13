"""PB2002 (Bird 2003) plate-boundary steps -> web/public/data/plates.geojson.

Consecutive steps of the same boundary and class are merged into one LineString.
Properties: type (ridge | transform | subduction | convergent | rift), cls (PB2002 STEPCLASS),
boundary ("PA-NA"), plates ("Pacific / North America"), rate_mm_yr (mean relative velocity).
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/plates"
OUT = ROOT / "web/public/data/plates.geojson"

CLASS_TYPE = {
    "OSR": "ridge",        # oceanic spreading ridge
    "CRB": "rift",         # continental rift boundary
    "OTF": "transform",    # oceanic transform fault
    "CTF": "transform",    # continental transform fault
    "SUB": "subduction",   # subduction zone (trench)
    "OCB": "convergent",   # oceanic convergent boundary
    "CCB": "convergent",   # continental convergent boundary
}


def plate_names() -> dict[str, str]:
    p = RAW / "PB2002_plates.json"
    if not p.exists():
        return {}
    d = json.loads(p.read_text())
    return {f["properties"]["Code"]: f["properties"]["PlateName"] for f in d["features"]}


def main() -> None:
    names = plate_names()
    steps = json.loads((RAW / "PB2002_steps.json").read_text())["features"]
    steps.sort(key=lambda f: f["properties"]["SEQNUM"])
    feats, cur = [], None
    for f in steps:
        p = f["properties"]
        key = (p["PLATEBOUND"], p["STEPCLASS"])
        coords = [[round(x, 2), round(y, 2)] for x, y in f["geometry"]["coordinates"]]
        coords = [c for i, c in enumerate(coords) if i == 0 or c != coords[i - 1]] or coords[:1]
        joins = cur is not None and cur["key"] == key and cur["coords"][-1] == coords[0] \
            and abs(coords[0][0] - coords[-1][0]) < 180
        if joins:
            cur["coords"].extend(coords[1:])
            cur["rates"].append((p["VELOCITYLE"], p["STEPLENGTH"]))
        else:
            if cur:
                feats.append(cur)
            cur = {"key": key, "coords": coords, "rates": [(p["VELOCITYLE"], p["STEPLENGTH"])]}
    feats.append(cur)

    out = []
    for c in feats:
        bound, cls = c["key"]
        sep = "/" if "/" in bound else "-"
        a, b = (bound.split(sep) + [""])[:2]
        L = sum(w for _, w in c["rates"]) or 1.0
        rate = sum(v * w for v, w in c["rates"]) / L
        out.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": c["coords"]},
            "properties": {
                "type": CLASS_TYPE.get(cls, "other"), "cls": cls, "boundary": bound,
                "plates": f"{names.get(a, a)} / {names.get(b, b)}",
                "rate_mm_yr": round(rate, 1),
            },
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": out,
                               "attribution": "Bird (2003) PB2002, via github.com/fraxen/tectonicplates, ODC-By 1.0"},
                              separators=(",", ":")))
    print(f"{len(steps)} steps -> {len(out)} lines, {OUT.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
