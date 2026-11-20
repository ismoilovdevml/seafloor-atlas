# Blind test: GEBCO's estimated depths against the measurements that replaced them

When a 15″ cell changes from an indirect source code (TID 40 = predicted from satellite gravity, 41 =
interpolated, 44 = multiple sources in a gridded data set guided by satellite gravity, 70 = pre-generated grid, …) in one GEBCO release to a direct
measurement (TID 10–17) in the next, the earlier depth was an estimate made without that measurement and the
later depth is the measurement. Their difference is an out-of-sample error of the estimate, measured on the
grid users actually download. Produced by `pipeline/blindtest.py`; numbers in `data/derived/blindtest_stats.json`;
figure `figures/fig_blindtest.png`; tests `tests/test_blindtest.py`.

## Method

* **Pairs.** GEBCO_2024 → GEBCO_2025 and GEBCO_2025 → GEBCO_2026 (release a → release b).
* **Depths.** z = the 15″ elevation of each release (the ice-surface grid, which GEBCO calls "the GEBCO_<year>
  Grid"), for the **same** 15″ cell in both releases; diff = z_a − z_b in metres. diff > 0 means the estimate was
  too shallow. GEBCO_2026 is read from the local copy, GEBCO_2024 and GEBCO_2025 are streamed strip by strip from
  the Source Cooperative COG mirror (nothing stored).
* **Mirror check.** `pipeline/verify_mirror.py releases 2024 2025 2026` compares 16 × 16-cell windows of the mirror
  (and the local GEBCO_2026 file) with the official BODC netCDF on CEDA (OPeNDAP), at 10 sites: Challenger Deep,
  Horizon Deep (Tonga Trench), Mid-Atlantic Ridge, North Sea shelf, Fram Strait (79° N), Nansen Basin (85° N), Ross
  Ice Shelf (80° S), Weddell Sea shelf (75.5° S), the central Indian Ocean far from soundings, and the Himalaya.
  The cell-centre coordinates of each official window are checked too. Result: **all 2,560 cells identical for
  each of 2024, 2025 and 2026** to the official ice-surface grid; at the Ross Ice Shelf the mirror differs from
  the official sub-ice grid by up to 574 m, so the mirror is the ice-surface variant
  (`data/derived/verify_mirror_releases.json`).
* **Cells.** World ocean only: the published record's `inland_below_sea_level == 0` at 15″ (inside the paper's
  mask GEBCO_2026 TID ≠ 0 and 1′ elevation < 0, connected to the world ocean; the Caspian Sea and other inland
  basins are out), and TID ≠ 0 in both releases.
* **Classes.** `new_from_40`, `new_from_41`, `new_from_44`, `new_from_70`, `new_from_other` (direct in b, that
  code in a); controls `ctrl_pred_pred` (TID 40 in both releases: how much the prediction itself moved) and
  `ctrl_meas_meas` (direct in both: how much measured depths moved).
* **Strata** for TID 40 → measured, for all estimated → measured pooled, and for the 40 → 40 control: measured depth
  −z_b; distance from the cell's 1′ cell to the nearest measured 1′ cell **in release a** (`docs/distance.md`;
  "same 1′ cell" = another 15″ cell of the same 1′ cell was already measured); TID received in b (not for the
  40 → 40 control, which receives none); 5° latitude band.
* **Statistics.** Area-weighted (exact spherical 15″ areas) histograms with 1 m bins over ±3000 m (overflow in the
  end bins, reported). Median, NMAD = 1.4826 × median |diff − median| (robust σ), IQR/1.349, quantiles of |diff|,
  shares of |diff| > 50/100/200/500 m, share of exactly 0 m, and number of 15″ cells n.
* Run time about 36 min (85 strips of 512 rows, three elevation grids, two of them over the network).

## Main result

Out-of-sample error of GEBCO's satellite-gravity predictions (TID 40) where a measurement replaced them in the next
release, area-weighted, diff = predicted − measured:

| Pair | Cells | n (M cells) | Area (M km²) | Median diff | NMAD | Median abs | P90 abs | abs > 100 m | abs > 500 m | diff = 0 |
|---|---|---|---|---|---|---|---|---|---|---|
| 2024 → 2025 | all TID 40 → measured | 18.30 | 3.40 | +3 m | 46 m | 31 m | 192 m | 22.0 % | 1.5 % | 2.2 % |
| 2024 → 2025 | ≥ 3 km from any earlier measurement | 11.18 | 2.12 | +5 m | 64 m | 43 m | 225 m | 27.6 % | 1.8 % | 1.5 % |
| 2025 → 2026 | all TID 40 → measured | 23.86 | 4.58 | 0 m | 12 m | 8 m | 105 m | 10.5 % | 0.4 % | 14.6 % |
| 2025 → 2026 | ≥ 3 km from any earlier measurement | 10.28 | 1.98 | +2 m | 39 m | 26 m | 160 m | 18.8 % | 0.8 % | 3.0 % |

In plain terms: where GEBCO_2024 showed a depth predicted from satellite gravity at least 3 km from any measured
cell, and a ship then measured it for GEBCO_2025, the prediction was off by more than 43 m in half of the area,
by more than 100 m in about one cell in four, and by more than 500 m in about one in 55. The GEBCO_2025
predictions did better against GEBCO_2026 measurements (median |error| 26 m, about one cell in five off by more
than 100 m). Predictions are almost unbiased (median +2 to +5 m, slightly too shallow; 54–56 % of the area too
shallow), but heavy-tailed: the RMS (115–155 m) is two to three times the NMAD.

**Distance.** The error grows from the same 1′ cell (median |error| 12 m in 2024 → 2025) to 3–5 km (39 m) and then
**stops growing**: from 5 km to beyond 100 km the NMAD stays at 59–70 m (2024 → 2025) and 42–44 m (2025 → 2026,
5–100 km). Beyond a few kilometres, distance to the nearest sounding does not predict the error of the gravity
prediction; the error is set by what gravity cannot resolve.

**Depth.** On the shelf (< 200 m) the error is small (median |error| 3 m), but those cells are few and many are
near data. The largest errors are in the deepest water: below 6000 m the predictions were too shallow (median
+24 m in 2024 → 2025, +6 m in 2025 → 2026) with NMAD 95 m and 43 m, consistent with trenches being smoothed in the
predicted grid.

**Controls.** Cells measured in both releases changed by a median of 0 m (P90 14 m and 23 m): the measured depths
are stable, so the differences above are the prediction error, not noise in the measurement grid. Cells that stayed
TID 40 changed by NMAD 24 m between GEBCO_2024 and GEBCO_2025 (base grid SRTM15+ V2.6 → V2.7) but only 1.5 m
between GEBCO_2025 and GEBCO_2026 (V2.7 → V2.8; versions from each release's netCDF `summary` attribute).

**The two pairs differ.** Both near data and far from it, the 2025 → 2026 errors are smaller. Far from data
(≥ 3 km, exact-zero share 3 % in both pairs) the difference is real in these data: NMAD 64 m vs 39 m. Whether this
is because SRTM15+ V2.7 predicts better than V2.6, or because the 2026 surveys went to easier seafloor, is not
established here. Near data (< 3 km), the 2025 → 2026 pair is contaminated (next section).

## Re-labelled measurements (why the 2025 → 2026 near-data numbers are too good)

A depth predicted from gravity agrees with a later multibeam depth to the metre in about 1 % of cells for a 40–60 m
spread. In 2024 → 2025, 1.2–1.9 % of the TID 40 → measured cells farther than 3 km from data have diff = 0, as
expected. In 2025 → 2026, 29 % of the cells in the same 1′ cell as earlier data and 15 % of those within 3 km have
diff = 0, and the NMAD there is 3–6 m. One inspected case: a 4′ block near 16.2 S, 143.6 W (Tuamotu) where 105 cells
went from TID 40 (GEBCO_2024 and GEBCO_2025) to TID 10/17 (GEBCO_2026) with depths identical to the metre in 90 %
of cells in all three releases: the measurement was already in the grid and only its label changed. Such cells are
not a blind test. The `*_excl_exact_zero` variant in `blindtest_stats.json` drops the 0 m bin; it removes most of
them (NMAD near data rises from 3–6 m to 9–10 m in 2025 → 2026) but not re-labelled cells that moved by a metre or
two, so **near-data numbers of 2025 → 2026 should not be used**. The ≥ 3 km numbers and the whole 2024 → 2025 pair
are barely affected (NMAD changes by ≤ 4 m).

Other source codes behave like re-labelling more than like prediction: TID 70 (pre-generated grid) → measured has
diff = 0 in 32–34 % of cells and median |error| 2 m, TID 41 (interpolated) 15–16 % and 4–5 m. Those grids were
built from the same surveys that later appear as direct.

## Tables

### By class

| Pair | Class | n (M cells) | Median diff (m) | NMAD (m) | Median abs (m) | P90 abs (m) | abs > 100 m | diff = 0 |
|---|---|---|---|---|---|---|---|---|
| 2024 -> 2025 | new_from_40 | 18.30 | +3 | 46 | 31 | 192 | 22.0 % | 2.2 % |
| 2024 -> 2025 | new_from_41 | 23.94 | +0 | 7 | 5 | 71 | 6.8 % | 15.1 % |
| 2024 -> 2025 | new_from_44 | 2.54 | +0 | 15 | 10 | 62 | 4.7 % | 5.5 % |
| 2024 -> 2025 | new_from_70 | 2.82 | +0 | 3 | 2 | 40 | 3.5 % | 32.4 % |
| 2024 -> 2025 | new_from_other | 0.03 | +0 | 3 | 2 | 42 | 3.9 % | 36.2 % |
| 2024 -> 2025 | ctrl_pred_pred | 1124.56 | +0 | 24 | 16 | 104 | 10.5 % | 7.9 % |
| 2024 -> 2025 | ctrl_meas_meas | 672.90 | +0 | 0 | 0 | 14 | 0.5 % | 57.0 % |
| 2025 -> 2026 | new_from_40 | 23.86 | +0 | 12 | 8 | 105 | 10.5 % | 14.6 % |
| 2025 -> 2026 | new_from_41 | 7.78 | +0 | 6 | 4 | 65 | 6.0 % | 15.8 % |
| 2025 -> 2026 | new_from_44 | 2.21 | +0 | 7 | 5 | 50 | 4.0 % | 19.6 % |
| 2025 -> 2026 | new_from_70 | 2.83 | +0 | 3 | 2 | 18 | 1.7 % | 34.3 % |
| 2025 -> 2026 | new_from_other | 0.43 | +0 | 3 | 2 | 7 | 1.7 % | 15.0 % |
| 2025 -> 2026 | ctrl_pred_pred | 1098.03 | +0 | 1 | 1 | 13 | 1.3 % | 16.0 % |
| 2025 -> 2026 | ctrl_meas_meas | 707.11 | +0 | 1 | 1 | 23 | 1.1 % | 36.2 % |

### TID 40 -> measured, by distance to the nearest measurement in release a (km)

| Pair | Stratum | n (M cells) | Median diff (m) | NMAD (m) | Median abs (m) | P90 abs (m) | abs > 100 m | diff = 0 | NMAD without diff = 0 (m) |
|---|---|---|---|---|---|---|---|---|---|
| 2024 -> 2025 | same 1' cell | 3.56 | +1 | 18 | 12 | 82 | 7.8 % | 4.7 % | 21 |
| 2024 -> 2025 | < 3 | 3.56 | +2 | 40 | 27 | 161 | 17.8 % | 1.9 % | 42 |
| 2024 -> 2025 | 3-5 | 1.70 | +3 | 58 | 39 | 209 | 24.2 % | 1.3 % | 58 |
| 2024 -> 2025 | 5-10 | 2.98 | +5 | 67 | 45 | 227 | 27.4 % | 1.2 % | 68 |
| 2024 -> 2025 | 10-20 | 2.59 | +6 | 68 | 46 | 227 | 28.7 % | 1.6 % | 70 |
| 2024 -> 2025 | 20-50 | 2.44 | +5 | 61 | 41 | 222 | 27.8 % | 1.9 % | 62 |
| 2024 -> 2025 | 50-100 | 0.97 | +5 | 59 | 41 | 243 | 29.1 % | 1.8 % | 62 |
| 2024 -> 2025 | > 100 | 0.50 | +7 | 70 | 48 | 233 | 29.7 % | 1.6 % | 73 |
| 2025 -> 2026 | same 1' cell | 8.11 | +0 | 3 | 2 | 36 | 2.7 % | 29.0 % | 9 |
| 2025 -> 2026 | < 3 | 5.48 | +0 | 6 | 4 | 68 | 6.4 % | 15.3 % | 10 |
| 2025 -> 2026 | 3-5 | 1.27 | +1 | 34 | 23 | 144 | 16.0 % | 3.6 % | 36 |
| 2025 -> 2026 | 5-10 | 2.16 | +2 | 42 | 28 | 154 | 18.0 % | 2.6 % | 44 |
| 2025 -> 2026 | 10-20 | 2.16 | +3 | 42 | 28 | 160 | 18.8 % | 2.8 % | 44 |
| 2025 -> 2026 | 20-50 | 2.46 | +2 | 42 | 28 | 170 | 20.3 % | 2.8 % | 44 |
| 2025 -> 2026 | 50-100 | 1.33 | +2 | 42 | 28 | 179 | 21.0 % | 2.8 % | 44 |
| 2025 -> 2026 | > 100 | 0.90 | +4 | 24 | 16 | 144 | 17.1 % | 4.3 % | 28 |

### TID 40 -> measured, by measured depth (m)

| Pair | Stratum | n (M cells) | Median diff (m) | NMAD (m) | Median abs (m) | P90 abs (m) | abs > 100 m | diff = 0 | NMAD without diff = 0 (m) |
|---|---|---|---|---|---|---|---|---|---|
| 2024 -> 2025 | 0-200 | 0.94 | +0 | 4 | 3 | 27 | 3.4 % | 12.4 % | 6 |
| 2024 -> 2025 | 200-1000 | 0.51 | +1 | 27 | 18 | 178 | 17.6 % | 4.1 % | 30 |
| 2024 -> 2025 | 1000-2000 | 1.32 | +2 | 44 | 30 | 225 | 21.6 % | 1.7 % | 46 |
| 2024 -> 2025 | 2000-3000 | 2.16 | +0 | 53 | 36 | 262 | 25.9 % | 1.4 % | 55 |
| 2024 -> 2025 | 3000-4000 | 3.92 | +3 | 62 | 42 | 207 | 25.9 % | 1.3 % | 64 |
| 2024 -> 2025 | 4000-5000 | 5.32 | +4 | 42 | 28 | 181 | 20.6 % | 1.8 % | 43 |
| 2024 -> 2025 | 5000-6000 | 3.89 | +9 | 53 | 36 | 175 | 22.1 % | 1.5 % | 55 |
| 2024 -> 2025 | > 6000 | 0.25 | +24 | 95 | 68 | 289 | 38.3 % | 0.9 % | 96 |
| 2025 -> 2026 | 0-200 | 3.73 | +0 | 4 | 3 | 12 | 0.8 % | 14.1 % | 6 |
| 2025 -> 2026 | 200-1000 | 0.69 | +0 | 6 | 4 | 65 | 6.3 % | 22.1 % | 12 |
| 2025 -> 2026 | 1000-2000 | 1.01 | +0 | 7 | 5 | 104 | 10.3 % | 23.2 % | 18 |
| 2025 -> 2026 | 2000-3000 | 2.15 | +0 | 18 | 12 | 154 | 16.0 % | 18.0 % | 31 |
| 2025 -> 2026 | 3000-4000 | 5.65 | +0 | 21 | 14 | 131 | 13.9 % | 14.1 % | 31 |
| 2025 -> 2026 | 4000-5000 | 6.65 | +0 | 21 | 14 | 109 | 11.3 % | 13.3 % | 30 |
| 2025 -> 2026 | 5000-6000 | 3.79 | +0 | 18 | 12 | 104 | 10.5 % | 13.3 % | 25 |
| 2025 -> 2026 | > 6000 | 0.21 | +6 | 43 | 30 | 255 | 27.2 % | 10.6 % | 58 |

### TID 40 -> measured, by code received (2024 -> 2025)

| Code | n (M cells) | Median diff (m) | NMAD (m) | Median abs (m) | P90 abs (m) | abs > 100 m | diff = 0 |
|---|---|---|---|---|---|---|---|
| 10 | 0.18 | +2 | 18 | 12 | 116 | 11.5 % | 7.7 % |
| 11 | 14.64 | +5 | 46 | 32 | 186 | 21.5 % | 1.7 % |
| 16 | 0.62 | +0 | 6 | 4 | 30 | 3.8 % | 10.9 % |
| 17 | 2.81 | +0 | 71 | 48 | 257 | 31.0 % | 2.0 % |

## Caveats

* **Not random sampling.** Surveys go where ships go: transit lines, EEZ mapping, features of interest, the North
  Pacific and the South-West Pacific (map in `figures/fig_blindtest.png`). The numbers describe the predicted
  depths that were later replaced, not the whole unmeasured ocean. Seamounts and rough terrain may be over- or
  under-represented.
* **"Measured" is a gridded value.** z_b is GEBCO's 15″ depth in a cell coded direct, i.e. a gridded survey, not a
  raw sounding; part of diff is the measured grid's own error (the measured-in-both control bounds the
  release-to-release part of it: median 0 m, P90 14–23 m).
* **Leakage.** TID 40 marks cells whose depth comes from SRTM15+, and SRTM15+ itself blends ship soundings. A
  "predicted" cell can therefore already carry information from the survey that is coded direct only in the next
  release; exact-zero cells show this happened at scale in 2025 → 2026 near earlier data (above). Leakage makes the
  errors look smaller, never larger.
* **Same cell, same grid.** Both releases are on the identical 15″ grid (checked: shapes and transforms equal); no
  horizontal mis-registration is modelled. A survey offset by one cell on a steep slope counts as depth error.
* **Distance strata** are 1′ cell to 1′ cell (`docs/distance.md`), so "same 1′ cell" and "< 3 km" mean "next to
  data" at about 2 km resolution.
* **Ice.** The elevation is the ice-surface grid; ice-shelf cells have elevation ≥ 0 and fall outside the ocean mask
  (1′ elevation < 0), so they are not in the test.
* **Histogram limits.** 1 m bins from −3000 to +3000 m; the overflow share is ≤ 0.01 % in every class, so the RMS
  cap does not matter. Quantiles are at 1 m resolution.

## What is and is not new

Not new: comparing predicted (altimetric) bathymetry with multibeam that was not in the model, and finding errors
of tens of metres in the median and hundreds in the tail. Marks, Smith & Sandwell (2010) did this for successive
versions of the Smith & Sandwell model with JAMSTEC multibeam (median 49–57 m, P90 219–257 m), and Picard et al.
(2018) for SRTM15_PLUS in the MH370 search area (more than 38 % off by more than 100 m). Our 2024 → 2025 numbers far
from data (median |error| 43 m, P90 225 m) are in the same range. That interpolation error grows with distance to
the nearest measurement is also established (Amante & Eakins 2016 for coastal DEMs with withheld soundings).

New, as far as our search found: (1) using the GEBCO TID grid of consecutive releases as a natural experiment, so
the test runs on the published global grid itself, on every cell that changed status (42 M cells in two pairs),
without choosing or obtaining withheld surveys; (2) the stratification by distance to the nearest measurement in
the earlier release, which shows that for satellite-gravity predictions the error stops growing beyond about 5 km
rather than increasing steadily; (3) the controls (measured-in-both, predicted-in-both) and the exact-zero
diagnostic, which expose re-labelled measurements that would otherwise pass as excellent predictions. We did not
find a published release-to-release blind test of GEBCO; this is a statement about our search, not proof that none
exists (paywalled full texts of Marks & Smith 2006 and Marks et al. 2010 were not read).

## Prior work

Searched 2026-11-17 (web search, Crossref, Semantic Scholar; queries on predicted/altimetric bathymetry error
against independent or later multibeam, error versus distance to the nearest sounding, withheld-sounding /
split-sample validation, GEBCO / SRTM15+ / IBCAO / IBCSO uncertainty). Every DOI below resolved in Crossref to
the title, journal and year given. What each item says is taken from its abstract or from the publisher / NOAA
page, not from memory; where only the abstract was read this is stated.

**Same idea, different data: predicted depth against multibeam that was not in the model**

* Marks, K. M., Smith, W. H. F. & Sandwell, D. T. (2010). Evolution of errors in the altimetric bathymetry model
  used by Google Earth and GEBCO. *Marine Geophysical Researches* 31, 223–238.
  [doi:10.1007/s11001-010-9102-0](https://doi.org/10.1007/s11001-010-9102-0). The closest prior work. JAMSTEC
  multibeam surveys that were not in the Smith & Sandwell models are used as ground truth for model versions
  7.2–12.1; median errors 57 → 55 → 49 m and 90th-percentile errors 257 → 235 → 219 m for versions 8.2, 11.1,
  12.1, with problems traced to interpolation across survey gaps and a gravity-to-topography scaling bias
  (abstract as listed by NOAA LSA and library catalogues; full text paywalled, not read).
* Marks, K. M. & Smith, W. H. F. (2006). An evaluation of publicly available global bathymetry grids. *Marine
  Geophysical Researches* 27, 19–34. [doi:10.1007/s11001-005-2095-4](https://doi.org/10.1007/s11001-005-2095-4).
  Six global grids compared, partly against a regional grid and a multibeam survey.
* Smith, W. H. F. (1993). On the accuracy of digital bathymetric data. *Journal of Geophysical Research* 98,
  9591–9603. [doi:10.1029/93JB00716](https://doi.org/10.1029/93JB00716). Early assessment of gridded bathymetry
  accuracy (abstract not available to us; cited for context only).
* Picard, K. et al. (2018). Malaysia Airlines flight MH370 search data reveal geomorphology and seafloor processes
  in the remote southeast Indian Ocean. *Marine Geology* 395, 301–319.
  [doi:10.1016/j.margeo.2017.10.014](https://doi.org/10.1016/j.margeo.2017.10.014). A new multibeam survey of an
  area known before only from altimetry: 62 % of SRTM15_PLUS depths within its ±100 m uncertainty, more than 38 %
  off by more than 100 m and up to 1900 m. See also Smith, W. H. F. & Marks, K. M. (2014), Seafloor in the
  Malaysia Airlines Flight MH370 search area, *Eos* 95, 173–174,
  [doi:10.1002/2014EO210001](https://doi.org/10.1002/2014EO210001).
* Zilberman, N. V. et al. (2025). Deep Argo improves the accuracy and resolution of ocean bathymetry. *Earth and
  Space Science* 12. [doi:10.1029/2025EA004304](https://doi.org/10.1029/2025EA004304). Float-derived depths agree
  with multibeam to 88–96 m RMS and change GEBCO's altimetry-predicted depths by 50–200 m where added.

**How the predicted grids are made and how their error is quoted**

* Smith, W. H. F. & Sandwell, D. T. (1994). Bathymetric prediction from dense satellite altimetry and sparse
  shipboard bathymetry. *JGR* 99, 21803–21824. [doi:10.1029/94JB00988](https://doi.org/10.1029/94JB00988);
  Smith & Sandwell (1997), Global sea floor topography from satellite altimetry and ship depth soundings,
  *Science* 277, 1956–1962. [doi:10.1126/science.277.5334.1956](https://doi.org/10.1126/science.277.5334.1956).
* Becker, J. J. et al. (2009). Global bathymetry and elevation data at 30 arc seconds resolution: SRTM30_PLUS.
  *Marine Geodesy* 32, 355–371. [doi:10.1080/01490410903297766](https://doi.org/10.1080/01490410903297766).
* Tozer, B. et al. (2019). Global bathymetry and topography at 15 arc sec: SRTM15+. *Earth and Space Science* 6,
  1847–1864. [doi:10.1029/2019EA000658](https://doi.org/10.1029/2019EA000658). GEBCO's base grid; altimetry-
  constrained cells quoted at ±150 m (deep ocean) and ±180 m (coast to continental rise) (abstract).
* Harper, H. & Sandwell, D. T. (2024). Global predicted bathymetry using neural networks. *Earth and Space Science*
  11. [doi:10.1029/2023EA003199](https://doi.org/10.1029/2023EA003199). Shows that a random train/test split
  underestimates misfit because nearby soundings are not independent, and uses geographic bins instead; RMSE 165
  → 138 m (abstract). This is the reason our blind test stratifies by distance to the nearest earlier
  measurement.
* Sandwell, D. T. et al. (2022). Improved bathymetric prediction using geological information: SYNBATH. *Earth
  and Space Science* 9. [doi:10.1029/2021EA002069](https://doi.org/10.1029/2021EA002069). Gravity-predicted
  seamounts are too low and too wide; abyssal hills are not resolved (abstract) — consistent with the heavy tails
  seen here.
* Weatherall, P. et al. (2015). A new digital bathymetric model of the world's oceans. *Earth and Space Science* 2,
  331–345. [doi:10.1002/2015EA000107](https://doi.org/10.1002/2015EA000107) (GEBCO_2014).

**Error versus distance to the nearest measurement; uncertainty of compiled grids**

* Amante, C. J. & Eakins, B. W. (2016). Accuracy of interpolated bathymetry in digital elevation models. *Journal
  of Coastal Research* SI 76, 123–133. [doi:10.2112/SI76-011](https://doi.org/10.2112/SI76-011). Split-sample
  test (withheld soundings, Kachemak Bay, Alaska): interpolation error grows with distance to the nearest
  measurement, with slope and curvature, and at low sampling density. Amante, C. J. (2018), Estimating coastal
  digital elevation model uncertainty, *Journal of Coastal Research* 34(6), 1382 ff.,
  [doi:10.2112/JCOASTRES-D-17-00211.1](https://doi.org/10.2112/JCOASTRES-D-17-00211.1), turns this into
  per-cell uncertainty.
* Adediran, E. et al. (2025). Toward quantifying interpolation uncertainty in set-line spacing hydrographic
  surveys. *ISPRS Int. J. Geo-Inf.* 14, 90. [doi:10.3390/ijgi14020090](https://doi.org/10.3390/ijgi14020090).
  Finds distance to the nearest measurement the least significant predictor in its testbeds (as summarised in
  search results; full text not read).
* Jakobsson, M., Calder, B. & Mayer, L. (2002). On the effect of random errors in gridded bathymetric
  compilations. *JGR* 107(B12). [doi:10.1029/2001JB000616](https://doi.org/10.1029/2001JB000616). Monte Carlo
  confidence grid for IBCAO.
* Hell, B. & Jakobsson, M. (2011). Gridding heterogeneous bathymetric data sets with stacked continuous curvature
  splines in tension. *Marine Geophysical Research* 32, 493–501.
  [doi:10.1007/s11001-011-9141-1](https://doi.org/10.1007/s11001-011-9141-1).
* Jakobsson, M. et al. (2020). IBCAO Version 4.0. *Scientific Data* 7, 176.
  [doi:10.1038/s41597-020-0520-9](https://doi.org/10.1038/s41597-020-0520-9); Dorschel, B. et al. (2022). IBCSO
  Version 2. *Scientific Data* 9, 275.
  [doi:10.1038/s41597-022-01366-7](https://doi.org/10.1038/s41597-022-01366-7). Regional compilations that ship
  source-type grids, the model for GEBCO's TID grid.
* Mayer, L. et al. (2018). The Nippon Foundation–GEBCO Seabed 2030 project. *Geosciences* 8, 63.
  [doi:10.3390/geosciences8020063](https://doi.org/10.3390/geosciences8020063); Wölfl, A.-C. et al. (2019).
  Seafloor mapping – the challenge of a truly global ocean bathymetry. *Frontiers in Marine Science* 6, 283.
  [doi:10.3389/fmars.2019.00283](https://doi.org/10.3389/fmars.2019.00283). Context and coverage targets.
