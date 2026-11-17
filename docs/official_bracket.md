# Bracketing the official Seabed 2030 "mapped" share

Question: the TID-based share in this repo (30.81 % for GEBCO_2026) is higher than the official Seabed 2030 figure
(28.7 %). Is the official number consistent with the public TID grids once the Seabed 2030 definition of "mapped" is
applied? Produced by `pipeline/official_bracket.py`; numbers in `data/derived/official_bracket.json` (per-row counts in
`data/derived/official_bracket_counts.npz`); figure `figures/fig_official_bracket.png`.

**This is an approximation.** Seabed 2030 has not published how its percentage is computed from the source data. The
public TID grid tells only whether a 15″ cell holds direct measurements, not how many target cells inside it do, so
the result is a range, not a reproduction.

## Definition used

Mayer et al. (2018), section 4 and Table 2: the seafloor is "mapped" "if at least one sounding falls in a grid cell of
the size described in Table 2". Table 2 (checked in the open-access PDF, 2026-11-17):

| Depth range | Grid-cell size | % of world ocean (Table 2) | % in this repo's ocean mask |
|---|---|---|---|
| 0–1,500 m | 100 × 100 m | 13.7 | 13.58 |
| 1,500–3,000 m | 200 × 200 m | 11 | 10.99 |
| 3,000–5,750 m | 400 × 400 m | 72.6 | 72.24 |
| 5,750–11,000 m | 800 × 800 m | 2.7 | 3.19 |

The depth-class shares of our mask (GEBCO_2026 15″ depth) agree with Table 2 to within 0.5 points.

## Method

* Ocean mask, "measured" (TID 10–17) and exact spherical 15″ cell areas are those of `pipeline/history.py`, so the
  upper variant is the published measured share.
* Depth: GEBCO_2026 15″ elevation for every release (the older grids' elevations are not on disk).
* For each measured 15″ cell of area A15 in depth class with target size s:
  * **upper**: credit 1 (every target cell inside holds a sounding);
  * **lower**: credit min(1, s²/A15) (exactly one target cell holds a sounding);
  * **mixed**: credit 1 for TID 11 (multibeam) and 17 (combination of direct measurements), min(1, s²/A15) for the
    other direct codes (10 singlebeam, 12 seismic, 13 isolated sounding, 14 ENC sounding, 15 lidar, 16 optical
    light/satellite).
* Where s² ≥ A15 (800 m class everywhere, 400 m class poleward of about 41.7°) one sounding covers more than its
  own 15″ cell. That spill-over into unmeasured neighbours is not modelled, so all variants are low there;
  `docs/sensitivity_cellsize.md` puts the size of such block effects at +0.3 points globally (31.12 % vs 30.81 %
  on 463 m equal-width blocks, "any" rule).
* Implementation: 512-row strips (the TIFF block height); each strip reads the 15″ elevation, the 1′ elevation
  and each of the eight TID grids exactly once and reduces them with `np.bincount` to per-row counts of measured
  cells by depth class and TID-11/17 flag; the bracket arithmetic runs on those counts.
* Run time: **110 s** on 6 worker processes (peak 1.4 GB per worker), while other jobs were running. The earlier
  version (1,024-row strips, float64 temporaries for every year) was killed after more than 10 minutes.

## Self-check

Upper for 2026 = **30.8102 %**, equal to `history_stats.json` `measured_frac` (0.30810194); the check
`upper_equals_history_measured_frac` (|difference| < 1e-9) is true for all eight releases.

## Result (% of the ocean, 361.69 M km²)

| Release | lower | mixed | upper | official | official lies | position in lower→upper | official − upper (points) | official − mixed (points) | TID 11/17 share of measured area (%) |
|---|---|---|---|---|---|---|---|---|---|
| 2019 | 9.10 | 12.28 | 12.43 | 15.0 | above upper | 1.77 | +2.57 | +2.72 | 98.2 |
| 2020 | 12.19 | 18.05 | 18.24 | 19.0 | above upper | 1.13 | +0.76 | +0.95 | 98.1 |
| 2021 | 14.72 | 21.61 | 21.91 | 20.6 | between lower and mixed | 0.82 | −1.31 | −1.01 | 97.7 |
| 2022 | 16.65 | 24.95 | 25.35 | 23.4 | between lower and mixed | 0.78 | −1.95 | −1.55 | 97.3 |
| 2023 | 17.62 | 25.87 | 26.27 | 24.9 | between lower and mixed | 0.84 | −1.37 | −0.97 | 97.3 |
| 2024 | 19.05 | 27.97 | 28.54 | 26.1 | between lower and mixed | 0.74 | −2.44 | −1.87 | 96.9 |
| 2025 | 19.79 | 29.01 | 29.69 | 27.3 | between lower and mixed | 0.76 | −2.39 | −1.71 | 96.7 |
| 2026 | 20.38 | 29.78 | 30.81 | 28.7 | between lower and mixed | 0.80 | −2.11 | −1.08 | 95.6 |

GEBCO_2026 by target class (share of the class's ocean area; lower / mixed / upper):

| Target cell | Ocean (M km²) | lower | mixed | upper |
|---|---|---|---|---|
| 100 m | 49.1 | 2.8 | 28.2 | 34.8 |
| 200 m | 39.7 | 11.5 | 40.7 | 41.6 |
| 400 m | 261.3 | 24.0 | 27.8 | 27.8 |
| 800 m | 11.5 | 44.3 | 44.3 | 44.3 |

## Reading

* **2021–2026: the official figure lies inside the TID bracket every year**, between the lower and the mixed
  variant, at 0.74–0.84 of the way from lower to upper, and 1.0–1.9 points below the mixed variant. So the
  official numbers are consistent with the TID grids plus the Table 2 target cells, provided that some multibeam or
  combination cells do not fill all their target cells (e.g. 100 m cells at the edge of a swath). The bracket is wide
  (8–10 points) because the 0–1,500 m class (100 m target cells, ~21 per 15″ cell) is almost all in play.
* **2019 and 2020: the official figure is above the upper bound** (+2.57 and +0.76 points). The TID grids cannot
  produce those numbers under this definition. Possible reasons, none tested here: the early announcements were
  computed on a different basis (e.g. a coarser grid or data held by Seabed 2030 but not yet coded in the
  released TID grid); the ocean area or depth used differed; or spill-over of large target cells (not modelled,
  ~+0.3 points) — too small alone for 2019.
* Mixed ≈ upper because 95.6–98.2 % of the measured area is coded TID 11 or 17; the other direct codes move the
  number by only 0.15–1.0 points. The open question is not which codes count but how completely the 100–200 m target
  cells inside multibeam/combination cells are filled.
* The official − upper gap since 2021 (1.3–2.4 points) is therefore explained within this bracket without assuming
  any error in either the TID grid or the official number.

## Caveats

* The official algorithm, depth model and ocean area are not published; this is a consistency check only.
* Depth is GEBCO_2026 for every release; class boundaries move little between releases, but this is untested.
* TID codes are per 15″ cell of the grid, not per sounding; a cell coded 17 can be largely interpolated in reality.
* Spill-over of 400/800 m target cells into neighbouring unmeasured 15″ cells is not modelled (all variants low).
* Official percentages are announcement figures (dates and quotes in `pipeline/history.py` `OFFICIAL`).

## Sources

* Mayer, L., Jakobsson, M., Allen, G., Dorschel, B., Falconer, R., Ferrini, V., Lamarche, G., Snaith, H. and
  Weatherall, P. (2018). The Nippon Foundation—GEBCO Seabed 2030 Project: The Quest to See the World's Oceans
  Completely Mapped by 2030. Geosciences 8, 63. https://doi.org/10.3390/geosciences8020063 (Table 2 and the
  "at least one sounding" definition read from the open-access PDF).
* GEBCO Compilation Group, GEBCO_2019 … GEBCO_2026 Grid and TID grids; DOIs per release in
  `dataset/tables/global_by_release.csv` (GEBCO_2026: https://doi.org/10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa).
* Official percentages: Seabed 2030 / GEBCO / Nippon Foundation announcements, URLs in
  `dataset/tables/global_by_release.csv`.
