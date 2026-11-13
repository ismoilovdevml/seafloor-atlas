# Seafloor Atlas

A map of the whole Earth's ocean floor, built from the open **GEBCO_2026** grid. It also shows **which parts of the seafloor were actually measured by ships** and which were only estimated from satellites.

![The seafloor of the whole Earth](figures/fig1_seafloor.png)

## Interactive globe

**Open it: https://ismoilovdevml.github.io/seafloor-atlas/**

![Seafloor Atlas viewer](web/screenshots/desktop-1-globe.png)

* Rotate and zoom the whole seafloor in 3D (depth exaggerated so trenches and ridges are visible from space).
* **What's actually measured:** switch it on and the estimated seafloor goes dark, so you see only what ships have surveyed.
* **Depth profile:** click two points and get the depth along the line (here: across Challenger Deep, 227 km, deepest −10,721 m).
* **Guided views:** 11 places such as Challenger Deep, the Hawaiian–Emperor bend, the Mid-Atlantic Ridge and the MH370 search area.
* **Search** 5,412 named undersea features; **plate boundaries** with spreading rates.

| Measured vs estimated | Depth profile across the Mariana Trench |
|---|---|
| ![coverage](web/screenshots/desktop-2-coverage.png) | ![profile](web/screenshots/desktop-5-profile-mariana.png) |

Runs in the browser with no server and no tracking. Built with MapLibre GL; code in [web/](web/).

## Key numbers

| | |
|---|---|
| Ocean area | **361.7 million km²** (70.9 % of Earth) |
| Directly measured (ship sonar, lidar, …) | **30.8 %** = 111.4 million km² |
| Estimated from satellite gravity | **56.7 %** |
| Interpolated or other indirect | **10.8 %** |
| Source unknown | **1.6 %** |
| Deepest point on the grid | **Challenger Deep, −10,927 m** (15″ grid) |

All numbers are computed in this repo from the GEBCO_2026 Type Identifier (TID) grid, weighted by real area on the sphere. The official Seabed 2030 figure for GEBCO_2026 is **28.7 %**. Ours is 2.1 points higher because we count every 15″ cell (~460 m) with a direct measurement, while Seabed 2030 also requires a depth-dependent minimum resolution ("mapped to modern standards").

## What the data shows

### 1. Less than a third of the seafloor has been measured

![Measured vs predicted seafloor](figures/fig2_measured.png)

The dark lines are single ship tracks. The solid dark areas are full multibeam surveys: around Japan, the North Atlantic, the US coasts, Australia and New Zealand. Everything in light grey has never been touched by a sonar. Its depth comes from small bumps in sea-surface gravity measured by satellites, which only resolve features of a few kilometres.

### 2. The deepest places are the best known, the "average" seafloor is the least known

![Depth distribution and coverage by depth](figures/fig3_depth.png)

* Most of the ocean floor (74 %) lies between 3 and 6 km deep. Only **28 %** of that range is measured. The 4–5 km abyssal plains are the worst at **26.7 %**.
* The trenches below 7 km are **94 %** measured, because expeditions target them.
* Continental shelves (0–250 m) are **31 %** measured in this grid. Many national shelf surveys are not shared publicly.

### 3. The north is mapped, the Southern Hemisphere is not

![Coverage by latitude and by data source](figures/fig4_latitude_sources.png)

The 25–35° N and 50–65° N bands are about **50–55 %** measured (busy shipping lanes, Europe, North America, Japan). The 40–50° S band, under the Southern Ocean's storms, is only **19–20 %**. Multibeam sonar alone accounts for 26.4 % of the ocean; satellite-gravity prediction (code 40) covers 56.7 %.

## What it is useful for

* **Science and education:** see plate tectonics directly. Mid-ocean ridges, trenches, fracture zones and hotspot seamount chains are all visible on one globe.
* **Planning surveys:** the coverage layer shows where a ship's transit would add new data (grey areas).
* **Tsunami, cable and pipeline context:** seafloor slope and depth along any route, via the depth-profile tool in the viewer.
* **Fisheries and habitat:** seamounts, canyons and shelf edges are where marine life concentrates.
* **Honest maps:** any "seafloor map" you see online shows the same picture, but rarely says that ~70 % of it is an estimate. This one does.

## How it is built

```
GEBCO_2026 elevation (15″, 1′ overview)  ─┐
GEBCO_2026 TID grid (15″, official CEDA)  ─┼─ pipeline/coverage.py ── stats.json + coverage grid
                                           │
                                           ├─ pipeline/tiles.py ───── web tiles (Terrarium DEM + coverage veil)
GEBCO Gazetteer (5,412 names) ─────────────┼─ pipeline/features.py ── features.geojson
PB2002 plate boundaries (Bird 2003) ───────┴─ pipeline/plates.py ──── plates.geojson
                                              pipeline/figures.py ─── figures/*.png
```

* **Elevation** comes from a Cloud-Optimised GeoTIFF mirror of the official grid (Source Cooperative), so only the 1′ level (~140 MB) needs to be downloaded instead of 7.5 GB. `pipeline/verify_mirror.py` checks the mirror against the official GEBCO server cell by cell at 6 sites (Challenger Deep, Mid-Atlantic Ridge, Hawaii, SE Indian Ocean, North Sea, Himalaya). Result: **all 6 windows identical** for elevation and TID; the 1′ level is the mean of each 4 × 4 block of 15″ cells (max difference 0.8 m, rounding).
* **"Measured"** = TID codes 10–17 (single beam, multibeam, seismic, soundings, lidar, optical). **"Ocean"** = TID ≠ 0 *and* elevation below sea level. Without the elevation test, the Antarctic ice sheet (2.7 % of Earth) would count as ocean.
* **Tiles:** Web Mercator, 512 px, zoom 0–5, lossless WebP. Depth is stored as Terrarium RGB in whole metres. See [docs/data-contract.md](docs/data-contract.md).

## Run it

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r pyproject.toml
pipeline/fetch_data.sh                    # inputs (~370 MB, needs GDAL)
.venv/bin/python pipeline/coverage.py     # stats + coverage grid   (~1 min)
.venv/bin/python pipeline/tiles.py        # web tiles              (~10 min)
.venv/bin/python pipeline/features.py     # undersea feature names
.venv/bin/python pipeline/plates.py       # plate boundaries
.venv/bin/python pipeline/figures.py      # README figures
.venv/bin/python -m pytest tests          # encoding tests
cd web && npm ci && npm run dev           # viewer at http://localhost:5173
```

## Limits

* The web map uses the 1′ grid (~1.85 km), so it shows features a few km across, not the full 15″ (~460 m) detail.
* The depth axis of figure 3 uses the 1′ cell mean, which smooths narrow trenches (Challenger Deep reads −10,900 m at 1′ vs −10,927 m at 15″).
* Even "measured" cells are a 460 m average. A single ship track crossing a cell marks it as measured.

## Data and licences

* GEBCO Compilation Group (2026) **GEBCO_2026 Grid**, doi:[10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa](https://doi.org/10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa). Open Government Licence v3.
* **IHO-IOC GEBCO Gazetteer of Undersea Feature Names**, www.gebco.net.
* Bird, P. (2003) An updated digital model of plate boundaries, *G³* 4(3), 1027. Via [fraxen/tectonicplates](https://github.com/fraxen/tectonicplates), ODC-By 1.0.
* Code: MIT. Prior work and how this differs: [docs/prior-work.md](docs/prior-work.md).
