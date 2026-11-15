# EarthArXiv submission checklist

Requirements were read on 2026-11-15 from:

* the EarthArXiv Moderation and Terms of Use, version 2.9 of 13 October 2025: https://eartharxiv.github.io/moderation.html
* the FAQ: https://eartharxiv.github.io/faq.html
* the About page: https://eartharxiv.org/repository/about/

Quotes are from those pages. Nothing has been submitted.

## Required by the moderation policy

| # | Requirement (quote) | Status in this draft | To do |
|---|---|---|---|
| 1 | "Please submit your paper in PDF format." "All material must be included in ONE PDF." | Not built: pandoc and LaTeX are not installed on this machine (`build.sh` exits 2) | `brew install pandoc` plus `brew install --cask basictex` (or `brew install tectonic`), then `docs/paper/build.sh`; check the PDF by eye |
| 2 | "The paper must be written in English" | Yes | – |
| 3 | "Your paper contains a title, abstract, author names, and affiliations." | Yes (affiliation: Independent researcher) | – |
| 4 | ORCID: "a full URL link to their ORCID account on the coversheet or at the top of the first page" | Placeholder `https://orcid.org/[ORCID TO ADD]` | Insert the ORCID iD |
| 5 | The ORCID profile must include "educational history and current or recent work affiliations" | Unknown | Check the ORCID profile has education and an employment entry. "Independent researcher" may need to be added as an employment entry |
| 6 | "ORCID email address must match the submittors email address" | Unknown | Submit with the same email that is on ORCID |
| 7 | "At least one author must supply an email address for correspondence." | Placeholder `[EMAIL TO ADD]` | Add an email address (the same as on ORCID) |
| 8 | State that it is "a non-peer reviewed preprint submitted to EarthArXiv": option 1 a cover sheet, option 2 "a header on each page" | Both: a status line on page 1, and a running header on every page (`fancyhdr` in the YAML header) | Check that the header appears in the built PDF |
| 9 | "all authors listed on the paper must appear in the metadata"; "at least one keyword must be selected" | Keywords in the manuscript | Enter author and keywords in the submission form |
| 10 | Must be "uploaded by one of the authors listed on the manuscript" | – | Submit from the author's own account |
| 11 | Must cite "established scientific literature" | Yes: Mayer et al. 2018, Charette & Smith 2010, Tozer et al. 2019, Smith & Sandwell 1997, Wölfl et al. 2019, Weatherall et al. 2015, Jakobsson et al. 2020, Dorschel et al. 2022, Moritz 2000, Simpson & Heydorn 1965, Bergstad et al. 2019 | – |
| 12 | Not a commentary, opinion piece, poster or thesis | Research article | – |
| 13 | "Do not submit additional PDFs with supplemental material." Supplements belong in external repositories (GitHub, Zenodo, FigShare) | Code and data on GitHub and Zenodo; no supplement PDF | – |
| 14 | Scope: "of interest to the Earth and Planetary Science community" | Bathymetry / ocean mapping | – |

## Licence

The moderation page and the FAQ do not list the licence options. The only licence they state is CC BY 2.0, for the website itself. Six recent preprints checked on 2026-11-15 (eartharxiv.org/repository/view/16079, 16080, 16081, 16083, 16086, 16088) all show "CC BY Attribution 4.0 International". Whether other licences can be chosen in the submission form was **not verified**.

* Plan: CC BY 4.0.
* All eight figures are CC BY 4.0-compatible:
  * fig2, fig3, fig5 and fig13 are derived only from GEBCO grids. The GEBCO terms of use make them public domain with attribution required; CEDA lists OGL v3 for 2025–2026.
  * fig6, fig7, fig8 and fig9 also use CC BY 4.0 data: Marine Regions, AUST_2026_BAT, SO-ABBA and Hotham 2026.
* Excluded: fig10 (CC BY-NC 4.0, OBIS speciesgrids / AquaMaps) and every figure or screenshot with cable data (TeleGeography, CC BY-NC-SA 3.0; OSM, ODbL). fig1, fig4, fig11 and fig12 are not used.
* To verify: that OGL v3 is accepted as compatible with CC BY 4.0. OGL v3 was designed to be, but this was not re-checked here.

## Not covered by EarthArXiv policy, but in the manuscript

* AI-use statement: present ("Use of AI tools"). EarthArXiv has no stated AI policy (moderation page and FAQ, 2026-11-15). Fill in the model versions and dates.
* Competing interests: "none" stated.
* Data and code availability: GitHub, Zenodo concept DOI 10.5281/zenodo.24228190, live site, Hugging Face tiles.
* CRediT: single author. Confirm the roles.

## Before submitting

1. **Archive a new Zenodo version.** v1.0.0 (doi:10.5281/zenodo.24228191, tag `v1.0.0` = commit b38084d) does **not** contain `pipeline/history.py` (added in 74efd44) or `docs/paper/`. Cite the new version DOI in "Data and code availability".
2. Resolve every `[VERIFY]`, `[AUTHOR: ...]`, `[ORCID TO ADD]` and `[EMAIL TO ADD]` in `manuscript.md` and `references.bib` (`grep -n -E "VERIFY|AUTHOR|TO ADD" docs/paper/*`).
3. Vema Seamount: the manuscript cites ~21.5 m and 26 m from secondary sources. `docs/data-contract.md` says "about 25 m". Read Bergstad et al. 2019 (p. 15) and Simpson & Heydorn 1965 and make the two consistent.
4. Confirm that both data issues were reported (date and channel), or remove the sentence.
5. Build the PDF and check that:
   * Figure and Table numbers match the text (pandoc numbers floats in source order; the text assumes Figure 1 = fig13, 2 = fig2, 3 = fig3, 4 = fig6, 5 = fig5, 6 = fig9, 7 = fig7, 8 = fig8);
   * the running header is present;
   * Unicode symbols render (″ ′ ≥ − ×).
6. Optional: run the reproducibility checks again (`.venv/bin/python pipeline/history.py check`, `pytest tests`). They were not run for this draft.
