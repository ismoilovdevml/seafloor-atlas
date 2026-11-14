# Seafloor Atlas viewer

Interactive globe of the whole ocean floor from GEBCO 2026 (MapLibre GL JS 6, globe projection + 3D
terrain), built only from this project's own tiles: no basemap, no external tile or font servers, no analytics.

## Layout

Map first: the globe gets the window, everything else floats at the edges and folds away.

* **Top bar**: the name, a search box (`⌘K` / `Ctrl K` or `/`; finds undersea features, cables, notable wrecks and
  guided views), **Explore** (the guided views drawer, left) and **Layers** (right, with a count of layers that are on),
  then **About this map** (headline numbers, data sources and licences, shortcuts) and **Map settings** (vertical
  exaggeration and its auto mode). Popovers close with `Esc` or a click outside and give focus back.
* **Layers drawer**, in three groups: *Seafloor* (Relief as the base; What's actually measured, New in GEBCO 2026,
  Plate boundaries, Named features; a *Depth certainty* sub-group with Model disagreement, Prediction confidence and
  Seal soundings), *Ocean* (Ocean water, Marine life) and *Human activity* (cables with landing points, shipping,
  wrecks with "show all", platforms, pipelines, wind). Each row is a switch, a name and an (i) that unfolds a short note:
  the key number, one or two sentences, the source. Sub-options appear under a row only while it is on.
* **Legend dock** (bottom left): one section per layer that is on the map, the depth scale first; it hides when nothing
  needs a key and folds to its header. A tall legend counts as a side panel, so the globe centres beside it.
* **Tool bar** (bottom centre): Depth profile, Sea level, Ocean water. One tool is open at a time; its panel opens above
  the bar (or in the right column on windows under 760 px tall) and minimises to its header.
* **Readout** (bottom right): depth, measured share (or the water value), position, plus one line for an active
  marine-life or depth-certainty layer.
* **Phone** (≤ 760 px): the top bar keeps the name, About, Settings and search; a bottom sheet with tabs Explore / Layers /
  Tools (tap the open tab to fold it), the legend folds to a chip beside the readout, and a tool takes the sheet.
* Open/closed state of the drawers and the legend is kept in `localStorage` (`sfa-ui`, wrapped in try/catch; the page
  works without it). Keyboard: everything is a button, switch, radio or select with a visible focus ring; the phone tabs
  are a `tablist` with arrow keys; `prefers-reduced-motion` turns transitions off.

What it answers:

* **What does the seafloor look like?** Colour relief (pale shelf to violet-black abyss, land muted grey),
  hillshade and 3D terrain with vertical exaggeration (auto by zoom, or fixed in Map settings).
* **How much of it has actually been measured?** "What's actually measured" dims every cell that ships have
  not surveyed directly (GEBCO TID 10-17); its (i) note shows the global measured share from `meta.json`.
* **Where are the plate boundaries and what kind?** PB2002 (Bird 2003), coloured by type, click for plates + rate.
* **What is that feature?** ~5,400 gazetteer names (tiered by size), click for a card; search box over names.
* **How deep is it here / along a line?** Hover (or tap) readout of depth and measured fraction; depth profile
  tool: click two points, 400 great-circle samples, chart with deepest point, length and measured share.
* **What if the sea were higher or lower?** "Change sea level" (−6,000 m to +100 m; the −200…+100 m part of the
  slider moves 1 m per step) recolours the map for that sea level: water by its depth below the new sea, newly
  exposed sea floor in sand, flooded land in blue. Presets (ice age −120 m, ridges −2,500 m, trenches −6,000 m,
  +1/+10 m, no land ice ~+70 m), play/pause animation, land area for that level from `public/data/hypsometry.json`
  (`pipeline/hypsometry.py`), hover depth relative to the chosen sea level. Deep link `#sea=-120`.
* **What is the water like down there?** "Show ocean water" (WOA23, 1991–2020): temperature / salinity / potential
  density at 11 depths over the relief, fixed colour ranges (cmocean thermal / haline / dense) with an optional stretch,
  12-month surface-temperature animation, hover values, and a water-column chart (T, S, σ₀ vs depth) on click.
  Data in `public/woa/` (`pipeline/woa.py`); deep link `#water=s-1000`. Screenshots: `node scripts/capture_water.mjs screenshots <url>`.
* **What do people build and do at sea?** "Human activity" in the Layers drawer, all off by default; each adds a
  compact key to the legend dock, and its (i) note carries the count and licence line:
  * **Internet cables** (TeleGeography snapshot 2022-11-14, 527 cables, schematic routes; planned ones dashed) and
    1,436 landing points (sub-toggle).
  * **Shipping traffic** (World Bank / IMF AIS density 2015–2021, inferno raster tiles, log legend from `legend.json`).
  * **Shipwrecks** (Wikidata): by default the 1,204 wrecks with a Wikimedia sitelink; "Show all" adds the
    UK/Irish register bulk records (20,124). Nautical-chart wreck glyph, names appear by notability as you zoom.
  * **Oil & gas platforms** (OSM, 6,027; clustered with counts up to z6, click a cluster to zoom in), **subsea
    pipelines** (OSM, 2,751; gas solid gold, oil dashed orange, untagged dotted grey, disused faded) and
    **offshore wind farms** (OSM, 318; turbine glyph sized by capacity). Platforms use the pipelines' substance
    colours (oil, gas, split square for both), so one key reads for both layers.
  * Click anything for a card (cable: length, ready-for-service, owners, landing points, website; landing point;
    wreck: date, type, grid depth, Wikipedia/Wikidata links and a Wikimedia Commons thumbnail loaded only when the
    card opens; platform, pipeline, wind farm with OSM/Wikidata links). The clicked item is outlined in white.
  * Search also finds cable names and notable wreck names (marked "Undersea cable" / "Shipwreck, <year>"); choosing
    one turns its layer on. Deep link `#layers=cables,wrecks` (`wrecks-all` for every record), combinable with
    `#story=`, `#sea=` and `#water=`.
  * Order: shipping above the relief, coverage veil and new-2026 layers; lines and symbols above the plate
    boundaries; everything below the gazetteer labels, which are placed first and never hidden by an overlay.
  * GeoJSON is fetched when a layer is first switched on (or when the search box is first focused, for the cable
    and wreck names), not at page load. Colours: three hue slots checked as a set (cables `#e872c8`, gas `#e9b62c`,
    oil `#f26a2e`: all-pairs CVD ΔE ≥ 8.5, normal-vision ΔE ≥ 17.5, ≥ 3:1 on the abyss), dark casings so marks
    read on both the pale shelf and the violet abyss; wind and wrecks are told apart by shape.
* **How sure is the depth?** (Layers, *Depth certainty*; real tiles only, all off by default):
  * **Model disagreement**: |AUST_2026_BAT − GEBCO_2026| from `tiles/disagree/` (z0–5) and its `legend.json`, shown only
    deeper than 1 km where most of the cell is unmeasured. The readout gives the value under the cursor, read back from
    the tile's alpha channel (the pipeline writes alpha as an exact function of the log value), e.g. "about 520 m".
  * **Prediction confidence**: the SWOT machine-learning model's own confidence class from `tiles/uncertainty/` (high /
    medium / low; never shown as metres, the file gives no unit), read back from the class alpha.
  * **Seal soundings**: `data/seals.geojson` (0.1° bins where tagged seals dived > 20 m deeper than the chart beyond the
    position error, coloured by the largest excess) over `data/seals-coverage.geojson` (faint: where seals dived at all).
    The note computes the headline from the file (2.2 % of 4.5 million dives); click a bin for its card.
* **Marine life** (Layers, *Ocean*; `public/data/obis/`, `pipeline/obis.py`): three views on one Web Mercator canvas
  under the hillshade, reprojected in the browser from the lat/lon byte-plane grids (`marine.ts`, like the WOA layer):
  *Where species live* (AquaMaps model richness), *Species diversity, corrected* (ES50; grey = fewer than 50 records) and
  *Where nobody has looked* (OBIS records; pale = no record). A group filter (whales, sharks, turtles, corals, tunas,
  penguins, seals, cephalopods, deep-sea fish) shows that group's records per 1.4° cell. Hover reads the cell value; a
  click on open ocean loads `cells/<geohash2>.json` and opens the cell's most-recorded species (English names and IUCN
  status from the group files where known). The (i) says the sampling-bias caveat in one line. Marine life and Ocean
  water take turns (they use the same place on the map). Licence: CC BY-NC 4.0 as a whole; OBIS, speciesgrids and
  AquaMaps (with its link) are credited in the note, the card and About.
* Guided views (`public/data/stories.json`), deep-linkable as `#story=<id>` (a story resets the sea level to today).

## Run

```sh
npm install
npm run dev            # http://localhost:5173/
npm run build          # type-check + production build into dist/ (static, relative paths)
npm test               # unit tests + story-centre verification on real tiles (needs `dwebp`)
npm run verify:stories # only the story-centre check, prints the depth table
```

Data the viewer reads (format in `../docs/data-contract.md`):

* `public/tiles/{dem,coverage}/{z}/{x}/{y}.webp` + `public/tiles/meta.json` (from `pipeline/tiles.py`)
* `public/data/plates.geojson`, `public/data/features.geojson` (pipeline), `public/data/stories.json` (hand-written)
* overlays: `public/tiles/shipping/` + `legend.json`, `public/data/{cables,landing-points,wrecks,platforms,pipelines,windfarms}.geojson`
  (`pipeline/{shipping,cables,wrecks,offshore}.py`; licences in the data contract, "Context overlays")

Before the real tiles exist: `npm run synth` writes a small synthetic set (z0-2) to `public/tiles-synthetic/`
(needs `cwebp`). Open `?tiles=synthetic` to force it; the viewer also falls back to it when
`public/tiles/meta.json` is missing, and says so in "Data sources".

Screenshots (isolated headless Chrome via playwright-core; dev server must be running):

```sh
node scripts/capture_views.mjs screenshots '' http://localhost:5173/
node scripts/capture_sea.mjs screenshots http://localhost:4173/   # sea-level views, frame timing, deep link checks
node scripts/capture_infra.mjs screenshots http://localhost:4173/ # overlay views + pan frame times (infra-frames.json)
node scripts/qa.mjs http://localhost:4173/ qa-out                 # end-to-end checks against `vite preview`

`qa.mjs` also covers the panel shell: layer groups and rows, (i) notes, the legend dock listing only active layers,
one tool at a time, the settings popover changing the exaggeration, `⌘K` and `/`, remembered panel state, phone tabs,
the map share of the default 1440×900 view (≥ 85 %), and the depth-certainty and marine-life layers at known places
(140° W 20° S disagreement 300–1,000 m, a confidence class at 120° W 30° S, Antarctic seal bins and a seal card,
Coral Triangle AquaMaps > 2,000 species, ES50 vs records in the Coral Triangle and North Sea, a whale-filtered cell card).
The monthly ocean-water animation check first loads all 12 monthly layers (~6.6 MB) and then measures, so on a slow
connection it times the drawing, not the download.
```

## Notes

* Depth/fraction readouts decode our tiles directly (not the GPU): Terrarium at max zoom, bilinear for depth,
  nearest pixel for the measured fraction. Tiles are decoded with `createImageBitmap({premultiplyAlpha:'none'})`;
  only the veil's alpha is read, which survives canvas premultiplication exactly.
* Long profiles read a coarser zoom so a pixel is no smaller than the sample spacing.
* Sea level: `palette.seaLevelExpression(L)` rebuilds the `color-relief` ramp (color-relief only takes a linear
  interpolate over `['elevation']`, so the coastline is two stops 0.05 m apart). Only one ramp swap is in flight
  at a time; the next waits for the map's `render` event, so dragging or playing never queues more swaps than the
  GPU draws.
* Two raster-dem sources point at the same DEM tiles (terrain vs. relief/hillshade) to avoid cache contention.
* High-density screens: the tiles are 512 px files. On `devicePixelRatio >= 1.5` the relief, hillshade, coverage
  veil, new-2026 and shipping sources declare `tileSize: 256`, so MapLibre requests one zoom level higher and draws
  each tile pixel to one device pixel (declared 512 on a 2x screen, every tile pixel is stretched 2x and the first
  globe view looks soft). The files, their zoom ranges (z0–5 static, z6–7 PMTiles) and the depth sampler (reads the
  files at their real 512 px) are unchanged. The terrain mesh keeps 512: same sharpness, fewer requests.
  `?tilesize=512|256` and `?terraintile=512|256` force either for comparisons (`qa.mjs` measures both).
* Bottom panels (sea level, ocean water, depth profile): map padding comes from where the panels really are, so the
  globe centres in the free area; at globe scale (the whole Earth fits the window) the camera also zooms out just
  enough for the globe to fit the free area, and back when the panel closes, unless the user zoomed in between.
  Each bottom panel minimises to its header bar (chevron, keyboard accessible, remembered for the session). Ocean
  water opens compact, with the water column as a one-line hint until a point is clicked. Below 760 px window
  height, sea level and ocean water dock into the right column instead. `qa.mjs` checks at 1440×900, 1280×720 and
  1920×1080 that the globe centre is uncovered and at least 60 % of the visible globe disk is free of any UI (top-bar
  items, drawers, legend, tool bar and readout included).
* The first view zooms so the globe fills the free area (0.96 × the fit radius); a deep-linked story moves the camera after.
* MapLibre logs one `calculateFogMatrix is not supported on globe projection` warning when terrain is drawn on
  the globe; it comes from the library's terrain pass, not from this app's style.
