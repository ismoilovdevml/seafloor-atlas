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

## Vector overlays (web/public/data/)

* `plates.geojson`: PB2002 boundaries, property `type` in {ridge, trench, transform, other} derived from PB2002 `Type`.
* `features.geojson`: named undersea features (Point), properties `name`, `kind`, `depth_m` (sampled from GEBCO at the point), `blurb` (one sentence), `source`.
* `stories.json`: guided views `{id, title, blurb, center:[lon,lat], zoom, pitch, bearing, exaggeration}`.
