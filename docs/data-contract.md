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
