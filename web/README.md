# Seafloor Atlas viewer

Interactive globe of the whole ocean floor from GEBCO 2026 (MapLibre GL JS 6, globe projection + 3D
terrain), built only from this project's own tiles: no basemap, no external tile or font servers, no analytics.

What it answers:

* **What does the seafloor look like?** Colour relief (pale shelf to violet-black abyss, land muted grey),
  hillshade and 3D terrain with vertical exaggeration (auto by zoom, or fixed by the slider).
* **How much of it has actually been measured?** "What's actually measured" dims every cell that ships have
  not surveyed directly (GEBCO TID 10-17); the panel shows the global measured share from `meta.json`.
* **Where are the plate boundaries and what kind?** PB2002 (Bird 2003), coloured by type, click for plates + rate.
* **What is that feature?** ~5,400 gazetteer names (tiered by size), click for a card; search box over names.
* **How deep is it here / along a line?** Hover (or tap) readout of depth and measured fraction; depth profile
  tool: click two points, 400 great-circle samples, chart with deepest point, length and measured share.
* Guided views (`public/data/stories.json`), deep-linkable as `#story=<id>`.

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

Before the real tiles exist: `npm run synth` writes a small synthetic set (z0-2) to `public/tiles-synthetic/`
(needs `cwebp`). Open `?tiles=synthetic` to force it; the viewer also falls back to it when
`public/tiles/meta.json` is missing, and says so in "Data sources".

Screenshots (isolated headless Chrome via playwright-core; dev server must be running):

```sh
node scripts/capture_views.mjs screenshots '' http://localhost:5173/
```

## Notes

* Depth/fraction readouts decode our tiles directly (not the GPU): Terrarium at max zoom, bilinear for depth,
  nearest pixel for the measured fraction. Tiles are decoded with `createImageBitmap({premultiplyAlpha:'none'})`;
  only the veil's alpha is read, which survives canvas premultiplication exactly.
* Long profiles read a coarser zoom so a pixel is no smaller than the sample spacing.
* Two raster-dem sources point at the same DEM tiles (terrain vs. relief/hillshade) to avoid cache contention.
* MapLibre logs one `calculateFogMatrix is not supported on globe projection` warning when terrain is drawn on
  the globe; it comes from the library's terrain pass, not from this app's style.
