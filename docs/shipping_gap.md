# Unmeasured seafloor under ship traffic

Question: crowdsourced bathymetry (IHO CSB) logs depths from the echo sounders of ordinary vessels. How much of the
seafloor not coded as measured in GEBCO_2026 lies under recorded ship tracks or heavy traffic, how much of it is
shallow, and is it inside EEZs or on the high seas? Produced by `pipeline/shipping_gap.py`; numbers in
`data/derived/shipping_gap.json` and `data/derived/shipping_unit_check.json`; figure `figures/fig_shipping_gap.png`.

## The unit of the shipping raster (corrected)

Source: World Bank Data Catalog dataset 0037580, "Global Shipping Traffic Density" (IMF World Seaborne Trade
Monitoring System; Cerdeiro et al. 2020; CC BY 4.0), `shipdensity_global.tif`, Int32, 0.005°, Jan 2015 – Feb 2021,
all vessel types. The catalogue page and the readme inside the zip say the layers "were created using IMF's analysis
of hourly AIS positions" and "represent the total number of AIS positions that have been reported by ships in each
grid cell". **The values are not counts of positions:**

1. **Total.** The raster sums to **6.560 × 10¹⁴** (source statistics: mean 267,984.24 over 2,448,059,988 cells;
   our 0.02° block sums give the same total, relative difference 1.2 × 10⁻¹¹, so the aggregation in
   `pipeline/shipping.py` is a plain sum and is not the cause). The IMF AIS set behind it holds "over one billion
   messages from over 50,000 distinct ships", down-sampled to hourly (Cerdeiro et al. 2020, section II), i.e.
   ~10⁹. The raster total is **~6.6 × 10⁵ times** that.
2. **Single ships.** In seven remote 5° × 5° boxes (South Pacific, South Atlantic, South Indian, Southern Ocean),
   lone ships leave isolated 0.005° cells spaced like hourly fixes (one track: 13 cells ~13 km apart, ~7 kn), each
   carrying **10²–10^6.6** instead of 1. Over 6,716 isolated track cells, log10 value percentiles 5/25/50/75/95 =
   3.92 / 4.98 / **5.35** / 6.13 / 6.56. The value drifts smoothly along a track (e.g. 9,936 → 9,763) and the box medians range
   from 10^4.53 to 10^6.51.
3. **Two populations.** Non-zero cells in those boxes are either a diffuse background of 1–9 (126,626 of
   133,835 cells, not arranged along tracks) or track values ≥ 100 (7,208 cells); between 10 and 99 there is 1 cell.

So every recorded position carries an undocumented weight spanning about four orders of magnitude. The absolute
unit cannot be recovered from the published documentation (the IMF paper describes the AIS data and the port
detection, not the density raster). The raster is used here only as a **relative intensity**, in raster units:
density = 0.02° block sum / cell area / (74/12 yr), "raster value per km² per year". The docstrings of
`pipeline/shipping.py` and `pipeline/shipping_gap.py`, the `units` string written to `legend.json` by
`pipeline/shipping.py`, and `docs/data-contract.md` were corrected accordingly.

## Classes (two-mode approach kept, relabelled)

At 0.02° the background and the track values stay apart: 131.5 M km² of ocean have density < 1, 1.2 M km² have
1–100 (of which only 0.07 M km² have 10–100), and 82.8 M km² have ≥ 100. The split at 100 is therefore real, but its
meaning changes with the unit finding: one isolated position of median weight in a ~4 km² cell already gives
~8,500. Hence

* **track** = density ≥ 10² = at least one recorded vessel position (track value) in the 0.02° cell in six years.
  This is *not* "dense traffic" (the earlier label).
* intensity classes 10²–10⁴, 10⁴–10⁵, 10⁵–10⁶, ≥ 10⁶. At the median weight they correspond very roughly to < 1,
  ~1, ~10 and ≥ ~100 position-equivalents per 0.02° cell in six years; the 5–95 % range of the weight is a factor
  ~20 either way, so they are named by raster value, not by vessel numbers.
* **heavy** = density ≥ 10⁶, the busiest **5.5 %** of the world ocean (19.9 M km²).

## Numbers (world ocean without inland basins, 85° N – 85° S; GEBCO_2026 TID 10–17 = measured)

World ocean 360.76 M km²; unmeasured 248.55 M km²; 0.97 M km² lies outside the shipping grid (> 85°).

| | unmeasured area (M km²) | share of all unmeasured | of which 0–200 m | in EEZs | on high seas |
|---|---|---|---|---|---|
| any value (incl. background) | 139.1 | 56.0 % | | | |
| under a recorded track (≥ 10²) | **48.99** | **19.7 %** | 14.9 % (7.30 M km²) | 57.1 % | 42.9 % |
| under heavy traffic (≥ 10⁶) | **9.53** | **3.8 %** | 30.2 % (2.88 M km²) | 76.6 % | 23.4 % |

By depth (share of the unmeasured area of that depth band):

| Depth | unmeasured (M km²) | measured share | under a track | under heavy traffic |
|---|---|---|---|---|
| 0–200 m | 17.40 | 31.5 % | 42.0 % | 16.5 % |
| 200–1,000 m | 9.46 | 38.9 % | 29.4 % | 10.7 % |
| 1,000–3,000 m | 27.15 | 41.8 % | 28.7 % | 7.5 % |
| > 3,000 m | 194.55 | 28.5 % | 16.0 % | 1.9 % |

By zone: EEZs have 86.37 M km² unmeasured, 32.4 % of it under a track and 8.5 % under heavy traffic; the high seas
have 162.05 M km² unmeasured, 13.0 % under a track and 1.4 % under heavy traffic.

Measured share by traffic class (is busy seafloor better mapped?): no value 24.2 %, background only 32.1 %,
10²–10⁴ 34.5 %, 10⁴–10⁵ 36.4 %, 10⁵–10⁶ 38.2 %, ≥ 10⁶ **52.1 %**. Measured share rises with traffic, but even under
the heaviest traffic about half of the seafloor is not coded as measured.

Largest blocks of unmeasured seafloor under heavy traffic (10° × 10° boxes): 30–40° N 120–130° E (East China and
Yellow Seas) 0.44 M km², 0.40 M km² of it shallower than 200 m; 20–30° N 120–130° E 0.24 M km²; Caribbean 10–20° N
80–70° W 0.23 M km² (only 0.01 M km² shallow); Black Sea 40–50° N 30–40° E 0.22 M km². Full list in
`shipping_gap.json` `top_boxes_heavy`.

### What changed against the first (uncommitted) version

The areas at each threshold are unchanged (the thresholds were applied to the same raster), but the first version
called density ≥ 100 "dense traffic" and gave 49.0 M km² (19.7 %) as the unmeasured area "under dense traffic".
That class is "any recorded track". Under the heaviest-traffic class it is 9.5 M km² (3.8 %). The ≥ 100 share of
0–200 m (42 %) and the EEZ / high-seas split (57 / 43 %) likewise describe recorded tracks, not dense traffic.

## Caveats

* The traffic weight is undocumented and varies by orders of magnitude between positions; class edges are ranks of
  an intensity index, not vessel counts. Results at 10⁴–10⁶ can move if the weight varies regionally; in the map
  some edges look rectangular (e.g. North Atlantic around 45–60° N), which may be processing artefacts in the
  source — not investigated.
* "Unmeasured" is the GEBCO_2026 TID coding at 15″, not the absence of soundings; vessels may already have logged
  depths that are not in GEBCO.
* A navigational echo sounder reaches only the shallow classes; the 0–200 m column is the relevant one for CSB.
* Each 1′ cell takes the density of the 0.02° cell under its centre (no interpolation); 1′ depth class from the
  GEBCO_2026 1′ elevation.
* AIS coverage (satellite reception, pre-2017 gaps) and the 2015–2021 period are inherited from the source.

## Sources

* World Bank (2021). Global Shipping Traffic Density, dataset 0037580, CC BY 4.0.
  https://datacatalog.worldbank.org/search/dataset/0037580 (unit text checked 2026-11-17; the readme inside
  `shipdensity_global.zip` carries the same text).
* Cerdeiro, D. A., Komaromi, A., Liu, Y. and Saeed, M. (2020). World Seaborne Trade in Real Time: A Proof of Concept
  for Building AIS-based Nowcasts from Scratch. IMF Working Paper WP/20/57. https://doi.org/10.5089/9781513544106.001
* GEBCO Compilation Group (2026). GEBCO_2026 Grid. https://doi.org/10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa
* EEZ / ocean regions: `dataset/build/regions_1arcmin.npy` (sources in `dataset/build/regions_labels.json`).
