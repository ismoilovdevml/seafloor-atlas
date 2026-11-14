"""Submarine cables -> web/public/data/cables.geojson + landing-points.geojson.

Source: the last public, Creative-Commons-licensed snapshot of TeleGeography's Submarine Cable Map data
(git commit 91265d81 of github.com/telegeography/www.submarinecablemap.com, 2022-11-14; the repository
was taken down later and TeleGeography now licenses current data commercially). The snapshot's README and
LICENSE file say CC BY-NC-SA 3.0 Unported. CC licences are irrevocable for that copy, so this derived
product is CC BY-NC-SA 3.0 too (attribution, non-commercial, share-alike) - NOT the MIT licence of the code.
Fetch: pipeline/fetch_data.sh section "cables" (tarball from a fork that kept the commit, see
docs/data-contract.md).

Routes are TeleGeography's schematic drawings (not surveyed cable positions); they are already light
(about 11.6 k vertices), so we only merge the per-segment features by cable and round to 1e-4 deg.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAP = ROOT / "data/raw/cables/www.submarinecablemap.com-91265d81"
API = SNAP / "web/public/api/v3"
OUT_CABLES = ROOT / "web/public/data/cables.geojson"
OUT_LANDING = ROOT / "web/public/data/landing-points.geojson"
COMMIT = "91265d81"
SNAPSHOT_DATE = "2022-11-14"
ATTRIBUTION = ("Submarine cables: TeleGeography Submarine Cable Map data, snapshot 2022-11-14, "
               "CC BY-NC-SA 3.0 (submarinecablemap.com)")
LICENCE_URL = "https://creativecommons.org/licenses/by-nc-sa/3.0/"


def rnd(c):
    return [round(c[0], 4), round(c[1], 4)]


def dedupe(line):
    out = []
    for p in map(rnd, line):
        if not out or p != out[-1]:
            out.append(p)
    return out


def length_km(s: str | None) -> int | None:
    if not s:
        return None
    m = re.match(r"([\d,\.]+)\s*km", s)
    return int(round(float(m.group(1).replace(",", "")))) if m else None


def meta() -> dict:
    return {"source": "TeleGeography Submarine Cable Map data (github.com/telegeography/www.submarinecablemap.com, "
                      f"commit {COMMIT}, {SNAPSHOT_DATE})",
            "licence": "CC BY-NC-SA 3.0", "licenceUrl": LICENCE_URL, "attribution": ATTRIBUTION,
            "snapshot": SNAPSHOT_DATE, "note": "schematic routes; status (planned/RFS) as of the snapshot date"}


def main() -> None:
    lic = (SNAP / "LICENSE").read_text()
    assert "Attribution-NonCommercial-ShareAlike 3.0 Unported" in lic, "unexpected licence in snapshot"
    geo = json.loads((API / "cable/cable-geo.json").read_text())
    lines: dict[str, list] = {}
    color: dict[str, str] = {}
    for f in geo["features"]:
        cid = f["properties"]["id"]
        color[cid] = f["properties"].get("color")
        for line in f["geometry"]["coordinates"]:
            d = dedupe(line)
            if len(d) >= 2:
                lines.setdefault(cid, []).append(d)
    lons = [p[0] for ls in lines.values() for l in ls for p in l]
    print(f"route features {len(geo['features'])}, cables with geometry {len(lines)}, "
          f"lon range {min(lons)}..{max(lons)}")

    feats, missing = [], []
    for cid, ls in sorted(lines.items()):
        p = API / "cable" / f"{cid}.json"
        if not p.exists():
            missing.append(cid)
            continue
        d = json.loads(p.read_text())
        props = {"id": cid, "name": d["name"], "color": color[cid],
                 "length_km": length_km(d.get("length")), "rfs": d.get("rfs"), "rfs_year": d.get("rfs_year"),
                 "planned": bool(d.get("is_planned")), "owners": d.get("owners"),
                 "suppliers": d.get("suppliers"), "url": d.get("url"),
                 "landing_points": [lp["id"] for lp in d.get("landing_points", [])]}
        feats.append({"type": "Feature", "properties": {k: v for k, v in props.items() if v not in (None, "", [])},
                      "geometry": {"type": "MultiLineString", "coordinates": ls}})
    OUT_CABLES.write_text(json.dumps({"type": "FeatureCollection", "metadata": meta(), "features": feats},
                                     separators=(",", ":"), ensure_ascii=False))

    lp_geo = json.loads((API / "landing-point/landing-point-geo.json").read_text())
    lfeats = []
    for f in lp_geo["features"]:
        lid = f["properties"]["id"]
        p = API / "landing-point" / f"{lid}.json"
        d = json.loads(p.read_text()) if p.exists() else {}
        props = {"id": lid, "name": f["properties"]["name"], "country": d.get("country"),
                 "cables": [c["id"] for c in d.get("cables", [])]}
        if f["properties"].get("is_tbd"):
            props["tbd"] = True
        lfeats.append({"type": "Feature", "properties": {k: v for k, v in props.items() if v not in (None, [])},
                       "geometry": {"type": "Point", "coordinates": rnd(f["geometry"]["coordinates"])}})
    OUT_LANDING.write_text(json.dumps({"type": "FeatureCollection", "metadata": meta(), "features": lfeats},
                                      separators=(",", ":"), ensure_ascii=False))
    print(f"cables {len(feats)} (no detail file: {missing}), landing points {len(lfeats)}; "
          f"{OUT_CABLES.stat().st_size / 1e6:.2f} MB + {OUT_LANDING.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
