# Prior work

Checked 2026-11-13/14 before building. What already exists and what this project adds.

## Data

| Product | Resolution | Licence | Notes |
|---|---|---|---|
| [GEBCO_2026 Grid](https://www.gebco.net/data-products/gridded-bathymetry-data) | 15" (~450 m) global | OGL v3, cite | Released April 2026. Base = SRTM15+ v2.8 (now with SWOT gravity + ML), plus Seabed 2030 regional multibeam compilations. Used here. |
| GEBCO TID grid | 15" | same | Per-cell source type (multibeam, single beam, satellite gravity, ...). Used here for the "measured" layer. |
| [GMRT](https://gmrt.org/) | multi-res, ~100 m where multibeam | CC BY 4.0 | Lamont synthesis of ship multibeam; finer than GEBCO in surveyed swaths. Candidate for a later high-res layer. |
| SRTM15+ (Tozer et al. 2019) | 15" | open | GEBCO's base grid. |
| EMODnet Bathymetry | ~115 m, European seas | CC BY 4.0 | Regional. |
| [GEBCO Gazetteer of Undersea Feature Names](https://www.gebco.net/data-products/undersea-feature-names) | 5,412 named features | cite IHO-IOC GEBCO | ArcGIS FeatureServer (points, lines, polygons). Used for labels. |
| PB2002 plate model (Bird 2003) via [fraxen/tectonicplates](https://github.com/fraxen/tectonicplates) | 5,824 boundary steps | ODC-By 1.0 | Boundary class (ridge, transform, subduction) + relative velocity. |

COG mirrors of GEBCO_2026 exist on Source Cooperative (ausantarctic/gebco, giswqs/gebco-bathymetry). They are third-party copies, so `pipeline/verify_mirror.py` checks them cell-for-cell against the official CEDA/BODC server before use.

## Viewers

| Viewer | What it shows | Gap this project fills |
|---|---|---|
| [GEBCO WMS](https://www.gebco.net/data-products/gebco-web-services/web-map-service) | Shaded relief and a colour-coded TID layer, 2D | No 3D, no combined relief + coverage, no profiles |
| ["Understanding TID" StoryMap](https://storymaps.arcgis.com/stories/115beb845eae4facb1047a5deb28f121) | Measured areas in colour vs indirect in black, 2D | Narrative only, ArcGIS-hosted |
| GEBCO [download tool](https://download.gebco.net) | Subset download | Not a viewer |
| GMRT MapTool | Custom maps / grids of GMRT | Desktop-style tool, not a globe |
| Google Earth ocean | Global relief from SRTM15+/GEBCO | Closed, does not say what is measured |

## What is new here

1. A 3D globe of the whole seafloor (MapLibre globe + terrain, own tiles, no third-party basemap) where **every pixel tells you whether a ship actually measured it** (continuous measured fraction, not just a class colour).
2. Our own area-weighted statistics from the TID grid: global measured share, measured share by depth and by latitude, and per source type, so the headline "x % mapped" can be checked and broken down.
3. Depth profiles, named features and plate boundaries on the same globe.
