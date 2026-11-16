# Seafloor measured record, GEBCO releases 2019–2026

Version 1.0.0. Creator: Otabek Ismoilov (ORCID [0009-0008-2785-3691](https://orcid.org/0009-0008-2785-3691)).
Licence: **CC BY 4.0** (see [Licence and attribution](#licence-and-attribution)).

For every 15 arc-second cell of the global ocean, this dataset records in which of the eight GEBCO grid releases
(GEBCO_2019 … GEBCO_2026) the cell is coded as **directly measured**, and summarises that record in tidy tables:
per release, per 5° latitude band, per 250 m depth bin, per ocean basin, for national waters (EEZ) vs the high
seas and per TID code, plus the cell-size sensitivity of the 2026 share. A per-cell flag marks the parts of the ocean
mask that are below sea level but not connected to the world ocean.

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
netCDF file itself (see [Verification](#verification)). Of the mask, 931,885 km² is flagged
`inland_below_sea_level`; without it the measured share is 12.46 % (2019) and 30.89 % (2026)
(`global_by_release.csv`, columns `*_excluding_inland_*`).

## Definitions

* **Measured.** A cell is measured in a release if its GEBCO Type Identifier (TID) in that release is **10–17**
  (direct measurement: 10 single beam, 11 multibeam, 12 seismic, 13 isolated sounding, 14 ENC sounding, 15 lidar,
  16 optical light sensor, 17 combination of direct methods) **and** it lies inside the ocean mask. All codes are
  listed in `tables/tid_codes.csv` (GEBCO grid documentation, Table 2).
* **Ocean mask** (the same for every release): GEBCO_2026 TID ≠ 0 **and** GEBCO_2026 1′ elevation < 0, where the
  1′ elevation is that of the 1′ cell containing the 15″ cell. It excludes the Antarctic ice sheet and land. It also
  keeps areas below sea level that are not connected to the world ocean (931,885 km², flagged
  `inland_below_sea_level`, see below); they are included in every published area and share. Because the mask is
  fixed, differences between
  releases come only from the TID codes; coastline and ice-shelf changes between releases are ignored (each
  release's own mask changes the share by at most 0.02 percentage points, column
  `measured_share_own_mask_fraction`).
* **Inland below sea level.** A cell of the mask is `inland_below_sea_level` = 1 when it is not connected to the
  world ocean: connected components on the 15″ grid, 8-connectivity, wrapping across 180°; the component with the
  largest area is the world ocean. Connectivity is traced through the mask and through cells whose GEBCO_2026 TID is
  not 0 and whose 15″ GEBCO_2026 elevation is below 0, so straits narrower than a 1′ cell (e.g. the Bosporus) stay
  open; this never changes the mask. The flagged area (931,885 km², 8,766 components) holds basins below sea level
  (the Caspian Sea together with the dry lowland of the Caspian Depression, 694,682 km²; the Qattara Depression,
  Lake Eyre, the Danakil Depression, the Dead Sea, the Turpan Depression, …), lakes whose beds GEBCO places below
  0 m (Laurentian Great Lakes, Lake Baikal, …) and lagoons or inlets whose link to the sea the grid does not resolve
  (e.g. the Curonian Lagoon). Components ≥ 100 km² are listed in `tables/inland_components.csv`.
* **Area.** Exact spherical area of each 15″ cell on the authalic sphere, R = 6371.0072 km:
  A = R² · Δλ · (sin φ_north − sin φ_south), Δλ = 15″ in radians, with the geodetic latitudes of the grid used as
  latitudes on the sphere. All km² values are sums of 15″ cell areas, never cell counts and never 1′
  approximations. Against exact WGS84 ellipsoidal cell areas, the ocean area of a 5° band differs by −0.89 % to
  +0.45 %, the whole mask by +118,801 km² (+0.033 %), and the global measured share by at most 0.011 percentage
  points (2020; 0.002 points in 2026). Values in `build/verify.log`.
* **First measured in GEBCO_YYYY** is the first release that codes the cell 10–17, not the survey year: a release can
  add surveys collected years earlier.
* **Re-coded away.** A cell measured in release Y−1 that is not measured in release Y (its TID moved to an indirect
  or unknown class, e.g. 40 satellite-gravity prediction, 41 interpolation, 44 mixed gridded, 70 pre-generated grid).
  In the grid, `recoded_away` = measured in at least one release 2019–2025 but not in GEBCO_2026.
* **GEBCO_2023 TID version.** The GEBCO_2023 TID grid used is the **January 2024 re-issue** (CEDA zip,
  `GEBCO_2023_TID.nc` dated 2024-02-12, GeoTIFF sha256 `db45124a…09eef0`), which corrects TID coding in the central
  Mediterranean and the North Pacific. With the original April 2023 file the 2023 share would be 25.89 %, not
  26.27 %. Both copies carry the same DOI. Details: `docs/gebco2023_tid_version.md`.
* **TID 44 and 70 can hold soundings.** By GEBCO's definitions, TID 44 ("bathymetric depths from multiple sources
  including measured and derived data") and TID 70 ("pre-generated grid … based on mixed source data types, e.g.
  single beam, multibeam, interpolation") can contain measurements. They are not counted as measured here, so the
  10–17 share is a lower bound on the area holding data. In GEBCO_2026 they cover 3.05 % of the mask (1.41 % and
  1.64 %, `tables/by_tid_code_by_release.csv`); 32.6 % of the area re-coded away over all transitions went to them.
* **Not the Seabed 2030 metric.** The Seabed 2030 announcements give the share "mapped" (in 2025 and 2026 "mapped to
  modern standards") without a reproducible method; Seabed 2030 sets depth-dependent target cells of 100–800 m. The official figure for each release is given for comparison, with
  its source URL, in `tables/global_by_release.csv`.

## Files

The deposit consists of these files (the same list is in the data paper):

| File | Content | In `checksums.sha256` |
|---|---|---|
| `build/seafloor_measured_record_2019_2026.nc` | per-cell record, 783,337,035 bytes | yes |
| `tables/global_by_release.csv` | 8 rows | yes |
| `tables/recoded_away_by_destination_tid.csv` | 65 rows | yes |
| `tables/by_latitude_band_by_release.csv` | 280 rows | yes |
| `tables/by_depth_bin_by_release.csv` | 352 rows | yes |
| `tables/by_ocean_by_release.csv` | 96 rows | yes |
| `tables/by_zone_by_release.csv` | 32 rows | yes |
| `tables/by_tid_code_by_release.csv` | 145 rows | yes |
| `tables/inland_components.csv` | 186 rows | yes |
| `tables/cellsize_sensitivity_2026.csv` | 252 rows | yes |
| `tables/tid_codes.csv` | 21 rows | yes |
| `README.md` | this file | yes |
| `inputs.sha256` | sha256 of every input file (paths relative to the repository root) | yes |
| `checksums.sha256` | sha256 of the files marked "yes" (paths relative to `dataset/`) | – |
| `build/verify.log` | output of `verify` | no (log, not byte-reproducible) |
| `build/compliance_checker.txt` | IOOS compliance-checker report | no (log, carries its run time) |

`dataset/build/` is gitignored; the netCDF file and the two logs are deposited separately. `build/` also holds working
files that are not part of the dataset: `summary_cube.npz` (area sums behind the tables), `inland_labels.npz`
(connected components of the mask), `regions_1arcmin.npy` / `regions_labels.json` (rasterised Marine Regions
polygons), `build_info.json`, `essd_fig1_4arcmin.npz` (figure cache).

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
| `measured_release_flags` | short | 0 … 255, no fill | bitmask: bit k (value 2^k) set = measured in GEBCO_(2019 + k). CF `flag_masks` 1, 2, 4, …, 128. 0 outside the ocean mask. This is the full record; the other per-release variables are functions of it. |
| `first_measured_release` | short | 2019 … 2026; `_FillValue` −1 | first release in which the cell is measured. Fill = never measured in 2019–2026, or outside the ocean mask |
| `last_measured_release` | short | 2019 … 2026; `_FillValue` −1 | last release in which the cell is measured. Fill as above |
| `n_releases_measured` | byte | 0 … 8; `_FillValue` −1 | number of releases in which the cell is measured. Fill = outside the ocean mask |
| `measured_in_2026` | byte | 0, 1; `_FillValue` −1 | measured in GEBCO_2026 |
| `recoded_away` | byte | 0, 1; `_FillValue` −1 | measured in at least one release 2019–2025 but not in GEBCO_2026 |
| `inland_below_sea_level` | byte | 0, 1; `_FillValue` −1 | 1 = in the ocean mask but not connected to the world ocean (see Definitions). Fill = outside the ocean mask |
| `ocean_mask` | byte | 0, 1, no fill | 1 = inside the fixed ocean mask |

Relations that hold in every cell (checked by `verify`): `n_releases_measured > 0` ⇔ `first_measured_release`
not fill; `recoded_away = 1` ⇔ `n_releases_measured > 0` and `measured_in_2026 = 0`; `last ≥ first`. A cell can be
measured, re-coded, and measured again, so first/last/n do not determine the per-release state; use
`measured_release_flags` for that.

Why `short` for an 8-bit mask: bit 7 (value 128) does not fit a signed byte, and the IOOS compliance checker 6.1.0
rejects unsigned types under CF-1.8 (§2.2 Data Types: "failed because the datatype is uint8", tested on
2026-11-16). With shuffle + zlib the always-zero high byte costs almost nothing.

Global attributes carry the title, summary, the source (GEBCO DOI of each release), history, licence, creator,
references, geospatial bounds, and `measured_definition`, `ocean_mask_definition`, `area_method`,
`gebco_2023_tid_version`, `first_measured_note`. `time_coverage_start` / `time_coverage_end` are the announcement
dates of GEBCO_2019 (2019-06-13) and GEBCO_2026 (2026-04-27).

### Reading it in Python

```python
import numpy as np
import xarray as xr

ds = xr.open_dataset("seafloor_measured_record_2019_2026.nc")   # lazy; add chunks=... if dask is installed
# one region, e.g. the North Sea
sub = ds.sel(lat=slice(51, 62), lon=slice(-4, 9))
first = sub.first_measured_release            # NaN where never measured or outside the mask

# measured in GEBCO_2022 (bit 3), area-weighted share of the ocean in the box
R = 6371.0072
s = np.sin(np.radians(sub.lat_bnds))
area_row = R**2 * np.radians(1 / 240) * (s[:, 1] - s[:, 0])          # km2 per cell, per latitude row
ocean = sub.ocean_mask == 1
m2022 = (sub.measured_release_flags.astype("int16") >> (2022 - 2019)) & 1
share = float((m2022.where(ocean, 0) * area_row).sum() / (ocean * area_row).sum())   # 0.8874
```

Tested on 2026-11-16 with `uvx --with netCDF4 --with xarray python` (xarray and netCDF4 only, no dask); the result
equals the same sum done with netCDF4 directly.

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
  2026-11-15; quotes in `pipeline/history.py`, `OFFICIAL`), and the shares without the cells flagged
  `inland_below_sea_level`: `inland_below_sea_level_area_km2`, `inland_below_sea_level_measured_area_km2`,
  `ocean_area_excluding_inland_km2`, `measured_area_excluding_inland_km2`,
  `measured_share_excluding_inland_fraction`.
* **`recoded_away_by_destination_tid.csv`**: for each transition `from_release` → `to_release`, the area re-coded
  away, split by the TID code the cells have in `to_release`: `destination_tid`, `destination_tid_meaning`,
  `area_km2`, `share_of_transition_fraction`. Codes 10–17 cannot appear. Code 0 = the cell is land in that release
  (inside the GEBCO_2026 mask).
* **`by_latitude_band_by_release.csv`**: 5° bands, `lat_south_deg`, `lat_north_deg` (a 15″ cell belongs to the
  band containing its centre; band edges fall on cell edges, so this is exact). Bands without ocean are omitted.
* **`by_depth_bin_by_release.csv`**: 250 m bins of the **GEBCO_2026 1′ depth** of the 1′ cell containing the 15″
  cell: `depth_min_m` < depth ≤ `depth_max_m`, depth = −elevation. The same 2026 depth is used for every release.
* **`by_ocean_by_release.csv`**: `ocean_name` = Marine Regions Global Oceans and Seas v01 polygon (IHO S-23 based;
  "South China and Easter Archipelagic Seas" is shown as "Eastern"), plus "Outside all GOaS polygons" (areas below
  sea level away from the sea, coastline mismatch) and "Caspian Sea box" (46–55.5° E, 36–47.5° N). The Caspian box is
  reported as its own group but is **included** in the global figures.
* **`by_zone_by_release.csv`**: `zone` = `eez` (inside any Marine Regions World EEZ v12 polygon, including
  overlapping claims and joint regimes, each cell counted once), `high_seas` (inside Marine Regions High Seas v2
  and outside every EEZ), `neither` (ocean cells in neither polygon set: areas below sea level away from the sea,
  coastal slivers), `caspian_sea_box` (the box above; included in the global figures). Zones and oceans are given
  **for every release**.
* **`cellsize_sensitivity_2026.csv`**: copied from `data/derived/sensitivity_cellsize.json`
  (`pipeline/sensitivity_cellsize.py`; GEBCO_2026 only). `variant` (`native`, `ew<s>_any`, `ew<s>_majority`),
  `block_family` (`native` = 15″ cells, `ew1/ew2/ew4` = blocks about 463 / 926 / 1853 m wide in both directions:
  s 15″ rows × k = max(1, round(s / cos φ)) columns), `block_rule` (`native`; `any` = block measured if any ocean
  cell is; `majority` = if more than half of its ocean cells are), `nominal_block_size_m`, `scope` (`global` or
  `band`), `lat_south_deg`, `lat_north_deg` (5° bands; empty for global), `ocean_area_km2`, `measured_area_km2`,
  `measured_share_fraction`, `mean_block_ew_width_m` (mean east-west width of a block in the band).
* **`by_tid_code_by_release.csv`**: per release, the area of every TID code inside the fixed mask: `release`, `tid`,
  `group`, `meaning`, `area_km2`, `share_of_ocean_fraction`. Codes 10–17 sum to `measured_area_km2`.
* **`inland_components.csv`**: one row per `inland_below_sea_level` component of at least 100 km², largest first,
  and one row for all smaller components: `rank`, `name` (assigned from the bounding box for orientation; empty
  where not identified), `lat_min_deg`, `lat_max_deg`, `lon_min_deg`, `lon_max_deg` (bounding box of the connected
  component), `ocean_area_km2` (area of its mask cells), `measured_area_2019_km2`, `measured_area_2026_km2`,
  `measured_share_2026_fraction`.
* **`tid_codes.csv`**: `tid`, `group` (`land`, `direct`, `indirect`, `unknown`), `meaning`.

Regions are burned onto the 1′ grid by cell centre (`rasterio.features.rasterize`, `all_touched=False`) from the
Marine Regions layers exactly as `pipeline/regions.py` does, then each 15″ cell takes the region of its 1′ cell. The
layers were fetched from the Marine Regions GeoServer as WMS GetMap responses in GeoJSON format, 72 tiles of
30° × 30° per layer requested at 1′ pixel size. The server clips and generalises the polygons at that pixel size
(spot check, Belgian EEZ: 4,136 → 87 vertices, maximum shift 0.43′, area −0.24 %; `docs/regions.md`). areas and measured flags are exact 15″ values. For 2026 the EEZ share is 37.961 % here vs 37.951 % in
`data/derived/regions.json` (which uses a 1′ measured fraction quantised to 1/254); the high-seas share 26.416 % vs
26.417 %. EEZ boundaries include disputed areas and have no legal value.

## Provenance

| Input | Source |
|---|---|
| `data/raw/gebco_<year>/gebco_<year>_tid.tif`, 2019–2026 | GEBCO_<year> TID grid (netCDF from CEDA, `https://dap.ceda.ac.uk/bodc/gebco/global/gebco_<year>/type_identifier_grid/netcdf/gebco_<year>_tid.zip`), converted to north-up Int8 GeoTIFF by `pipeline/history.py convert` (values unchanged; orientation checked) |
| `data/raw/gebco_2026/GEBCO_2026_15s.tif` | GEBCO_2026 elevation (ice surface), cloud-optimised GeoTIFF copy of the official grid published by the Australian Antarctic Division on Source Cooperative: `https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/ausantarctic/gebco/GEBCO_2026.tif` (page `https://source.coop/ausantarctic/gebco`; 3,286,944,666 bytes, last modified 2026-05-07). Converted from the CEDA netCDF with GDAL, overviews by average resampling (data-preparation notes at `https://github.com/AustralianAntarcticDivision/gebco`). Used at 15″ only for the connectivity behind `inland_below_sea_level`. |
| `data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif` | overview level 1 of the file above (one value per 4 × 4 15″ cells, GDAL average), extracted by `gdal_translate -ovr 1` (`pipeline/fetch_data.sh`); used for the ocean mask and the depth bins. `verify` checks that it equals overview level 1 of the local 15″ copy in every cell. At six test sites the 15″ values of the copy equal the official CEDA grid and the 1′ values are within 0.82 m of the mean of the 4 × 4 underlying 15″ cells (`pipeline/verify_mirror.py`, `data/derived/verify_mirror.json`). |
| `data/raw/regions/{goas,eez,high_seas}/*.geojson.gz` | Marine Regions GeoServer WMS GetMap GeoJSON, 72 tiles of 30° per layer at 1′ pixel size (`pipeline/regions.py`); not redistributed |

`inputs.sha256` (written by `pipeline/build_dataset.py inputs`) lists the sha256 of every one of these input files:
the eight TID GeoTIFFs, the two elevation files and the 216 Marine Regions tiles (paths relative to the repository
root). Derived intermediate files are not listed: `data/derived/history_stats.json` (`pipeline/history.py build`,
the reference values for `verify`) and `data/derived/sensitivity_cellsize.json` (`pipeline/sensitivity_cellsize.py
run`) are regenerated by the code.

GEBCO DOIs (GEBCO Compilation Group, GEBCO_<year> Grid): 2019 10.5285/836f016a-33be-6ddc-e053-6c86abc0788e;
2020 10.5285/a29c5465-b138-234d-e053-6c86abc040b9; 2021 10.5285/c6612cbe-50b3-0cff-e053-6c86abc09f8f;
2022 10.5285/e0f0bb80-ab44-2739-e053-6c86abc0289c; 2023 10.5285/f98b053b-0cbc-6c23-e053-6c86abc0af7b;
2024 10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f; 2025 10.5285/37c52e96-24ea-67ce-e063-7086abc05f29;
2026 10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa.

## Reproduce

```
.venv/bin/python pipeline/history.py fetch && .venv/bin/python pipeline/history.py convert   # TID inputs, once
pipeline/fetch_data.sh                                # 1' elevation and the 15" mirror copy
.venv/bin/python pipeline/build_dataset.py inputs        # inputs.sha256
.venv/bin/python pipeline/build_dataset.py connectivity  # components of the mask (inland_labels.npz)
.venv/bin/python pipeline/build_dataset.py build         # netCDF + summary cube (a few minutes)
.venv/bin/python pipeline/build_dataset.py tables        # CSVs (asserts the global numbers again)
.venv/bin/python pipeline/build_dataset.py verify        # netCDF -> numbers, every cell vs the sources
uvx compliance-checker==6.1.0 --test=cf:1.8 --test=acdd:1.3 dataset/build/seafloor_measured_record_2019_2026.nc \
    > dataset/build/compliance_checker.txt
.venv/bin/python pipeline/build_dataset.py checksums
.venv/bin/python -m pytest tests/test_build_dataset.py
```

Version 1.0.0 was built with `--workers 4` on a 24 GB laptop; memory use per worker was not measured.

## Verification

`verify` reads the netCDF file: it takes cell areas from `lat_bnds` / `lon_bnds`, recomputes per release the
measured area and share, the ever-measured area and share, the first-measured area (from the bitmask and,
separately, from `first_measured_release`), new and re-coded-away area vs the previous release, and the 2026
totals from `n_releases_measured`, `measured_in_2026` and `recoded_away`. It asserts each equals
`data/derived/history_stats.json` (written by `pipeline/history.py`, a separate code path with the same
definitions) within 1 km² (the JSON stores whole km²) or 1 × 10⁻⁹ (fractions), that every derived variable equals
the function of the bitmask in every cell, that no bit is set outside the ocean mask, that all cell areas add up to
the sphere, and that `inland_below_sea_level` is 0/1 inside the mask, fill outside, with the area of the
connectivity step. Because global sums cannot detect a north-south flip, it compares the bitmask and the ocean mask
**in every cell** with values recomputed from the eight source TID GeoTIFFs and the 1′ elevation (rows located
through the netCDF `lat`), and checks the 1′ elevation against overview level 1 of the 15″ copy. Finally it compares
the spherical areas with exact WGS84 ellipsoidal areas. Result of the current file: worst difference 0.49 km² and
4 × 10⁻¹⁵ (fraction); 0 disagreeing cells; all 3,732,480,000 cells equal to the sources (4,706,861,838 measured
bits); 0 of 233,280,000 1′ cells differ. Log: `build/verify.log`.

## Conventions check

IOOS `compliance-checker` 6.1.0 (`uvx compliance-checker --test=cf:1.8 --test=acdd:1.3`, report in
`build/compliance_checker.txt`): **CF-1.8: all tests passed.** ACDD-1.3: no required attribute missing; remaining
notes are "highly recommended" `standard_name` for `n_releases_measured` (no CF standard name exists for it),
"recommended" attributes that do not apply or are not set (vertical extent, time duration/resolution,
`creator_email`, `publisher_*`), that it found no time variable to test `time_coverage_*` against, and that `geospatial_lat/lon_min/max` (−90/90, −180/180)
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
* TID 44 and 70 can contain soundings (see Definitions); the 10–17 share is a lower bound on the area holding data.
* The ocean mask includes 931,885 km² below sea level that is not connected to the world ocean
  (`inland_below_sea_level`); use the `*_excluding_inland_*` columns or the flag to leave it out.
* One 15″ cell with a single sounding counts as measured; see `cellsize_sensitivity_2026.csv` for how the 2026
  share changes with ~463–1853 m equal-width blocks.
* A low share means "not in the public GEBCO grid", not necessarily "never surveyed".
