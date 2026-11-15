# Cell-size sensitivity of the measured share

Response to the reviewer point that a 15″ cell is 463 m wide east-west at the equator but only 232 m at
60° and 80 m at 80°, so the same survey marks less area as "measured" at high latitude. Produced by
`pipeline/sensitivity_cellsize.py`; numbers in `data/derived/sensitivity_cellsize.json`; figure
`figures/fig_sensitivity_cellsize.png`.

## What was done

* Same ocean mask as the paper (GEBCO_2026 TID ≠ 0 and GEBCO_2026 1′ elevation < 0), same "measured"
  definition (TID 10–17), same exact spherical cell areas (authalic sphere, R = 6371.0072 km). The native 15″
  share was recomputed with this code: 30.8102 % (pipeline/history.py: 30.8102 %,
  difference 1.7e-16).
* **Equal-width blocks (EW 463 m).** In each 15″ row at latitude φ, k = max(1, round(1/cos φ)) adjacent
  cells along longitude form one block, starting at 180° W; the last block of a row is shorter when 86,400 is
  not a multiple of k. Because k is an integer, the block width is 309–618 m (k = 1 up to 48.2°, k = 2 to 66.4°,
  …), never the 80–232 m of the native cell at high latitude.
* **Coarser equal-width blocks (EW 926 m, EW 1853 m).** Rows are grouped into globally aligned groups of s = 2 or 4
  rows, and k = max(1, round(s/cos φ)) columns, φ = centre of the row group, so blocks are about s × 463 m in
  both directions. (Close to merging 2×2 / 4×4 equal-width blocks, but avoids blocks whose rows have
  different k.)
* A block is measured if **any** of its ocean cells is measured, or (variant) if **more than half** of its ocean
  cells are. Block area = sum of its ocean cells' areas, so every variant has the same total ocean area
  (361.694 M km², checked). The native share is the area-weighted mean measured
  *fraction* of the blocks, so "any" ≥ native by construction; "majority" can fall on either side of native.
* Run time 32 s on 6 processes, 512-row strips.

## Result (% of the ocean area in each band coded as directly measured)

| Band | Ocean (M km²) | 15″ cell E-W (m) | Native 15″ | EW 463 m any | EW 463 m majority | EW 926 m any | EW 926 m majority | EW 1853 m any | EW 1853 m majority |
|---|---|---|---|---|---|---|---|---|---|
| **Global** | 361.7 | | **30.81** | **31.12** | **30.60** | **33.52** | **29.98** | **37.65** | **30.21** |
| 85°N–90°N | 0.97 | 20 | 18.5 | 21.0 | 18.4 | 24.2 | 18.4 | 29.7 | 18.5 |
| 80°N–85°N | 2.50 | 60 | 17.5 | 18.8 | 17.4 | 21.1 | 17.4 | 25.6 | 17.5 |
| 75°N–80°N | 3.64 | 100 | 23.5 | 25.1 | 23.2 | 28.3 | 23.3 | 34.0 | 23.6 |
| 70°N–75°N | 4.27 | 139 | 29.9 | 31.9 | 29.7 | 36.6 | 29.3 | 44.4 | 29.5 |
| 65°N–70°N | 2.32 | 177 | 38.7 | 44.3 | 37.1 | 53.5 | 36.9 | 66.3 | 37.2 |
| 60°N–65°N | 3.05 | 214 | 52.2 | 56.2 | 48.1 | 65.6 | 49.9 | 77.2 | 50.4 |
| 55°N–60°N | 5.40 | 249 | 55.2 | 57.3 | 53.1 | 61.8 | 54.3 | 67.3 | 54.9 |
| 50°N–55°N | 5.51 | 282 | 50.3 | 51.4 | 49.2 | 53.6 | 49.7 | 57.8 | 50.1 |
| 45°N–50°N | 6.93 | 313 | 41.0 | 41.3 | 40.8 | 43.9 | 40.5 | 47.5 | 40.9 |
| 40°N–45°N | 8.67 | 341 | 45.7 | 45.7 | 45.7 | 48.1 | 45.2 | 51.3 | 45.4 |
| 35°N–40°N | 10.16 | 367 | 48.7 | 48.7 | 48.7 | 50.7 | 48.0 | 53.8 | 48.3 |
| 30°N–35°N | 10.83 | 391 | 50.2 | 50.2 | 50.2 | 52.2 | 49.4 | 56.4 | 49.8 |
| 25°N–30°N | 11.79 | 411 | 50.0 | 50.0 | 50.0 | 52.4 | 49.0 | 56.5 | 49.5 |
| 20°N–25°N | 13.35 | 428 | 45.2 | 45.2 | 45.2 | 47.1 | 44.4 | 50.3 | 44.7 |
| 15°N–20°N | 15.04 | 442 | 37.0 | 37.0 | 37.0 | 39.1 | 36.1 | 42.8 | 36.4 |
| 10°N–15°N | 16.60 | 452 | 32.3 | 32.3 | 32.3 | 34.6 | 31.3 | 38.7 | 31.5 |
| 5°N–10°N | 16.69 | 459 | 26.1 | 26.1 | 26.1 | 28.2 | 25.2 | 32.1 | 25.4 |
| 0°–5°N | 17.46 | 463 | 25.3 | 25.3 | 25.3 | 27.1 | 24.5 | 30.6 | 24.7 |
| 0°–5°S | 16.84 | 463 | 23.4 | 23.4 | 23.4 | 25.7 | 22.4 | 29.9 | 22.6 |
| 5°S–10°S | 16.93 | 459 | 23.4 | 23.4 | 23.4 | 25.7 | 22.5 | 29.9 | 22.6 |
| 10°S–15°S | 17.27 | 452 | 25.7 | 25.7 | 25.7 | 27.9 | 24.7 | 32.2 | 24.9 |
| 15°S–20°S | 16.17 | 442 | 27.7 | 27.7 | 27.7 | 29.9 | 26.7 | 34.0 | 27.0 |
| 20°S–25°S | 15.50 | 428 | 26.1 | 26.1 | 26.1 | 28.1 | 25.3 | 31.8 | 25.5 |
| 25°S–30°S | 15.46 | 411 | 28.7 | 28.7 | 28.7 | 30.5 | 27.9 | 34.2 | 28.3 |
| 30°S–35°S | 15.78 | 391 | 27.4 | 27.4 | 27.4 | 29.2 | 26.5 | 33.2 | 27.0 |
| 35°S–40°S | 16.48 | 367 | 25.2 | 25.2 | 25.2 | 27.3 | 24.5 | 30.6 | 24.7 |
| 40°S–45°S | 15.79 | 341 | 19.4 | 19.4 | 19.4 | 21.6 | 19.0 | 24.1 | 19.1 |
| 45°S–50°S | 14.64 | 313 | 20.3 | 20.5 | 20.0 | 22.2 | 19.8 | 24.8 | 19.9 |
| 50°S–55°S | 13.32 | 282 | 22.5 | 23.6 | 21.4 | 26.3 | 21.5 | 31.6 | 21.5 |
| 55°S–60°S | 11.94 | 249 | 24.1 | 24.8 | 23.5 | 27.4 | 23.4 | 31.7 | 23.4 |
| 60°S–65°S | 10.24 | 214 | 25.5 | 26.3 | 24.7 | 29.8 | 24.5 | 35.6 | 24.3 |
| 65°S–70°S | 6.76 | 177 | 30.6 | 31.8 | 30.2 | 35.4 | 29.7 | 41.4 | 29.6 |
| 70°S–75°S | 2.75 | 139 | 35.7 | 37.0 | 35.5 | 40.4 | 35.2 | 45.5 | 35.4 |
| 75°S–80°S | 0.63 | 100 | 40.1 | 43.0 | 39.4 | 49.7 | 39.2 | 59.1 | 39.5 |

The 15″ cell E-W column is the mean width of a native cell in the band; EW block widths per band are in the JSON
(`band_block_ew_m_*`).

## Interpretation

* **The high-latitude drop is real, not a cell-size artefact.** On native cells the share falls from 55.2 % at
  55–60° N to 17.5 % at 80–85° N (37.7 percentage points). On equal-width 463 m blocks (any rule) it falls from
  57.3 % to 18.8 % (38.5 points); at ~926 m and ~1853 m the drop is 40.7 and 41.7 points. Equal-width blocking
  raises the high-latitude bands by at most 5.6 points (65–70° N: 38.7 → 44.3 %) and by only 1.3 points at
  80–85° N, so the gradient does not shrink; it steepens slightly.
* **The global effect is small.** Equal-width 463 m blocks give 31.12 % (any) and 30.60 % (majority) against
  30.81 % native, i.e. +0.31 / −0.21 points. All of the +0.31 points (1.12 M km²) comes from rows poleward of
  48.2°, the only rows where k ≥ 2.
* **Scale and counting rule matter more than latitude.** Coarsening the equal-width blocks to ~926 m and ~1853 m
  raises the "any" share to 33.52 % and 37.65 %, while the "majority" share stays at 29.98–30.60 %. A measured
  share defined by "one sounding per cell" is therefore scale dependent by several points, much more than the
  east-west shrinkage of the 15″ cell changes it.
* **For the comparison with Seabed 2030:** a native 15″ cell is narrower than 400 m east-west poleward of 30.3° and
  smaller in area than a 400 m square poleward of 41.8°; 33.0 % of the ocean area lies poleward of 40°. So at native
  resolution the "coarser than the 100–400 m target" argument holds for about two thirds of the ocean area, not
  everywhere. On equal-width blocks (309–618 m east-west, 463 m north-south at every latitude) the global share is
  31.12 %: correcting for the narrow high-latitude cells moves the TID share slightly away from the official
  28.7 %, not toward it, so the direction of the argument is unchanged.
