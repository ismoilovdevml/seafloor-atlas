# Maintenance

What keeps itself up to date, what needs a person, and how to undo a bad data commit.

## Automatic

| What | Workflow | When | Does |
|---|---|---|---|
| OSM platforms, pipelines, wind farms, submarine cables; Wikidata shipwrecks | `.github/workflows/refresh-data.yml` | Mondays 04:17 UTC, or by hand (Actions → Refresh data → Run workflow) | re-queries Overpass / Wikidata, validates, commits real changes, redeploys |
| New GEBCO grid, World Ocean Atlas, OBIS speciesgrids build, AquaMaps version | `.github/workflows/release-watch.yml` | 3rd of each month 05:41 UTC, or by hand | opens one issue per new version with the rebuild checklist; builds nothing |
| Site size | step in `.github/workflows/pages.yml` | every deploy | prints the largest folders; warns > 750 MB, fails > 950 MB (Pages limit 1 GB) |

GitHub disables scheduled workflows of a public repository after 60 days without any commit; the weekly refresh
commits whenever OSM or Wikidata changed, which keeps it alive in practice, but if the Actions page shows a
"disabled" banner, re-enable both workflows there.

Neither workflow creates releases or tags. The Zenodo integration mints a permanent DOI version for every
GitHub release, so releases stay a manual decision of the owner.

### Weekly data refresh in detail

1. `pipeline/sea_inputs.py` restores the inputs the scripts need from the Actions cache
   (`sea-inputs-gebco2026-eez12-v1`, about 310 MB: the 1′ GEBCO elevation, the 15″ TID grid, the EEZ tiles). After a
   cache miss (caches unused for 7 days are evicted) it downloads them again: elevation from the COG mirror,
   TID from BODC/CEDA, EEZ from the Marine Regions WMS, about 5–10 minutes. They never go into git.
2. `pipeline/refresh_overlays.py` runs each layer on its own: `offshore.py --only platforms|pipelines|windfarms`,
   `wrecks.py`, `cables_osm.py`, each with `--refresh`, writing into `data/derived/refresh/`. One query at a time,
   30 s between Overpass queries, User-Agent with the project URL. Overpass goes to the first of several instances
   (`offshore.OVERPASS_URLS`; overpass-api.de, overpass.private.coffee, maps.mail.ru; env `OVERPASS_URLS`
   overrides) that answers a tiny probe query, in 3 rounds 2 and 5 minutes apart; a 200 answer carrying a
   timeout or out-of-memory remark counts as no answer.
3. Each new file must pass: valid GeoJSON FeatureCollection, `metadata.attribution` and `licence` as in
   `docs/data-contract.md`, a minimum feature count, the expected geometry type, finite lon/lat in range,
   required properties, unique ids, a size limit (cables-osm < 3 MB), and **a feature count within ±20 % of the
   current file**. A failing layer keeps its old file; the others still update.
4. A file whose features are identical to the current one is not rewritten (a new OSM timestamp alone is not a
   change), so most weeks end with "no content change" and no commit.
5. `npx vitest run test/overlays.test.ts` runs on the new files (cards from real features, attribution text).
   If it fails, nothing is committed.
6. Commit as `ismoilovdevml <107093598+ismoilovdevml@users.noreply.github.com>` with a message such as
   `Refresh data 2026-11-23: platforms, wrecks` and the before → after counts; push to `main`; start `pages.yml`
   (a push made with `GITHUB_TOKEN` does not trigger other workflows, so the job dispatches the deploy itself).
7. If any layer failed, the run ends red with the reason in the job summary.
8. **Source down is not a failure.** When no Overpass instance answers (seen 2026-11-23: the main instance at
   capacity, the mirrors timing out, the runner unable to connect at all), that layer and the remaining Overpass
   layers are skipped with their old files, listed as `unavailable`, and the run stays green with a warning; the
   next weekly run tries again. It still ends red once a skipped layer's `osmTimestamp` is older than 60 days.

**When the ±20 % check stops a layer** (a mass OSM edit, a Wikidata bulk import, a broken query): open the failed
run's summary, compare the counts, look at the data if needed
(`.venv/bin/python pipeline/refresh_overlays.py --layers wrecks` locally), and if the change is real, run the
workflow by hand with `allow_count_change` ticked (optionally only that layer in `layers`).

**When the viewer test stops the commit**: a spot check in `web/test/overlays.test.ts` (Troll A, Nord Stream 1,
Hornsea 1, Titanic) no longer matches because someone edited that OSM / Wikidata object. Check the object; if
the edit is right, update the test, push, and re-run the workflow.

### Release watcher in detail

`pipeline/watch_releases.py` reads the versions in use from the repository (`web/public/tiles/meta.json`,
`pipeline/woa.py`, `pipeline/obis.py`) and compares them with public listings: the CEDA GEBCO directory index
(the gebco.net page is logged as evidence only), the NCEI WOA file listing and THREDDS catalogue, the public S3
listing of OBIS speciesgrids builds, the "Version MM/YYYY" text on aquamaps.org. TeleGeography is not watched:
its open data ended with the 2022-11-14 snapshot. An issue is opened once per version: the title names the
version, and no open **or closed** issue with that title may exist, so closing an issue silences it for that
version. A source whose probes all fail appears as a warning on the run (its page may have moved), never as a
release. Test locally with `python pipeline/watch_releases.py --dry-run`.

## Manual rebuilds

These need the heavy local pipeline (GBs of input, GDAL, tens of minutes) and the release watcher reminds you.

| Upstream | Rebuild |
|---|---|
| GEBCO grid (yearly, usually spring/summer) | full: `fetch_data.sh`, `verify_mirror.py`, `coverage.py`, `tiles.py`, `tiles_hires.py` + `publish_hires.py`, `change.py`, `regions.py`, `hypsometry.py`, `trenches.py`, `features.py`, `disagree.py`, `uncertainty.py`, `seals.py`, `figures.py`; then `refresh_overlays.py --no-fetch --allow-count-change` (depths and the "at sea" test use the grid) and a new cache key in `refresh-data.yml` |
| World Ocean Atlas | `pipeline/woa.py all` after updating its URLs / period |
| OBIS speciesgrids, AquaMaps | `pipeline/obis.py` after updating `SG_S3` / `AQ_URL` and the citations |
| TeleGeography cables | nothing: frozen snapshot (CC BY-NC-SA 3.0); newer cables only through the OSM supplement |
| Shipping density, AUST_2026_BAT, SO-ABBA, SWOT confidence | one-off datasets; rebuild only if a new version is published (not watched) |

Common checklist after any rebuild (the issues carry the same one):

```bash
.venv/bin/python -m pytest tests
cd web && npm test && npm run build && npm run preview     # then, in another shell:
node scripts/qa.mjs http://localhost:4173/ qa-out
.venv/bin/python pipeline/figures.py                         # README figures; update the README numbers
```

Update `docs/data-contract.md` and the licence table, push to `main` (Pages deploys), then decide whether the
change deserves a GitHub release (= a new Zenodo version).

## Rolling back a bad data commit

Refresh commits touch only `web/public/data/{platforms,pipelines,windfarms,wrecks,cables-osm}.geojson` and
`docs/cables-osm.md`, one commit per run, so a revert is clean:

```bash
git log --oneline --grep "^Refresh data" -- web/public/data | head    # find "Refresh data YYYY-MM-DD"
git revert <sha>                                                     # new commit restoring the old files
git push origin main                                                 # pages.yml redeploys (path web/**)
```

To restore one file only: `git checkout <sha>~1 -- web/public/data/wrecks.geojson`, commit, push. To stop the
weekly job while investigating: Actions → Refresh data → ⋯ → Disable workflow (or
`gh workflow disable refresh-data.yml`). The site itself can be redeployed from any commit with
Actions → Deploy viewer (Cloudflare Pages + GitHub Pages mirror) → Run workflow. The live site seaflooratlas.org is the Cloudflare Pages project `seafloor-atlas`; GitHub Pages is a mirror. The Cloudflare step needs the repository secret `CLOUDFLARE_API_TOKEN`.
