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
| Submarine telecom cables from OSM (supplement to the 2022 snapshot) | `data/cables-osm.geojson` | `pipeline/cables_osm.py` | ODbL 1.0 | © OpenStreetMap contributors (ODbL) |

Every GeoJSON carries the same text in a top-level `metadata` object (`source`, `licence`, `attribution`, ...),
and `legend.json` has `licence` and `attribution`.

**Weekly refresh.** `platforms`, `pipelines`, `windfarms`, `wrecks` and `cables-osm` are re-queried every Monday by
`.github/workflows/refresh-data.yml` (`pipeline/refresh_overlays.py`). A new file replaces the old one only when it
parses, keeps the `metadata.attribution`/`licence` above, has the expected geometry type, valid coordinates, the
required properties and unique ids, stays under its size limit, and its feature count is within ±20 % of the old
file. Files whose features did not change are not rewritten. Formats below do not change with a refresh; counts do.
Details and roll-back: `docs/maintenance.md`.

### Shipping traffic density (`tiles/shipping/`)

* Source: World Bank Data Catalog dataset 0037580 "Global Shipping Traffic Density",
  `shipdensity_global.zip` (https://datacatalog.worldbank.org/search/dataset/0037580). IMF World Seaborne
  Trade Monitoring System, all ship types, one value per 0.005° cell (about 500 m), Jan 2015 to Feb 2021,
  85° S to 85° N. Licence CC BY 4.0. The catalogue describes the values as the number of AIS positions; they are
  not (the raster sums to 6.56e14 and one hourly fix of one ship carries 10^2-10^6.6), so the unit is an
  undocumented relative intensity (`docs/shipping_gap.md`).
* Processing: 4 x 4 block sums (0.02° grid, `data/derived/shipping_counts_0p02deg.tif`), divided by the
  spherical cell area and by 74/12 years, giving **raster value per km² per year** (relative intensity)
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
* The values are weighted AIS positions with an undocumented weight, so they mix vessel numbers, speed,
  reporting rate and that weight, and can only be read as relative intensity. Satellite AIS coverage was weaker before about 2017 and in
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

### Submarine cables from OpenStreetMap (`data/cables-osm.geojson`, supplement)

* Why: the open TeleGeography data stops at 2022-11-14 and lists 2022 status (2Africa, Equiano, Firmina, Bifrost,
  Echo, Apricot are "planned" there). OSM is the only open, maintained cable geometry. Script `pipeline/cables_osm.py`,
  one Overpass query, refreshed weekly. Licence **ODbL 1.0**, attribution "© OpenStreetMap contributors (ODbL)".
* Tagging (checked on taginfo and with Overpass counts, 2026-11-15): ways with `communication=line` plus
  `location=underwater|submarine`, `submarine=yes` or `seamark:type=cable_submarine`; `telecom=line` underwater;
  `seamark:type=cable_submarine` with `seamark:cable_submarine:category` telephone / fibre_optic / telecommunication
  (and spelling variants). Excluded: `power=cable`, the power / transmission categories, and uncategorised seamark
  cables (≈5,700 ways, mostly a Finnish fairway import, not separable from power cables).
* Kept when at least one vertex is at sea (the GEBCO test of `offshore.py`), so lake and river crossings drop out.
  Ways with the same name are merged into one feature; unnamed ways are line-merged per operator into connected
  pieces and kept from 1 km. Simplified with 0.0005°, coordinates rounded to 1e-5°. Sorted by length.
* MultiLineStrings. Properties (absent = unknown): `name`, `operator` (else `owner`), `start_date` (raw OSM text,
  earliest of the merged ways), `status` (`disused` when tagged so), `length_km` (geodesic, OSM geometry
  before simplification), `osm` (way ids `w…`, ≤ 20; `osm_ways` = total when more), `in_tg2022` (bool: the
  normalised name matches a cable of `cables.geojson`), `tg_id` / `tg_name` (the matched snapshot cable),
  `wikidata`. `metadata.stats` has the counts below.
* Name matching: accents, case and punctuation removed; the words cable / system / submarine / fibre / telecom
  dropped; parenthesised acronyms ("(FEA)") and "/" alternatives tried on their own; on the OSM side segment,
  branch, phase and direction suffixes ("SEG 10.4", "S2.1", "South") dropped. Exact key match only.
  `tests/test_refresh_overlays.py` pins examples. A cable not in the snapshot is called newer only when its
  OSM `start_date` is certainly after 2022-11-14 (partial dates count from their first day).
* Report: `docs/cables-osm.md` (generated, not edited by hand): counts, the known post-2022 cables, the
  not-in-snapshot list split by start date, and every match.
* Coverage (2026-11-15): 405 features, 279 named cables, 240,311 km; 108 named cables match the snapshot. OSM
  mappers rarely draw long-haul cables (routes are not verifiable on the ground): the layer is mostly North Sea,
  Baltic, Channel and Mediterranean chart cables, plus retired systems (TAT-8 to TAT-13, PTAT) that
  TeleGeography no longer lists. It adds coastal detail; it does not replace the snapshot.

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

## Phytoplankton, winds and currents (web/public/chl/, web/public/flow/; `pipeline/chlorophyll.py`, `pipeline/flow.py`)

Three monthly climatologies (12 months + annual) in the same zlib byte-plane style as `web/public/woa/`, reprojected
in the browser. All three are open data that may be redistributed with attribution.

| Layer | Source (exact product) | Period | Grid served | Licence | Attribution to show |
|---|---|---|---|---|---|
| Chlorophyll-a | NASA OBPG **MODIS-Aqua L3m CHL `chlor_a` R2022.0** (`MODISA_L3m_CHL` v2022.0, processing R2022.0.3), 9 km **MC** (monthly) and **CU** (cumulative = annual) mission climatologies | MC: 2002/2003 to 2025/2026 (per month in `layers[].period`); CU: 2002-07-04 to 2025-11-30 | 0.25°, 1440 x 720 | NASA Earth Science Data and Information Policy: free and open, no restrictions | Chlorophyll-a: NASA OBPG, MODIS-Aqua R2022.0 climatology (doi:10.5067/AQUA/MODIS/L3M/CHL/2022.0) |
| Winds | **NCEP/NCAR Reanalysis 1**, 10 m `uwnd`/`vwnd`, long-term monthly means 1991-2020 (`surface_gauss/{u,v}wnd.10m.mon.ltm.1991-2020.nc`, NOAA PSL) | 1991-2020 | 1°, 360 x 180 (from the T62 Gaussian grid, 192 x 94, ~1.9°) | NOAA PSL: public, no restrictions (US Government work), acknowledge | Winds: NCEP/NCAR Reanalysis 1, 1991-2020 monthly means (NOAA PSL) |
| Currents | **OSCAR v2.0 final** (`OSCAR_L4_OC_FINAL_V2.0`, ESR / NASA PO.DAAC), daily 0.25° total current, top-30 m mean | 2015-2024, days 1, 5, 10, 15, 20, 25 of every month (60 snapshots per calendar month, 720 granules) | 0.25° native nodes, 1440 x 719 | NASA Earth science data, free and open ("may be freely distributed"), cite the DOI | Currents: OSCAR v2.0 (ESR, NASA PO.DAAC), 2015-2024 monthly means |

Citations (also in each `manifest.json`):

* NASA Ocean Biology Processing Group (2022). MODIS-Aqua Level-3 Global Mapped Chlorophyll (CHL) Data, version R2022.0.
  NASA OB.DAAC, Greenbelt, MD, USA. doi:10.5067/AQUA/MODIS/L3M/CHL/2022.0. Algorithm (OCI): Hu, C. et al. (2019),
  J. Geophys. Res. Oceans 124, 1524-1543, doi:10.1029/2019JC014941; O'Reilly, J.E. and Werdell, P.J. (2019), Remote
  Sens. Environ. 229, 32-47, doi:10.1016/j.rse.2019.04.021.
* Kalnay, E. et al. (1996). The NCEP/NCAR 40-Year Reanalysis Project. Bull. Amer. Meteor. Soc. 77, 437-471,
  doi:10.1175/1520-0477(1996)077<0437:TNYRP>2.0.CO;2. "NCEP/NCAR Reanalysis 1 data provided by the NOAA PSL, Boulder,
  Colorado, USA, from their website at https://psl.noaa.gov".
* ESR (2022). OSCAR ocean surface currents, version 2.0 final, 0.25° daily. PO.DAAC, CA, USA. doi:10.5067/OSCAR-25F20.
  Method: Dohan, K. (2017), J. Geophys. Res. Oceans 122, 2647-2651, doi:10.1002/2016JC012246.

### Inputs (data/raw/, gitignored) and access

* `chl/` (195 MB): 12 MC + 1 CU NetCDF files, the newest granule per month found by a public CMR search, downloaded
  from `https://oceandata.sci.gsfc.nasa.gov/getfile/<name>` with Earthdata Login (`~/.netrc`). The cloud links
  CMR also lists (`obdaac-tea.earthdatacloud.nasa.gov`) refuse the download (401) unless the MERIS and Sentinel EULAs
  are accepted in the Earthdata profile; `getfile` does not need them. The OBPG OPeNDAP server returned HTTP 429.
* `wind/` (2.3 MB): the two NetCDF files from `https://downloads.psl.noaa.gov/Datasets/ncep.reanalysis.derived/surface_gauss/`
  (public; the `ncep.reanalysis/Monthlies/` path returns 403 to scripts).
* `oscar/` (~350 MB): `accum_MM.npz` running sums per calendar month (`su`, `sv`, `ss2` = Σu²+v², `n` count, float64
  on the native 719 x 1440 node grid) and `done.json` (granules already summed). Each granule is fetched as a u/v-only
  DAP4 subset (`https://opendap.earthdata.nasa.gov/collections/C2098858642-POCLOUD/granules/oscar_currents_final_YYYYMMDD.dap.nc4?dap4.ce=/u;/v`,
  ~9 MB, Earthdata Login), added and deleted. ~6.5 GB transferred in total; resumable.
* Credentials are never stored here: curl reads `~/.netrc` and keeps the session cookie in a temporary directory that
  is deleted after the run (`pipeline/earthdata.py`).

### Files and encoding

* `chl/01.bin` .. `chl/12.bin`, `chl/annual.bin`: 0.25° grid, 1440 x 720, **row 0 = northernmost** (89.875° N),
  column 0 = 179.875° W, exactly like `woa/map/`. zlib-deflated **uint16 as two byte planes** (all low bytes, then all
  high bytes). `q = 0` no data (land, ice, persistent cloud, polar night); otherwise
  **log10(chl in mg/m³) = lo + (q − 1) · step**, `lo = −3`, `step = 0.001` (fixed for all layers, in
  `manifest.grid`). Built as the 3 x 3 block mean of log10(`chlor_a`) of the 9 km grid (geometric mean) where at least
  3 of the 9 pixels are valid. Default colour range 0.01-20 mg/m³ on a log scale (`manifest.variable.range`,
  the OBPG display range), colormap cmocean `algae`.
* `chl/manifest.json`: `source`, `product`, `doi`, `citations`, `licence`, `attribution`, `variable`, `grid`,
  `months`, `layers[key]` (`source_file`, `period`, `time_coverage`, `bytes`, `ocean_cells`, `log10_p2/p50/p98`),
  `caveats`.
* `flow/{wind,currents}/01.bin` .. `12.bin`, `annual.bin`: regular grid, row 0 = northernmost, column 0 = westernmost
  from 180° W, longitudes wrap; row `r` is at latitude `lat0 − r · res_deg`, column `c` at longitude `lon0 + c · res_deg`
  (`manifest.grid`: `res_deg`, `width`, `height`, `lat0`, `lon0`). Sample bilinearly between those points.
  zlib-deflated **u then v**, each a little-endian **int16 stored as two byte planes** (low bytes, then high bytes of the
  two's-complement value; the decoder does `q = lo | hi << 8; if (q >= 32768) q -= 65536`).
  **value (m/s) = q · scale**, `scale` = 0.01 (wind) / 0.001 (currents); **q = −32768 = no data** (always in u and v
  together). u = eastward, v = northward. Decompressed size = 4 · width · height bytes.
  * wind: 1°, 360 x 180, `lat0` 89.5, `lon0` −179.5; no cell is no data (a global field over land and sea).
    Annual = vector mean of the 12 monthly means.
  * currents: the native OSCAR 0.25° **nodes** (not cell centres), 1440 x 719, `lat0` 89.75, `lon0` −180.0 (no
    resampling). Monthly mean of the 60 snapshots, kept only where ≥ 80 % of them are valid (sea-ice edge); annual =
    mean of the 12 monthly means where all 12 months are open water.
* `flow/<set>/manifest.json`: `source`, `period`, `citation`, `licence`, `attribution`, `speed_range` (suggested colour
  range, m/s), `grid`, `months`, `layers[key]` (`bytes`, `cells`, `speed_max`, `speed_p99`, `speed_mean_area` =
  cos(lat)-weighted mean speed of the mean vector), `caveats`; currents also `product`, `doi`, `sampling`.
* Sizes: `chl/` 7.9 MB (0.56-0.73 MB per layer), `flow/wind/` 1.6 MB (~130 kB per layer), `flow/currents/` 15.3 MB
  (1.0-1.2 MB per layer); 24.8 MB in total.
* Animation proof (2026-11-15, throwaway page outside the repo, Chrome 157 on an M4 Pro MacBook, 120 Hz display):
  fetch + inflate (`DecompressionStream('deflate')`) + decode of one wind and one currents month 41 ms; 2 x 10,000
  particles advected with bilinear sampling on two 1440 x 720 equirectangular canvases with fading trails:
  **1.7 ms per frame** of JS (p95 1.9 ms), frame interval 8.2-8.9 ms (112-122 fps, display-limited).

### Checks (`pipeline/chlorophyll.py check`, `pipeline/flow.py check`, `tests/test_chl_flow.py`)

Chlorophyll (geometric mean over a 1° box, mg/m³): Peru upwelling 10° S 78° W 3.54 (annual), Benguela 23° S 13.5° E 3.25,
Arabian Sea off Oman (19° N 58° E) 2.25 in August (SW monsoon) vs 0.57 in April, North Atlantic 50° N 25° W 0.63 in May
(spring bloom) vs 0.23 in January; oligotrophic gyres: South Pacific (25° S 120° W) 0.017, Sargasso (25° N 50° W) 0.040,
Indian Ocean (25° S 80° E) 0.037, North Pacific (25° N 150° W) 0.060; equatorial Pacific upwelling tongue (0°, 140° W) 0.20.

Winds (mean vector, m/s): NE trades 15° N 40° W 7.1 (annual, from ENE), SE trades 15° S 120° W 6.6; Southern Ocean
westerlies 50° S 90° E 9.1 (40-65° S band: p90 8.0, max 9.3; zonal-mean u peaks 7.0 at 52.5° S); Arabian Sea
12° N 62° E **January 6.6 from the NE, July 11.6 from the SW** (Findlater jet; monsoon reversal); Bay of Bengal 15° N 88° E
6.0 from the NE in January, 8.3 from the SW in July.

Currents (2015-2024, 0.25°; "box max" = highest mean-vector speed in the box): Gulf Stream (26-38° N, 82-70° W)
1.35 m/s annual, 1.60 in August; Agulhas 1.34 annual, 1.51 in December; North Brazil Current 1.11 annual, 1.56 in August;
Kuroshio south of Japan and Extension (25-41° N, 132-148° E) 0.91 annual, 1.08 in September (the 2017-2025 Kuroshio
Large Meander spreads the climatological jet; east of Taiwan 0.82); Antarctic Circumpolar Current: eastward everywhere,
45-60° S mean u 0.08 m/s, 90th percentile speed 0.20, Drake Passage (65° W, 56-62° S) mean u 0.13; North Equatorial
Countercurrent (4-9° N, 150-100° W) annual mean u +0.15 (eastward, 0.30 at 7° N 120° W in August) between the westward
South Equatorial Current (2° S 120° W, u −0.07); Somali Current at 8° N 51° E reverses with the monsoon: v +0.71
(northward, 1.09 m/s) in July, −0.19 in January.

### Caveats (also in each `manifest.caveats`)

* Satellite chlorophyll is an ocean-colour estimate of the top optical depth, ~30-35 % uncertainty in the open ocean,
  biased high in turbid coastal and river-influenced water; deep chlorophyll maxima are invisible. Inland waters
  (Caspian, Great Lakes, large lakes) are in the grid; mask them with the land/ocean mask if only the ocean is wanted.
  High latitudes have no data in their winter, and the annual CU layer is weighted to the sunlit season there.
* A monthly-mean wind is a vector average: where direction varies (ITCZ, monsoon transitions, storm tracks) its speed is
  much lower than typical daily winds. NCEP R1 at ~1.9° smooths coastal jets and storms; scatterometer climatologies
  give somewhat stronger Southern Ocean westerlies.
* OSCAR is a diagnostic model (DUACS sea level + ERA5 wind + SST), a top-30 m mean; averaging 60 snapshots smooths
  eddies and meanders, so western boundary currents are broader and slower than on any one day. Near the equator the
  geostrophic part is ill-defined (OSCAR uses a special treatment). No data under sea ice and inshore of the grid.
* "Live" option (documented, not built): NOAA GFS 0.25° analyses on NOMADS (`gfs.tYYz.pgrb2.0p25.anl`, `UGRD`/`VGRD`
  at 10 m via the grib filter) are public and updated every 6 h; it would need a scheduled job, which this static site
  does not have.

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

## Earthquakes and seamounts (`data/quakes.json`, `data/seamounts.json`)

Two point layers in **columnar JSON** (one array per field, `n` entries each, plus a `metadata` object), not
GeoJSON: as GeoJSON with the same properties they are 7.8 MB (quakes) and 14.6 MB (seamounts), over the size budget. The
viewer zips the arrays into features, e.g.
`features = d.lon.map((x, i) => ({type: "Feature", id: i, geometry: {type: "Point", coordinates: [x, d.lat[i]]}, properties: {mag: d.mag[i], depth_km: d.depth_km[i], time: d.time[i], id: d.id[i], place: d.place[i]}}))`.
GitHub Pages serves both gzipped (0.89 MB and 1.01 MB on the wire).

| Layer | File | Script | Licence | Attribution to show |
|---|---|---|---|---|
| Earthquakes M ≥ 5.5 since 1900 + last 30 days live | `data/quakes.json` + USGS feed | `pipeline/quakes.py` | Public domain (USGS) | Earthquakes: USGS ANSS ComCat (public domain) |
| Seamounts | `data/seamounts.json` | `pipeline/seamounts.py` | CC BY 4.0 | Seamounts: SDUST2026SM (Gao et al. 2026) and SIO 2023 / Kim & Wessel 2011 (Gevorgian et al. 2023), CC BY 4.0; summits from GEBCO_2026 |

### Earthquakes (`data/quakes.json`, `pipeline/quakes.py`)

* Source: U.S. Geological Survey, Earthquake Hazards Program (2017) *Advanced National Seismic System (ANSS)
  Comprehensive Catalog of Earthquake Events and Products* (ComCat), doi:10.5066/F7MS3QZH, via the FDSN event web
  service `https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv&minmagnitude=5`, one request per calendar year
  1900..today (largest year far below the 20,000-event limit). Raw CSVs in `data/raw/quakes/<year>.csv` (18 MB).
  Public domain (U.S. Government work; USGS asks for acknowledgement). Pre-1976 large events come from the ISC-GEM
  catalogue inside ComCat.
* Build of 2026-11-15: 107,637 rows M ≥ 5; 513 non-earthquakes dropped (444 nuclear explosions, 55 volcanic
  eruptions, 10 explosions, 4 other); 107,124 earthquakes M ≥ 5 (39,650 M ≥ 5.5, 14,485 M ≥ 6, 1,620 M ≥ 7, 100 M ≥ 8).
  The browser file keeps **M ≥ 5.5 (39,650 events, 3.19 MB)**; adding M 5–5.5 would make it about 8.6 MB.
* Columns (sorted by magnitude descending, then time): `lon`, `lat` (0.01°), `time` (origin time, Unix **ms** UTC, as
  in the USGS feeds), `mag` (ComCat preferred magnitude, mixed types Mw/mb/Ms), `depth_km` (rounded to 1 km; null if
  unknown), `id` (ComCat id: event page `https://earthquake.usgs.gov/earthquakes/eventpage/<id>`), `place`.
  `metadata`: `source`, `licence`, `attribution`, `minmag`, `count`, `first`, `newest`, `generated`, `columns`,
  `live_feeds`, `stats`.
* `--update` (weekly CI): reads `quakes.json`, queries FDSN from 30 days before the newest event to now with the file's
  `minmag`, merges by `id` (new versions replace old), drops events revised below `minmag`, re-sorts, rewrites; needs
  no raw cache. Tested: idempotent on a current file (0 new, 0 revised); with the 5 newest events removed it restored
  all 5. Deletions from ComCat and revisions older than 30 days are only picked up by a full rebuild.
* **Live layer (last 30 days)**, called directly by the viewer, no pipeline:
  `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson` (M ≥ 2.5, 30 days; 2,007 events,
  1.41 MB, 178 kB gzipped on 2026-11-15), also `4.5_month`, `2.5_week`, `all_day`, `significant_month` (same path
  pattern). Updated every minute (`cache-control: public, max-age=60`). Real GeoJSON; depth is the third coordinate
  (`geometry.coordinates[2]`, km) and `properties.time` is Unix ms, so copy depth into a property before styling.
  For one event's details: `https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=<id>&format=geojson`.
* **CORS verified** 2026-11-15: response headers `access-control-allow-origin: *`, `access-control-allow-methods:
  GET, OPTIONS`, preflight OPTIONS 200; and in headless Chromium from the live page origin
  `https://ismoilovdevml.github.io`, `fetch()` of `2.5_month`, `4.5_week` and an FDSN `format=geojson` query all
  returned `status 200, type "cors"`. The FDSN query endpoint carries the same headers.
* Checks (`metadata.stats`, `data/derived/quakes_stats.json`):
  * Largest events: 1960 Valdivia M 9.5 (−38.14, −73.41, 25 km), 1964 Alaska 9.2, 2004 Sumatra–Andaman 9.1
    (3.29, 95.98, 30 km, 2004-12-26 00:58:53 UTC), 2011 Tōhoku 9.1 (38.30, 142.37, 29 km, 05:46:24 UTC), 1952
    Kamchatka 9.0, then 8.8 for 1906 Ecuador–Colombia, 2010 Maule and 2025 Kamchatka.
  * Plate boundaries (PB2002 lines in `plates.geojson`, densified to ≤ 2 km, great-circle distance): **65.5 % of the
    14,485 M ≥ 6 events lie within 100 km of a boundary line**, which covers only 9.5 % of Earth's surface (400,000
    random points); 85.3 % within 200 km; **36.5 % within 100 km of a subduction line** (2.1 % of the surface). Nearest
    type for those within 100 km: subduction 4,603, transform 2,253, convergent 1,170, rift 759, ridge 695. Of the
    events beyond 100 km, 24.7 % are deeper than 70 km (intraslab events under the overriding plate); most of the rest
    are in PB2002's diffuse orogens (Himalaya–Tibet, Iran, Anatolia), which are areas, not lines.
  * Tonga slab (15–26° S, 176° E–172° W, all M ≥ 5): 7,837 events, 2,637 deeper than 300 km, deepest 700 km. Median
    distance west of the PB2002 TO/PA trench line: 75 km at 0–70 km depth, 226 km at 70–300 km, 451 km at 300–500 km,
    523 km at 500–800 km. Linear fit of depth vs distance below 100 km: apparent dip **45°** (slope 1.01). That is the
    Wadati–Benioff zone (fig11a inset). Distance is to the nearest trench vertex, not along a fixed profile.
* Caveats: completeness changes with time (M ≥ 6 per decade: 350 in the 1900s, 1,300 in the 1950s, ~1,500 since the
  1990s), so early decades are incomplete below about M 6.5–7 and density maps over-weight recent decades. Magnitude
  types are mixed. Epicentres before the 1960s can be tens of km off; many shallow depths are fixed defaults (10, 33,
  35 km), visible as horizontal lines in a depth section.

### Seamounts (`data/seamounts.json`, `pipeline/seamounts.py`)

* Sources (raw in `data/raw/seamounts/`, 77 MB):
  * **SDUST2026SM** — Gao, Y., Guo, J., Ya, S., Yu, D., Liu, X. & Hwang, C. (2026) *SDUST2026SM: A Global Seamount
    Catalog Based on Vertical Gradient of Gravity Anomaly and Bathymetric Data* (v1.0, 2026-10-10). Zenodo.
    doi:10.5281/zenodo.23277209. CC BY 4.0. Paper: Earth Syst. Sci. Data Discuss., doi:10.5194/essd-2026-860
    (**preprint, in review**). SWOT_04 VGG + GEBCO_2025, 80° S–80° N, seamounts ≥ 100 m high, 68,934 candidates,
    **67,374 accepted after visual inspection** (`visual_pass_flag = 1`), stored on a 1′ grid. Heights and base depths
    come from GEBCO_2025 foot-of-slope profiles.
  * **SIO 2023** — Gevorgian, J., Sandwell, D. T., Yu, Y., Kim, S.-S. & Wessel, P. (2023) Global distribution and
    morphology of small seamounts. *Earth and Space Science* 10, e2022EA002331, doi:10.1029/2022EA002331; data:
    Zenodo doi:10.5281/zenodo.7718512 (`SIO_Seamounts.zip`, `Seamounts_Modeled/all.xyhrdnc`). CC BY 4.0. The Kim &
    Wessel (2011) census (24,643, ids `KW-xxxxx`) re-centred on VGG v32 plus 19,325 new (`SIO-xxxxx`) and one
    `Mew-` pick; the 514 KW picks in `KW_badlist.txt` (no VGG signal any more) are dropped → **43,455**. Heights are a
    VGG Gaussian model in 100 m steps (600 = below 700 m, 2600 = 2,600 m or more); paper accuracy ~270 m.
  * **Kim & Wessel (2011)** — Kim, S.-S. & Wessel, P. (2011) New global seamount census from altimetry-derived
    gravity data. *Geophys. J. Int.* 186, 615–631, doi:10.1111/j.1365-246X.2011.05076.x. KWSMTS v0.1
    (`KWSMTSv01.txt`, 24,643 rows; header says 24,646) from https://www.soest.hawaii.edu/PT/SMTS/ (reachable on
    2026-11-15). The SOEST page states no licence; the same catalogue is redistributed in the CC BY 4.0 SIO 2023 Zenodo
    record, which is what the layer uses. Used here for counts and cross-checks only.
  * **Yesson et al. (2020)** — Yesson, C., Letessier, T. B., Nimmo-Smith, A., Hosegood, P., Brierley, A. S., Hardouin,
    M. & Proud, R. (2020) *List of seamounts in the world oceans – An update*. PANGAEA, doi:10.1594/PANGAEA.921688,
    CC BY 4.0 (37,889 peaks from SRTM30_PLUS v11 by a bathymetry-only cone search; the 2011 list, doi:10.1594/PANGAEA.757562,
    is CC BY 3.0). Cross-check only; not merged (different method and definition).
* Merge: every SDUST2026SM seamount (`src = 0`); an SIO 2023 seamount within 10 km gives it `cat` (its KW/SIO id).
  SIO 2023 seamounts with no SDUST seamount within 10 km are added as `src = 1` (2,396), so the Kim & Wessel census
  stays traceable: 97.0 % of the 24,643 KW 2011 positions have a layer seamount within 10 km. **69,770 seamounts,
  3.65 MB.** Overlap: 94.5 % of SIO 2023 has an SDUST seamount within 10 km; 61.4 % of SDUST has an SIO one (SDUST adds
  mostly small ones: 42 % of SDUST seamounts 100–500 m high match, 90 % of those ≥ 2 km). 71.3 % of Yesson 2020 peaks
  have a layer seamount within 10 km.
* Summit: the shallowest GEBCO_2026 15″ cell within a disc of radius clamp(0.5 × SDUST semi-minor axis, 1.5, 5) km
  (SIO-only: clamp(0.3 × basal radius, 1.5, 5) km; median 3 km) around the catalogue centre; its depth and TID.
* Name: GEBCO gazetteer elevation features (Seamount, Guyot, Knoll, Hill, Bank, Peak, Tablemount and plurals). A
  seamount inside a gazetteer polygon (raw `data/raw/gazetteer/layer2_polygon.geojson`) takes its name (singular: the
  tallest seamount inside only; plural: all inside); otherwise the nearest seamount within 10 km of a point label in
  `features.geojson` (plural labels: all within 10 km). Singular beats plural, polygon beats point.
* Columns (sorted by height descending): `lon`, `lat` (0.001°), `height_m`, `base_depth_m` (catalogue, positive down),
  `summit_depth_m` (GEBCO_2026, positive down, negative = above sea level), `tid` (GEBCO TID of the summit cell),
  `src` (0 SDUST2026SM, 1 SIO 2023 only), `cat` (`KW-xxxxx` / `SIO-xxxxx` / ''), `sdust_id` (0 for src 1), `name`
  ('' = unnamed). `metadata`: `sources` (citation + licence each), `attribution`, `licence`, `columns`, `stats`.
* Numbers (`data/derived/seamounts_stats.json`):
  * **Summit cell directly measured (TID 10–17): 34.2 % (23,827 of 69,770)**, i.e. about two in three seamount summits
    have never been reached by sonar; 49.0 % have at least one measured cell in the summit disc. Summit TIDs: 40
    (gravity-predicted) 39,126, 11 (multibeam) 22,139, 41 (interpolated) 4,294, 44 1,657, 17 1,086, 0 (land) 605, other
    the rest. The measured share rises with height: 14.6 % at 100–250 m, 18 % at 250–500 m, 31 % at 500–1,000 m,
    47–59 % above 1 km. For comparison 30.8 % of the whole ocean floor is measured, and the SIO 2023 authors flag 38.3 %
    of their seamounts as "charted" (an actual sounding within 2 km).
  * **Named: 2.7 % (1,892 seamounts, 1,790 distinct names)**; 0.4 % of those under 500 m, 15 % of those 2–3 km, 24 % of
    3–4 km. 82.3 % of the gazetteer's 1,738 Seamount/Guyot/Tablemount labels have a catalogue seamount within 10 km.
  * Height (catalogue): median 800 m, p10 378, p25 551, p75 1,146, p90 1,688, max 6,308 m. Summit depth (GEBCO):
    median 3,063 m; 644 summits shallower than 200 m, 3,342 shallower than 1,000 m; 724 reach sea level in GEBCO
    (islands and atolls, plus grid artefacts, see below).
  * Height checks: SDUST height vs GEBCO_2026 relief (catalogue base − our summit): median difference −1 m, median
    |Δ| 7 m (SDUST used GEBCO_2025, so this checks our summit extraction, not the heights). SIO 2023 VGG heights
    (class "good") vs that GEBCO relief at matched seamounts: median |Δ| 467 m (346 m where the summit cell is measured;
    paper: ~270 m). SIO-only seamounts: GEBCO relief is 591 m lower than the VGG height (median), and 30 % show less
    than 200 m of GEBCO relief; 202 lie within 10 km of a candidate SDUST rejected by visual inspection.
  * Spot checks: Vema Seamount (8.36° E, 31.64° S) height 4,520 m, but its GEBCO_2026 summit cell is +29 m with
    TID 0 (land) — published surveys put the shallowest point at 22 m below sea level (Bergstad et al. 2019; 26 m in the 1965 survey), so these are GEBCO cells coded as land (two cells, +29 m and +6 m, near 8.3771 E, 31.6104 S); reported to Seabed 2030.
    SG̲áan K̲ínghlas-Bowie: summit 83 m, multibeam (published shallowest ~24 m; 15″ cells average). Davidson: 1,393 m,
    multibeam (KW-17785). Kamaʻehuakanaloa (Lōʻihi): a layer seamount 1.4 km from 18.92° N 155.27° W, summit 1,033 m (published ~975 m).
* Caveats: catalogue positions and heights come from satellite gravity; small seamounts (< ~1 km) are incomplete
  and vary most between catalogues. Volcanoes on spreading axes are largely absent (Axial Seamount has no layer
  seamount within 35 km). Large flat edifices can appear as several smaller picks with heights measured from the
  plateau (Great Meteor: the nearest pick is SIO-only, height 600 m = the "below 700 m" class). SIO-only entries
  (`src = 1`) have weaker bathymetric support. "Measured summit" = one 460 m cell holds any sounding, not a full
  survey. SDUST2026SM's paper is still under review; the dataset itself is a published, versioned Zenodo record.

## Mapping history (web/public/history/, `pipeline/history.py`)

Which seafloor was **directly measured** (TID 10-17) in each GEBCO release 2019-2026, for the timeline slider.

### Inputs (data/raw/gebco_<year>/, gitignored)

* `gebco_<year>_tid.tif` for 2019-2026: Int8, 86400 x 43200 (15"), north-up, same transform as `gebco_2026_tid.tif`.
  2019-2024 are converted by `history.py convert` from the official CEDA zips
  `https://dap.ceda.ac.uk/bodc/gebco/global/gebco_<year>/type_identifier_grid/netcdf/gebco_<year>_tid.zip`
  (90-107 MB each; inside: `GEBCO_<year>_TID.nc`, netCDF-4/HDF5 for 2019/2021/2023/2024, classic netCDF for
  2020/2022; 2019 is a 7.5 GB Int16 file, the others 3.7 GB Int8). `gdal_translate` flips them north-up; an
  orientation check (45° N: inner Asia land, North Pacific ocean) runs before the .nc and .zip are deleted.
  `gebco_<year>_tid_meta.json` keeps the netCDF global attributes (title, DOI).
* Ocean mask for **every** year: GEBCO_2026 TID != 0 and GEBCO_2026 1' elevation < 0 (same as `coverage.py`).
  Areas: exact spherical area of each 15" cell (authalic sphere, R = 6371.0072 km), as in `change.py`.

### Files

* `first-measured_1arcmin.bin` (14.4 MB): 1' grid, 21600 x 10800, **row 0 = northernmost** (89.99167° N cell
  centre), column 0 = 179.99167° W, row-major, zlib-deflated **uint8** (one byte plane). Codes:
  `0` = land / outside the mask / never measured; `19..26` = first release (GEBCO_2019..2026) in which any ocean
  15" sub-cell of the 1' cell is TID 10-17, still measured in GEBCO_2026; `119..125` = first measured in
  20(code − 100) but **not** measured in GEBCO_2026 (re-coded to an indirect / unknown class).
  Threshold for year Y: measured-by-Y = `19 <= v <= Y-2000 || 119 <= v <= Y-2000+100` (the second branch is
  "measured at some point, later re-coded"; the exact per-year state is in the tiles' G channel).
  *Why "any sub-cell" and not a fraction*: single-beam tracks are one 15" cell wide and would vanish under a
  fraction threshold at 1'; the per-year area numbers are exact 15" sums, never 1' counts.
  *Why no per-year fractions*: eight 1' planes deflate to ~17 MB more (bitmask alone, tested), the tiles carry it.
* `tiles/{z}/{x}/{y}.webp`, z0-5, 512 px, Web Mercator XYZ, **lossless WebP RGBA (exact)**:
  R = first-measured code (as above), G = year bitmask (bit i = measured in GEBCO_(2019 + i), bit 7 = 2026),
  B = 0 (unused: a measured-share channel tripled the tile size, 159 → 51 kB on a z5 tile, and `tiles/coverage/`
  already has it), A = 255 ocean / 0 land. Base level z5 built directly from the 1' grids (every pixel ORs all 1'
  rows/columns it overlaps, at least one, so tracks are never dropped); lower zooms OR the bitmask. At z0-3 nearly
  every pixel touched by one track lights up: combine with the coverage layer for opacity. Use `nearest`
  resampling, never interpolate codes.
* `manifest.json`: grid description, codes, `cells_per_code`, `tiles` block, `stats` (below), citation, licence,
  attribution, caveats, `sizes_bytes`.
* `manifest.stats.years[]` per release: `measured_km2` / `measured_frac` (same mask), `measured_frac_own_mask`
  (that year's own TID != 0), `ever_measured_km2/frac` (this or any earlier release), `first_measured_km2`,
  `new_vs_previous_km2`, `no_longer_measured_vs_previous_km2`, `no_longer_measured_now_coded` (km² by the TID code
  the lost cells got), `lat_measured_frac` (10° bands), `doi`, and the official Seabed 2030 figure with date,
  quote and URL.

### Numbers (build of 2026-11-15; ocean = 361.7 M km²)

| Release | Ours (TID 10-17) | Official | New vs previous (M km²) | Re-coded away (M km²) | Ever measured |
|---|---|---|---|---|---|
| 2019 | 12.43 % | 15 % | | | 12.43 % |
| 2020 | 18.24 % | 19 % | 25.65 | 4.62 | 19.52 % |
| 2021 | 21.91 % | 20.6 % | 17.35 | 4.06 | 23.49 % |
| 2022 | 25.35 % | 23.4 % | 14.48 | 2.07 | 26.82 % |
| 2023 | 26.27 % | 24.9 % | 7.83 | 4.48 | 28.70 % |
| 2024 | 28.54 % | 26.1 % | 10.00 | 1.80 | 30.39 % |
| 2025 | 29.69 % | 27.3 % | 4.92 | 0.76 | 31.47 % |
| 2026 | 30.81 % | 28.7 % | 6.57 | 2.51 | 33.04 % |

Cross-checks: 2026 = `coverage.py` (30.81 %); 2025→2026 new/lost = `change.py` (6.57 / 2.51 M km²; `change.py`
uses the union mask, hence 2.513 vs 2.506). Bookkeeping m(y) = m(y−1) + new − lost holds to < 5 km² every year.

Official figures (each read on the cited page, 2026-11-15): 2019 15 % (GEBCO press release, 13 Jun 2019),
2020 19 % (Nippon Foundation, 21 Jun 2020), 2021 20.6 % (GEBCO, 1 Aug 2021), 2022 23.4 % (GEBCO, 22 Sep 2022),
2023 24.9 % (Seabed 2030, 2 May 2023), 2024 26.1 % (GEBCO, 24 Jul 2024), 2025 27.3 % (GEBCO, 6 Aug 2025),
2026 28.7 % (GEBCO, 27 Apr 2026). URLs and quotes in `OFFICIAL` (pipeline/history.py) and the manifest.

### Citation, licence, attribution

GEBCO Compilation Group (2019 ... 2026) GEBCO_<year> Grid. DOIs: 2019 10.5285/836f016a-33be-6ddc-e053-6c86abc0788e,
2020 10.5285/a29c5465-b138-234d-e053-6c86abc040b9, 2021 10.5285/c6612cbe-50b3-0cff-e053-6c86abc09f8f,
2022 10.5285/e0f0bb80-ab44-2739-e053-6c86abc0289c, 2023 10.5285/f98b053b-0cbc-6c23-e053-6c86abc0af7b,
2024 10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f, 2025 10.5285/37c52e96-24ea-67ce-e063-7086abc05f29,
2026 10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa (2019-2024 read from each netCDF's `references`).
Licence: GEBCO Grid terms of use (in every zip): public domain, free to copy/adapt/commercially use, must
acknowledge the source, must not imply GEBCO endorsement or misrepresent the grid. CEDA lists OGL v3 for
2025/2026 and "contact CEDA" for 2019-2022; the bundled terms of use are the same text every year.
Attribution text: "Mapping history from the GEBCO_2019-GEBCO_2026 Type Identifier grids (GEBCO Compilation
Group); official percentages from Seabed 2030 / GEBCO announcements".

### Caveats

* Ours is not the official metric: Seabed 2030 counts cells holding data on its depth-dependent target grid
  (100 m to 800 m cells, Mayer et al. 2018, Geosciences 8:63; the release notes do not give the exact method), so a 15" TID share is expected to differ (ours is 2.6 pp lower in 2019, 0.8 pp lower in 2020,
  1.3-2.4 pp higher from 2021 on).
* TID codes change between releases for reasons other than surveys: 2.5-4.6 M km² per release stop being
  "measured", mostly to 40 (satellite-gravity predicted), 41 (interpolated), 44 (mixed gridded) or 70
  (pre-generated grid). By 2026, 33.0 % has been measured in at least one release vs 30.8 % in GEBCO_2026.
* "First measured in 20YY" = first appears as TID 10-17 in a GEBCO release, not the survey year: a release can
  add surveys collected years earlier (newly shared or newly gridded).
* One mask for all years ignores coastline / ice-shelf changes between releases (own-mask shares differ by
  ≤ 0.02 pp).

## Sea level since the Last Glacial Maximum (`data/sea-level-history.json`, `pipeline/sealevel_history.py`)

* Source: Lambeck, K., Rouby, H., Purcell, A., Sun, Y. & Sambridge, M. (2014). Sea level and global ice volumes
  from the Last Glacial Maximum to the Holocene. *PNAS* 111(43), 15296-15303, doi:10.1073/pnas.1411762111,
  **SI Appendix Table S3**: best-estimate ice-volume equivalent sea level (esl) and its 2σ accuracy, 0-35 ka.
  Read with `pdftotext -layout` from the authors' copy of paper + SI (ANU,
  `http://rses.anu.edu.au/~malcolm/papers/pdf/Lambeck-etal-2014.pdf`, sha256 pinned in the script).
* Format: `{title, quantity, years_bp_reference, citation, source_url, source_sha256, licence, attribution, n, lgm,
  caveats, points: [{years_bp, sea_level_m, lo, hi}]}`; 276 points 0-26,065 yr BP at irregular 70-170 yr steps,
  `lo/hi = esl ∓ 2σ`. Interpolate linearly.
* Spot checks (`sealevel_history.py check`, `tests/test_history.py`): 0 BP 0 m; 7 ka −5.4 m; 11.7 ka −61.8 m;
  14.0 ka −86.9 m; 14.65 ka −102.2 m (**Meltwater Pulse 1A**: +15.8 m between 14.6 and 14.0 ka); 16 ka −116.8 m;
  19 ka −125.8 m; **LGM minimum −134.3 m at 20.5 ka**; 21 ka −134.0 m; 24 ka −130.9 m; 26 ka −128.8 m.
* Licence: the article is free to read (PNAS open access option); the SI table has **no separate open data
  licence**. The values are reproduced as factual scientific data with full citation. Fallback with explicitly
  open terms: Spratt & Lisiecki (2016) sea-level stack (NOAA NCEI, doi:10.25921/rd66-5820), but it is 1 kyr
  resolution and reads +8.5 m at 0 ka, so it was not used.
* Attribution text: "Sea level: Lambeck et al. (2014) PNAS, doi:10.1073/pnas.1411762111".
* Caveats: esl is a **global** ice-volume number, not relative sea level at a coast; glacial isostatic adjustment
  shifts local sea level by up to tens of metres (most near former ice sheets). The viewer floods present-day
  topography (no sedimentation, erosion, reef growth or tectonics since). The 2σ band is Lambeck et al.'s own
  accuracy estimate, narrower than the spread between reconstructions (LGM −120 to −135 m).
