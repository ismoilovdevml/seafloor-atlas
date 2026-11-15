---
title: "How much of the seafloor has been measured? A reproducible, release-by-release accounting of the GEBCO Type Identifier grids, 2019–2026"
author: "Otabek Ismoilov"
date: "Preprint, version 2, 16 November 2026"
bibliography: references.bib
link-citations: true
lang: en-GB
geometry: margin=2.5cm
fontsize: 11pt
header-includes:
  - \usepackage{fancyhdr}
  - \pagestyle{fancy}
  - \fancyhead{}
  - \fancyhead[C]{\small This is a non-peer-reviewed preprint submitted to EarthArXiv.}
  - \fancyfoot[C]{\thepage}
  - \renewcommand{\headrulewidth}{0pt}
  - \usepackage{newunicodechar}
  - \newunicodechar{→}{\ensuremath{\rightarrow}}
  - \newunicodechar{≠}{\ensuremath{\neq}}
  - \newunicodechar{≥}{\ensuremath{\geq}}
  - \newunicodechar{≈}{\ensuremath{\approx}}
---

<!--
SOURCE CONVENTION. Every number in the text is followed by an HTML comment naming the repository file
(and key) it comes from. HTML comments are dropped by pandoc in PDF output. Paths are relative to the
repository root. "derived:" means simple arithmetic on the named file, shown in the comment.
Main sources:
  H  = data/derived/history_stats.json           (pipeline/history.py build, 2026-11-15)
  S  = data/derived/stats.json                   (pipeline/coverage.py)
  C  = data/derived/change_2025_2026.json        (pipeline/change.py)
  RG = data/derived/regions.json, docs/regions.md (pipeline/regions.py)
  T  = data/derived/trenches.json, docs/trenches.md (pipeline/trenches.py)
  D  = data/derived/disagree_stats.json          (pipeline/disagree.py)
  SE = data/derived/seals_stats.json             (pipeline/seals.py)
  U  = data/derived/uncertainty_stats.json       (pipeline/uncertainty.py)
  SM = data/derived/seamounts_stats.json         (pipeline/seamounts.py)
  RL = docs/paper/analysis/recoded_by_latitude.json (docs/paper/analysis/recoded_by_latitude.py, run 2026-11-15)
  OFF = OFFICIAL dict in pipeline/history.py (quotes re-checked on each URL on 2026-11-15)
-->

**Otabek Ismoilov**, Independent researcher. ORCID: https://orcid.org/0009-0008-2785-3691. Correspondence: ismoilovdev@gmail.com.

**Status:** This is a non-peer-reviewed preprint submitted to EarthArXiv.

**Keywords:** bathymetry; GEBCO; Seabed 2030; ocean mapping; type identifier grid; reproducibility

# Abstract

The Nippon Foundation–GEBCO Seabed 2030 Project reports with each GEBCO release the share of the seafloor that has been mapped, from 15 % in 2019 to 28.7 % in 2026, computed on target grids that are not distributed. <!-- OFF 2019, 2026 --> Following @niyazi2025, we compute a reproducible alternative from the public Type Identifier (TID) grids, extended to all eight releases from 2019 to 2026, with exact spherical areas and one fixed ocean mask of 361.7 million km². <!-- H ocean_km2 = 361,694,058 --> The share of 15″ ocean cells coded as directly measured (TID 10–17) rises from 12.4 % to 30.8 %, matching their 12.4 % and 28.5 % for 2019 and 2024. <!-- H years[0] 0.12427, years[5] 0.28544, years[7] 0.30810 --> Following every cell from one release to the next shows that the coding is not cumulative: 0.8–4.6 million km² leave the measured codes in each transition. <!-- H no_longer_measured_vs_previous_km2: min 764,863, max 4,624,417 --> By 2026, 33.0 % of the seafloor has been coded as measured in at least one release, an upper bound against 30.8 % today; north of 66.5° N, 16 % of that area is no longer coded so, against 7 % globally. <!-- H years[7].ever_measured_frac 0.33037; RL 0.164, 0.067 --> The least-measured seafloor is the abyssal plain (26.7 % at 4–5 km), 40–50° S (19–20 %) and the high seas (26.4 %, against 38.0 % in exclusive economic zones). <!-- S, RG --> On blocks of near-constant width the shares barely change (31.1 % or 30.6 %) and the Arctic gap remains, but when one sounding marks a whole block the share grows with block size, to 33.5 % at ~0.9 km and 37.7 % at ~1.9 km. <!-- SC ew1_any 0.3112, ew1_majority 0.3060, ew2_any 0.3352, ew4_any 0.3765 --> Coverage figures are therefore only comparable at a stated cell size. We recommend reporting the "ever measured" share and the area re-coded per release alongside the headline figure.

# 1 Introduction

Most of the ocean floor is known only indirectly. Global bathymetric grids such as SRTM15+ [@tozer2019] fill the space between ship soundings with depths predicted from satellite-derived marine gravity [@smith1997]. These predictions resolve features only a few kilometres across, and their errors are poorly constrained away from ship tracks. The Nippon Foundation–GEBCO Seabed 2030 Project, launched in June 2016, aims to have the entire seafloor mapped by 2030 [@mayer2018; @wolfl2019]. <!-- Mayer et al. 2018, Introduction: launched at the Forum for the Future of Ocean Floor Mapping, Monaco, June 2016 --> It reports progress as one number with each annual GEBCO grid release: 15 % in 2019, 19 % in 2020, 20.6 % in 2021, 23.4 % in 2022, 24.9 % in 2023, 26.1 % in 2024, 27.3 % in 2025 and 28.7 % in 2026 [@news2019; @news2020; @news2021; @news2022; @news2023; @news2024; @news2025; @news2026]. <!-- OFF, each quote found verbatim on the cited page on 2026-11-15 -->

How the number is defined matters. @mayer2018 set depth-dependent resolution goals: grid cells of 100 m at 0–1,500 m depth, 200 m at 1,500–3,000 m, 400 m at 3,000–5,750 m and 800 m at 5,750–11,000 m. The seafloor counts as "mapped" if at least one sounding falls in a cell of that size (their Table 2). <!-- read first-hand in the open-access PDF of Mayer et al. 2018 --> The release announcements give the resulting percentage, and the 2026 announcement also gives an area of about 104 million km², <!-- OFF 2026 page: "approximately 104 million square kilometres of mapped seabed" --> but they do not describe the calculation in enough detail to reproduce it. The multi-resolution target grids exist only as test data sets for three regions [@gebcodoc2026].

Every GEBCO grid release also comes with a Type Identifier (TID) grid, which codes the source of each 15″ cell: land; direct measurement (single beam, multibeam, seismic, isolated sounding, sounding from an electronic navigational chart, lidar, optical, or a combination); indirect estimate (satellite-gravity prediction, interpolation, chart contours, mixed gridded data, and others); or unknown [@gebcodoc2026]. The TID grid is public, versioned and the same size for every release since 2019, and it is what users actually work with when they want to know whether a depth was measured. GEBCO_2014 already had a similar source identifier grid [@weatherall2015]. <!-- checked 2026-11-15: Weatherall et al. 2015 describe the GEBCO_2014 SID grid (soundings / pre-generated grids / interpolation) -->

This paper asks four questions of the TID grids, with every number computed openly from the released files:

1. What share of the seafloor is coded as directly measured in each release from 2019 to 2026, and how does it compare with the official figure?
2. How stable is the coding between releases?
3. Where, by depth, latitude, ocean and jurisdiction, are the gaps?
4. How sensitive are the shares to the size of a 15″ cell, which shrinks east–west towards the poles?

The closest earlier work is @niyazi2025. They used the GEBCO bathymetry and TID grids of 2019–2024 on the native 15″ grid, counted TID 10–17 as mapped, and computed areas from pixel counts after projecting to Mollweide. They report 12.4 % mapped in 2019 and 28.5 % in 2024, with breakdowns by ocean, depth zone and exclusive economic zone, and a mean gain of about 3.2 % of the seafloor per year. They also note that some regional shares swing between releases, for example in the Baltic Sea, and attribute this to mis-categorisation. <!-- Niyazi et al. 2025, Results and Discussion, read 2026-11-16 -->

This paper adds four things to that analysis: (i) a release-to-release account of the area that enters and leaves the measured codes, with the codes it moves to; (ii) the share measured in at least one release; (iii) the GEBCO_2025 and GEBCO_2026 releases; and (iv) exact spherical areas, a fixed ocean mask and fully open code, so that every number can be recomputed. Where our periods overlap, the two studies agree (Section 5). We use the compilation of published depths at the deepest places by @hotham2026 as a reference.

# 2 Data

**GEBCO grids.** We use the TID grids of GEBCO_2019 to GEBCO_2026 [@gebco2019; @gebco2020; @gebco2021; @gebco2022; @gebco2023; @gebco2024; @gebco2025; @gebco2026], each 86,400 × 43,200 cells at 15″. <!-- pipeline/history.py H15, W15; docs/data-contract.md "Mapping history / Inputs" --> The 2019–2025 grids were downloaded as the official netCDF archives from the Centre for Environmental Data Analysis (CEDA) and converted to GeoTIFF without resampling, with an orientation check (pipeline/history.py, convert step). <!-- docs/data-contract.md "Mapping history / Inputs"; pipeline/fetch_data.sh for 2025 --> The GEBCO_2026 TID and elevation grids came from cloud-optimised mirrors. These were checked cell for cell against the official server at six test sites, and elevation and TID matched at all six. <!-- data/derived/verify_mirror.json: elev_equal and tid_equal true at 6 sites --> The ocean mask uses the GEBCO_2026 elevation at 1′; the depth statistics and validation use the 15″ elevation. The bundled GEBCO terms of use place the grids in the public domain, with attribution required; CEDA lists the Open Government Licence v3 for 2025–2026. <!-- LICENSES.md; docs/data-contract.md "Citation, licence, attribution" -->

**Official figures.** The eight percentages above, each taken from the announcement accompanying a release (dates 13 June 2019 to 27 April 2026). <!-- OFF dates -->

**Regions.** Marine Regions' Global Oceans and Seas v1 [@vliz2021goas], World EEZ v12 [@vliz2023eez] and High Seas v2 [@vliz2024hs], all CC BY 4.0. <!-- docs/regions.md "Sources and licences" -->

**Reference depths.** The 14 deepest places with published depths compiled by @hotham2026 (CC BY 4.0). That compilation cites the original surveys, and Wikipedia for some places. <!-- docs/trenches.md -->

# 3 Methods

**Ocean mask.** One mask is used for every release: TID ≠ 0 in GEBCO_2026 and GEBCO_2026 1′ elevation < 0. The elevation condition removes the Antarctic ice sheet and ice shelves, which the TID grid codes as non-land. <!-- pipeline/coverage.py docstring and comments; docs/data-contract.md "TID classes" --> With a fixed mask, year-to-year differences come only from the TID codes. Using each release's own mask instead changes the share by at most 0.02 percentage points. <!-- H measured_frac_own_mask vs measured_frac: max |diff| 0.0002 (2021: 21.930 vs 21.915 %) --> The mask covers 361.7 million km². It includes the Caspian Sea and lake beds below sea level (about 0.15 % of the area). These are kept in the global figures and excluded from the regional tables. <!-- H ocean_km2; README "Limits"; docs/regions.md "Caspian Sea, excluded" -->

**Measured.** "Measured" means TID 10–17 (direct measurement); all other ocean codes are "not measured". <!-- docs/data-contract.md "TID classes" --> One sounding in a 15″ cell is enough. The measure is therefore a count of cells holding data, like the Seabed 2030 definition, but on the native grid. A 15″ cell is 463 m north–south everywhere, but its east–west width shrinks with latitude: 463 m at the equator, 232 m at 60° and 80 m at 80°. The same survey density therefore marks a smaller area as measured at high latitudes. We test the effect of this in Section 4.4.

**Area weighting.** Each 15″ cell is weighted by its exact area on a sphere of radius R = 6,371.0072 km, the authalic (equal-area) radius of the GRS80 ellipsoid [@moritz2000]. For a row of cells between latitudes φ₁ < φ₂, the area is A = R² Δλ (sin φ₂ − sin φ₁), with Δλ = 1/240° in radians. The grid's geodetic latitudes are used directly as latitudes on this sphere; the difference from converting them to authalic latitudes changes no reported share at the precision given. <!-- pipeline/history.py row_area_km2, R_KM; pipeline/change.py; pipeline/trenches.py --> The GEBCO_2026-only statistics in pipeline/coverage.py weight cells by cos φ at the row centre, which gives the same fraction (both 30.810 %). <!-- S measured_fraction_area 0.308102; H years[7].measured_frac 0.308102 -->

**Release-to-release bookkeeping.** For each release y we compute:

- the measured area m(y);
- the area newly measured relative to y − 1;
- the area measured in y − 1 but not in y ("re-coded away"), tallied by the TID code it received;
- the area measured in y or any earlier release ("ever measured").

The identity m(y) = m(y − 1) + new − re-coded holds to better than 5 km² for every pair of releases (pipeline/history.py, check step). <!-- docs/data-contract.md "Numbers": "Bookkeeping ... holds to < 5 km² every year" --> To see where the re-coded area lies, we summed it in latitude bands (docs/paper/analysis/recoded_by_latitude.py, using the same mask and areas). The sums agree with the per-release totals in pipeline/history.py to the km². <!-- RL lost_vs_previous_by_lat_km2 row sums == H no_longer_measured_vs_previous_km2, e.g. 2020: 4,624,417 both -->

**Stratification.** Depth bins (250 m) use the 1′ cell elevation, with the measured fraction taken from the 16 15″ TID cells inside each 1′ cell. Latitude bands are 5° wide (pipeline/coverage.py). <!-- S depth_bins_m, lat_edges --> Marine Regions polygons were rasterised onto the 1′ grid by cell centre (pipeline/regions.py). Overlapping claims and joint regimes are counted once in the "all EEZs" total. <!-- docs/regions.md -->

**Consistency with published depths.** For each of the 14 reference places, we took the deepest 15″ GEBCO_2026 cell within ±0.25° of the published position and recorded its TID (pipeline/trenches.py). This is a consistency check, not an independent validation: the published surveys are themselves contained in GEBCO, and nine of the 14 places have no published position. Ocean volume is the sum of cell area × depth over the mask, with the Caspian Sea excluded. <!-- pipeline/trenches.py docstring, BOX = 0.25 -->

**Cell-size sensitivity.** To remove the narrowing of 15″ cells towards the poles, we merged, in each row at latitude φ, k = max(1, round(1/cos φ)) adjacent cells along longitude into one block, starting at 180° W, so that blocks are about 463 m wide everywhere (309–618 m, because k is a whole number; k = 1 equatorward of 48.2°). A block counts as measured if any of its ocean cells is measured, or, in a second variant, if more than half are. To show the effect of block size itself, we repeated this with 2 and 4 rows per block (about 926 m and 1,853 m). Block areas are the sums of their ocean cells' exact areas, so the total ocean area is the same in every variant (pipeline/sensitivity_cellsize.py). <!-- data/derived/sensitivity_cellsize.json block_rule; tests/test_sensitivity_cellsize.py -->

**Cross-checks.** The GEBCO_2026 measured share was computed by three separate scripts with different aggregation. pipeline/coverage.py (15″, cos φ weights) and pipeline/history.py (15″, exact areas) both give 30.810 %. pipeline/regions.py (1′ cells, fraction stored in 1/254 steps) gives 30.809 %. <!-- S 0.3081019; H 0.3081019; RG global_check measured_fraction 0.3080868 --> The 2025→2026 new and re-coded areas from pipeline/change.py (6.57 and 2.51 million km²) match pipeline/history.py. The two differ only in the third decimal of the re-coded area, because change.py uses the union of both years' masks. <!-- C newly_measured_km2 6,565,379, no_longer_measured_km2 2,512,741; H years[7] new 6,565,379, lost 2,505,725 -->

# 4 Results

## 4.1 Measured share per release

The area coded as directly measured grows from 44.9 million km² in GEBCO_2019 to 111.4 million km² in GEBCO_2026, or from 12.4 % to 30.8 % (Table 1, Figure 1a). <!-- H measured_km2 44,947,953 and 111,438,640 --> Our share is 2.6 percentage points below the official figure in 2019 and 0.8 points below in 2020. From 2021 it is 1.3–2.4 points above (Table 1). <!-- derived from H: 12.43-15.0 = -2.57; 18.24-19.0 = -0.76; 2021..2026 +1.31, +1.95, +1.37, +2.44, +2.39, +2.11 --> For 2026, our 111.4 million km² compares with the "approximately 104 million square kilometres" announced. <!-- H; OFF 2026 page -->

| Release | TID 10–17 share | Official | Difference (pp) | New vs previous (M km²) | Re-coded away (M km²) | Ever measured |
|---|---:|---:|---:|---:|---:|---:|
| 2019 | 12.43 % | 15 % | −2.57 | – | – | 12.43 % |
| 2020 | 18.24 % | 19 % | −0.76 | 25.65 | 4.62 | 19.52 % |
| 2021 | 21.91 % | 20.6 % | +1.31 | 17.35 | 4.06 | 23.49 % |
| 2022 | 25.35 % | 23.4 % | +1.95 | 14.48 | 2.07 | 26.82 % |
| 2023 | 26.27 % | 24.9 % | +1.37 | 7.83 | 4.48 | 28.70 % |
| 2024 | 28.54 % | 26.1 % | +2.44 | 10.00 | 1.80 | 30.39 % |
| 2025 | 29.69 % | 27.3 % | +2.39 | 4.92 | 0.76 | 31.47 % |
| 2026 | 30.81 % | 28.7 % | +2.11 | 6.57 | 2.51 | 33.04 % |

: Directly measured share of the seafloor in each GEBCO release (TID 10–17, fixed GEBCO_2026 ocean mask of 361.7 M km², exact spherical areas), the official Seabed 2030 figure, and release-to-release changes. <!-- H years[*]: measured_frac, official_percent, new_vs_previous_km2, no_longer_measured_vs_previous_km2, ever_measured_frac; same as docs/data-contract.md "Numbers" table -->

![(a) Directly measured share of the seafloor in each GEBCO release: this study (TID 10–17, fixed ocean mask), the announced Seabed 2030 figure, and the share measured in this or any earlier release. (b) First release in which each 4′ cell contains a directly measured 15″ cell; red marks cells measured in an earlier release but not in GEBCO_2026. Map (b) uses the Equal Earth projection centred on 150° E, so that the Pacific is not split. Data: GEBCO Compilation Group, GEBCO_2019–GEBCO_2026 TID grids; official figures from GEBCO, Seabed 2030 and Nippon Foundation announcements. Figure licence: GEBCO terms of use (public domain, attribution required).](../../figures/fig13_mapping_history.png){#fig:history width=100%}

We cannot reproduce the official calculation, so we can only point out what should make the two differ. If both measures count a cell as soon as it holds one sounding, the measure with the larger cell credits more area per sounding. A 15″ cell (463 m × 463 cos φ m) is larger in area than the 400 m Seabed 2030 target cell for 3,000–5,750 m depth only equatorward of about 42°, and larger than the 200 m and 100 m targets for shallower depths up to about 79° and 87° [@mayer2018]. <!-- derived: 463^2 cos(phi) > 400^2 -> phi < 41.7 deg; > 200^2 -> phi < 79.2; > 100^2 -> phi < 87.3 --> Most of the ocean lies at 3,000–5,750 m (72.6 % according to @mayer2018) and equatorward of 42°, so a higher TID share is expected globally, but not at high latitudes, where the 15″ cell is smaller than the 400 m target. The direction of the 2019–2020 gap is not explained by cell size. The GEBCO documentation describes a change in compilation method between these releases, from "remove-restore" blending in 2019 to direct insertion of sparse regional grids from 2020 [@gebcodoc2026]. We could not test whether this or a different counting rule is responsible.

## 4.2 Re-coding between releases

The measured area does not only grow. In every transition, part of the area coded as measured in one release is coded as not measured in the next: 4.62 million km² in 2020, 4.06 in 2021, 2.07 in 2022, 4.48 in 2023, 1.80 in 2024, 0.76 in 2025 and 2.51 in 2026 (Table 1). <!-- H no_longer_measured_vs_previous_km2 --> Over the seven transitions, 86.8 million km² entered the measured codes and 20.3 million km² left them. <!-- derived: sum of H new_vs_previous_km2 = 86,794,561; sum of no_longer_measured = 20,303,874; check 44,947,953 + 86,794,561 - 20,303,874 = 111,438,640 = H years[7].measured_km2 --> The re-coded cells most often become TID 40 (satellite-gravity prediction), 41 (interpolation), 44 (mixed gridded data guided by gravity) or 70 (pre-generated grid). In 2020, for example, 2.62 million km² became TID 40, 1.30 million km² TID 44 and 0.68 million km² TID 70; in 2021, 1.53 million km² became TID 70, 1.25 million km² TID 41 and 1.09 million km² TID 40. <!-- H years[1].no_longer_measured_now_coded {40: 2,622,777, 44: 1,302,583, 70: 680,405}; years[2] {70: 1,529,972, 41: 1,250,136, 40: 1,087,773} -->

Some of this area is coded as measured again later. The net effect by 2026 is that 33.0 % of the seafloor (119.5 million km²) has been coded as measured in at least one release, against 30.8 % (111.4 million km²) in GEBCO_2026. <!-- H years[7].ever_measured_km2 119,492,714, ever_measured_frac 0.33037 --> The difference, 8.05 million km² or 2.2 % of the ocean, is coded in GEBCO_2026 as TID 40 (51.8 %), 41 (23.4 %), 44 (12.3 %) or 70 (11.5 %). <!-- RL recoded_total_km2 8,054,074 = 119,492,714 - 111,438,640; recoded_2026_code_km2 40: 4,171,054; 41: 1,881,784; 44: 988,832; 70: 928,292 -->

Most of this area lies at low and middle latitudes, where most of the ocean is (red in Figure 1b). Relative to the area ever measured, however, the Arctic stands out. North of 66.5° N lies 3.6 % of the ocean but 8.2 % of the re-coded area (0.66 million km²). There, 16.4 % of the area ever coded as measured is not coded so in GEBCO_2026, against 6.7 % globally and 9.4 % south of 60° S. <!-- RL: >66.5N recoded 659,300 / 8,054,074 = 0.082; ocean 13,110,338 / 361,694,058 = 0.036; 659,300 / 4,012,478 = 0.164; global 8,054,074 / 119,492,714 = 0.067; <60S 610,376 / 6,524,213 = 0.094 --> The Arctic losses are concentrated in two transitions. North of 66.5° N lie 21 % of the 2021 re-coding (36 % north of 60° N) and 49 % of the 2025 re-coding; in other years the share is 10 % or less. <!-- RL lost_vs_previous_by_lat_km2: 2021 855,075/4,059,674 = 21.1 %, (587,268+855,075)/4,059,674 = 35.5 %; 2025 377,661/764,864 = 49.4 %; others <= 9.7 % (2024) --> The largest single transition, 2023, was mostly at 30–60° S (2.03 of 4.48 million km²). <!-- RL 2023: 2,026,951 / 4,477,877 = 45 % -->

We do not interpret these changes as errors. The GEBCO documentation offers two mechanisms consistent with the pattern [@gebcodoc2026]. First, outside the polar regions, Seabed 2030 regional centres deliver "sparse grids" of cells with data. North of about 64° N (the IBCAO compilation; @jakobsson2020) and south of 50° S (IBCSO; @dorschel2022), they deliver complete regional grids, which are feather-blended into the global grid. When a new version of a complete regional grid replaces the previous one, all its source codes are replaced at once. The documentation lists IBCAO 5.0, 5.1 and 5.2 for the 2024, 2025 and 2026 releases. Second, a data set can be re-classified, for example as a pre-generated grid (TID 70) or as mixed gridded data (TID 44), without any change to the depths. The documentation also notes that the GEBCO_2023 TID grid was re-issued in January 2024 to correct coding errors in the North Pacific and central Mediterranean. We used the re-issued file; with the original, the 2022→2023 re-coded area would be 5.92 instead of 4.48 million km² (Section 6). Data contributed under different terms in successive years, or the downgrading of legacy soundings judged unreliable, would produce the same signal. The TID grids alone cannot separate these causes.

For users the practical consequence is simple: whether a cell counts as "measured" can depend on which release is used. For progress reporting, we suggest publishing, with each release, the area that entered and the area that left the measured codes, and the share measured in at least one release, alongside the headline figure.

## 4.3 Where the gaps are

Figure 2 shows the measured share of each 4′ cell in GEBCO_2026. Coverage is dense on the continental margins of Europe, North America, Japan and Australasia, and along transit lines, and sparse in the central South Pacific, the southern Indian Ocean and the South Atlantic.

![Share of each 4′ cell measured directly (TID 10–17) in GEBCO_2026; grey = predicted from satellite gravity or otherwise indirect. Equal Earth projection centred on 150° E. Data: GEBCO Compilation Group (2026), GEBCO_2026 Grid, TID grid. Figure licence: GEBCO terms of use (public domain, attribution required).](../../figures/fig2_measured.png){#fig:measured width=100%}

**By depth** (Figure 3). The abyssal seafloor, 3–6 km deep, makes up 74.4 % of the ocean area but is only 28.1 % measured. <!-- derived from S depth_ocean_area_rel and depth_measured_fraction, bins -6000..-3000: area 0.744, area-weighted fraction 0.281 --> The 4–5 km band alone (31.9 % of the area) is 26.7 % measured, the lowest of any 1 km band. <!-- derived from S, bins -5000..-4000: area 0.319, fraction 0.267 --> Depths of 1–3 km are 41–42 % measured, and the shelf (0–250 m) 30.9 %. <!-- derived from S: 1000-2000 m 0.420; 2000-3000 m 0.414; bin -250..0 0.309 (area 7.7 %) --> Trenches deeper than 7 km cover 0.1 % of the area and are 93.6 % measured, because expeditions target them. <!-- derived from S bins -11000..-7000: area 0.0011, fraction 0.936; README states 94 % -->

![Left: share of the ocean area per 250 m depth bin; right: share of each depth bin directly measured (TID 10–17), GEBCO_2026. Depth is the 1′ cell mean; coverage is computed from 15″ TID cells, area-weighted. Data: GEBCO Compilation Group (2026), GEBCO_2026 Grid. Figure licence: GEBCO terms of use (public domain, attribution required).](../../figures/fig3_depth.png){#fig:depth width=100%}

**By latitude.** The Northern Hemisphere ocean is 38.6 % measured, the Southern 25.0 %. <!-- derived from S lat_ocean_area_rel x lat_measured_fraction, 5-degree bands: N 0.386, S 0.250 --> The 25–35° N bands are 50 % measured and 50–65° N 50–55 %; 40–50° S is the least measured band of open ocean, at 19.4–20.3 %. <!-- S lat_measured_fraction: 25-30N 0.500, 30-35N 0.502; 50-55N 0.503, 55-60N 0.552, 60-65N 0.522; 45-40S 0.194, 50-45S 0.203 -->

**By ocean and jurisdiction** (Figure 4). The North Atlantic is 47.4 % measured, the North Pacific 39.4 %, the South Pacific 25.8 % and the Indian Ocean 20.5 %. <!-- RG / docs/regions.md Oceans table --> The 200-nautical-mile exclusive economic zones (EEZs) cover 139.6 million km² and are 38.0 % measured. The high seas, 61 % of the ocean, cover 221.1 million km² and are 26.4 % measured. <!-- RG zones all_eez 139,633,468 / 0.3795; high_seas 221,122,177 / 0.2642; docs/regions.md "The high seas are 61 %" --> Among EEZs larger than 100,000 km², metropolitan France (99.9 %), Ireland (97.7 %) and Portugal (97.2 %) are almost fully covered. The Maldives (2.3 %), the Chagos Archipelago (2.6 %) and China (3.3 %) are the least covered. <!-- docs/regions.md best/least-mapped EEZ tables --> These numbers describe what has been shared with GEBCO. A low value means "not in the public grid", not necessarily "never surveyed".

![Directly measured share of each EEZ (map, Equal Earth projection centred on 150° E) and of each ocean and sea (bars), GEBCO_2026. Data: GEBCO Compilation Group (2026), GEBCO_2026 Grid (TID 10–17); Flanders Marine Institute, Marine Regions World EEZ v12, High Seas v2 and Global Oceans and Seas v01 (CC BY 4.0). EEZ boundaries include disputed areas. Figure licence: CC BY 4.0 (Marine Regions) with GEBCO attribution.](../../figures/fig6_regions.png){#fig:regions width=100%}

**Year-on-year gains** (Figure 5). Between GEBCO_2025 and GEBCO_2026, 6.57 million km² became measured and 2.51 million km² were re-coded away, a net gain of 4.05 million km². <!-- C newly_measured_km2 6,565,379; no_longer_measured_km2 2,512,741; net_km2 4,052,638 --> The announcement for this release gives "almost five million square kilometres of data added" [@news2026]. The largest gain in a 10° × 10° box is in the Arabian Sea (10–20° N, 50–60° E: 0.20 million km²), followed by the box at 20–30° N, 60–70° E (0.097 million km²). <!-- C top_boxes_new[0] new_km2 201,774; [1] 97,212 --> This is the region where Seabed 2030 reported that the coverage of the ROPME Sea Area rose from about 6.4 % to 20.5 % [@iho2026]. The two areas are not identical, so this is a check on location, not on magnitude.

![Seafloor newly coded as directly measured in GEBCO_2026 relative to GEBCO_2025 (red); dark grey = measured in 2025. Equal Earth projection centred on 150° E. Red includes older surveys newly contributed. Data: GEBCO Compilation Group (2025, 2026), GEBCO_2025 and GEBCO_2026 TID grids. Figure licence: GEBCO terms of use (public domain, attribution required).](../../figures/fig5_new_in_2026.png){#fig:new width=100%}

## 4.4 Cell-size sensitivity

On blocks about 463 m wide, the global measured share is 31.12 % when any measured cell counts and 30.60 % when a majority must be measured, against 30.81 % on the native grid (Table 2, Figure 6). <!-- SC ew1_any 0.31122, ew1_majority 0.30602, native 0.30810 --> All of the +0.31 percentage points under the "any" rule come from rows poleward of 48.2°, where cells are merged. The high-latitude bands rise by at most 5.6 points (65–70° N) and by 1.3 points at 80–85° N, so the fall from 55–60° N to 80–85° N (37.7 points on the native grid) is 38.5 points on equal-width blocks. <!-- SC bands: 65-70N 38.7 -> 44.3; 80-85N 17.5 -> 18.8; drop native 55.2-17.5 = 37.7; ew1_any 57.3-18.8 = 38.5 --> The low Arctic shares are therefore not an artefact of narrow cells.

Block size matters more than latitude. With the "any" rule, the global share rises to 33.52 % on ~926 m blocks and 37.65 % on ~1,853 m blocks; with the "majority" rule it stays between 29.98 % and 30.60 %. <!-- SC ew2_any 0.3352, ew4_any 0.3765; ew2_majority 0.2998, ew1_majority 0.3060 --> A share defined by "one sounding per cell" therefore depends strongly on the cell size, which is one reason why figures computed on different grids, including the official one, should not be compared without stating the cell size.

| Band | Native 15″ | ~463 m, any | ~463 m, majority | ~926 m, any | ~1,853 m, any |
|---|---:|---:|---:|---:|---:|
| Global | 30.81 % | 31.12 % | 30.60 % | 33.52 % | 37.65 % |
| 55–60° N | 55.2 % | 57.3 % | 53.1 % | 61.8 % | 67.3 % |
| 65–70° N | 38.7 % | 44.3 % | 37.1 % | 53.5 % | 66.3 % |
| 80–85° N | 17.5 % | 18.8 % | 17.4 % | 21.1 % | 25.6 % |
| 60–65° S | 25.5 % | 26.3 % | 24.7 % | 29.8 % | 35.6 % |
| 75–80° S | 40.1 % | 43.0 % | 39.4 % | 49.7 % | 59.1 % |

: Measured share (TID 10–17, GEBCO_2026) on the native 15″ grid and on blocks of near-constant east–west width. "Any": a block counts as measured if at least one of its ocean cells is; "majority": if more than half are. All 5° bands are in data/derived/sensitivity_cellsize.json. <!-- SC variants.*.bands -->

![Measured share by 5° latitude band on native 15″ cells and on blocks of near-constant width (about 463, 926 and 1,853 m). Data: GEBCO Compilation Group (2026), GEBCO_2026 Grid and TID grid. Figure licence: GEBCO terms of use (public domain, attribution required).](../../figures/fig_sensitivity_cellsize.png){#fig:cellsize width=100%}

## 4.5 Consistency with published depths

At the 14 deepest places, the deepest GEBCO_2026 15″ cell within ±0.25° lies within a median of 10 m of the published depth (Figure 7). <!-- T / docs/trenches.md "Median |published − grid|: 10 m" --> Because the surveys behind the published depths are part of GEBCO and the search box picks the deepest cell, close agreement is expected; the check mainly confirms that our processing preserves the grid's extreme depths. The 10 km grid of @hotham2026 is shown for reference only; a grid that coarse cannot resolve trench floors, so the two are not comparable as measures of quality. For example, Challenger Deep is 10,927 m in the grid and 10,935 m in the published survey. <!-- T trenches[0] gebco_min_m 10927, published_m 10935 --> Seven of the 14 are within 10 m. <!-- derived from docs/trenches.md Diff column: +8, +7, +9, -5, +7, 0, -8 --> Three places miss by more than 300 m: Emden Deep (450 m), the Japan Trench (378 m) and the Cayman Trough (329 m). For the first two, the source gives a depth but no position, and the depth comes from Wikipedia. The deepest Cayman Trough cell is coded TID 40, so it was never measured. <!-- docs/trenches.md rows and Notes; T gebco_min_tid 40 for Cayman Trough -->

![Deepest places: published depth (bar), deepest GEBCO_2026 15″ cell within ±0.25° (filled), and the 10 km grid value of Hotham (2026) (open). Published depths and positions via Hotham (2026), doi:10.5281/zenodo.23850291 (CC BY 4.0). GEBCO Compilation Group (2026), GEBCO_2026 Grid. Figure licence: CC BY 4.0 (Hotham 2026) with GEBCO attribution.](../../figures/fig9_trenches.png){#fig:trenches width=90%}

Over the 15″ ocean mask, excluding the Caspian Sea (361.4 million km²), the ocean volume is 1.338 × 10⁹ km³ and the mean depth 3,702 m. <!-- T ocean.ocean_area_km2 361,375,209; volume_km3 1,337,802,136; mean_depth_m 3701.98 --> @charette2010 gave 1.332 × 10⁹ km³ and 3,682 m, and @hotham2026 3,675 m. Our volume is 0.4 % larger and our mean depth 20 m (0.5 %) deeper. <!-- derived: 1.3378/1.332 = 1.0044; 3702 - 3682 = 20 m, 20/3682 = 0.54 % --> Water under floating ice shelves is not counted, because the grid holds the ice surface there. Including it would increase both area and volume slightly. <!-- docs/trenches.md -->

# 5 Discussion

The TID-based share is not a replacement for the Seabed 2030 figure. The two answer different questions. The official figure measures progress against an engineering target, multibeam-resolution coverage at depth-dependent cell sizes [@mayer2018]. The TID share measures what users of the released grid can identify as measured. The TID share has three practical advantages: it can be reproduced from public files, it can be broken down by any region, depth or time, and it can be audited from one release to the next. Its main weaknesses are a cell size that varies with latitude and favours sparse single-beam tracks: one track marks a band up to 463 m wide as measured (Sections 3 and 4.4).

Both measures rise over 2019–2026, the TID share by about a third more: 18.4 percentage points against 13.7 for the official figure. <!-- derived: H 30.81 - 12.43 = 18.38; OFF 28.7 - 15.0 = 13.7 --> The TID share grows unevenly. The large 2020 step (25.65 million km² newly measured) is followed by much smaller gains in 2023 and 2025 (7.83 and 4.92). <!-- H new_vs_previous_km2 --> How long full coverage would take depends strongly on the period used. At the 2025→2026 net gain of about 4 million km² per year, the 250 million km² still unmeasured in GEBCO_2026 would take about 62 years. <!-- derived: C net_km2 4,052,638; unmeasured = 361,694,058 - 111,438,640 = 250,255,418; 250.3/4.05 = 62 --> At the 2019–2026 mean of 2.63 percentage points per year it would take about 26 years. <!-- derived: (30.81 - 12.43)/7 = 2.626 pp/yr; (100 - 30.81)/2.626 = 26.3 --> @niyazi2025, using a mean gain of about 3.2 % of the seafloor per year over 2019–2024, give about 20 years in their abstract, over 22 years in their outlook and completion by 2047 in their conclusion; we quote this as 20–22 years. These are extrapolations, not forecasts. Shared, legacy and crowd-sourced data arrive in bursts, and the unmeasured area is mostly deep abyssal plain, which takes longest to survey.

The re-coding result has a methodological consequence. Any study that uses the TID grid of one release as a "measured" mask, for example to separate measured from predicted depths in a validation, should state the release. Results can change by millions of square kilometres between releases without any new survey. The "ever measured" share (33.0 % by 2026) counts every cell coded as directly measured in at least one public release. It is an upper bound: it also keeps cells that GEBCO later re-coded because the earlier code was an error. <!-- H years[7].ever_measured_frac --> The current share (30.8 %) counts only cells still coded so. Reporting both, together with the area re-coded each year, would make the headline figure easier to interpret.

**Comparison with @niyazi2025.** Where the periods overlap, our global shares match theirs to the first decimal although the area methods differ (exact spherical cell areas here, planar Mollweide pixel areas there). Their regional figures are for 2024 and ours for 2026, so the regional rows show the change over two releases rather than a check.

| Quantity | @niyazi2025 | This study |
|---|---:|---:|
| Global share, 2019 | 12.4 % | 12.43 % |
| Global share, 2024 | 28.5 % | 28.54 % |
| North Atlantic | 44.5 % (2024) | 47.4 % (2026) |
| North Pacific | 37.2 % (2024) | 39.4 % (2026) |
| South Pacific | 23.4 % (2024) | 25.8 % (2026) |
| Indian Ocean | 17.5 % (2024) | 20.5 % (2026) |
| All EEZs | 33.2 % (2024) | 38.0 % (2026) |
| Mean gain per year | ≈ 3.2 % of the seafloor (2019–2024) | 2.63 pp (2019–2026) |
| Re-coding out of measured codes | noted for single regions | 0.8–4.6 M km² per release, globally |

: Comparison with @niyazi2025. Their values are as printed in their Results; ocean boundaries differ between the two studies (they use their own basin polygons, we use Marine Regions Global Oceans and Seas v1). <!-- Niyazi et al. 2025 Results, read 2026-11-16; ours: H years[0], years[5] measured_frac; RG oceans; RG zones all_eez; derived mean gain (30.81-12.43)/7 -->

Our re-coding account is consistent with their observation that some regional shares swing between releases (the Baltic Sea in their study). It shows that these swings are not local: every transition since 2019 moved between 0.8 and 4.6 million km² out of the measured codes.

# 6 Limitations

- **Definition.** "Measured" is GEBCO's own source classification. We do not check whether a cell coded as measured is accurate, or whether a single sounding represents a whole cell. The share is a cell count, not swath coverage.
- **Cell size varies with latitude.** The east–west width of a 15″ cell falls from 463 m at the equator to 80 m at 80°. Section 4.4 tests the effect on cells of near-constant width.
- **Fixed ocean mask.** Using GEBCO_2026 for all years ignores coastline and ice-shelf changes; the own-mask shares differ by at most 0.02 percentage points. Water under floating ice shelves and the Antarctic ice sheet are excluded. The Caspian Sea and lake beds below sea level (about 0.15 % of the area) are included in the global figures. <!-- H; README "Limits" -->
- **TID versions.** We used the TID archives available from CEDA in November 2026. The GEBCO_2023 TID grid was re-issued in January 2024 [@gebcodoc2026]. Both issues carry identical netCDF metadata (`date_created` 2023-05-18), so we identified ours by checksum: it is the re-issue (netCDF dated 2024-02-12 inside the CEDA archive), not the April 2023 original preserved in a web archive. A cell-by-cell comparison shows 2.80 million km² of the ocean re-coded between the two issues, mostly in the Mediterranean (TID 41 to 17 or 70), plus a re-coding off Brazil (24–18° S) that the GEBCO notes do not mention. With the original file, the 2023 share would be 25.89 % instead of 26.27 %, and 1.45 million km² of Mediterranean seafloor would appear to leave the measured codes in 2023 and return in 2024. Other releases may have been re-issued without notice; we analysed the files as distributed in November 2026. <!-- docs/gebco2023_tid_version.md; sha256 of converted tif db45124a...; compare_out: ocean diff 2,804,267 km2; original 2023 measured 93.64 M km2 (25.89 %), recoded out 5.92 M km2 -->
- **"First measured" is not the survey year.** A release can add surveys collected years earlier.
- **Shared is not surveyed.** National and commercial surveys withheld from GEBCO are counted as unmeasured.
- **Region boundaries.** Polygons are rasterised by cell centre on a 1′ grid. Boundaries are accurate to about one cell (about 1.9 km), so small EEZs below about 10,000 km² carry errors of a few percent. EEZ boundaries are political and often contested. <!-- docs/regions.md "Caveats" -->
- **Reference depths.** Nine of the 14 reference places have no published position, and several depths come from Wikipedia. The comparison is a consistency check, not an independent validation. <!-- docs/trenches.md Notes: 9 places listed -->
- **No uncertainty on the shares.** The percentages are exact sums under a stated definition. Their uncertainty is one of definition (cell size, code grouping), not sampling. We did not attempt to reproduce the Seabed 2030 calculation.

# Appendix A: Supplementary analyses

These analyses use the same grids but answer different questions from the main text. They are kept here so the main argument stays on the TID record.

**Data.** **Independent depth information.** AUST_2026_BAT [@yuan2026], a 1′ global bathymetry predicted from marine gravity with deep neural networks for 75° S–75° N. <!-- docs/data-contract.md "Model disagreement" --> SO-ABBA v1.0 [@hindell2026], the maximum depths of 4,492,019 quality-flagged seal dives in the Southern Ocean, 1996–2025. <!-- SE dives_flag1, date_range --> And the SWOT machine-learning confidence classes of @nilsson2025. All are CC BY 4.0.

**Methods.** For model disagreement, we compared AUST_2026_BAT cell by cell with the GEBCO_2026 1′ value (the mean of 4 × 4 15″ cells). The cell centres of the two grids coincide, so no resampling was needed. Each 1′ cell was classed as measured (all 16 sub-cells TID 10–17), unmeasured (none) or partial, and we report GEBCO depths ≥ 1,000 m (pipeline/disagree.py). <!-- docs/data-contract.md "Model disagreement" --> For each seal dive, the excess is the maximum dive depth plus the GEBCO_2026 elevation. The chart depth is the deepest 15″ cell within ±1 standard error of the dive location, and a dive counts as "deeper than the chart" if the excess exceeds 20 m (pipeline/seals.py). <!-- docs/data-contract.md "Seal dives"; SE method -->

## A.1 Where not measured: model disagreement and seal dives

**Model disagreement** (Figure 8). Unmeasured 1′ cells with GEBCO depths ≥ 1,000 m cover 203.9 million km². <!-- D by_class_deep.unmeasured.area_km2 203,888,376 --> There, AUST_2026_BAT and GEBCO_2026 differ by a median of 60.5 m, with an RMS of 190.9 m and a 95th percentile of 402.5 m. The difference exceeds 100 m over 35.1 % of this area and 200 m over 16.6 %. <!-- D by_class_deep.unmeasured: median_abs_m 60.5, rms_m 190.9, p95_abs_m 402.5, share_abs_gt 100: 0.3513, 200: 0.1664 --> In fully measured cells, the median difference is 46.5 m (84.8 million km²). <!-- D by_class_deep.measured median_abs_m 46.5, area_km2 84,782,706 --> Neither number is an error estimate of GEBCO. AUST_2026_BAT was trained on ship soundings that GEBCO also contains, so the measured-cell difference is largely AUST's own prediction error. In unmeasured cells, both grids are predictions from overlapping gravity data. A difference shows that at least one of them is wrong; agreement does not show that both are right. By the same reasoning as for measured cells, a large part of the 60.5 m may be AUST's own error, so it is a disagreement between two models, not a bound on GEBCO's uncertainty. On shelves and upper slopes shallower than 1 km, AUST_2026_BAT is systematically deeper than GEBCO: it is the deeper grid in 98.7 % of cells that differ by more than 500 m. These depths are excluded. <!-- D shallow_check.share_big_aust_deeper 0.9869 --> As a consistency check, the SWOT machine-learning confidence of @nilsson2025 correlates with |AUST − GEBCO| at Spearman ρ = 0.44 per 1′ cell and 0.63 for 15′ block means. Both grow where prediction from gravity is hard, so this is not an independent calibration. <!-- U correlation_predicted_error_vs_abs_aust_minus_gebco: cells 0.443, blocks_15arcmin 0.634 -->

![Absolute difference between AUST_2026_BAT and GEBCO_2026 where < 50 % of the 1′ cell is measured and the GEBCO depth is ≥ 1 km (map, Equal Earth projection centred on 150° E), the distribution of the difference, and medians by depth. Data: Yuan & Yang (2026), AUST_2026_BAT, doi:10.5281/zenodo.22711109 (CC BY 4.0); GEBCO Compilation Group (2026), GEBCO_2026 Grid. Figure licence: CC BY 4.0 (AUST_2026_BAT) with GEBCO attribution.](../../figures/fig7_model_disagreement.png){#fig:disagree width=100%}

**Seal dives** (Figure 9). Of 4,492,019 quality-flagged dives, 2.18 % (97,933) went more than 20 m deeper than the deepest GEBCO_2026 cell within one standard error of the dive location. The median location standard error is 2.0 km. <!-- SE dives_flag1; gebco2026.within_uncertainty_gt20 0.0218, _count 97,933; location_se_km.median 2.01 --> With a box of two standard errors, the share is 1.02 %. Comparing at the dive location only, as in the dataset description, gives 6.97 %. <!-- SE sensitivity_wider_box_sigma.2.gt20 0.0102; point_gt20 0.0697 --> The dataset description reports 8.4 % against IBCSO v2 at the location [@hindell2026]. Recomputing this from the file's own IBCSO v2 columns gives 8.47 %. The file's column for the deepest IBCSO v2 depth within the location error ellipse gives 2.84 %. <!-- SE paper_check_ibcso_v2.point_ge20 0.0847, ellipse_ge20 0.0284 --> The headline 8.4 % is therefore a point comparison. Allowing for location error reduces it by about a factor of three for either chart. Dives deeper than the chart cluster where the chart is shallow. They are 12.0 % of dives where GEBCO gives < 200 m, 1.6 % at 500–1,000 m and 0 below 2 km, where seals rarely reach the bottom. <!-- SE by_chart_depth within_uncertainty_gt20: 0-200 0.1201; 500-1000 0.0155; 2000+ 0.0 --> In cells coded as measured the rate is 1.8 %, and in unmeasured cells 2.3 %. <!-- SE within_uncertainty_gt20_where_point_measured 0.0181, _unmeasured 0.0225 --> A dive's maximum depth is a lower bound on the seafloor depth, so this test can only show where the chart is too shallow, never where it is too deep.

![Seal dives in SO-ABBA v1.0 deeper than GEBCO_2026 by more than 20 m beyond the location uncertainty: share per bin (map), distribution of dive minus chart depth, and share by charted depth. Data: Hindell, McMahon, Jonsen et al. (2026), SO-ABBA v1.0, doi:10.5281/zenodo.19121676 (CC BY 4.0); GEBCO Compilation Group (2026), GEBCO_2026 Grid. Figure licence: CC BY 4.0 (SO-ABBA) with GEBCO attribution.](../../figures/fig8_seals.png){#fig:seals width=100%}

The disagreement and seal results agree on one thing: the seafloor is most uncertain where it has not been measured, and also on shelves and plateaus with sparse data. The seal dives are concentrated on the Antarctic continental shelf (Figure 9), where 12 % of dives exceed the charted depth beyond location error. <!-- SE by_chart_depth 0-200 0.1201 --> This independent confirmation of a too-shallow chart shows the value of opportunistic depth data. GEBCO already has a TID code for animal-borne data loggers (48) [@gebcodoc2026].

## A.2 Seamounts

**Seamounts.** In a merged catalogue of 69,770 seamounts, 34.2 % have a directly measured summit cell. This rises from 14.6 % for 100–250 m high seamounts to about half for those taller than 1 km. <!-- SM count 69,770; summit_cell_measured_share 0.3415; by_height 100-250: 0.146; >1000 m: 0.465-0.586 --> Catalogue construction is documented in the repository (pipeline/seamounts.py) and is not part of this paper's main argument.

## A.3 Two data issues

**Vema Seamount.** The shallowest GEBCO_2026 cell at Vema Seamount (8.377° E, 31.610° S, about 3.7 km from the catalogue position) has an elevation of +29 m and is coded TID 0 (land). <!-- docs/data-contract.md "Seamounts / Spot checks" --> Published surveys put the summit under water: a 22 m deep summit knoll in multibeam work [@bergstad2019], and 26 m in an early survey [@simpson1965]. <!-- checked 2026-11-15: 22 m in Bergstad et al. 2019 abstract; 26 m via secondary citation of Simpson & Heydorn 1965 --> At 15″, a summit only a few tens of metres deep can be represented as a shallow cell, but not as land. A cell coded as land also falls outside any ocean mask built from the TID grid.

**Global Oceans and Seas.** In Global Oceans and Seas v1, the `area_km2` attribute of the Southern Ocean polygon is 6.79 million km², whereas the polygon rasterised on our 1′ grid covers 21.75 million km². <!-- RG oceans: Southern Ocean attr_area_km2 6,793,589; polygon_area_km2 21,745,425 --> The attributes of the three adjacent basins are larger than their geometry: South Pacific by 5.26, Indian Ocean by 7.15 and South Atlantic by 2.49 million km². Together that is 14.90 million km², close to the Southern Ocean deficit of 14.95 million km². <!-- derived from RG oceans attr_area_km2 - polygon_area_km2: SP 5,259,806; IO 7,150,315; SA 2,488,611; sum 14,898,732; SO -14,951,836 --> The attribute may therefore describe a different southern boundary from the geometry. All regional areas in this paper are measured from the geometry.

Both items were reported to the data providers by email on 15 November 2026 (Seabed 2030 and the Marine Regions team).

Limitations of these analyses: AUST_2026_BAT shares training data and gravity input with GEBCO; the seal test detects only charts that are too shallow; dives are not independent samples.

# Data and code availability

The code is MIT-licensed at https://github.com/ismoilovdevml/seafloor-atlas (data files keep their source licences, listed in LICENSES.md) and archived on Zenodo [@ismoilov2026atlas]; this paper uses version 1.2.0, doi:10.5281/zenodo.24260821 (concept DOI for all versions: 10.5281/zenodo.24228190). The live viewer is at https://seaflooratlas.org/. The numbers in this paper come from the following scripts and outputs:

- `pipeline/coverage.py` → `data/derived/stats.json`
- `pipeline/history.py` → `data/derived/history_stats.json` and `web/public/history/manifest.json`
- `pipeline/change.py` → `data/derived/change_2025_2026.json`
- `pipeline/regions.py` → `data/derived/regions.json` and `docs/regions.md`
- `pipeline/trenches.py` → `data/derived/trenches.json` and `docs/trenches.md`
- `pipeline/disagree.py` → `data/derived/disagree_stats.json`
- `pipeline/seals.py` → `data/derived/seals_stats.json`
- `pipeline/uncertainty.py` → `data/derived/uncertainty_stats.json`
- `docs/paper/analysis/recoded_by_latitude.py` → `docs/paper/analysis/recoded_by_latitude.json`
- `pipeline/sensitivity_cellsize.py` → `data/derived/sensitivity_cellsize.json` and `docs/sensitivity_cellsize.md`
- `docs/gebco2023_tid_version.md`: which GEBCO_2023 TID issue was used, with checksums and the cell-by-cell comparison

The HTML comments in the manuscript source (`docs/paper/manuscript.md`) give the file and key for every number. The input data are not redistributed and are fetched by `pipeline/fetch_data.sh` and the scripts' fetch steps from the DOIs cited. An interactive globe built from the same outputs, including a per-release "first measured" layer, is at https://seaflooratlas.org/. The 15″ tiles for zooms 6–7 are at https://huggingface.co/datasets/ismoilovdev/seafloor-atlas-tiles. Derived data keep the licences of their sources (per-file table in `LICENSES.md`). All figures in this preprint are derived from GEBCO grids (public domain with attribution under the GEBCO terms of use; CEDA lists the Open Government Licence v3 for 2025–2026) and, where stated in the caption, from CC BY 4.0 data sets, so they are compatible with a CC BY 4.0 preprint licence. Figures derived from non-commercial sources (marine-life and submarine-cable layers) are not included.

# Author contributions (CRediT)

Otabek Ismoilov: conceptualization, project administration, validation (review of methods and results), writing – review and editing. Software, formal analysis, visualization and the original draft were produced with substantial AI assistance under the author's direction (see AI disclosure).

# Use of AI tools

Much of the code (the data pipeline, the analysis scripts and the figure scripts), the analyses run with it, the repository documentation and drafts of this manuscript, including this text, were produced by an AI assistant, Anthropic's Claude used through Claude Code, under the author's direction. The author defined the questions and scope, directed the work, reviewed the outputs and the text, and takes full responsibility for the content, including any errors. The AI assistant is not an author. The model was Claude Opus 5.5 (model identifier claude-opus-5-5), used between 12 and 16 November 2026.

# Competing interests

The author declares no competing interests.

# Acknowledgements

The author thanks the GEBCO Compilation Group and the Seabed 2030 regional and global centres, and the providers of the open data sets used here: Flanders Marine Institute, T. Hotham, J. Yuan and C. Yang, the SO-ABBA team, and B. Nilsson, B. J. Phrampus and co-authors.

# References

::: {#refs}
:::
