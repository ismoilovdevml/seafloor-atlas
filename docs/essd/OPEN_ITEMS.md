# Open items before ESSD submission

Status on 2026-11-16. Nothing has been submitted, uploaded or deposited.

## Blocking

1. **Dataset DOI.** `\datasetdoi` in `manuscript.tex` is `10.5281/zenodo.XXXXXXX`. Deposit dataset version 1.0.0 on
   Zenodo (netCDF `dataset/build/seafloor_measured_record_2019_2026.nc`, `dataset/tables/*.csv`, `dataset/README.md`,
   `inputs.sha256`, `checksums.sha256`), licence CC BY 4.0, then replace the macro. ESSD requires the DOI in the
   abstract and in the data availability section; both use the macro.
2. **Code DOI.** `\codedoi` is `10.5281/zenodo.XXXXXXX`. The existing code archive (concept DOI
   10.5281/zenodo.24228190; version 1.2.0 = 10.5281/zenodo.24260821) does not contain `pipeline/build_dataset.py` or
   `docs/essd/figures.py`. Make a new GitHub release that includes both, let Zenodo archive it, and put that version
   DOI in `\codedoi`.
3. **Rebuild and re-check after the DOIs exist:** `.venv/bin/python docs/essd/figures.py && docs/essd/build.sh`, then
   `python3 -I ~/.claude/skills/preprint-submission/scripts/check_preprint_pdf.py docs/essd/manuscript.pdf --journal "Earth System Science Data" --orcid 0009-0008-2785-3691`.
   The checker now BLOCKs on `zenodo.XXXXXXX` (fixed 2026-11-16). Also check by hand:
   `pdftotext docs/essd/manuscript.pdf - | grep XXXX` must print nothing.
4. **Independent review** of the final text (verifier agent or a fresh reader) before upload, per the
   preprint-submission skill, gate item 1.

## Not blocking, decide before submission

5. **ACDD metadata.** `creator_email` and `publisher_*` are not set in the netCDF file (compliance checker,
   "recommended"). The manuscript says so in Known issues. If the file is rebuilt before deposit, set them and remove
   that bullet.
6. **ORCID placement.** The Copernicus class has no ORCID field; the ORCID URL is in the affiliation line so that it
   is on page 1. Copernicus collects ORCIDs in the submission form; the typesetters may move or drop it.
7. **Status line on page 1.** The journal manuscript carries no "non-peer reviewed preprint" statement and does not
   print the journal name (the class's manuscript header is empty). The preprint checker flags both. ESSD posts the
   submitted manuscript itself as a discussion preprint, so no statement is added here. If the PDF is ever mirrored
   on a preprint server, add a cover sheet with the status statement and the ESSD submission date.
8. **GEBCO author string.** The GEBCO grid references use "GEBCO Compilation Group" (GEBCO's recommended citation);
   the DataCite creator is "GEBCO Bathymetric Compilation Group YYYY". Keep or switch, but be consistent with the
   dataset README.
9. **Niyazi et al. (2025)**: full text re-read on 2026-11-16 (frontiersin.org article XML): TID 1-17 mapped,
   Mollweide ESRI:54009, nearest-neighbour resampling, GOaS v1 basins, EEZ v12 by first-level sovereign, coastline =
   GEBCO_2024 zero depth. Their supplementary file (`Table1.docx`, with the per-year Table S3) could not be
   downloaded (publisher file URLs returned 404), so the paper compares only values stated in their text (Table 4).
   If the supplement becomes available, compare all years 2019-2024.
10. **Short summary** (`short_summary.txt`, 437 characters) goes into the submission form, not the PDF.
11. **Commit and push** of `docs/essd/` was not done (not requested).
12. **Names in `dataset/tables/inland_components.csv`** were assigned from bounding boxes by the AI assistant
    (`INLAND_NAMES` in `pipeline/build_dataset.py`); several were not checked against a gazetteer (e.g. Aftout es
    Saheli, Sabkhat Ghuzayyil, Lower Yenisei, Lac Saint-Jean). Check the named rows on a map before deposit, or drop
    the `name` column.
13. **15" elevation copy.** `data/raw/gebco_2026/GEBCO_2026_15s.tif` has the size of the Source Cooperative object
    (3,286,944,666 bytes) and its overview 1 equals the 1' file in every cell, but it was not compared byte-for-byte
    with the S3 object (multipart ETag). Its sha256 is in `dataset/inputs.sha256`.
14. **Code release** must contain the 2026-11-16 changes to `pipeline/build_dataset.py` (connectivity, full-grid
    verify, inputs step), `pipeline/fetch_data.sh`, `tests/test_build_dataset.py` and `docs/essd/figures.py`.

## Copernicus reference check (manuscript version 1, report of 18 Nov 2026)

Three references were flagged; all three are fixed in the source for the next file upload (not needed before the
editorial decision, per the editorial office):
- Ref. 1 `aad2026gebcocog`: URL now points at the object page `source.coop/ausantarctic/gebco/GEBCO_2026.tif`
  (HTTP 200; object 3,286,944,666 bytes, last modified 7 May 2026, checked 18 Nov 2026).
- Ref. 5 `news2019`: the page exists (HTTP 200); the check failed because the PDF typeset "fl"/"fi" in the URL as
  ligature glyphs. URLs are now set with `\urlstyle{tt}` + `xurl`; no URL in the PDF text contains a ligature.
  Title corrected to the page title ("... definitive global map").
- Ref. 10 `gebcodoc2026`: now cites the GEBCO_2026 grid DOI it ships with and the GEBCO_2026 grid page URL.
All other references from 2010 on already carry DOIs; the GEBCO and Nippon Foundation news items have no DOI and keep
their (checked, HTTP 200) URLs.
