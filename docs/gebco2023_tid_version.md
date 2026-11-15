# Which GEBCO_2023 TID grid this repo uses

Checked 2026-11-16, in reply to a reviewer question: GEBCO re-issued the GEBCO_2023 Type Identifier (TID) grid after
its first release. Which copy does the mapping history (`pipeline/history.py`, `data/derived/history_stats.json`) use,
and does the choice matter?

**Answer:** the repo uses the **corrected (re-issued) TID grid**, dated 2024-02-12, which is the only copy CEDA serves
now. The original April 2023 file differs in 16.5 million 15" cells (2.80 million km² inside our ocean mask), almost all
in the Mediterranean. If that original file were used instead, the 2022→2023 outflow from measured codes would be
**5.92** million km², not 4.48, and the 2023 measured share would be **25.89 %**, not 26.27 %. The published numbers come
from the corrected file, so the re-issue does not inflate them. The original file would inflate them.

## 1. What GEBCO says about the re-issue

* GEBCO documentation shipped **inside** the current CEDA zip (`GEBCO_Grid_documentation.pdf`, 221,908 bytes, PDF
  CreationDate 2024-01-03, sha256 `65460956…ee7360`), section 2.1: *"Please note that the GEBCO_2023 Type Identifier
  (TID) Grid was updated in January 2024 to correct errors in TID coding in the North Pacific region and central
  Mediterranean Sea region."* The GEBCO_2024 documentation repeats the same sentence
  (https://www.gebco.net/sites/default/files/documents/GEBCO_grid_2024.pdf).
* GEBCO errata page (https://www.gebco.net/data-products/gridded-bathymetry-data/data-set-errata), GEBCO_2023 section:
  * Central Mediterranean: TID wrongly labelled 41 (interpolation); should be 17 (combination of direct measurements).
    The linked PDF, *error_in_gebco_2023_tid_in_the_med.pdf* (now 404 on gebco.net; Wayback copy
    https://web.archive.org/web/20240901022131/https://www.gebco.net/data_and_products/gridded_bathymetry_data/data_set_errata/documents/error_in_gebco_2023_tid_in_the_med.pdf),
    shows "Figure 2. Revised TID coding for GEBCO_2023 for the Mediterranean Sea".
  * Aleutian Islands and Bering Sea: "problems with the coding of the TID Grid … being investigated (September 2023)".
* What does **not** mention it: the standalone documentation PDF (https://www.gebco.net/sites/default/files/documents/GEBCO_2023_Grid.pdf
  = CEDA `gebco_2023/GEBCO_2023_Grid_documentation.pdf`, 199,494 bytes, sha256 `ed30febc…0f7349`, dated 2023-04-18), the
  GEBCO_2023 grid page, and the CEDA catalogue record (https://catalogue.ceda.ac.uk/uuid/c25d585d8c314cbba6faebb4f21ff4a3,
  "No news update for this record", publication date 2023-04-18). No separate version number or DOI was issued: both
  copies carry DOI 10.5285/f98b053b-0cbc-6c23-e053-6c86abc0af7b.

## 2. The two copies

| | Original (April 2023) | Re-issued (Jan/Feb 2024), used here |
|---|---|---|
| Source | BODC `https://www.bodc.ac.uk/data/open_download/gebco/gebco_2023_tid/zip/`, Wayback capture 2023-08-12 (`web.archive.org/web/20230812151420id_/…`) | CEDA `https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2023/type_identifier_grid/netcdf/gebco_2023_tid.zip` |
| HTTP headers | orig. `Last-Modified: Tue, 25 Apr 2023 14:31:55 GMT`, `Content-Length: 104042968` | `Last-Modified: Fri, 07 Feb 2025 18:06:14 GMT` (date of the CEDA move), `Content-Length: 104123496`, `ETag: "67a64b96-634cc68"` |
| zip sha256 | `460547412ab0172458387e9dc5603e87f1efd32b40de1d32c0e279c7ea1ea7bb` | `83737f8fb231d752be295b3abb24bb0da46604d99b4a505289d22a58900f99fb` |
| zip SHA-1 (base32, = Wayback digest) | `R3BZZ5T4EYMCGXHYSGLMW4G2HHB2BEFA` | `X3V4FFPW4DMUNWGAFVIXM4RKO3NVUSEB` |
| `GEBCO_2023_TID.nc` in zip | 3,733,540,412 bytes, zip time 2023-04-24 | 3,733,540,427 bytes, zip time 2024-02-12, CRC `cf32027d` |
| nc sha256 | `6f9f863d…1e699` | `98551c36…f6ff5` |
| documentation in zip | `GEBCO_2023_Grid_documentation.pdf` (199,494 B, 2023-04-18) | `GEBCO_Grid_documentation.pdf` (221,908 B, 2024-01-03, has the update note) |
| netCDF global attributes | identical, incl. `date_created = 2023-05-18` | identical |

How to tell them apart: **not** from the netCDF metadata (all attributes are identical, `date_created` was not changed).
Use the zip/nc checksum, the timestamp of `GEBCO_2023_TID.nc` inside the zip (2023-04-24 vs 2024-02-12), or the
documentation file inside the zip.

Wayback CDX for the BODC netCDF URL shows the digest `R3BZZ5T4…` on 2023-08-12 and still on 2024-02-14, and
`X3V4FFPW…` (byte-identical to today's CEDA zip) on 2024-04-08. So BODC switched its download between 2024-02-14 and
2024-04-08. CEDA's GeoTIFF zip (`gebco_2023_tid_geotiff.zip`, tiles dated 2024-02-12) is the corrected version too.
CEDA has no versioned subfolders and no copy of the original under `gebco_2023/`.

**The repo's file is the corrected one.** I converted the current CEDA zip with the same `gdal_translate` call as
`pipeline/history.py convert`. The GeoTIFF it produces is byte-identical to `data/raw/gebco_2023/gebco_2023_tid.tif`
(sha256 `db45124abf408484fb953e88c1bdf3dfe3d6e23f6052ecc5a1bd50767109eef0`, 86,628,777 bytes), and
`gebco_2023_tid_meta.json` matches. The repo fetched it on 2026-11-15, long after the switch.

## 3. Cell-by-cell difference (original → corrected)

16,542,538 cells differ (2,814,556 km²); 16,478,255 of them (2,804,267 km²) lie inside the history ocean mask. Areas
are exact spherical 15" cells, R = 6371.0072 km.

| Region (bbox of differing cells) | Cells | Main changes, original → corrected (ocean km²) | Measured area, corrected − original |
|---|---|---|---|
| Mediterranean, 28.65–46.00° N, 5.47° W–37.00° E | 14,673,263 | 41→17: 1,456,517; 41→70: 1,002,175; 40→70: 42,547 | **+1,454,057 km²** |
| Black Sea, 40.30–47.00° N, 27.00–41.78° E | 95,960 | 41→70, 41↔17, 0→41 (a few thousand km² each) | +221 km² |
| SW Atlantic off Brazil, 24.14–18.00° S, 42–36° W | 906,467 | 17 split into 11 (55,431), 42 (37,191), 12 (36,478), 70 (31,345), 10 (20,514) | **−68,479 km²** |
| Aleutians / Gulf of Alaska, 47–60° N, 180–121.9° W | 741,877 | 13→10 (45,092), 11→17 (28,486), 15/14→11 | +921 km² |
| Aleutians / Bering, 47.0–60° N, 167.5–180° E | 200,757 | 11→17 (16,058), 14→11 (5,007), 13→41/17/10 | −1,273 km² |
| Inland basins (Chott Melrhir area), 33.58–34.69° N, 5.84–8.75° E | 49,594 | 40→70 (8,592) | 0 |
| Kurils / Okhotsk, Bay of Biscay, other specks | < 1,000 | — | < ±100 km² |

The Mediterranean fix (interpolation code 41 → measured 17 or pre-generated grid 70) is almost the whole effect. The
North Pacific fix mostly moves cells between measured codes (13→10, 11→17), so it barely changes the measured area.
The Brazilian margin change is **not** listed in GEBCO's note or errata: there, the corrected file replaces part of
"17, combination" with specific codes, and 68,479 km² of that goes to non-measured codes 42 and 70.

## 4. Effect on the history numbers

Same method as `pipeline/history.py build`: ocean mask = GEBCO_2026 TID ≠ 0 and GEBCO_2026 1' elevation < 0
(361,694,058 km²); measured = TID 10–17. My re-implementation run on the repo's file reproduces `history_stats.json`
exactly (2023 measured 95,023,637 km², new 7,827,094, no-longer-measured 4,477,876, first-measured 6,811,398; 2024 new
10,004,202 / lost 1,801,568).

| Quantity | Corrected file (published) | Original file | Difference |
|---|---|---|---|
| 2023 measured area | 95.02 M km² (**26.27 %**) | 93.64 M km² (**25.89 %**) | −1.39 M km² (−0.38 pp) |
| 2023 measured, own mask | 26.29 % | 25.90 % | −0.38 pp |
| Ours − official (24.9 %) | +1.37 pp | +0.99 pp | |
| 2022→2023 new | 7.83 M km² | 7.89 M km² | +0.06 |
| 2022→2023 no longer measured | **4.48 M km²** | **5.92 M km²** | +1.45 (of which code 41: 0.93 → 2.39) |
| Measured in 2023 or earlier | 28.70 % | 28.71 % | +55,711 km² |
| 2023→2024 new / lost | 10.00 / 1.80 M km² | 11.45 / 1.87 M km² | +1.45 / +0.06 |

With the original file, 2023 would show 1.45 million km² of Mediterranean "measured → interpolated" loss, followed
by the same area "re-gained" in 2024. That is an artefact of the coding error, not of the data. The corrected file
removes it. Our 2023 re-coding statement (2.03 of 4.48 million km² at 30–60° S) is unaffected: all the changed
regions lie north of 25° S. Years other than 2023 and 2024 do not change, except that the 2026 "ever measured"
total could rise by at most ~52,000 km² (Brazil cells coded 17 only in the original 2023 file).

**Conclusion:** we used the corrected GEBCO_2023 TID grid, the version GEBCO and CEDA distribute today. The
published 2023 figures (26.27 %, 4.48 million km² re-coded) are the corrected-file values. I edited no history
outputs.

## Reproduce

```
curl -L -o orig.zip 'https://web.archive.org/web/20230812151420id_/https://www.bodc.ac.uk/data/open_download/gebco/gebco_2023_tid/zip/'
curl -L -o ceda.zip 'https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2023/type_identifier_grid/netcdf/gebco_2023_tid.zip?download=1'
# unzip GEBCO_2023_TID.nc from each, then the same gdal_translate call as pipeline/history.py convert();
# compare the two GeoTIFFs band by band against the GEBCO_2026 ocean mask.
```

Not verified: GEBCO gives no separate change log for the re-issue, so the Brazilian-margin change is known only from
the comparison above. I did not find an announcement that dates the BODC switch more precisely than the Wayback
captures (2024-02-14 old, 2024-04-08 new).
