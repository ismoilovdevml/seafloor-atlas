# Distance to the nearest directly measured seafloor, GEBCO 2019–2026

How far is a point of the world ocean from the nearest depth that GEBCO codes as a direct measurement, and how
did that change from release to release? Produced by `pipeline/distance.py`; numbers in
`data/derived/distance_stats.json`; figure `figures/fig_distance_to_measurement.png`; tests
`tests/test_distance.py`.

## Method

* **Measured.** A 1′ cell is measured in a release if at least one of its sixteen 15″ cells has TID 10–17 in that
  release (the per-year bitmask `data/derived/history_mask_1arcmin.npy` from `pipeline/history.py`).
* **Ocean.** The paper's fixed mask (GEBCO_2026 TID ≠ 0 and GEBCO_2026 1′ elevation < 0) **without** the cells
  flagged `inland_below_sea_level` in the published record
  (`dataset/build/seafloor_measured_record_2019_2026.nc`): the Caspian Sea, lake beds and dry land below sea
  level (Qattara, Turpan, …). Connectivity comes from the 15″ record, so the Black Sea stays connected through
  the Bosporus (a 1′ connectivity test would cut it off). A 1′ cell is in the world ocean if any of its 15″ cells
  is (`data/derived/world_ocean_1arcmin.npy`). World ocean 360.763 M km² of the 361.694 M km² mask; 0.931 M km²
  excluded as inland.
* **Distance.** Great-circle distance on the authalic sphere (R = 6371.0072 km) from the centre of each ocean
  1′ cell to the centre of the nearest measured 1′ cell; measured cells are 0. Cell centres become unit vectors,
  a k-d tree of the measured cells (`scipy.spatial.cKDTree`) gives the nearest chord c, and the arc is
  2R·asin(c/2). This is exact on the sphere, wraps across the dateline and has no polar distortion, unlike a pixel
  distance transform on a latitude–longitude grid. Checked against brute-force haversine at three latitudes
  (incl. the polar cap) and across the dateline (`tests/test_distance.py`).
* **Statistics.** Area-weighted: weight = (number of ocean 15″ cells / 16) × exact spherical area of the 1′ cell.
  Quantiles come from an area histogram with 240 log-spaced bins from 1 to 3000 km (bin width 3.4 %), linear
  inside a bin, so quantiles carry about ±2 % bin error. "Unmeasured only" excludes distance-0 cells.
* **Stored grids.** Only the 1′ grids of 2024 and 2025 (inputs of the blind test, `docs/blindtest.md`) are kept,
  as `data/derived/distance_<year>_1arcmin.npz` (uint16, 0.1 km units, 65535 = not world ocean; 57–58 MB each).
  For 2026 an 8′ block mean (`distance_2026_8arcmin.npz`, 7.7 MB) is kept for the map. Every release takes
  41–109 s on 12 cores.

## Numbers per release (world ocean, area-weighted)

| Release | Mean (km) | Median (km) | P90 (km) | P99 (km) | Median, unmeasured only (km) | > 10 km | > 50 km | > 100 km | > 200 km |
|---|---|---|---|---|---|---|---|---|---|
| 2019 | 79.6 | 31.5 | 219.1 | 591 | 44.7 | 68.2 % | 40.3 % | 24.7 % | 11.3 % |
| 2020 | 61.2 | 17.1 | 163.1 | 647 | 31.6 | 58.2 % | 30.3 % | 17.4 % | 7.6 % |
| 2021 | 34.2 | 9.3 | 99.6 | 299 | 20.9 | 49.1 % | 21.0 % | 10.0 % | 2.9 % |
| 2022 | 21.7 | 4.9 | 61.7 | 230 | 12.3 | 37.7 % | 12.5 % | 5.4 % | 1.5 % |
| 2023 | 19.4 | 4.2 | 53.0 | 212 | 11.3 | 35.9 % | 10.7 % | 4.4 % | 1.2 % |
| 2024 | 17.5 | 3.7 | 48.1 | 196 | 10.7 | 33.4 % | 9.6 % | 3.9 % | 0.9 % |
| 2025 | 16.6 | 3.7 | 45.4 | 185 | 10.5 | 32.7 % | 9.0 % | 3.6 % | 0.8 % |
| 2026 | 15.1 | 3.5 | 41.9 | 163 | 10.0 | 31.5 % | 8.1 % | 3.0 % | 0.5 % |

In plain terms: in GEBCO_2019 two points in five of the world ocean (40 %) lay more than 50 km from any direct
depth measurement; in GEBCO_2026 it is one in twelve (8.1 %, 29 M km²). Half of the ocean is within 3.5 km of a
measured 1′ cell, but half of the *unmeasured* ocean is still more than 10 km from one. Most of the gain came
between 2019 and 2022 (median 31 → 5 km); since 2022 the median has barely moved (4.9 → 3.5 km) while the tail
keeps shrinking (P99 230 → 163 km).

## Farthest points (sanity check)

| Release | Farthest point | km | 1′ elevation (m) | Farthest point deeper than 200 m | km | 1′ elevation (m) |
|---|---|---|---|---|---|---|
| 2019 | 56.83 N, 138.46 E (Sea of Okhotsk coast) | 1419 | −12 | 55.41 N, 140.84 E | 1229 | −201 |
| 2020 | 11.19 S, 142.81 E (east coast of Cape York Peninsula) | 1245 | −8 | 10.83 S, 144.04 E | 1204 | −462 |
| 2021 | 19.38 N, 105.79 E (Gulf of Tonkin coast) | 784 | −3 | 27.41 S, 81.61 E | 584 | −4186 |
| 2022 | 26.38 S, 81.93 E (central Indian Ocean) | 528 | −4381 | same | 528 | −4381 |
| 2023 | 26.38 S, 81.93 E | 528 | −4381 | same | 528 | −4381 |
| 2024 | 26.29 S, 81.94 E | 525 | −4295 | same | 525 | −4295 |
| 2025 | 16.78 N, 96.13 E (Yangon River estuary) | 565 | −2 | 26.29 S, 81.94 E | 525 | −4295 |
| 2026 | 26.29 S, 81.94 E | 525 | −4295 | same | 525 | −4295 |

No farthest point is an inland depression: all lie in the world ocean as defined above. In four releases the
overall farthest point is in very shallow coastal or estuarine water that GEBCO keeps in the ocean (elevation −2
to −12 m) and that was far from any direct coding at the time. Beyond the shelf (deeper than 200 m) the farthest
point is in the open ocean in every release, and since 2021 it is the same abyssal plain of the central Indian
Ocean, about 525 km from the nearest measured cell.

The 2025 outlier is a re-coding effect, not missing data: the measured 1′ cells nearest to the Yangon estuary
lay at about 15.0 N, 93.9 E in GEBCO_2021–2024 (≈ 300–309 km away), are not coded direct in GEBCO_2025 (nearest
then 13.36 N, 100.02 E, in the Gulf of Thailand across land: 565 km) and new direct cells 10 km away appear in
GEBCO_2026.

## Caveats

* **1′ resolution.** A 1′ cell is "measured" if any one of its sixteen 15″ cells is; distances are between 1′ cell
  centres. The smallest non-zero distance is one cell (1.85 km north–south, less east–west at high latitude).
  The median of 3.5 km is therefore partly set by the grid; the unmeasured-only median (10 km) and the tail
  are robust to it.
* **Straight line, not through water.** The nearest measurement may lie across land or in another basin
  (see 2025 above). This is the right measure for "how far does an interpolator have to reach", not for a ship.
* **TID is a label.** A direct code means GEBCO placed a measurement-based depth in the cell, not that the cell
  was mapped at full coverage; codes are sometimes re-assigned between releases (the 2025 Andaman case). All
  releases are measured on the same GEBCO_2026 ocean mask, so changes come only from the TID codes.
* **Quantiles** carry the histogram bin error (about ±2 %); means and threshold shares are exact sums.
