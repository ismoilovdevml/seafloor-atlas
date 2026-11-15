"""Weekly refresh of the small, fast-changing overlays, fail-safe (run by .github/workflows/refresh-data.yml).

For each layer: re-query the API into a staging folder (data/derived/refresh/, gitignored), validate the new
file, and only then replace web/public/data/<file>. A layer that fails keeps its old file; the others still
update. Layers whose features are identical to the current file are left untouched (the timestamps inside a
file alone are not a change), so git sees a diff only when the data really changed.

  layer        script                               API
  platforms    offshore.py --only platforms          Overpass (OSM)
  pipelines    offshore.py --only pipelines          Overpass (OSM)
  windfarms    offshore.py --only windfarms          Overpass (OSM)
  wrecks       wrecks.py                             Wikidata SPARQL
  cables-osm   cables_osm.py (+ docs/cables-osm.md)  Overpass (OSM)

Checks on every new file: parses as a GeoJSON FeatureCollection; metadata.attribution/licence as in the
data contract; at least MIN features; allowed geometry type with finite lon/lat in range; required
properties present; ids unique; size limit; feature count within +-20 % of the current file
(--allow-count-change to accept a bigger jump after looking at it).

Inputs: the GEBCO and EEZ files from pipeline/sea_inputs.py. Politeness: one API query at a time, a pause
between Overpass queries, retries with back-off inside the scripts, a User-Agent with the project URL.

usage: python pipeline/refresh_overlays.py [--layers platforms,wrecks] [--allow-count-change]
                                           [--no-fetch] [--summary FILE] [--commit-message FILE]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "web/public/data"
STAGE = ROOT / "data/derived/refresh"
PY = sys.executable
OSM_ATTR = "© OpenStreetMap contributors (ODbL)"
MAX_COUNT_CHANGE = 0.20

LAYERS = {
    "platforms": {"file": "platforms.geojson", "cmd": ["offshore.py", "--only", "platforms", "--out-dir", "{stage}"],
                  "overpass": True, "geom": {"Point"}, "required": ["id", "type"], "unique": "id",
                  "attribution": OSM_ATTR, "licence": "ODbL 1.0", "min": 1000, "max_mb": 6},
    "pipelines": {"file": "pipelines.geojson", "cmd": ["offshore.py", "--only", "pipelines", "--out-dir", "{stage}"],
                  "overpass": True, "geom": {"MultiLineString"}, "required": ["substance", "length_km"],
                  "attribution": OSM_ATTR, "licence": "ODbL 1.0", "min": 100, "max_mb": 5},
    "windfarms": {"file": "windfarms.geojson", "cmd": ["offshore.py", "--only", "windfarms", "--out-dir", "{stage}"],
                  "overpass": True, "geom": {"Point"}, "required": ["id", "status", "depth_m"], "unique": "id",
                  "attribution": OSM_ATTR, "licence": "ODbL 1.0", "min": 50, "max_mb": 2},
    "wrecks": {"file": "wrecks.geojson", "cmd": ["wrecks.py", "--out", "{stage}/wrecks.geojson"],
               "overpass": False, "geom": {"Point"}, "required": ["id", "depth_m", "sitelinks"], "unique": "id",
               "attribution": "Shipwrecks: Wikidata (CC0)", "licence": "CC0 1.0", "min": 5000, "max_mb": 8},
    "cables-osm": {"file": "cables-osm.geojson",
                   "cmd": ["cables_osm.py", "--out", "{stage}/cables-osm.geojson", "--report", "{stage}/cables-osm.md"],
                   "overpass": True, "geom": {"MultiLineString"}, "required": ["osm", "length_km", "in_tg2022"],
                   "attribution": OSM_ATTR, "licence": "ODbL 1.0", "min": 50, "max_mb": 3,
                   "extra": {"cables-osm.md": ROOT / "docs/cables-osm.md"}},
}


def validate(spec: dict, path: Path, old: dict | None, allow_count_change: bool) -> tuple[dict, list[str]]:
    errs: list[str] = []
    if not path.exists() or path.stat().st_size == 0:
        return {}, [f"{path.name} missing or empty"]
    if path.stat().st_size > spec["max_mb"] * 1e6:
        errs.append(f"{path.stat().st_size / 1e6:.1f} MB > {spec['max_mb']} MB")
    try:
        d = json.loads(path.read_text())
    except ValueError as e:
        return {}, [f"not JSON: {e}"]
    if d.get("type") != "FeatureCollection" or not isinstance(d.get("features"), list):
        return d, ["not a FeatureCollection"]
    m = d.get("metadata") or {}
    if m.get("attribution") != spec["attribution"]:
        errs.append(f"metadata.attribution {m.get('attribution')!r} != {spec['attribution']!r}")
    if m.get("licence") != spec["licence"]:
        errs.append(f"metadata.licence {m.get('licence')!r} != {spec['licence']!r}")
    feats = d["features"]
    if len(feats) < spec["min"]:
        errs.append(f"{len(feats)} features < minimum {spec['min']}")
    bad_geom = bad_coord = 0
    missing: dict[str, int] = {}
    for f in feats:
        g = f.get("geometry") or {}
        if f.get("type") != "Feature" or g.get("type") not in spec["geom"]:
            bad_geom += 1
            continue
        pts = [g["coordinates"]] if g["type"] == "Point" else [p for line in g["coordinates"] for p in line]
        if not pts or any(len(p) < 2 or not all(math.isfinite(v) for v in p[:2])
                          or not (-180 <= p[0] <= 180 and -90 <= p[1] <= 90) for p in pts):
            bad_coord += 1
        props = f.get("properties") or {}
        for k in spec["required"]:
            if props.get(k) is None:
                missing[k] = missing.get(k, 0) + 1
    if bad_geom:
        errs.append(f"{bad_geom} features without an allowed geometry ({'/'.join(sorted(spec['geom']))})")
    if bad_coord:
        errs.append(f"{bad_coord} features with invalid coordinates")
    if missing:
        errs.append("missing required properties: " + ", ".join(f"{k} x{n}" for k, n in missing.items()))
    if spec.get("unique"):
        ids = [(f.get("properties") or {}).get(spec["unique"]) for f in feats]
        if len(set(ids)) != len(ids):
            errs.append(f"{len(ids) - len(set(ids))} duplicate {spec['unique']} values")
    if old is not None and not allow_count_change:
        n0 = len(old["features"])
        if n0 and abs(len(feats) - n0) / n0 > MAX_COUNT_CHANGE:
            errs.append(f"feature count {n0} -> {len(feats)} ({(len(feats) - n0) / n0:+.0%}) outside "
                        f"+-{MAX_COUNT_CHANGE:.0%}; rerun with --allow-count-change after checking it")
    return d, errs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", default=",".join(LAYERS), help="comma-separated subset of " + ",".join(LAYERS))
    ap.add_argument("--allow-count-change", action="store_true", help="skip the +-20 %% feature-count check")
    ap.add_argument("--no-fetch", action="store_true", help="use the cached API answers (local testing)")
    ap.add_argument("--pause", type=float, default=30, help="seconds between Overpass queries")
    ap.add_argument("--summary", type=Path, help="write a Markdown summary here")
    ap.add_argument("--commit-message", type=Path, help="write a git commit message here (only if changed)")
    args = ap.parse_args()
    names = [n.strip() for n in args.layers.split(",") if n.strip()]
    unknown = set(names) - set(LAYERS)
    if unknown:
        sys.exit(f"unknown layers: {sorted(unknown)}")
    STAGE.mkdir(parents=True, exist_ok=True)

    rows, changed, failed = [], [], []
    last_overpass = 0.0
    for name in names:
        spec = LAYERS[name]
        staged = STAGE / spec["file"]
        staged.unlink(missing_ok=True)
        cmd = [PY, str(ROOT / "pipeline" / spec["cmd"][0]),
               *[a.format(stage=STAGE) for a in spec["cmd"][1:]], *([] if args.no_fetch else ["--refresh"])]
        if spec["overpass"] and not args.no_fetch and last_overpass:
            wait = args.pause - (time.time() - last_overpass)
            if wait > 0:
                time.sleep(wait)
        print(f"== {name}: {' '.join(Path(c).name if i < 2 else c for i, c in enumerate(cmd))}", flush=True)
        t0 = time.time()
        proc = subprocess.run(cmd, cwd=ROOT)
        if spec["overpass"]:
            last_overpass = time.time()
        cur = DATA / spec["file"]
        old = json.loads(cur.read_text()) if cur.exists() else None
        n_old = len(old["features"]) if old else None
        if proc.returncode != 0:
            failed.append(name)
            rows.append((name, n_old, None, f"FAILED: script exit {proc.returncode}"))
            continue
        new, errs = validate(spec, staged, old, args.allow_count_change)
        n_new = len(new.get("features", [])) if new else None
        if errs:
            failed.append(name)
            rows.append((name, n_old, n_new, "FAILED: " + "; ".join(errs)))
            print(f"   validation failed, kept the old file: {errs}")
            continue
        if old is not None and old["features"] == new["features"]:
            rows.append((name, n_old, n_new, "unchanged"))
            print(f"   unchanged ({n_new} features, {time.time() - t0:.0f} s)")
            continue
        shutil.copyfile(staged, cur)
        for src_name, dst in spec.get("extra", {}).items():
            shutil.copyfile(STAGE / src_name, dst)
        changed.append((name, n_old, n_new))
        rows.append((name, n_old, n_new, "updated"))
        print(f"   updated {n_old} -> {n_new} features ({time.time() - t0:.0f} s)")

    fmt = lambda n: "-" if n is None else f"{n:,}"  # noqa: E731
    table = ["| Layer | Before | After | Result |", "|---|---:|---:|---|",
             *(f"| {n} | {fmt(a)} | {fmt(b)} | {r} |" for n, a, b, r in rows)]
    summary = "\n".join(["## Data refresh " + time.strftime("%Y-%m-%d", time.gmtime()), "", *table, ""])
    print(summary)
    if args.summary:
        args.summary.write_text(summary)
    if args.commit_message and changed:
        parts = [f"{n} {fmt(a)} -> {fmt(b)}" for n, a, b in changed]
        args.commit_message.write_text(
            f"Refresh data {time.strftime('%Y-%m-%d', time.gmtime())}: {', '.join(n for n, _, _ in changed)}\n\n"
            + "\n".join(f"- {p} features" for p in parts)
            + "\n\nAutomatic weekly refresh (pipeline/refresh_overlays.py); each file validated before replacing.\n")
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a") as f:
            f.write(f"changed={','.join(n for n, _, _ in changed)}\nfailed={','.join(failed)}\n")
    if failed:
        # exit 1 so CI marks the run red; the layers that passed are already in place and can be committed
        sys.exit(f"failed layers (old files kept): {', '.join(failed)}")


if __name__ == "__main__":
    main()
