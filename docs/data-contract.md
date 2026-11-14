# Data contract (single source of truth)

Everything the pipeline writes and the web viewer reads. Change this file first, then code.

## Inputs (data/raw/, gitignored)

| File | What | Source |
|---|---|---|
| `gebco_2026/gebco_2026_elev_1arcmin.tif` | GEBCO_2026 ice-surface elevation, Int16 m, EPSG:4326, 21600 x 10800 (1 arc-min). Overview level 1 of the 15" COG. | COG mirror of the official grid (ausantarctic on Source Cooperative), checked against the official BODC/CEDA OPeNDAP server by `pipeline/verify_mirror.py` |
| `gebco_2026/gebco_2026_tid.tif` | GEBCO_2026 Type Identifier grid, Int8, 86400 x 43200 (15") | COG mirror (giswqs on Source Cooperative), same check |
| `plates/PB2002_boundaries.json` | Bird (2003) plate boundaries | github.com/fraxen/tectonicplates, ODC-By 1.0 |

Official citation: GEBCO Compilation Group (2026) GEBCO 2026 Grid (doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa). Licence: Open Government Licence v3 with attribution.

## TID classes

| Code | Group |
|---|---|
| 0 | land (also: any cell whose 1′ elevation is ≥ 0, e.g. the Antarctic ice sheet and ice shelves, which TID codes as non-land) |
| 10-17 | **direct** measurement (single beam, multibeam, seismic, isolated sounding, ENC sounding, lidar, optical, combination) |
| 40-48 | **indirect** (40 = predicted from satellite gravity, 41 interpolated, 42/43 chart contours, 44 mixed gridded, 45-48 other) |
| 70-72 | **unknown** (pre-generated grid, unknown source, steering points) |

"Measured" in this project means TID 10-17, the same split GEBCO uses for the Seabed 2030 mapped fraction.

## Derived grids (data/derived/, gitignored)

* `coverage_1arcmin.tif`: UInt8, same grid as the 1' elevation. Value = round(254 * direct / ocean) + 1 over ocean (1..255), 0 = land (no ocean sub-cell). Computed from the 4 x 4 block of 15" TID cells under each 1' cell.
* `stats.json`: global and per-band numbers (area-weighted by cos(lat)), consumed by figures and the viewer.

## Web tiles (web/public/tiles/, Web Mercator XYZ, 512 px, z0..maxzoom)

* `dem/{z}/{x}/{y}.webp`: lossless WebP, **Terrarium** encoding: `h = R*256 + G + B/256 - 32768` (integer metres, so B = 0; GEBCO is integer and fractional B from averaging doubled tile size). Alpha 255 everywhere.
* `coverage/{z}/{x}/{y}.webp`: lossless WebP RGBA "veil" over areas NOT directly measured.
  RGB = constant veil colour `#0b1424`; alpha = `round(VEIL_MAX * (1 - f))` over ocean where `f` = measured fraction; land alpha = 0.
  Decode for readouts: alpha == 0 and DEM h > 0 -> land; otherwise `f = 1 - alpha / VEIL_MAX`.
  `VEIL_MAX` is in `meta.json` (default 230).
* `meta.json`:
  ```json
  {"version": "GEBCO_2026", "tileSize": 512, "minzoom": 0, "maxzoom": 5,
   "encoding": "terrarium", "veilMax": 230, "veilColor": "#0b1424",
   "sourceResolutionArcsec": 60, "citation": "...", "doi": "...", "stats": { ... }}
  ```

## High-zoom archives (Hugging Face, z6-7)

* `dem_z6-7.pmtiles`, `coverage_z6-7.pmtiles` in the HF dataset `ismoilovdev/seafloor-atlas-tiles`. Same encodings as `dem/` and `coverage/`, 512 px, built from the 15" grids (`pipeline/tiles_hires.py`; coverage from a 15" measured flag, not from codes averaged).
* `meta.json` -> `"hires": {"maxzoom": 7, "dem": url, "coverage": url, "revision": sha}`; URLs are pinned to the upload commit (`resolve/<sha>/...`). No `hires` = the viewer stays at z0-5.
* Polar rows: values poleward of 84.92 deg are the cap mean (same as z0-5), so the pole has no radial artefact at any zoom.
* The viewer reads both homes through one `sfa://<layer>/{z}/{x}/{y}` protocol (`web/src/tilesource.ts`); the depth readout and profiles use the same path.

## Vector overlays (web/public/data/)

* `plates.geojson`: PB2002 boundary steps merged into lines. Properties: `type` in {ridge, rift, transform, subduction, convergent} (from PB2002 `STEPCLASS`: OSR/CRB/OTF+CTF/SUB/OCB+CCB), `cls`, `boundary` ("PA-NA"), `plates` (full names), `rate_mm_yr` (length-weighted mean relative velocity).
* `features.geojson`: 5,412 named undersea features as label Points, sorted by `rank` desc. Properties `id`, `name`, `kind`, `depth_m` (1' GEBCO at the label point; min within +-2' for deeps/trenches/basins), `rank` (extent in km), `geom` (point|line|polygon), `blurb`, `source`.
* `hypsometry.json` (`pipeline/hypsometry.py`): area of Earth's surface at or above a sea level L, from the 1' elevation grid with true spherical cell areas (R = 6371.0072 km). `{source, method, radius_km, earth_km2, today_km2, levels_m: [int], land_km2: [int]}`; `levels_m` is every 1 m from -500 to +200 m and every 10 m elsewhere from -11,000 to +9,000 m; `land_km2[i]` = area of cells with elevation >= `levels_m[i]`. Ice surfaces count as land; no isostasy. The viewer interpolates linearly between levels.
* `stories.json`: guided views `{id, title, blurb, center:[lon,lat], zoom, pitch, bearing, exaggeration, veil?}`; `veil: true` turns the coverage layer on. Centres are checked against the DEM tiles by `web/test/stories.test.ts`.

## Context overlays (shipping, wrecks, cables, offshore infrastructure)

Three human-activity layers on top of the seafloor. Each has its own licence, which differs from the MIT
licence of the code; the viewer must show the attribution line when the layer is on.

| Layer | Files | Script | Licence | Attribution to show |
|---|---|---|---|---|
| Shipping traffic density | `tiles/shipping/{z}/{x}/{y}.webp`, `tiles/shipping/legend.json` | `pipeline/shipping.py` | CC BY 4.0 | Shipping density: World Bank / IMF (Cerdeiro, Komaromi, Liu & Saeed 2020), CC BY 4.0 |
| Shipwrecks | `data/wrecks.geojson` | `pipeline/wrecks.py` | CC0 1.0 | Shipwrecks: Wikidata (CC0) |
| Submarine cables | `data/cables.geojson`, `data/landing-points.geojson` | `pipeline/cables.py` | **CC BY-NC-SA 3.0** | Submarine cables: TeleGeography Submarine Cable Map data, snapshot 2022-11-14, CC BY-NC-SA 3.0 (submarinecablemap.com) |
| Offshore platforms, subsea pipelines, offshore wind farms | `data/platforms.geojson`, `data/pipelines.geojson`, `data/windfarms.geojson` | `pipeline/offshore.py` | ODbL 1.0 | © OpenStreetMap contributors (ODbL) |

Every GeoJSON carries the same text in a top-level `metadata` object (`source`, `licence`, `attribution`, ...),
and `legend.json` has `licence` and `attribution`.

### Shipping traffic density (`tiles/shipping/`)

* Source: World Bank Data Catalog dataset 0037580 "Global Shipping Traffic Density",
  `shipdensity_global.zip` (https://datacatalog.worldbank.org/search/dataset/0037580). IMF World Seaborne
  Trade Monitoring System: number of AIS positions reported by all ship types in each 0.005° cell
  (about 500 m), Jan 2015 to Feb 2021, 85° S to 85° N. Licence CC BY 4.0.
* Processing: 4 x 4 block sums (0.02° grid, `data/derived/shipping_counts_0p02deg.tif`), divided by the
  spherical cell area and by 74/12 years, giving **AIS positions per km² per year**
  (`data/derived/shipping_density_0p02deg.tif`). Warped to Web Mercator 512 px z5 with GDAL `average`,
  z4..z0 are 2x2 means (zeros included, so every level is an area mean).
* Encoding: **lossy** WebP RGBA (quality 35, alpha quality 35: about 38.6 MB for 1,365 tiles), 512 px, z0-5; tiles with nothing to draw are tiny lossless transparent WebPs, so every z/x/y exists. Colour = matplotlib `inferno` (from 0.18 up) on
  `t = (log10(density) - log10Min) / (log10Max - log10Min)`, clipped to 0..1. Alpha: 0 for no traffic
  and below `transparentBelow`, ramps from 0 to `alphaMin` between `transparentBelow` and `10**log10Min`, then
  to `alphaMax` at `10**log10Max`. The pixel colour is a picture, not data: read values from the legend.
* `legend.json`: `{title, units, period, scale: "log10", log10Min, log10Max, transparentBelow, alphaMin,
  alphaMax, colormap, stops: [{value, log10, color}], tileSize, minzoom, maxzoom, source, sourceUrl,
  licence, attribution, tiles, emptyTiles, bytes}`; `stops` are the colours at log10Min, every whole log10 step and log10Max, for a
  legend bar.
* The values are counts of AIS position reports, so they mix vessel numbers, speed and reporting rate,
  and are best read as relative intensity. Satellite AIS coverage was weaker before about 2017 and in
  some busy regions, and the poles beyond 85° are not covered (transparent).

### Shipwrecks (`data/wrecks.geojson`)

* Source: Wikidata SPARQL endpoint (CC0), cached in `data/raw/wrecks/`:
  (a) items that are an instance of shipwreck (Q852190) or a subclass, with a coordinate (P625; a statement
  qualified "applies to part: shipwreck" is preferred, then preferred rank); (b) ships that are not typed
  as shipwrecks but whose "significant event" (P793) is shipwrecking (Q906512, or an event item that is
  an instance of it) with a coordinate qualifier on that event: only that event coordinate is used
  (`src: "event"`), e.g. RMS Lusitania, SS Andrea Doria.
* Kept only where the GEBCO_2026 1′ elevation at the point is < 0 (sea, or a basin below sea level such as the
  Caspian). Lakes above sea level (the Great Lakes, so the Edmund Fitzgerald) and wrecks in a 1′ cell that is land
  are dropped.
* Points sorted by `sitelinks` descending (most notable first, for label priority). Coordinates rounded to 1e-4°.
* Properties (absent = unknown):
  `id` (Wikidata QID), `name` (English label, else any label), `date` (`YYYY-MM-DD` of sinking, only when the
  day is known), `year`, `type` (most specific English P31 label other than shipwreck), `image` (Commons file
  name, for `https://commons.wikimedia.org/wiki/Special:FilePath/<image>?width=320`), `wiki` (English
  Wikipedia title, for `https://en.wikipedia.org/wiki/<wiki>`), `sitelinks`, `depth_m` (−elevation of the
  1′ GEBCO cell, m, > 0), `src` (`"event"` for set b).
* Date sources in order: start time (P580) of the shipwreck P31 statement, the shipwrecking event's point
  in time (P585) or start time (P580), dissolved (P576). The CSV results drop date precision, so 1 January is
  read as "year only".
* Caveats: `depth_m` is the grid depth at the Wikidata coordinate, not a surveyed wreck depth, and many
  coordinates are historical sinking positions. Wikidata is dominated by bulk imports of national
  records (Canmore and other UK/Ireland databases), so the density of points shows where records exist,
  not where ships sank.

### Submarine cables (`data/cables.geojson`, `data/landing-points.geojson`)

* Source: TeleGeography Submarine Cable Map data, `web/public/api/v3/` of the repository
  github.com/telegeography/www.submarinecablemap.com at commit `91265d81` (2022-11-14), the last public commit
  (the upstream repository no longer exists, so `pipeline/fetch_data.sh` gets the same commit from a fork that
  kept it). The snapshot's README and LICENSE file license the map data under **CC BY-NC-SA 3.0 Unported**.
  TeleGeography now sells current cable data, and its CC BY-SA 4.0 page covers only references to and screenshots
  of its maps, so **only this 2022 snapshot is used**, never the live site's API. The derived files are therefore
  CC BY-NC-SA 3.0: attribution, non-commercial use only, and adaptations under the same licence.
* `cables.geojson`: one MultiLineString per cable (segments merged, consecutive duplicate vertices dropped,
  coordinates rounded to 1e-4°; the drawings are already light, so there is no further simplification). Routes
  are TeleGeography's schematic drawings, not surveyed cable positions. Properties: `id`, `name`, `color`
  (TeleGeography's map colour), `length_km` (stated system length), `rfs` (ready-for-service text, e.g.
  "2018 May"), `rfs_year`, `planned` (status at the snapshot date), `owners`, `suppliers`, `url`,
  `landing_points` (ids into landing-points.geojson).
* `landing-points.geojson`: Points with `id`, `name`, `country`, `cables` (cable ids), `tbd` (location to be
  decided).

## Ocean water (web/public/woa/, `pipeline/woa.py`)

Source: **World Ocean Atlas 2023**, NOAA NCEI, the **1991-2020 climate normal** (`decav91C0`), objectively analysed
means only (`t_an` in-situ temperature ITS-90, `s_an` practical salinity). Subsets are read over the NCEI THREDDS
OPeNDAP server (`https://www.ncei.noaa.gov/thredds-ocean/dodsC/woa23/DATA/...`, ~0.5 MB/s here), so only the
needed variable and levels are downloaded (194 MB in `data/raw/woa23/`, gitignored):
annual 0.25° T and S at the 11 map depths, monthly 0.25° T at 0 m (t01-t12), annual 1° T and S at all 102 levels.

Density: TEOS-10 via `gsw`: `p = p_from_z(-z, lat)`, `SA = SA_from_SP(SP, p, lon, lat)`, `CT = CT_from_t(SA, t, p)`,
**σ0 = ρ(SA, CT, 0) − 1000 kg/m³** (potential density anomaly, surface reference). Computed only where both T and S exist.

* `manifest.json`: `period`, `citations`, `licence`, `variables.{t,s,d}` (`name`, `units`, `long`, fixed colour
  `range`, `cmap`), `map` and `columns` blocks below, `sizes_bytes`.
* `map/<v>_<depth>.bin` (v in t, s, d; depth in 0, 50, 100, 200, 500, 1000, 1500, 2000, 3000, 4000, 5000 m) and
  `map/t_m01..t_m12.bin` (monthly surface temperature): 0.25° grid, 1440 x 720, **row 0 = northernmost** (89.875° N),
  column 0 = 179.875° W. zlib-deflated **uint16 stored as two byte planes** (all 1,036,800 low bytes, then all high
  bytes). `q = 0` no data (land, or seafloor shallower than the depth); otherwise `value = lo + (q − 1) · step`,
  `lo` and `step` per layer in `manifest.map.layers[key]` (`step` = 0.01 °C, 0.005 for S and σ0). Each layer
  entry also has `hi`, `p2`/`p98` (2nd/98th percentile, used by "stretch colours to this depth"), `bytes`, `ocean_cells`.
* `col/<i>_<j>.bin`: 1° water columns in 30° x 30° regions, `i` = row block from the north (0..5), `j` = column
  block from 180° W (0..11); all-land blocks are not written. zlib-deflated little-endian **int16
  `[var t,s,d][level 0..101][row 0..29][col 0..29]`**, `value = offset[var] + q · 0.001`
  (offsets t 10, s 20, d 15), `q = −32768` no data. Levels are the 102 WOA standard depths 0-5,500 m
  (`manifest.columns.depths`). A level counts only where T and S both exist.
* Viewer: the map layer is one canvas source (2048 x 2048 Web Mercator image of the world, reprojected per pixel
  from the 0.25° grid, bilinear over valid neighbours, no data transparent) under the hillshade; hover values come
  from the same grid; clicking fetches one `col/` block (nearest ocean cell within 2° if the 1° cell is land).
* Checks: `tests/test_woa.py` (encodings, TEOS-10 against the IAPWS-08 and EOS-80 check values, oceanographic spot
  values on the built files), `web/test/water.test.ts` (decode, sampling, reprojection, colour scales, real files).

### Offshore infrastructure (`data/platforms.geojson`, `data/pipelines.geojson`, `data/windfarms.geojson`)

* Script `pipeline/offshore.py`; three Overpass API queries (cached in `data/raw/offshore/`, `--refresh` to
  re-query). Licence **ODbL 1.0**, attribution "© OpenStreetMap contributors (ODbL)". The three files are a
  derived database: public redistribution is allowed with the attribution, and it stays under ODbL.
* Preferred sources were checked first and skipped (2026-11-14): Global Fishing Watch / SkyTruth offshore
  infrastructure detections need a GFW account token (download API returns 401 without one); Global Energy
  Monitor gas/oil infrastructure and wind power trackers sit behind a download request form.
* "At sea" = GEBCO_2026 TID (15″) is not land (0) and the 1′ elevation is < 0. Country = the Marine Regions
  World EEZ v12 polygon at the point (`territory1`/`iso_ter1`; joint regimes and overlapping claims by
  `geoname`), else the nearest one within 0.1°.
* `platforms.geojson`: Points (way and relation centres), `man_made=offshore_platform` plus `seamark:type=platform`.
  A seamark-only element within ~100 m of a `man_made` one is dropped as a duplicate; kept when any 15″ cell of
  its 3 x 3 neighbourhood is at sea. Properties: `id` (`n|w|r` + OSM id), `name`, `type`, `status`
  (`abandoned` when tagged so), `operator`, `start` (OSM `start_date`, free text), `country`, `iso`, `depth_m`
  (−1′ GEBCO elevation), `wikidata`. `type` from tags: `wind` (power substation/transformer or a wind name),
  `oil` / `gas` / `oil_gas` (`substance`, `seamark:platform:category`, `industrial=oil`; production, FPSO
  and drilling count as `oil_gas`), `other` (observation, research, accommodation, island, helideck),
  else `unknown`. No detection date exists in OSM.
* `pipelines.geojson`: MultiLineStrings from `man_made=pipeline` + `location=underwater` with a hydrocarbon
  `substance` (gas, oil, condensate, ...; plus unknown substance when ≥ 10 km), kept when at least one
  vertex is at sea (drops river crossings). Ways with the same name and substance are merged into one
  feature; unnamed ways are line-merged per (substance, operator) into connected pieces. Simplified with
  a 0.0005° tolerance, coordinates rounded to 1e-5°. Properties: `name`, `substance` (`gas|oil|oil_gas|unknown`),
  `operator`, `status` (`disused` if tagged), `diameter` (raw tag), `length_km` (geodesic, unsimplified
  OSM geometry, underwater part only), `countries` (EEZs crossed, sampled every ~5 km), `osm` (way ids, named
  pipelines only, ≤ 20), `wikidata`. Sorted by length, longest first.
* `windfarms.geojson`: Points (centre of the OSM plant), `power=plant` + `plant:source=wind` whose centre is
  at sea **and** inside an EEZ polygon (TID is not 0 on some polders and coastal marshes, so the EEZ test
  removes onshore farms in the Netherlands and Germany). Properties: `id`, `name`, `capacity_mw` (from
  `plant:output:electricity`, GW/kW converted), `status` (`construction` if `start_date` is after 2026 or
  `construction=*`, else `operating`: a heuristic), `start`, `operator`, `turbines`, `country`, `iso`,
  `depth_m`, `wikidata`. Sorted by capacity. Nearshore farms in lakes and internal waters (IJsselmeer) are
  not included; a few dam or harbour-wall farms (Maasvlakte 2) are.
* Coverage is whatever OSM mappers have added (snapshot time in `metadata.osmTimestamp`). There are no
  satellite detections: single turbines are not points here, and Chinese offshore wind is under-mapped.

## Marine life (web/public/data/obis/, `pipeline/obis.py`)

Three layers answer three different questions, so the viewer can be honest about what a "fish map" shows:

| Question | Layer | Source | Licence | Attribution to show |
|---|---|---|---|---|
| Where have people looked? | `records_gh4` (+ `ocean_gh4`): OBIS records per geohash-4 cell, ocean cells with **no record** explicit | OBIS API `occurrence/grid/4` | OBIS data policy (cite OBIS) | Marine life records: OBIS (2026), www.obis.org |
| Where are species recorded? | `species_gh3`, `species_gh4` (raw counts), `es50_gh3` (sampling-corrected) | OBIS **speciesgrids** build 20261014 (OBIS + GBIF) | **CC BY-NC 4.0** | Species and ES50: OBIS speciesgrids (OBIS + GBIF), CC BY-NC 4.0 |
| Where should they live? | `aquamaps_richness` (model) | AquaMaps version 10/2019 | **CC BY-NC 3.0** | Predicted richness: AquaMaps (www.aquamaps.org, version 10/2019), CC BY-NC 3.0, with a link to www.aquamaps.org |

Because two inputs are non-commercial, the derived marine-life files are **CC BY-NC 4.0** as a whole (like the cable layer,
this differs from the MIT code licence). `manifest.json` carries `licence`, `attribution`, `attributionByLayer`, full
`sources.*.citation` strings and `caveats`.

Citations (exact text in `manifest.sources`):
* OBIS (2026) Ocean Biodiversity Information System. Intergovernmental Oceanographic Commission of UNESCO. www.obis.org
  (the form OBIS asks for; accessed 2026-11-14 through api.obis.org/v3).
* OBIS (2025). speciesgrids: gridded dataset of marine species occurrence (H3 resolution 7). OBIS, IOC-UNESCO.
  s3://obis-products/speciesgrids/ (build 20261014); Provoost, P. (2026) doi:10.5281/zenodo.19392660; GBIF.org (1 May 2024)
  doi:10.15468/dl.ubwn8z; WoRMS doi:10.14284/170.
* Kaschner, K., K. Kesner-Reyes, C. Garilao, J. Segschneider, J. Rius-Barile, T. Rees, and R. Froese (2019). AquaMaps:
  Predicted range maps for aquatic species. www.aquamaps.org, version 10/2019 ("Global Species Richness Map for All
  Marine Species", probability > 0.5, as mirrored by SPREP).

### Inputs (data/raw/obis/, gitignored)

* `api/*.json.gz`: cached OBIS API v3 responses (~70 requests, sequential, 1 s pause, User-Agent names this repo).
  `occurrence/grid/4?geometry=<geohash1>` for each of the 32 geohash-1 regions (≤ 32,768 cells each, under the API's
  100,000-feature cap); cells the API returns from a neighbouring region are dropped so nothing is counted twice.
  Group grids `occurrence/grid/3?taxonid=...`, `checklist?taxonid=...&size=5000`, `statistics`.
* `speciesgrids/rgNNN.parquet`: the 41 row groups of `speciesgrids/20261014/h3_7/data.parquet`, read from the public
  bucket with column projection (geometry and year columns skipped: ~730 MB instead of 1.5 GB). Each row = one WoRMS
  species in one H3 resolution-7 cell (~5 km²) with its record count and source flags.
* `aquamaps/Global_2020_MarineSpeciesRichness_AquaMaps.csv`: 174,321 half-degree C-squares with `Species Count`.
* `common_names.json`: English common names (iNaturalist, WoRMS fallback) for the group top-species lists only.

### Grids and encoding

All grids are regular latitude/longitude, **row 0 = north (90° N), column 0 = 180° W**, cell-aligned with geohashes:

| Grid | Cell | Size | Use |
|---|---|---|---|
| `gh4` | 0.3515625° lon × 0.17578125° lat (geohash precision 4, ~39 × 20 km at the equator) | 1024 × 1024 | records, ocean share, raw species |
| `gh3` | 1.40625° × 1.40625° (geohash precision 3, ~156 km) = 4 × 8 `gh4` cells exactly | 256 × 128 | ES50, species, groups, click lists |
| `csquare_0p5` | 0.5° | 720 × 360 | AquaMaps |

`grid/<layer>.bin` = zlib-deflated little-endian unsigned integers stored as **byte planes** (all byte 0s, then all byte 1s,
...; same idea as `woa/map/*.bin`), `ncol × nrow` row-major. `manifest.layers[layer]` gives `grid`, `dtype`
(`uint8|uint16|uint32`), `bytes` and the meaning of the value:

* `records_gh4`, `records_gh3` (uint32): OBIS occurrence records (all ranks, presence records) in the cell; 0 = none.
* `ocean_gh4`, `ocean_gh3` (uint8): ocean share of the cell × 255 (GEBCO ocean mask of this repo: TID ≠ 0 and
  elevation < 0). Draw "no records" only where this is > 0.
* `species_gh4`, `species_gh3`, `species_fish_gh3` (uint16): distinct species in speciesgrids (fish = classes
  Teleostei, Elasmobranchii, Holocephali, Myxini, Petromyzonti, Holostei, Chondrostei, Cladistii, Coelacanthi).
* `records_sg_gh3` (uint32): species-level records in speciesgrids (OBIS + GBIF), the N behind ES50.
* `es50_gh3`, `es50_fish_gh3` (uint16): **ES50 = (q − 1) / 100**; q = 0 = fewer than 50 records ("not enough data").
* `aquamaps_richness` (uint16): AquaMaps predicted species; 0 = no prediction.

`manifest.scales` suggests colour scales (log10 for records/species/AquaMaps, linear 1–50 for ES50, a grey for
"no records" and "not enough data"). The viewer reprojects these grids itself (like the WOA layer); there are no
raster tiles. Reason: the whole set is ~1 MB with exact values for hover and click, versus several MB of tiles that
only carry colours.

**ES50** (Hurlbert 1971; the OBIS diversity indicator): for a cell with N species-level records, N_i of species i,
ES50 = Σ_i [1 − C(N − N_i, 50) / C(N, 50)] (computed with log-gamma), per `gh3` cell from all speciesgrids rows whose
H3 centre falls in the cell. The OBIS API has no ES50 endpoint, so it is computed here. Sensitivity variants (in
`manifest.stats.correlation`): only species flagged as present in OBIS, without birds, and incidence-based (each
occupied H3-7 cell counts as one "record").

### Groups (`groups/index.json`, `groups/<id>.json`)

whales (Cetacea), sharks (Elasmobranchii), turtles (Cheloniidae + Dermochelyidae), corals (Scleractinia), tunas
(Thunnini genera), penguins (Spheniscidae), seals (Pinnipedia), cephalopods, deepfish (fish records at ≥ 1,000 m).
Each file: `stats` (OBIS records, species, datasets, year range, cells), `top` (25 species with most OBIS records:
`aphiaId`, `name`, `common` (iNaturalist preferred English name, else first English WoRMS vernacular, may be empty), `records`, `iucn`), and `cells.data` =
`[col, row, records, species]` on `gh3` (records from the API, OBIS only; species from speciesgrids). Deep-sea fish
has no per-cell species (speciesgrids has no depth); of the 100 species with most deep records, those with less than
20 % of all their OBIS records at ≥ 1,000 m are flagged "mostly shallow" (60 of 100, e.g. swordfish, mackerel, blue shark,
yellowfin tuna: a bottom or gear depth recorded as the fish's depth). They are dropped from the top list and their deep
records (one extra `grid/3` request) are subtracted from the cells: 410,218 deep records → 209,288 on the grid
(`stats.flaggedMostlyShallow`, `recordsOfFlagged`, `recordsRemovedFromGrid`). Species outside the checked 100 are not filtered.

### Click info (`cells/<geohash2>.json`)

One file per geohash-2 block (11.25° × 5.625°), keyed by the `gh3` cell's geohash-3:
`{"r": OBIS records, "s": species, "e": ES50 or null, "top": [[AphiaID, name, records], ...]}` (up to 10 species with
most speciesgrids records). Links: `https://obis.org/taxon/{AphiaID}`, `https://www.marinespecies.org/aphia.php?p=taxdetails&id={AphiaID}`.
Live alternative (same cell): `https://api.obis.org/v3/checklist?geometry={geohash3}&size=20` (taxa of all ranks,
sorted by OBIS records; filter `taxonRank == "Species"`). CORS: `Access-Control-Allow-Origin: *`, checked from
https://ismoilovdevml.github.io in a real browser (checklist ~1.2 s, statistics ~0.2 s).

### Caveats (also in `manifest.caveats`)

* Records and raw species counts map **sampling effort** as much as biology (coasts, rich countries, research cruises,
  ship tracks); see `stats.correlation`. Absence of records is not absence of species.
* ES50 corrects for the number of records, not for where or what was sampled (a plankton-survey track or a bird
  survey gives that group's ES50).
* speciesgrids merges OBIS and GBIF: datasets in both can be counted twice, and GBIF bird observations are a large
  share of coastal records. Records span the 1700s to 2026.
* Names follow WoRMS at build time (synonyms merged); misidentified or mislocated records remain unless OBIS flagged them.
* The OBIS index changes while the API is queried (global totals moved by ~0.3 % within an hour on 2026-11-14).
* AquaMaps is a model (environmental envelopes plus expert ranges), smooth by construction, and excludes species with
  fewer than 10 good occurrence cells; per-group AquaMaps richness is not included (see below).
* Not included: per-group AquaMaps richness (needs the 1.25 GB `am.db.bz2`, ~10 GB unpacked SQLite, from
  archive.org/details/aquamapsdb, version 2019) and a chlorophyll layer (NASA OceanColor file search returned no
  public climatology without an Earthdata login).

## How sure is the depth? (model disagreement, seal dives, prediction confidence)

Three analysis layers from open Zenodo datasets (all CC BY 4.0). Raw files go in `data/raw/<name>/` (gitignored,
~1.8 GB together); md5 checked against the Zenodo record on download (2026-11-14).

| Layer | Files | Script | Attribution to show |
|---|---|---|---|
| Model disagreement | `tiles/disagree/{z}/{x}/{y}.webp`, `tiles/disagree/legend.json` | `pipeline/disagree.py` | Model disagreement: AUST_2026_BAT (Yuan & Yang 2026, doi:10.5281/zenodo.22711109, CC BY 4.0) minus GEBCO_2026 (OGL v3) |
| Seal dives deeper than the chart | `data/seals.geojson`, `data/seals-coverage.geojson` | `pipeline/seals.py` | Seal dives: SO-ABBA v1.0 (Hindell, McMahon, Jonsen et al. 2026, doi:10.5281/zenodo.19121676), CC BY 4.0; compared with GEBCO_2026 |
| Prediction confidence | `tiles/uncertainty/{z}/{x}/{y}.webp`, `tiles/uncertainty/legend.json` | `pipeline/uncertainty.py` | Prediction confidence: Nilsson, Phrampus, Sandwell et al. (2025), SWOT ML bathymetry confidence level v1.1, doi:10.5281/zenodo.17673974, CC BY 4.0 |

Every `legend.json` / GeoJSON `metadata` carries `citation`, `licence` and `attribution`. Statistics:
`data/derived/disagree_stats.json`, `seals_stats.json`, `uncertainty_stats.json`. Figures: `figures/fig7_model_disagreement.png`,
`figures/fig8_seals.png`.

### Model disagreement (`tiles/disagree/`)

* Source: Yuan, J. & Yang, C. (2026) *AUST_2026_BAT: A Global Bathymetry Model Derived from Multi-Scale Marine
  Gravity Anomalies Using Fully Connected Deep Neural Networks and Adaptive Multi-Factor Spatial Partitioning* (v2026).
  Zenodo. doi:10.5281/zenodo.22711109. `AUST_2026_BAT.nc` (386 MB): GMT pixel-registered 1′ grid, 21600 × 9000,
  75° S – 75° N, variable `z` (m, up positive). Ocean = neural-network prediction from SIO V33.1 marine gravity, trained
  on NCEI ship soundings; land filled from GEBCO_2025. Its cell centres coincide with GEBCO's 1′ centres, so the
  comparison is cell for cell (no resampling).
* Difference `AUST − GEBCO_2026` (1′ = mean of 4 × 4 15″ cells) over ocean (TID ≠ 0 and 1′ elevation < 0), minus the
  Caspian Sea and Lake Baikal boxes. Classes from `coverage_1arcmin.tif`: measured = all 16 sub-cells TID 10–17,
  unmeasured = none, partial = the rest. Area-weighted (spherical cell area). Derived grids:
  `data/derived/disagree_1arcmin.tif` (signed difference), `disagree_tiles_src.tif` (what the tiles show).
* **Shown on the map only where the GEBCO depth is ≥ 1,000 m and < 50 % of the 1′ cell is measured.** On shelves and
  upper slopes AUST is systematically too deep (GEBCO < 1,000 m: 98.7 % of the |diff| > 500 m area has AUST deeper; in
  19.8 % of that area AUST is more than twice the GEBCO depth; Gulf of Carpentaria: GEBCO median 54 m, AUST 196 m).
  Those differences are AUST errors, not genuine uncertainty. All depth bands remain in the statistics.
* Encoding: **lossy** WebP RGBA (quality 50), 512 px, z0–5, 1,365 tiles (660 fully transparent, stored as tiny lossless
  WebPs), 41.6 MB. Colour = matplotlib `plasma` from 0.12 on `t = (log10|diff| − log10 50) / (log10 1000 − log10 50)`,
  clipped; alpha 110 → 235 along `t`; transparent below 50 m, on land, measured-majority cells, shelves, and beyond
  75° (polar caps blank). z4..z0 are NaN-aware 2 × 2 means of |diff| (mean disagreement of the shown pixels).
  The colour is a picture: read values from `legend.json` (`stops`, `vmin`, `vmax`, `headline`).
* Numbers (GEBCO depth ≥ 1,000 m): unmeasured 203.9 M km², median |diff| **60.5 m**, RMS 190.9 m, p95 402.5 m,
  35.1 % > 100 m, 16.6 % > 200 m, 3.0 % > 500 m. Measured 84.8 M km²: median 46.5 m, RMS 174.1 m, p95 365.5 m.
  By TID of the unmeasured cell: 40 (gravity) median 59.5 m, 41 (interpolated) 46.5 m.
* Honest reading: (1) measured cells are **not** an independent validation; AUST was trained on NCEI soundings that GEBCO
  also contains, and AUST does not replace its prediction with the soundings, so there the difference is mostly AUST's
  own (in-sample) prediction error. (2) In unmeasured cells both depths are satellite-gravity predictions from
  overlapping inputs (SIO-type gravity; GEBCO's base is SRTM15+), so where they disagree at least one is wrong, and where
  they agree both can still be wrong: the difference is a lower bound on the real uncertainty, not an error estimate.
  (3) Unmeasured cells disagree only ~30 % more than measured ones (median 60.5 vs 46.5 m), so a large part of the map is
  AUST's own 1′ prediction noise; patterns at 10–100 km scale (zoom 0–3) are more meaningful than single pixels.

### Seal dives deeper than the chart (`data/seals.geojson`, `data/seals-coverage.geojson`)

* Source: Hindell, M., McMahon, C., Jonsen, I., Harcourt, R., Guinet, C., Picard, B., Coleman, R., Padman, L., Fedak, M.,
  Blight, C., Costa, D. P., Bester, M., Bornemann, H., Charrassin, J.-B., Labrousse, S., Campagna, C., Campagna, J.,
  Boehme, L., Lee, W. Y., Kokubun, N., Takahashi, A., Muelbert, M. M. C., Lowther, A., McCormack, F., Ribeiro Santos, N.,
  Post, A., Holland, M., Wege, M. & Raymond, B. (2026) *SO-ABBA: A Southern Ocean Animal-Borne Bathymetry Analysis*
  (v1.0). Zenodo. doi:10.5281/zenodo.19121676. `SO-ABBA-v1.0.parquet` (439 MB): 5,167,124 rows; **4,492,019 with
  `flag == 1`** (the authors' reliable-depth filter, `MATLAB_seal_read.m`), 1996-12 to 2025-08, 78.3° S – 50.0° S.
  Columns used: `max_dep` (maximum dive depth, m, positive down), `lon`/`lat` (state-space-model location), `x_se`/`y_se`
  (location standard errors, m; median max(x_se, y_se) = 2.0 km), and for the check `pt_elevation` /
  `ellipse_elev_deepest` (IBCSO v2 at the point / deepest IBCSO v2 in the error ellipse).
* Test per dive: excess = `max_dep` + GEBCO_2026 elevation. Two chart depths: (a) at the point, 15″ bilinear; (b) the
  **deepest 15″ cell in a box of half-width 1 × max(x_se, y_se)** around the location (rounded up to whole cells; the
  box contains the 1-σ error ellipse). 1 σ reproduces the authors' `ellipse_elev_deepest` best (200 k dives where GEBCO =
  IBCSO at the point: median difference 2 m, 81 % within 20 m; 0.5 / 1.5 / 2 / 3 σ give +12 / −4 / −14 / −33 m).
  "Deeper than the chart" = excess > 20 m with (b), i.e. beyond the location uncertainty.
* `seals.geojson`: Points at 0.1° bin centres, **only bins with ≥ 1 such dive**, sorted by `x` ascending (largest excess
  drawn last). Properties: `n` dives, `d` dives deeper than the chart beyond the uncertainty, `dp` deeper than the chart
  at the point, `x` largest excess in the bin (m), `md` deepest dive (m), `cd` mean GEBCO depth at the dives (m, positive
  down). Share = `d / n`.
* `seals-coverage.geojson`: Points at 0.5° bin centres for every bin with a dive, `n` and `d`: where seals sampled at
  all (no point in a bin = no seal data, not "chart confirmed").
* Numbers vs GEBCO_2026: **2.18 % of dives (97,933) are > 20 m deeper than the chart beyond the location uncertainty**
  (0.25 % > 200 m); at the point (paper's definition) 6.97 % (1.02 % > 200 m). With a 2-σ box: 1.02 %. Excess of those
  dives: median 64 m, p90 215 m, max 1,636 m. By charted depth: 12.0 % of dives where GEBCO says < 200 m, 3.1 % at
  200–500 m, 1.6 % at 500–1,000 m, 0.7 % at 1–2 km, 0 below 2 km (seals rarely reach the bottom there). 35.6 % of dives
  are in GEBCO-measured 15″ cells; 1.8 % of those are still deeper than the chart (vs 2.3 % in unmeasured cells).
* Check of our reading against the paper with the file's own IBCSO v2 columns: point ≥ 20 m **8.47 %**, ≥ 200 m 1.32 %
  (abstract: 8.4 % and 1.3 %), ellipse ≥ 20 m 2.84 %. So the abstract's 8.4 % is the point comparison. GEBCO_2026 vs
  IBCSO v2 at the dive points: median |Δ| 10.6 m, 36.7 % differ by > 20 m (likely resampling of the 500 m polar grid to 15″
  plus newer data; not checked further), which is why our point share (7.0 %) differs from the paper's 8.4 %.
* Caveats: a dive's maximum depth is a lower bound on the seafloor depth only where the seal reached it; `max_dep`
  does not tell whether the seal was on the bottom, so the test can only find charts that are **too shallow**, never too
  deep. Tag pressure-sensor errors and dives assigned to a wrong position beyond 1 σ remain possible; the 2-σ number
  is the conservative bound. Sampling follows where the tagged seals foraged (`seals-coverage.geojson`), not a
  survey design; the file has no per-seal id (85 tag `unittype` values), so dives are not independent samples.

### Prediction confidence (`tiles/uncertainty/`)

* Source: Nilsson, B., Phrampus, B. J., Salajegheh, F., Liu, B., Yu, Y., Sandwell, D., Harper, H., Andersen, O. B.,
  Smith, W. H. F., Elmore, P., Kirby, J., Beale, J., Roberts, J. & Altamirano, L. (2025) *Bathymetry Prediction with SWOT
  Gravity Anomaly using Machine Learning Methods: Paper 2 – Model Evaluation and Uncertainty Analysis*. Zenodo.
  doi:10.5281/zenodo.17673974. File `Bathymetry_Prediction_Confidence_Level_v1.1.nc` (981 MB, model v1.1.0, created
  2025-11-21): 1′ grid, 21600 × 9600, 80° S – 80° N, cell centres = GEBCO's 1′ centres.
* Meaning (from the file's global `description`; the variables have no attributes and the paper DOI in the file is a
  placeholder): `classification` 0 = contains a sounding, 1 = high, 2 = medium, 3 = low confidence in the prediction,
  4 = land; `predicted_error` = "numerical value of the predicted error (more noisy than classification level)",
  computed from gravity-field features and the distance to ship soundings. **No unit or statistical definition is given.**
  Measured here: in every non-sounding cell class 1 ⇔ `predicted_error` < 80, class 2 ⇔ 80–150, class 3 ⇔ > 150, and the
  median |AUST − GEBCO| per class (39 / 100 / 182 m) is close to the median `predicted_error` (51 / 104 / 178), so it
  behaves like metres of depth error. It describes the authors' SWOT-gravity ML bathymetry, **not GEBCO_2026**.
* Tile value: `predicted_error` where class 1–3 and GEBCO says ocean; NaN for class 0 (sounding), land, beyond 80°.
  z5 warped with GDAL `average`, z4..z0 NaN-aware 2 × 2 means, then classed with the file's thresholds (< 80 high,
  80–150 medium, > 150 low). Lossless WebP RGBA, 1,365 tiles, 9.1 MB. Colours: high `#4fb3bf` alpha 70, medium
  `#f2b705` alpha 160, low `#e03e52` alpha 225 (`legend.json.classes`).
* Validation (`uncertainty_stats.json`, area-weighted): of GEBCO ocean 80° S – 80° N, class 0/1/2/3 = 26.2 / 42.8 /
  24.0 / 6.7 %. 64 % of class-0 area is GEBCO-measured (their sounding set is not GEBCO's), 75 / 83 / 85 % of class
  1 / 2 / 3 is GEBCO-unmeasured. Against |AUST − GEBCO| (GEBCO ≥ 1,000 m, no sounding, 75° S – 75° N): Spearman
  **0.44** per 1′ cell (Pearson 0.39; 0.44 in GEBCO-unmeasured cells only), **0.63** for 15′ block means (n = 418,421).
  Both are partly circular (both grow where gravity-to-depth prediction is hard, e.g. rough seafloor, far from tracks),
  so this shows consistency, not an independent calibration.
* Note: Zenodo 24085730 (Phrampus 2026, "Global bathymetry with calibrated uncertainty") was the first choice, but its
  files are restricted (HTTP 403), so this earlier open confidence product is used.

### Checks (build of 2026-11-14, all in `manifest.stats`; `tests/test_obis.py`)

* **Data gap** (share of ocean area): 45.3 % of the ocean lies in `gh4` cells (~39 × 20 km) with **no OBIS record**,
  88.2 % in cells with fewer than 50, 97.9 % with fewer than 1,000. At `gh3` (~156 km): 1.9 % / 29.2 % / 74.8 %.
* **Effort vs species**: records and species per cell, Spearman ρ = 0.74 (`gh4`, 437,432 cells) and 0.77 (`gh3`,
  26,976 cells; Pearson on log10 0.79). ES50 vs records only ρ = 0.36. ES50 exists for 73.6 % of the ocean area
  (fish ES50: 33.3 %). ES50 sensitivity (ρ against the served ES50): OBIS-flagged species only 0.94, without birds 0.93,
  incidence-based 0.92.
* **Same regions, three measures** (median `gh3` cell; rank among 7 regions):

  | Region | OBIS records | raw species | ES50 | AquaMaps |
  |---|---|---|---|---|
  | North Sea | 270,110 (1) | 1,646 (1) | 32.0 (5) | 663 (4) |
  | Western Mediterranean | 12,444 (2) | 1,365 (2) | 35.8 (3) | 640 (5) |
  | Great Barrier Reef | 1,613 (3) | 686 (3) | 38.1 (2) | 1,303 (2) |
  | Caribbean | 1,577 (4) | 355 (4) | 33.8 (4) | 767 (3) |
  | Coral Triangle | 712 (6) | 351 (5) | **41.9 (1)** | **2,403 (1)** |
  | Central North Pacific gyre | 31 (7) | 17 (7) | 29.8 (6; 129 of 308 cells) | 387 (6) |
  | Southern Ocean, Indian sector | 816 (5) | 34 (6) | 13.1 (7) | 63 (7) |

* Richest raw `gh3` cells: Sydney (r3g, 12,169 species, 10.6 M records), Florida Keys (dhm, 8,520), Townsville / central
  Great Barrier Reef (rk8, 8,516), New Caledonia (rsn, 8,463), Moreton Bay (r7j, 8,132); Cairns/Lizard Island cells
  (rjp, rjr) also in the top 10. AquaMaps' top 10 are all Taiwan–Philippines–Indonesia (max 9,887 species).
* Blue whale (AphiaID 137090): 24,522 OBIS records, 5,612 south of 50° S, 13,889 in the NE Pacific (20–60° N,
  170–110° W). Leatherback (137209): 25,792 records from 65.4° N to 47.1° S (1–99 % of records 38.7° S–55.6° N),
  consistent with its known range into subpolar waters.
