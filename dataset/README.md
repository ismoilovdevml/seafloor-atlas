# Seafloor measured record, GEBCO releases 2019–2026

Version 1.0.0. Creator: Otabek Ismoilov (ORCID [0009-0008-2785-3691](https://orcid.org/0009-0008-2785-3691)).
Licence: **CC BY 4.0** (see [Licence and attribution](#licence-and-attribution)).

For every 15 arc-second cell of the global ocean, this dataset records in which of the eight GEBCO grid releases
(GEBCO_2019 … GEBCO_2026) the cell is coded as **directly measured**, and summarises that record in tidy tables:
per release, per 5° latitude band, per 250 m depth bin, per ocean basin and for national waters (EEZ) vs the high
seas, plus the cell-size sensitivity of the 2026 share.

| Release | Measured share | Measured in this or an earlier release | Re-coded away vs previous release (M km²) |
|---|---|---|---|
| 2019 | 12.43 % | 12.43 % | |
| 2020 | 18.24 % | 19.52 % | 4.62 |
| 2021 | 21.91 % | 23.49 % | 4.06 |
| 2022 | 25.35 % | 26.82 % | 2.07 |
| 2023 | 26.27 % | 28.70 % | 4.48 |
| 2024 | 28.54 % | 30.39 % | 1.80 |
| 2025 | 29.69 % | 31.47 % | 0.76 |
| 2026 | 30.81 % | 33.04 % | 2.51 |

Ocean mask area: 361,694,058 km². These are the numbers `pipeline/build_dataset.py verify` recomputes from the
netCDF file itself (see [Verification](#verification)).

## Definitions

* **Measured.** A cell is measured in a release if its GEBCO Type Identifier (TID) in that release is **10–17**
  (direct measurement: 10 single beam, 11 multibeam, 12 seismic, 13 isolated sounding, 14 ENC sounding, 15 lidar,
  16 optical light sensor, 17 combination of direct methods) **and** it lies inside the ocean mask. All codes are
  listed in `tables/tid_codes.csv` (GEBCO grid documentation, Table 2).
* **Ocean mask** (the same for every release): GEBCO_2026 TID ≠ 0 **and** GEBCO_2026 1′ elevation < 0, where the
  1′ elevation is that of the 1′ cell containing the 15″ cell. It excludes the Antarctic ice sheet and land, and keeps
  lake beds below sea level (the Caspian Sea, about 0.6 M km²). Because the mask is fixed, differences between
  releases come only from the TID codes; coastline and ice-shelf changes between releases are ignored (each
  release's own mask changes the share by at most 0.02 percentage points, column
  `measured_share_own_mask_fraction`).
* **Area.** Exact spherical area of each 15″ cell on the authalic sphere, R = 6371.0072 km:
  A = R² · Δλ · (sin φ_north − sin φ_south), Δλ = 15″ in radians. All km² values are sums of 15″ cell areas, never
  cell counts and never 1′ approximations.
* **First measured in GEBCO_YYYY** is the first release that codes the cell 10–17, not the survey year: a release can
  add surveys collected years earlier.
* **Re-coded away.** A cell measured in release Y−1 that is not measured in release Y (its TID moved to an indirect
  or unknown class, e.g. 40 satellite-gravity prediction, 41 interpolation, 44 mixed gridded, 70 pre-generated grid).
  In the grid, `recoded_away` = measured in at least one release 2019–2025 but not in GEBCO_2026.
* **GEBCO_2023 TID version.** The GEBCO_2023 TID grid used is the **January 2024 re-issue** (CEDA zip,
  `GEBCO_2023_TID.nc` dated 2024-02-12, GeoTIFF sha256 `db45124a…09eef0`), which corrects TID coding in the central
  Mediterranean and the North Pacific. With the original April 2023 file the 2023 share would be 25.89 %, not
  26.27 %. Both copies carry the same DOI. Details: `docs/gebco2023_tid_version.md`.
* **Not the Seabed 2030 metric.** Seabed 2030 counts cells holding data on a depth-dependent grid (100–800 m cells);
  a 15″ TID share is not expected to equal it. The official figure for each release is given for comparison, with
  its source URL, in `tables/global_by_release.csv`.

## Files

| File | Size | Committed to git |
|---|---|---|
| `build/seafloor_measured_record_2019_2026.nc` | 775,069,712 bytes | no (`dataset/build/` is gitignored; deposit separately) |
| `tables/global_by_release.csv` | 8 rows | yes |
| `tables/recoded_away_by_destination_tid.csv` | 65 rows | yes |
| `tables/by_latitude_band_by_release.csv` | 280 rows | yes |
| `tables/by_depth_bin_by_release.csv` | 352 rows | yes |
| `tables/by_ocean_by_release.csv` | 96 rows | yes |
| `tables/by_zone_by_release.csv` | 32 rows | yes |
| `tables/cellsize_sensitivity_2026.csv` | 252 rows | yes |
| `tables/tid_codes.csv` | 21 rows | yes |
| `inputs.sha256` | sha256 of every input file | yes |
| `checksums.sha256` | sha256 of every file above (paths relative to `dataset/`) | yes |

`build/` also holds working files that are not part of the dataset: `summary_cube.npz` (area sums behind the
tables), `regions_1arcmin.npy` / `regions_labels.json` (rasterised Marine Regions polygons), `build_info.json`,
`verify.log`.

## netCDF file: `seafloor_measured_record_2019_2026.nc`

netCDF-4 (HDF5), CF-1.8 and ACDD-1.3 attributes, zlib level 4 with shuffle, chunks of 720 × 1440 cells (3° × 6°).
Grid: 43,200 × 86,400 cells of 15″ (1/240°), cell-centre registered, **latitude ascending** (south to north) and
longitude −180 … 180, i.e. the same orientation and indexing as the GEBCO netCDF grids: index (i, j) here is
index (i, j) in `GEBCO_<year>_TID.nc`. Datum WGS84 (variable `crs`).

| Variable | Type | Values | Meaning |
|---|---|---|---|
| `lat`, `lon` | double | degrees_north / degrees_east | cell centres; `lat[i] = −90 + (i + 0.5)/240`, `lon[j] = −180 + (j + 0.5)/240` |
| `lat_bnds`, `lon_bnds` | double (·, 2) | degrees | cell edges (CF `bounds`) |
| `crs` | int | – | grid mapping `latitude_longitude`, WGS84 |
| `measured_release_flags` | short | 0 … 255, no fill | bitmask: bit k (value 2^k) set = measured in GEBCO_(2019 + k). CF `flag_masks` 1, 2, 4, …, 128. 0 outside the ocean mask. This is the full record; every other variable is a function of it. |
| `first_measured_release` | short | 2019 … 2026; `_FillValue` −1 | first release in which the cell is measured. Fill = never measured in 2019–2026, or outside the ocean mask |
| `last_measured_release` | short | 2019 … 2026; `_FillValue` −1 | last release in which the cell is measured. Fill as above |
| `n_releases_measured` | byte | 0 … 8; `_FillValue` −1 | number of releases in which the cell is measured. Fill = outside the ocean mask |
| `measured_in_2026` | byte | 0, 1; `_FillValue` −1 | measured in GEBCO_2026 |
| `recoded_away` | byte | 0, 1; `_FillValue` −1 | measured in at least one release 2019–2025 but not in GEBCO_2026 |
| `ocean_mask` | byte | 0, 1, no fill | 1 = inside the fixed ocean mask |

Relations that hold in every cell (checked by `verify`): `n_releases_measured > 0` ⇔ `first_measured_release`
not fill; `recoded_away = 1` ⇔ `n_releases_measured > 0` and `measured_in_2026 = 0`; `last ≥ first`. A cell can be
measured, re-coded, and measured again, so first/last/n do not determine the per-release state; use
`measured_release_flags` for that.

Global attributes carry the title, summary, the source (GEBCO DOI of each release), history, licence, creator,
references, geospatial bounds, and `measured_definition`, `ocean_mask_definition`, `area_method`,
`gebco_2023_tid_version`, `first_measured_note`.

### Reading it in Python

```python
import numpy as np
import xarray as xr

ds = xr.open_dataset("seafloor_measured_record_2019_2026.nc", chunks={"lat": 720, "lon": 1440})
# one region, e.g. the North Sea
sub = ds.sel(lat=slice(51, 62), lon=slice(-4, 9))
first = sub.first_measured_release            # NaN where never measured or outside the mask

# measured in GEBCO_2022 (bit 3), area-weighted share of the ocean in the box
R = 6371.0072
s = np.sin(np.radians(sub.lat_bnds))
area_row = R**2 * np.radians(1 / 240) * (s[:, 1] - s[:, 0])          # km2 per cell, per latitude row
ocean = sub.ocean_mask == 1
m2022 = (sub.measured_release_flags.astype("int16") >> (2022 - 2019)) & 1
share = float((m2022.where(ocean, 0) * area_row).sum() / (ocean * area_row).sum())
```

Plain netCDF4 also works: `netCDF4.Dataset(path)["first_measured_release"][i0:i1, j0:j1]` (masked array, fill
masked). Read in row strips or boxes; one full variable is 3.7 × 10⁹ cells.

## Tables (`tables/*.csv`)

UTF-8, comma-separated, one header row, `.` decimal separator, no thousands separator, empty field = not
applicable (e.g. "vs previous release" for 2019). Units are in the column names: `_km2` = square kilometres
(sums of exact 15″ cell areas, 3 decimals), `_fraction` = dimensionless 0–1 (full double precision), `_deg` =
degrees, `_m` = metres. `release` = GEBCO grid year.

**Common columns** of the four `by_*_by_release.csv` tables (one row per group and release):

| Column | Meaning |
|---|---|
| `release` | GEBCO release (2019 … 2026) |
| `ocean_area_km2` | ocean-mask area of the group (same every release) |
| `measured_area_km2` | area measured (TID 10–17) in this release |
| `measured_share_fraction` | `measured_area_km2 / ocean_area_km2` |
| `ever_measured_area_km2` | area measured in this or any earlier release (from 2019) |
| `ever_measured_share_fraction` | `ever_measured_area_km2 / ocean_area_km2` |
| `first_measured_area_km2` | area whose first measured release is this one |
| `new_vs_previous_km2` | measured in this release, not in the previous one (empty for 2019) |
| `recoded_away_vs_previous_km2` | measured in the previous release, not in this one (empty for 2019) |

Bookkeeping: `measured(Y) = measured(Y−1) + new_vs_previous(Y) − recoded_away_vs_previous(Y)`, and the sum of
`first_measured_area_km2` over releases equals `ever_measured_area_km2` of 2026.

* **`global_by_release.csv`**: one row per release. `gebco_grid`, `gebco_doi` (URL); the common columns, plus `measured_share_own_mask_fraction` and
  `own_mask_ocean_area_km2` (the release's own TID ≠ 0 with the GEBCO_2026 1′ elevation < 0, for comparison),
  `measured_earlier_not_in_this_release_km2` (= ever − measured), `official_seabed2030_share_fraction`,
  `official_announcement_date` (ISO date), `official_source_url` (the page the official figure was read from on
  2026-11-15; quotes in `pipeline/history.py`, `OFFICIAL`).
* **`recoded_away_by_destination_tid.csv`**: for each transition `from_release` → `to_release`, the area re-coded
  away, split by the TID code the cells have in `to_release`: `destination_tid`, `destination_tid_meaning`,
  `area_km2`, `share_of_transition_fraction`. Codes 10–17 cannot appear. Code 0 = the cell is land in that release
  (inside the GEBCO_2026 mask).
* **`by_latitude_band_by_release.csv`**: 5° bands, `lat_south_deg`, `lat_north_deg` (a 15″ cell belongs to the
  band containing its centre; band edges fall on cell edges, so this is exact). Bands without ocean are omitted.
* **`by_depth_bin_by_release.csv`**: 250 m bins of the **GEBCO_2026 1′ depth** of the 1′ cell containing the 15″
  cell: `depth_min_m` < depth ≤ `depth_max_m`, depth = −elevation. The same 2026 depth is used for every release.
* **`by_ocean_by_release.csv`**: `ocean_name` = Marine Regions Global Oceans and Seas v01 polygon (IHO S-23 based;
  "South China and Easter Archipelagic Seas" is shown as "Eastern"), plus "Outside all GOaS polygons" (lake beds
  below sea level, coastline mismatch) and "Caspian Sea box (excluded)" (46–55.5° E, 36–47.5° N: a lake below sea
  level that the GEBCO mask keeps).
* **`by_zone_by_release.csv`**: `zone` = `eez` (inside any Marine Regions World EEZ v12 polygon, including
  overlapping claims and joint regimes, each cell counted once), `high_seas` (inside Marine Regions High Seas v2
  and outside every EEZ), `neither` (ocean cells in neither polygon set: lake beds, coastal slivers),
  `caspian_box_excluded`. Zones and oceans are given **for every release**.
* **`cellsize_sensitivity_2026.csv`**: copied from `data/derived/sensitivity_cellsize.json`
  (`pipeline/sensitivity_cellsize.py`; GEBCO_2026 only). `variant` (`native`, `ew<s>_any`, `ew<s>_majority`),
  `block_family` (`native` = 15″ cells, `ew1/ew2/ew4` = blocks about 463 / 926 / 1853 m wide in both directions:
  s 15″ rows × k = max(1, round(s / cos φ)) columns), `block_rule` (`native`; `any` = block measured if any ocean
  cell is; `majority` = if more than half of its ocean cells are), `nominal_block_size_m`, `scope` (`global` or
  `band`), `lat_south_deg`, `lat_north_deg` (5° bands; empty for global), `ocean_area_km2`, `measured_area_km2`,
  `measured_share_fraction`, `mean_block_ew_width_m` (mean east-west width of a block in the band).
* **`tid_codes.csv`**: `tid`, `group` (`land`, `direct`, `indirect`, `unknown`), `meaning`.

Regions are burned onto the 1′ grid by cell centre (`rasterio.features.rasterize`, `all_touched=False`) from the
Marine Regions WMS GeoJSON tiles exactly as `pipeline/regions.py` does, then each 15″ cell takes the region of its
1′ cell; areas and measured flags are exact 15″ values. For 2026 the EEZ share is 37.961 % here vs 37.951 % in
`data/derived/regions.json` (which uses a 1′ measured fraction quantised to 1/254); the high-seas share 26.416 % vs
26.417 %. EEZ boundaries include disputed areas and have no legal value.

## Provenance

| Input | Source |
|---|---|
| `data/raw/gebco_<year>/gebco_<year>_tid.tif`, 2019–2026 | GEBCO_<year> TID grid (netCDF from CEDA, `https://dap.ceda.ac.uk/bodc/gebco/global/gebco_<year>/type_identifier_grid/netcdf/gebco_<year>_tid.zip`), converted to north-up Int8 GeoTIFF by `pipeline/history.py convert` (values unchanged; orientation checked) |
| `data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif` | GEBCO_2026 elevation, 1′ block mean of the 15″ grid |
| `data/raw/regions/{goas,eez,high_seas}/` | Marine Regions GeoServer WMS GeoJSON, 30° tiles at 1′ pixel size (`pipeline/regions.py`) |
| `data/derived/history_stats.json` | `pipeline/history.py build` (reference for `verify`) |
| `data/derived/sensitivity_cellsize.json` | `pipeline/sensitivity_cellsize.py run` |

sha256 of every input: `inputs.sha256` (paths relative to the repository root).

GEBCO DOIs (GEBCO Compilation Group, GEBCO_<year> Grid): 2019 10.5285/836f016a-33be-6ddc-e053-6c86abc0788e;
2020 10.5285/a29c5465-b138-234d-e053-6c86abc040b9; 2021 10.5285/c6612cbe-50b3-0cff-e053-6c86abc09f8f;
2022 10.5285/e0f0bb80-ab44-2739-e053-6c86abc0289c; 2023 10.5285/f98b053b-0cbc-6c23-e053-6c86abc0af7b;
2024 10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f; 2025 10.5285/37c52e96-24ea-67ce-e063-7086abc05f29;
2026 10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa.

## Reproduce

```
.venv/bin/python pipeline/history.py fetch && .venv/bin/python pipeline/history.py convert   # inputs, once
.venv/bin/python pipeline/build_dataset.py build      # netCDF + summary cube  (~165 s, 5 processes)
.venv/bin/python pipeline/build_dataset.py tables     # CSVs (asserts the global numbers again)
.venv/bin/python pipeline/build_dataset.py verify     # netCDF -> numbers -> history_stats.json (~30 s)
.venv/bin/python pipeline/build_dataset.py checksums
.venv/bin/python -m pytest tests/test_build_dataset.py
```

Peak memory is about 2.5 GB per worker process (`--workers`, default 5).

## Verification

`verify` reads only the netCDF file: it takes cell areas from `lat_bnds` / `lon_bnds`, recomputes per release the
measured area and share, the ever-measured area and share, the first-measured area (from the bitmask and,
separately, from `first_measured_release`), new and re-coded-away area vs the previous release, and the 2026
totals from `n_releases_measured`, `measured_in_2026` and `recoded_away`. It asserts each equals
`data/derived/history_stats.json` within 1 km² (the JSON stores whole km²) or 1 × 10⁻⁹ (fractions), that every
derived variable equals the function of the bitmask in every cell, that no bit is set outside the ocean mask, and that
all cell areas add up to the sphere. Because global sums cannot detect a north-south flip, it also compares the
bitmask and ocean mask cell by cell with values recomputed from the eight source TID GeoTIFFs in 42 windows of
512 × 512 cells (located through the netCDF `lat`/`lon`), when the inputs are present. Result of the current file:
worst difference 0.49 km² and 4 × 10⁻¹⁵ (fraction); 0 disagreeing cells; source-window check 11,010,048 cells,
0 mismatches. Log: `build/verify.log`.

## Conventions check

IOOS `compliance-checker` 6.1.0 (`uvx compliance-checker --test=cf:1.8 --test=acdd:1.3`, report in
`build/compliance_checker.txt`): **CF-1.8: all tests passed.** ACDD-1.3: no required attribute missing; remaining
notes are "highly recommended" `standard_name` for `n_releases_measured` (no CF standard name exists for it),
"recommended" attributes that do not apply or are not set yet (vertical extent, time duration/resolution,
`creator_email`, `publisher_*`, to be filled at deposit), and that `geospatial_lat/lon_min/max` (−90/90, −180/180)
are the cell edges, not the outermost cell centres (deliberate: they match `geospatial_bounds`). `cfchecks`
(cfchecker) could not be run: it needs the UDUNITS-2 C library, which is not installed on the build host.

## Licence and attribution

This dataset (netCDF and tables) is released under **CC BY 4.0**
(https://creativecommons.org/licenses/by/4.0/). Please cite it and its sources:

* GEBCO Compilation Group (2019 … 2026) GEBCO_2019 … GEBCO_2026 Grid (DOIs above). The GEBCO Grid terms of use allow
  copying, adapting and commercial use with acknowledgement of the source, and must not suggest endorsement by
  GEBCO or misrepresent the grid. Not for navigation.
* Tables by ocean and zone: Flanders Marine Institute (2021) Global Oceans and Seas, version 1, doi:10.14284/542;
  Flanders Marine Institute (2023) Maritime Boundaries Geodatabase: Maritime Boundaries and Exclusive Economic
  Zones (200NM), version 12, doi:10.14284/632; Flanders Marine Institute (2024) Maritime Boundaries Geodatabase:
  High Seas, version 2, doi:10.14284/696. Marine Regions, https://www.marineregions.org/, CC BY 4.0.
* Official percentages: Seabed 2030 / GEBCO / Nippon Foundation announcements (URLs in `global_by_release.csv`).

Attribution text: "Contains data from the GEBCO_2019–GEBCO_2026 Grids (GEBCO Compilation Group) and Marine Regions
(Flanders Marine Institute, CC BY 4.0)."

## Known limitations

* TID codes change between releases for reasons other than new surveys (re-gridding, a source re-classified as a
  pre-generated grid or interpolation), so "re-coded away" is a property of the GEBCO coding, not loss of data.
* One 15″ cell with a single sounding counts as measured; see `cellsize_sensitivity_2026.csv` for how the 2026
  share changes with ~463–1853 m equal-width blocks.
* A low share means "not in the public GEBCO grid", not necessarily "never surveyed".
