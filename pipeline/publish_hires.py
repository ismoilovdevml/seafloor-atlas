"""Publish the z6-7 PMTiles archives to Hugging Face and point the viewer at them.

1. uploads data/derived/hires/*.pmtiles + a dataset card to the HF dataset repo (needs `hf auth login`)
2. pins the URLs to the upload commit (resolve/<sha>/...), so browser caches never mix two versions
3. checks each URL from outside: HTTP 206 for a range request, CORS header, PMTiles v3 magic,
   zoom range in the header
4. writes "hires" into web/public/tiles/meta.json

usage: .venv/bin/python pipeline/publish_hires.py [--repo ismoilovdev/seafloor-atlas-tiles] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HIRES = ROOT / "data/derived/hires"
META = ROOT / "web/public/tiles/meta.json"
FILES = {"dem": "dem_z6-7.pmtiles", "coverage": "coverage_z6-7.pmtiles"}

CARD = """---
license: other
license_name: ogl-uk-3.0
license_link: https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/
pretty_name: Seafloor Atlas tiles (GEBCO_2026, z6-7)
tags:
- bathymetry
- gebco
- pmtiles
- geospatial
---

# Seafloor Atlas tiles

High-zoom web map tiles (Web Mercator, zoom 6-7, 512 px) for
[Seafloor Atlas](https://seaflooratlas.org/) ([code](https://github.com/ismoilovdevml/seafloor-atlas)).
Zoom 0-5 is served from GitHub Pages; these archives are read by the browser with HTTP range requests.

| File | Content |
|---|---|
| `dem_z6-7.pmtiles` | GEBCO_2026 elevation, 15 arc-second source, lossless WebP, Terrarium RGB in whole metres (`h = R*256 + G + B/256 - 32768`) |
| `coverage_z6-7.pmtiles` | Share of each pixel directly measured (GEBCO TID 10-17), RGBA veil: alpha = 230 * (1 - share) over ocean, 0 on land |

Polar rows beyond 84.92 deg are set to the mean of the grid beyond 85.05 deg so the globe has no radial artefact at the poles.

**Source and licence.** GEBCO Compilation Group (2026) GEBCO 2026 Grid, doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa.
Open Government Licence v3; attribution required. Not for navigation.
"""


def check_url(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Range": "bytes=0-126", "Origin": "https://seaflooratlas.org"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
        status, acao = r.status, r.headers.get("Access-Control-Allow-Origin")
    assert status == 206, f"{url}: expected 206, got {status}"
    assert acao in ("*", "https://seaflooratlas.org"), f"{url}: CORS header {acao!r}"
    assert body[:7] == b"PMTiles" and body[7] == 3, f"{url}: not a PMTiles v3 archive"
    return {"status": status, "cors": acao, "min_zoom": body[100], "max_zoom": body[101]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="ismoilovdev/seafloor-atlas-tiles")
    ap.add_argument("--dry-run", action="store_true", help="check files only, upload nothing")
    args = ap.parse_args()
    for f in FILES.values():
        p = HIRES / f
        assert p.exists() and p.stat().st_size > 1_000_000, f"missing or empty {p}"
        print(f"{f}: {p.stat().st_size / 1e9:.2f} GB")
    if args.dry_run:
        return

    from huggingface_hub import HfApi
    api = HfApi()
    card = HIRES / "README.md"
    card.write_text(CARD)
    info = api.upload_folder(repo_id=args.repo, repo_type="dataset", folder_path=str(HIRES),
                             allow_patterns=["*.pmtiles", "README.md"],
                             commit_message="Upload GEBCO_2026 z6-7 PMTiles")
    sha = info.oid
    print("commit", sha)
    urls = {k: f"https://huggingface.co/datasets/{args.repo}/resolve/{sha}/{f}" for k, f in FILES.items()}
    checks = {k: check_url(u) for k, u in urls.items()}
    for k, c in checks.items():
        assert (c["min_zoom"], c["max_zoom"]) == (6, 7), (k, c)
    print(json.dumps(checks, indent=1))

    meta = json.loads(META.read_text())
    meta["hires"] = {"maxzoom": 7, **urls, "revision": sha, "sourceResolutionArcsec": 15}
    META.write_text(json.dumps(meta, indent=1))
    print("meta.json hires ->", json.dumps(meta["hires"], indent=1))


if __name__ == "__main__":
    main()
