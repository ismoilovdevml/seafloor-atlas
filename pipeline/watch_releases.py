"""Watch upstream datasets that need the heavy local pipeline, and open one GitHub issue per new release.

Run monthly by .github/workflows/release-watch.yml. Current versions are read from the repository itself
(so the watcher follows the code after a rebuild); upstream versions from public listings:

  GEBCO grid        meta.json "version"        CEDA directory index (gebco_YYYY/), gebco.net grid page
  World Ocean Atlas pipeline/woa.py (woaNN)     NCEI file listing (WOANN/), NCEI THREDDS catalogue (woaNN/)
  OBIS speciesgrids pipeline/obis.py build id   public S3 listing s3://obis-products/speciesgrids/YYYYMMDD/
  AquaMaps          pipeline/obis.py version    "Version MM/YYYY" on www.aquamaps.org
  TeleGeography     not watched: the open data stopped at the 2022-11-14 snapshot (see pipeline/cables.py)

A GEBCO issue needs the data directory on CEDA (news on gebco.net about a coming grid is evidence only).
An issue is opened once: its title names the new version, and no issue (open or closed) with the same title
may exist. Needs GITHUB_TOKEN (issues: write) and GITHUB_REPOSITORY; --dry-run prints instead. A source
whose probes all fail is reported as a warning (the page may have moved), never as a new release.

usage: python pipeline/watch_releases.py [--dry-run] [--json FILE]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UA = "seafloor-atlas-release-watch/0.1 (https://github.com/ismoilovdevml/seafloor-atlas)"
API = "https://api.github.com"

COMMON_TAIL = """
- [ ] `.venv/bin/python -m pytest tests` and `cd web && npm test`
- [ ] browser QA: `cd web && npm run build && npm run preview`, then `node scripts/qa.mjs http://localhost:4173/ qa-out`
- [ ] README numbers and figures (`.venv/bin/python pipeline/figures.py`), `docs/data-contract.md`, licence table
- [ ] push to main (Pages deploys). A new Zenodo version needs a GitHub release: the owner decides, never automatic
"""

CHECKLISTS = {
    "gebco": """Rebuild with GEBCO_{new} (currently GEBCO_{cur}). Commands from README "Run it":

- [ ] wait for (or make) a COG mirror of the new grid, then point `pipeline/fetch_data.sh` and `pipeline/sea_inputs.py` at it;
      move the year in every script: `grep -rln "gebco_{cur}\\|GEBCO_{cur}" pipeline web/src docs README.md .github`
- [ ] keep GEBCO_{cur} TID as the "previous year" for `pipeline/change.py` (fetch_data.sh section GEBCO_2025 today)
- [ ] `pipeline/fetch_data.sh` and `.venv/bin/python pipeline/verify_mirror.py` (mirror == official server)
- [ ] `.venv/bin/python pipeline/coverage.py` (measured-share statistics)
- [ ] `.venv/bin/python pipeline/tiles.py` (web tiles z0-5, ~10 min)
- [ ] `.venv/bin/python pipeline/tiles_hires.py` then `.venv/bin/python pipeline/publish_hires.py` (z6-7 PMTiles on Hugging Face, needs `hf auth login`)
- [ ] the scripts that sample the grid: `change.py`, `regions.py`, `hypsometry.py`, `trenches.py`, `features.py`, `disagree.py`, `uncertainty.py`, `seals.py`
- [ ] overlays that use the "at sea" test and depths: `.venv/bin/python pipeline/refresh_overlays.py --no-fetch --allow-count-change`
- [ ] bump the Actions cache key `sea-inputs-gebco{cur}` in `.github/workflows/refresh-data.yml`
- [ ] mapping history with the new release: `.venv/bin/python pipeline/history.py fetch {new}`, `convert {new}`, `build`, `tiles`
- [ ] cell-level dataset: `.venv/bin/python pipeline/build_dataset.py inputs connectivity build tables verify checksums`
      (add the new release to the bitmask; `verify` must say VERIFY OK), `pipeline/sensitivity_cellsize.py run report figure`
      and `pipeline/survey_types.py`
- [ ] follow-up analyses: `pipeline/distance.py run`, `pipeline/blindtest.py run figure` (needs the {cur} and {new} elevation),
      `pipeline/official_bracket.py`, `pipeline/shipping_gap.py`; compare the new official Seabed 2030 figure
- [ ] website text: `.venv/bin/python pipeline/eez_cards.py`, then `cd web && node scripts/seo_pages.mjs`
      (update KEY numbers in seo_pages.mjs first; `npx vitest run test/seo.test.ts` checks them against README)
- [ ] README numbers, figures and screenshots (`web/scripts/readme_shots.mjs`, `pipeline/readme_images.py`)
- [ ] new Zenodo dataset version (owner's decision: permanent DOI) and a GitHub release for the code
""",
    "woa": """Rebuild the Ocean water layer with WOA{new_short} (currently WOA{cur_short}):

- [ ] check that the new atlas has the 1991-2020 (or a newer) climate normal at 0.25 deg and 1 deg, with `t_an` and `s_an`
- [ ] update `RAW`, `DODS`, `FILE_URL`, `PERIOD` and the citations in `pipeline/woa.py`
- [ ] `.venv/bin/python pipeline/woa.py all` (fetch only the used levels over OPeNDAP, build `web/public/woa/`, spot checks)
- [ ] `.venv/bin/python -m pytest tests/test_woa.py` and `cd web && npx vitest run test/water.test.ts`
""",
    "speciesgrids": """Rebuild the marine-life layers with OBIS speciesgrids build {new} (currently {cur}):

- [ ] set `SG_S3` and `CITATION_SG` in `pipeline/obis.py` to the new build; remove `data/raw/obis/speciesgrids/`
- [ ] `.venv/bin/python pipeline/obis.py` (downloads the H3-7 parquet row groups, rebuilds `web/public/data/obis/`)
- [ ] `.venv/bin/python -m pytest tests/test_obis.py` and `cd web && npx vitest run test/marine.test.ts`
""",
    "aquamaps": """AquaMaps shows version {new} (the site uses {cur}):

- [ ] find an openly licensed download of the new global richness map (the current one: `AQ_URL` in `pipeline/obis.py`)
- [ ] update `AQ_URL`, `ATTR_AQ`, the citation and the attribution in `docs/data-contract.md` (must match the viewer's text)
- [ ] `.venv/bin/python pipeline/obis.py` and `.venv/bin/python -m pytest tests/test_obis.py`
""",
}
TITLES = {
    "gebco": "Upstream release: GEBCO_{new} grid, rebuild needed",
    "woa": "Upstream release: World Ocean Atlas {new} (WOA{new_short}), rebuild needed",
    "speciesgrids": "Upstream release: OBIS speciesgrids build {new}, rebuild needed",
    "aquamaps": "Upstream release: AquaMaps version {new}, rebuild needed",
}


def get(url: str, timeout: int = 60) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""


def probe(url: str, pattern: str, conv=int) -> tuple[list, str]:
    """All matches of pattern in the page, converted; plus one line of evidence."""
    try:
        status, body = get(url)
    except Exception as e:  # noqa: BLE001 - network: a failed probe is reported, not fatal
        return [], f"{url}: failed ({e})"
    if status != 200:
        return [], f"{url}: HTTP {status}"
    vals = sorted({conv(m) for m in re.findall(pattern, body)})
    return vals, f"{url}: HTTP 200, found {vals[-6:] if vals else 'nothing matching'}"


def two_digit_year(s: str) -> int:
    y = int(s)
    return y + (2000 if y < 50 else 1900) if y < 100 else y


def current_versions() -> dict:
    meta = json.loads((ROOT / "web/public/tiles/meta.json").read_text())
    woa = (ROOT / "pipeline/woa.py").read_text()
    obis = (ROOT / "pipeline/obis.py").read_text()
    return {
        "gebco": int(re.search(r"GEBCO_(\d{4})", meta["version"]).group(1)),
        "woa": two_digit_year(re.search(r'DODS = ".*/woa(\d\d)/', woa).group(1)),
        "speciesgrids": re.search(r'SG_S3 = "obis-products/speciesgrids/(\d{8})/', obis).group(1),
        "aquamaps": re.search(r'ATTR_AQ = ".*?version (\d{1,2}/\d{4})', obis).group(1),
    }


def month_key(v: str) -> tuple[int, int]:
    m, y = v.split("/")
    return int(y), int(m)


def check_all(cur: dict) -> tuple[list[dict], list[str], list[str]]:
    found, evidence, warnings = [], [], []

    def source(key: str, probes: list[tuple], order=lambda v: v) -> None:
        """probes: (url, regex, convert[, decides=True]); a non-deciding probe is evidence only."""
        vals, ok = [], False
        for url, pat, conv, *rest in probes:
            v, ev = probe(url, pat, conv)
            decides = rest[0] if rest else True
            evidence.append(f"{key}: {ev}" + ("" if decides else " (evidence only)"))
            ok |= ev.split(": ", 1)[1].startswith("HTTP 200")
            if decides:
                vals += v
        if not ok:
            warnings.append(f"{key}: every probe failed; check the URLs in pipeline/watch_releases.py")
            return
        if not vals:
            warnings.append(f"{key}: pages answered but no version string matched (layout changed?)")
            return
        new = [v for v in vals if order(v) > order(cur[key])]
        if new:
            found.append({"key": key, "current": cur[key], "new": max(new, key=order)})

    source("gebco", [("https://dap.ceda.ac.uk/bodc/gebco/global/", r'href="gebco_(\d{4})/"', int),
                     ("https://www.gebco.net/data-products/gridded-bathymetry-data", r"GEBCO[_ ](\d{4})\b", int, False)])
    source("woa", [("https://www.ncei.noaa.gov/data/oceans/woa/", r'href="WOA(\d\d)/"', two_digit_year),
                   ("https://www.ncei.noaa.gov/thredds-ocean/catalog/catalog.html", r'catalog/woa(\d\d)/catalog\.html', two_digit_year)])
    source("speciesgrids", [("https://obis-products.s3.amazonaws.com/?list-type=2&prefix=speciesgrids/&delimiter=/",
                             r"<Prefix>speciesgrids/(\d{8})/</Prefix>", str)])
    source("aquamaps", [("https://www.aquamaps.org/", r"[Vv]ersion\s+(\d{1,2}/20\d\d)", str)], order=month_key)
    evidence.append("telegeography: not watched (open data frozen at the 2022-11-14 snapshot)")
    return found, evidence, warnings


def issue_for(f: dict, evidence: list[str]) -> dict:
    fields = {"new": f["new"], "cur": f["current"]}
    if f["key"] == "woa":
        fields |= {"new_short": f"{f['new'] % 100:02d}", "cur_short": f"{f['current'] % 100:02d}"}
    body = (CHECKLISTS[f["key"]].format(**fields) + COMMON_TAIL
            + "\n<details><summary>Evidence (pipeline/watch_releases.py)</summary>\n\n"
            + "\n".join(f"- {e}" for e in evidence if e.startswith(f["key"] + ":")) + "\n</details>\n"
            + "\nOpened automatically by `.github/workflows/release-watch.yml`; closing it keeps it from being "
              "opened again for this version.\n")
    return {"title": TITLES[f["key"]].format(**fields), "body": body}


def gh(method: str, path: str, token: str, data: dict | None = None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(data).encode() if data else None,
                                 headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                                          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"null")


def existing_titles(repo: str, token: str) -> set[str]:
    titles, page = set(), 1
    while True:
        batch = gh("GET", f"/repos/{repo}/issues?state=all&per_page=100&page={page}", token)
        titles |= {i["title"] for i in batch}
        if len(batch) < 100:
            return titles
        page += 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print the issues instead of opening them")
    ap.add_argument("--json", type=Path, help="write the findings as JSON")
    args = ap.parse_args()
    cur = current_versions()
    print("current:", json.dumps(cur))
    found, evidence, warnings = check_all(cur)
    for e in evidence:
        print("  " + e)
    for w in warnings:
        print(f"::warning::{w}")
    issues = [issue_for(f, evidence) for f in found]
    if args.json:
        args.json.write_text(json.dumps({"current": cur, "found": found, "issues": issues,
                                         "evidence": evidence, "warnings": warnings}, indent=1))
    if not issues:
        print("no new upstream versions")
        return
    if args.dry_run:
        for i in issues:
            print(f"\n=== would open: {i['title']}\n{i['body']}")
        return
    repo, token = os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_TOKEN"]
    have = existing_titles(repo, token)
    for i in issues:
        if i["title"] in have:
            print(f"already reported: {i['title']}")
            continue
        r = gh("POST", f"/repos/{repo}/issues", token, i)
        print(f"opened #{r['number']}: {i['title']}  {r['html_url']}")


if __name__ == "__main__":
    main()
