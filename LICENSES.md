# Licences

This repository mixes code and data. **The code is MIT. The data files and the figures are not**: each keeps the licence of the source it was derived from. Use and redistribution of a data file must follow its row below, including attribution. Some layers are **non-commercial (NC)** and some are **ShareAlike (SA / ODbL)**.

None of the depths here are for navigation. The data is provided as is, without warranty.

## Code

| Path | Licence |
|---|---|
| `pipeline/`, `web/src/`, `web/scripts/`, `web/test/`, `tests/`, `.github/` | MIT ([LICENSE](LICENSE)) |

## Data files

| Path | Derived from | Licence of the derived file | Attribution |
|---|---|---|---|
| `web/public/tiles/dem/`, `tiles/coverage/`, `tiles/new2026/`, `web/public/history/`, `data/hypsometry.json`, `data/stories.json` (depth checks), HF dataset `ismoilovdev/seafloor-atlas-tiles` | GEBCO_2026 (and 2019–2025) grids, type identifier grids | GEBCO terms: public domain with attribution, no implied endorsement; CEDA lists OGL v3 for 2025–2026 | GEBCO Compilation Group (2026) GEBCO 2026 Grid, doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa |
| `data/features.geojson` | IHO-IOC GEBCO Gazetteer of Undersea Feature Names | cite | IHO-IOC GEBCO Gazetteer of Undersea Feature Names, www.gebco.net |
| `data/amoc.json` | RAPID-MOCHA-WBTS AMOC at 26.5 N, v2024-2 (monthly transports) | UK Open Government Licence v3.0 | Moat, B. I. et al. (2026), doi:10.5285/5c39bf4e-5140-5546-e063-7086abc027bc; data from the RAPID (UK NERC), MOCHA (US NSF) and WBTS (NOAA) programmes |
| `data/plates.geojson` | PB2002 (Bird 2003) via fraxen/tectonicplates | ODC-By 1.0 | Bird (2003), G³ 4(3) 1027 |
| `web/public/woa/` | World Ocean Atlas 2023 (NOAA NCEI) | public (NOAA), cite | Locarnini et al. 2024; Reagan et al. 2024 |
| `web/public/chl/` | NASA OBPG MODIS-Aqua R2022.0 | NASA open data, no restrictions | NASA OBPG, doi:10.5067/AQUA/MODIS/L3M/CHL/2022.0 |
| `web/public/flow/wind/` | NCEP/NCAR Reanalysis 1 (NOAA PSL) | public, acknowledge | Kalnay et al. 1996; NOAA PSL |
| `web/public/flow/currents/` | OSCAR v2.0 (ESR, NASA PO.DAAC) | NASA open data, cite | ESR (2022), doi:10.5067/OSCAR-25F20 |
| `data/quakes.json` | USGS ANSS ComCat | public domain | USGS ANSS ComCat |
| `data/seamounts.json` | SDUST2026SM; SIO 2023 / Kim & Wessel 2011 | **CC BY 4.0** | Gao et al. 2026, doi:10.5281/zenodo.23277209; Gevorgian et al. 2023, doi:10.5281/zenodo.7718512 |
| `tiles/disagree/` | AUST_2026_BAT minus GEBCO_2026 | **CC BY 4.0** | Yuan & Yang 2026, doi:10.5281/zenodo.22711109 |
| `tiles/uncertainty/` | SWOT ML confidence (Nilsson, Phrampus et al. 2025) | **CC BY 4.0** | doi:10.5281/zenodo.17673974 |
| `data/seals.geojson`, `data/seals-coverage.geojson` | SO-ABBA v1.0 | **CC BY 4.0** | Hindell, McMahon, Jonsen et al. 2026, doi:10.5281/zenodo.19121676 |
| `data/obis/grid/records_*`, `data/obis/groups/`, `data/obis/cells/` (records) | OBIS | cite OBIS; individual datasets CC0 / CC BY / CC BY-NC | OBIS (2026) www.obis.org |
| `data/obis/grid/species_*`, `es50_*` | OBIS speciesgrids (OBIS + GBIF) | **CC BY-NC 4.0** (non-commercial) | OBIS speciesgrids build 20261014 |
| `data/obis/grid/aquamaps_richness.bin` | AquaMaps 10/2019 | **CC BY-NC 3.0** (non-commercial); maps must be identified as AquaMaps with a link to aquamaps.org | Kaschner et al. 2019, www.aquamaps.org |
| `tiles/shipping/` | World Bank / IMF Global Shipping Traffic Density | **CC BY 4.0** | Cerdeiro, Komaromi, Liu & Saeed 2020 |
| `data/wrecks.geojson` | Wikidata | CC0 | Wikidata |
| `data/cables.geojson`, `data/landing-points.geojson` | TeleGeography Submarine Cable Map, snapshot 2022-11-14 | **CC BY-NC-SA 3.0** (non-commercial, ShareAlike) | TeleGeography, submarinecablemap.com |
| `data/cables-osm.geojson`, `data/platforms.geojson`, `data/pipelines.geojson`, `data/windfarms.geojson` | OpenStreetMap | **ODbL 1.0** (ShareAlike for the database) | © OpenStreetMap contributors |
| `data/sea-level-history.json` | Lambeck et al. 2014, PNAS, SI Table S3 | factual values reproduced with citation; no separate data licence | Lambeck, Rouby, Purcell, Sun & Sambridge (2014), doi:10.1073/pnas.1411762111 |
| none stored: satellite land (`web/src/basemap.ts`) | Esri World Imagery, streamed from server.arcgisonline.com while Satellite land is on (default; off = no requests) | Esri terms of use; not redistributed | "Powered by Esri" plus the service's copyrightText, shown under the readout while it is on |
| Marine Regions-derived tables in `docs/regions.md` | Flanders Marine Institute | **CC BY 4.0** | doi:10.14284/542, 10.14284/632, 10.14284/696 |

## Figures (`figures/`, `docs/img/`)

Figures are derived works of their inputs and carry the most restrictive licence among them:

| Figure | Licence |
|---|---|
| fig1–fig5, fig9, fig13 | GEBCO terms (attribution); fig9 also uses Hotham 2026 (CC BY 4.0) |
| fig6 | CC BY 4.0 (Marine Regions) |
| fig7 | CC BY 4.0 (AUST_2026_BAT) |
| fig8 | CC BY 4.0 (SO-ABBA) |
| fig10 | **CC BY-NC 4.0** (OBIS speciesgrids, AquaMaps CC BY-NC 3.0) |
| fig11 | CC BY 4.0 (seamount catalogues); earthquakes public domain |
| fig12 | NASA / NOAA open data |
| `docs/img/*.jpg` (screenshots) | most restrictive layer visible in each; `cables.jpg` is CC BY-NC-SA 3.0, `north-sea.jpg` and `shipping.jpg` include ODbL / CC BY layers |

If you need any layer for commercial use, take it from its original source under that source's terms.
