// What is drawn on the globe (split from main.ts): the relief ramp (sea level, under-layer, satellite land, polar caps),
// the seafloor layer switches, human-activity overlays, depth certainty, marine life, earthquakes / seamounts /
// phytoplankton / winds / currents (loaded on first use), the AMOC line, the legend texts and credits, and the layer
// tokens the hash and the tour use.
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { FEATURE_LAYERS } from './style';
import { BATHY_STOPS, LAND_STOPS, PLATE_STYLE, seaLevelStops, UNDERLAY_STOPS } from './palette';
import { OverlayUI } from './overlay-ui';
import { CERTAINTY_IDS, CERTAINTY_LAYERS, RasterProbe, SEAL_STOPS, certaintyRasterLayers, certaintySources, loadSeals, sealLayers,
  type CertaintyId, type DisagreeLegend, type UncertaintyLegend } from './certainty';
import { MarineUI } from './marine-ui';
import { ATTRIBUTION, hashWithLayers, layersFromHash, layersToken, type LayerState } from './overlays';
import type { EventsUI } from './events-ui';
import type { OceanUI } from './ocean-ui';
import { amocCard, type AmocData } from './amoc';
import { PolarLayer, type PolarMeta } from './polar-layer';
import { SAT_ATTRIBUTION, clearLand, hashWithLand, iceLand, initialSatLand, rampExpression, satLandFromHash, satSource, storeSatLand, storedSatLand } from './basemap';
import { $, dataBase, getJSON, localStore, map, meta, rasterTileSize, synthetic, tilesBase } from './app-state';
import { showCard } from './cards-ui';
import { lastPoint, renderExtra } from './inspector-ui';
import { amocHit, hitBox } from './click-router';
import { closeSea, markSeaPainted, offerTime, seaLevel, seaOpen, timeUI, updateTimeDot, water } from './tools-ui';
import { updateLayersBadge, updatePadding } from './layout-ui';

// the real relief of both polar caps beyond the Mercator tiles' 85.05 degrees (polar-layer.ts, pipeline/polar.py)
export let polarLayer: PolarLayer | null = null;
/** polar.json once loaded: the inspector's cell size poleward of inspect.RATED_TO_LAT is the polar grid's pixel. */
export let polarMeta: PolarMeta | null = null;
// satellite land (basemap.ts): Esri imagery under the relief, whose land colours turn transparent; #land=grey = off.
// The relief ramp depends on it, on the sea level and on the ocean-water under-layer.
// The visitor's choice is remembered (localStorage); a land= part in the hash wins over it.
export let satLand = true;
/** Who needs the relief's neutral under-layer now: ocean water and phytoplankton each switch their own part. */
const underlayBy = new Set<'water' | 'chl'>();
/** The AMOC record once loaded (the map's click handler reads it). */
export let amocLast: AmocData | null = null;
export function initPolarAndLand() {
  satLand = initialSatLand(location.hash, storedSatLand(localStore()));
  if (!synthetic) {
    void getJSON<PolarMeta>(`${tilesBase}/polar/polar.json`).then((pm) => {
      if (!pm) return;
      polarMeta = pm;
      polarLayer = new PolarLayer(`${tilesBase}/polar/`, pm, reliefStops().polar);
      // right above the shaded relief: overlays (veil, coverage, age, ...) still draw over the disc between 83 and 85 degrees.
      // (Tried 2026-11-24: right above the relief ramp, so the colour fields under the hillshade draw over the disc too.
      // Rejected: the map's hillshade then draws over the disc and shows a dark seam along 85.05 degrees in every Arctic
      // view, worse than the 83.05-85.05 degree gap under marine life / water / phytoplankton. Either position makes
      // two render-to-texture stacks; only a renderToTerrainTile implementation in polar-layer.ts would avoid that.)
      const ids = map.getStyle().layers.map((l) => l.id);
      map.addLayer(polarLayer, ids[ids.indexOf('hillshade') + 1]);
    });
  }
}

// ---------- layer toggles ----------
// Each layer is a compact row in the Layers drawer (switch, name, (i) for a short note); what is on the map gets a
// section in the legend dock. The row's `on` class and the legend section follow the map layer.
export function setVisible(layer: string | string[], on: boolean) {
  for (const id of ([] as string[]).concat(layer)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
// ---------- satellite land (basemap.ts) ----------
/** The relief ramp for the current state: map stops (land clear when satellite land is on) and polar-cap stops. */
// A sea level other than today's always wins over the under-layer: the slider must never be dead (opening Sea
// level also switches the colour fields off, see openSea; this covers the Time panel's sea level as well).
const underlayActive = () => underlayBy.size > 0 && seaLevel === 0;
export function reliefStops(): { map: [number, string][]; polar: [number, string][] } {
  const under = underlayActive();
  const stops = under ? [...UNDERLAY_STOPS, ...LAND_STOPS] : seaLevelStops(seaLevel);
  const landFrom = under ? 0 : Math.max(0, Math.round(seaLevel));
  return satLand ? { map: clearLand(stops, landFrom), polar: iceLand(stops, landFrom) } : { map: stops, polar: stops };
}
export function paintRelief() {
  const r = reliefStops();
  map.setPaintProperty('relief', 'color-relief-color', rampExpression(r.map) as never);
  polarLayer?.setStops(r.polar);
  // the depth ramp legend does not describe the neutral under-layer (only written on a change: a legend observer
  // re-lays out the page on every write of the attribute)
  const dl = document.getElementById('depth-legend');
  if (dl && dl.hidden !== underlayActive()) dl.hidden = underlayActive();
}
export function setSatLand(on: boolean, writeHash = true) {
  satLand = on;
  if (on && !map.getSource('sat')) {
    map.addSource('sat', satSource());
    map.addLayer({ id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 0 } }, 'relief');
  }
  if (map.getLayer('sat')) setVisible('sat', on);
  paintRelief();
  $<HTMLInputElement>('t-satland').checked = on;
  $('row-satland').classList.toggle('on', on);
  $('map-att').hidden = !on;
  if (writeHash) {
    storeSatLand(localStore(), on); // a visitor's own switch is remembered; a hash change is not
    const h = hashWithLand(location.hash, on);
    if (h !== location.hash) history.replaceState(null, '', h || location.pathname + location.search);
    requestAnimationFrame(() => updatePadding()); // the readout grows or shrinks by the attribution line
  }
}
/** The relief's neutral under-layer while a colour field (ocean water, phytoplankton) is on; each owns its part. */
export function setUnderlay(by: 'water' | 'chl', on: boolean) {
  if (on) underlayBy.add(by); else underlayBy.delete(by);
  paintRelief(); // also shows or hides the depth ramp legend
  markSeaPainted();
}
export function initSatLand() {
  $('map-att').textContent = SAT_ATTRIBUTION;
  $('map-att').title = SAT_ATTRIBUTION;
  $('map-att').addEventListener('click', () => $('map-att').classList.toggle('open'));
  $<HTMLInputElement>('t-satland').addEventListener('change', (e) => setSatLand((e.target as HTMLInputElement).checked));
  setSatLand(satLand, false);
  // a remembered "grey" goes into the address too, so the hash and the map agree (hashchange compares the two)
  if (!satLand && satLandFromHash(location.hash)) history.replaceState(null, '', hashWithLand(location.hash, false));
}

export let tVeil: HTMLInputElement, tPlates: HTMLInputElement, tFeatures: HTMLInputElement, tNew: HTMLInputElement;
let change: typeof meta.change2025to2026;
export function rowState(row: string, legend: string | null, on: boolean) {
  $(row).classList.toggle('on', on);
  if (legend) $(legend).hidden = !on;
}
export function setVeil(on: boolean) { tVeil.checked = on; setVisible('veil', on); rowState('row-veil', 'lg-veil', on); if (on) $('story-veil').hidden = true; }
let platesP: Promise<unknown> | null = null;
export function setPlates(on: boolean) {
  tPlates.checked = on; setVisible('plates', on); rowState('row-plates', 'lg-plates', on);
  // plates.geojson (~4 MB) is fetched only the first time the layer is switched on
  if (on && !platesP) {
    platesP = getJSON<GeoJSON.FeatureCollection>(`${dataBase}/plates.geojson`).then((fc) => {
      if (fc) (map.getSource('plates') as GeoJSONSource).setData(fc); else platesP = null;
    });
  }
}
export function setFeatures(on: boolean) { tFeatures.checked = on; setVisible(FEATURE_LAYERS, on); rowState('row-features', null, on); }
export function setNew(on: boolean) { tNew.checked = on; setVisible('new2026', on); rowState('new-layer', 'lg-new', on); }
const pct1 = (f: number) => `${(100 * f).toFixed(1)}%`;
const mkm1 = (km2: number) => (km2 / 1e6).toFixed(1);
export function initSeafloorLayers() {
  tVeil = $<HTMLInputElement>('t-veil'); tPlates = $<HTMLInputElement>('t-plates'); tFeatures = $<HTMLInputElement>('t-features');
  tVeil.addEventListener('change', () => setVeil(tVeil.checked));
  tPlates.addEventListener('change', () => setPlates(tPlates.checked));
  tFeatures.addEventListener('change', () => setFeatures(tFeatures.checked));
  // newly measured between the GEBCO_2025 and GEBCO_2026 grids (pipeline/change.py); hidden if not built
  tNew = $<HTMLInputElement>('t-new');
  change = meta.change2025to2026;
  tNew.addEventListener('change', () => setNew(tNew.checked));
  if (change && (meta.tiles?.new2026 ?? 0) > 0) {
    $('new-stat').innerHTML = `<strong>${mkm1(change.newly_measured_km2)} million km²</strong> newly counted as measured; the measured share went from ${pct1(change.measured_2025_frac)} to ${pct1(change.measured_2026_frac)}.`;
  } else {
    $('new-layer').hidden = true;
  }
  setPlates(false);
}

// human-activity overlays (cables, shipping, wrecks, platforms, pipelines, wind); off by default, #layers= deep link
// Modules loaded on first use (main.ts imports them dynamically, so the first page load does not grow):
// earthquakes + seamounts, phytoplankton + winds + currents, the Time panel and the mapping-history layer.
export let eventsUI: EventsUI | null = null;
export let oceanUI: OceanUI | null = null;
// new layers outside "Human activity" (earthquakes, seamounts, phytoplankton, winds, currents) share the list
export function extraTokens(): string[] {
  const t: string[] = [];
  if (eventsUI?.quakesOn) t.push(eventsUI.quakeMode === 'live' ? 'quakes-live' : 'quakes');
  if (eventsUI?.seamountsOn) t.push('seamounts');
  if (oceanUI?.chlOn) t.push('chl');
  if (oceanUI?.flow) t.push(oceanUI.flow === 'wind' ? 'winds' : 'currents');
  if ($<HTMLInputElement>('t-amoc').checked) t.push('amoc');
  return t;
}
export function writeLayersHash(st: LayerState = overlays.state) {
  const h = hashWithLayers(location.hash, { ...st, extra: extraTokens() });
  if (h !== location.hash && !(h === '' && location.hash === '')) history.replaceState(null, '', h || location.pathname + location.search);
}
let prevOverlays = new Set<string>();
export let overlays: OverlayUI;
export function initOverlays() {
  overlays = new OverlayUI({ map, dataBase, shippingLegend: 'tiles/shipping/legend.json', onChange: (st) => {
    writeLayersHash(st);
    // a time-aware overlay just went on: the Time panel offers itself once
    for (const id of ['cables', 'wind'] as const) if (st.ids.includes(id) && !prevOverlays.has(id)) offerTime(id);
    prevOverlays = new Set(st.ids);
    layersChanged();
  } });
}

export const ATTRIBUTION_SEALS = 'Seal dives: SO-ABBA v1.0 (Hindell, McMahon, Jonsen et al. 2026, doi:10.5281/zenodo.19121676), CC BY 4.0; compared with GEBCO 2026';
// ---------- how sure is the depth? (model disagreement, prediction confidence, seal soundings) ----------
// real tiles only; each switch shows its layer and legend section, the readout adds the value under the cursor
let tilesUrl: string;
export let disagreeLg: DisagreeLegend | null = null, uncertaintyLg: UncertaintyLegend | null = null;
export let certaintyOk: Record<CertaintyId, boolean>;
export let probes: { disagree: RasterProbe; uncertainty: RasterProbe };
export const certaintyOn = new Set<CertaintyId>();
let sealsLoaded: Promise<unknown> | null = null;
export async function setCertainty(id: CertaintyId, on: boolean) {
  if (!certaintyOk[id]) return;
  $<HTMLInputElement>(`t-${id}`).checked = on;
  if (on) certaintyOn.add(id); else certaintyOn.delete(id);
  rowState(`row-${id}`, `lg-${id}`, on);
  if (id === 'seals' && on && !sealsLoaded) {
    $('row-seals').setAttribute('aria-busy', 'true');
    sealsLoaded = loadSeals(map, dataBase).then((r) => {
      $('row-seals').removeAttribute('aria-busy');
      if (r && Number.isFinite(r.dives)) $('seals-stat').innerHTML = `<strong>${pct1(r.deeper / r.dives).replace('.0%', '%')}</strong> of ${(r.dives / 1e6).toFixed(1)} million seal dives went more than 20 m deeper than the chart (${r.deeper.toLocaleString('en-US')} dives).`;
    });
    await sealsLoaded;
  }
  setVisible(CERTAINTY_LAYERS[id], on);
  updateLayersBadge();
  if (lastPoint) renderExtra(lastPoint[0], lastPoint[1]);
}
// legends and the short notes, from each layer's own legend.json
const tickRow = (vals: number[], pos: (v: number) => number, label: (v: number) => string) => vals.map((v, i) =>
  `<span class="${i === 0 ? 'first' : i === vals.length - 1 ? 'last' : ''}" style="left:${(100 * pos(v)).toFixed(1)}%">${label(v)}</span>`).join('');
export function initCertainty(legends: readonly [DisagreeLegend | null, UncertaintyLegend | null]) {
  tilesUrl = new URL(`${tilesBase}/`, location.href).href;
  [disagreeLg, uncertaintyLg] = legends;
  certaintyOk = { disagree: !!disagreeLg, uncertainty: !!uncertaintyLg, seals: !synthetic };
  {
    const srcs = certaintySources(tilesUrl, rasterTileSize);
    for (const [id, src] of Object.entries(srcs)) if (certaintyOk[id.startsWith('seals') ? 'seals' : id as CertaintyId]) map.addSource(id, src);
    for (const l of certaintyRasterLayers()) if (certaintyOk[l.id as CertaintyId]) map.addLayer(l, 'shipping');
    if (certaintyOk.seals) for (const l of sealLayers()) map.addLayer(l, 'plates');
    for (const id of CERTAINTY_IDS) if (!certaintyOk[id]) $(`row-${id}`).hidden = true;
    if (!CERTAINTY_IDS.some((id) => certaintyOk[id])) $('sub-certainty').hidden = true;
  }
  probes = { disagree: new RasterProbe(`${tilesUrl}disagree/`), uncertainty: new RasterProbe(`${tilesUrl}uncertainty/`) };
  for (const id of CERTAINTY_IDS) $<HTMLInputElement>(`t-${id}`).addEventListener('change', (e) => setCertainty(id, (e.target as HTMLInputElement).checked));

  map.on('mouseenter', 'seals', () => { if (!map.getCanvas().style.cursor) map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'seals', () => { if (map.getCanvas().style.cursor === 'pointer') map.getCanvas().style.cursor = ''; });
  if (disagreeLg) {
    const lg = disagreeLg; // (a module binding is not narrowed inside the closure below)
  const L = Math.log10, pos = (v: number) => (L(v) - L(lg.vmin)) / (L(lg.vmax) - L(lg.vmin));
    $('disagree-bar').style.background = `linear-gradient(90deg, ${disagreeLg.stops.map((st) => `${st.color} ${(100 * pos(st.value)).toFixed(1)}%`).join(', ')})`;
    $('disagree-ticks').innerHTML = tickRow(disagreeLg.stops.map((st) => st.value), pos, (v) => (v >= 1000 ? `${v / 1000} km` : String(v)));
    const h = disagreeLg.headline;
    $('disagree-stat').innerHTML = `Where the seafloor is unmeasured and deeper than ${h.depthFromM.toLocaleString('en-US')} m, the two models differ by a median <strong>${Math.round(h.unmeasured_median_abs_m)} m</strong>; ${Math.round(100 * h.unmeasured_share_gt_200m)}% of that area by more than 200 m.`;
    if (disagreeLg.attribution) $('disagree-src').textContent = disagreeLg.attribution;
  }
  if (uncertaintyLg) {
    $('uncertainty-key').innerHTML = uncertaintyLg.classes.map((c) => `<li><span class="veil-chip" style="background:${c.color};opacity:${Math.max(0.45, c.alpha / 255).toFixed(2)}" aria-hidden="true"></span><span>${c.label}</span></li>`).join('')
      + '<li><span class="veil-chip dim" aria-hidden="true"></span><span>Clear: a ship sounding in the cell</span></li>';
    const sh = uncertaintyLg.shareOfOcean;
    $('uncertainty-stat').innerHTML = `Low confidence over <strong>${pct1(sh['3'])}</strong> of the ocean, medium over ${pct1(sh['2'])}; ${pct1(sh['0'])} of cells hold a sounding.`;
    if (uncertaintyLg.attribution) $('uncertainty-src').textContent = uncertaintyLg.attribution;
  }
  {
    const [lo, , hi] = SEAL_STOPS.map(([v]) => v), pos = (v: number) => (v - lo) / (hi - lo);
    $('seals-bar').style.background = `linear-gradient(90deg, ${SEAL_STOPS.map(([v, c]) => `${c} ${(100 * pos(v)).toFixed(1)}%`).join(', ')})`;
    $('seals-ticks').innerHTML = tickRow(SEAL_STOPS.map(([v]) => v), pos, (v) => (v === hi ? `${v}+ m` : `${v}`));
  }
}

// ---------- marine life (OBIS, speciesgrids, AquaMaps) ----------
export let marine: MarineUI;
// the manifests of marine life and ocean water download alongside the other start-up files (awaited further down)
export let marineReady = false;
export function initMarine(): Promise<boolean> {
  marine = new MarineUI({
    map, base: `${dataBase}/obis/`,
    beforeOn: () => { if (water.open) water.close(); water.hideLayer(); if (oceanUI?.chlOn) oceanUI.setChl(false); },
    onChange: () => { updateLayersBadge(); if (lastPoint) renderExtra(lastPoint[0], lastPoint[1]); },
  });
  return (synthetic ? Promise.resolve(false) : marine.init()).then((ok) => { marineReady = ok; if (!ok) $('row-marine').hidden = true; return ok; });
}

// plate key (line samples match the map's dash patterns)
const DASH: Record<string, string> = { ridge: '', subduction: '', transform: '4 3', convergent: '1.2 3.2' };
const PLATE_SHORT: Record<string, string> = { ridge: 'Spreading', subduction: 'Subduction', transform: 'Transform', convergent: 'Collision' };
/** Legend texts, the depth ramp and the credits (About this map), from meta.json and the legends loaded at start-up. */
export function renderStaticText() {
  // measured statistic (meta.stats.measured_fraction_area, area-weighted, TID 10-17)
  const mfRaw = meta.stats?.measured_fraction_area;
  const mf = typeof mfRaw === 'number' ? mfRaw : NaN;
  $('measured-stat').innerHTML = Number.isFinite(mf)
    ? `<strong>${pct1(mf)}</strong> of the seafloor is directly measured by ships (Seabed 2030 counts 28.7% for GEBCO 2026, with a slightly different method).`
    : 'Coverage statistics are not available for these tiles.';
  $('plate-key').innerHTML = (Object.keys(PLATE_STYLE) as (keyof typeof PLATE_STYLE)[]).map((k) =>
    `<li title="${PLATE_STYLE[k].label}"><svg width="22" height="10" aria-hidden="true"><line x1="1" y1="5" x2="21" y2="5" stroke="${PLATE_STYLE[k].color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${DASH[k]}"/></svg><span>${PLATE_SHORT[k]}</span></li>`).join('');
  // depth ramp legend: horizontal, stops spaced evenly as the colour scale is (dense near the surface)
  {
    const deep = [...BATHY_STOPS].reverse(); // 0 m at the left
    const n = deep.length - 1;
    const grad = deep.map(([, c], i) => `${c} ${((i / n) * 100).toFixed(1)}%`).join(', ');
    const show = [0, -200, -1500, -4500, -11000];
    const ticks = deep.map(([h], i) => show.includes(h)
      ? `<span class="${i === 0 ? 'first' : i === n ? 'last' : ''}" style="left:${((i / n) * 100).toFixed(1)}%">${h === 0 ? '0' : Math.abs(h).toLocaleString('en-US')}${i === n ? ' m' : ''}</span>` : '').join('');
    $('ramp').innerHTML = `<div class="ramp-bar" style="background: linear-gradient(90deg, ${grad})"></div><div class="ramp-ticks" aria-hidden="true">${ticks}</div>`;
    $('ramp').setAttribute('role', 'img');
    $('ramp').setAttribute('aria-label', 'Colour scale from pale green at 0 m through teal and blue to violet-black at 11,000 m; steps are closer near the surface.');
  }

  // credits and headline numbers (About this map)
  {
    const doi = meta.doi;
    $('credits-body').innerHTML = `
      <p><strong>Bathymetry</strong>: ${meta.citation}, <a href="https://doi.org/${doi}" target="_blank" rel="noopener">doi:${doi}</a>. ${meta.licence ?? 'Open Government Licence v3'}: <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener">OGL v3</a>. Shown at ${meta.sourceResolutionArcsec / 60} arc-minute resolution up to zoom ${meta.maxzoom}${meta.hires ? `, the full ${meta.hires.sourceResolutionArcsec ?? 15}″ grid at zoom ${meta.maxzoom + 1}–${meta.hires.maxzoom}` : ''}. “Measured” = GEBCO type identifier 10–17 (direct survey).</p>
      <p><strong>Plate boundaries</strong>: Bird, P. (2003) An updated digital model of plate boundaries, <em>G³</em> 4(3), 1027, <a href="https://doi.org/10.1029/2001GC000252" target="_blank" rel="noopener">doi:10.1029/2001GC000252</a> (PB2002), ODC-By 1.0.</p>
      <p><strong>Undersea feature names</strong>: IHO-IOC GEBCO Gazetteer of Undersea Feature Names.</p>
      <p><strong>Atlantic overturning (AMOC) at 26.5° N</strong>: Moat, B. I. et al. (2026), RAPID-MOCHA-WBTS v2024-2, NERC EDS British Oceanographic Data Centre, <a href="https://doi.org/10.5285/5c39bf4e-5140-5546-e063-7086abc027bc" target="_blank" rel="noopener">doi:10.5285/5c39bf4e-5140-5546-e063-7086abc027bc</a>, UK Open Government Licence v3.0. Data collected and made freely available by the RAPID program (UK NERC), the MOCHA program (US NSF) and the WBTS project (NOAA).</p>
      <p><strong>Ocean water</strong>: World Ocean Atlas 2023, 1991–2020 climate normal, objectively analysed means (NOAA NCEI). Temperature: Locarnini et al. (2024), NOAA Atlas NESDIS 89, <a href="https://doi.org/10.25923/54bh-1613" target="_blank" rel="noopener">doi:10.25923/54bh-1613</a>. Salinity: Reagan et al. (2024), NOAA Atlas NESDIS 90, <a href="https://doi.org/10.25923/70qt-9574" target="_blank" rel="noopener">doi:10.25923/70qt-9574</a>. Potential density computed here with TEOS-10 (gsw). Colour maps: cmocean (Thyng et al. 2016).</p>
      <p><strong>How sure is the depth?</strong> ${disagreeLg?.attribution ?? 'Model disagreement: AUST_2026_BAT (Yuan &amp; Yang 2026, doi:10.5281/zenodo.22711109, CC BY 4.0) minus GEBCO_2026 (OGL v3)'}. ${uncertaintyLg?.attribution ?? 'Prediction confidence: Nilsson, Phrampus, Sandwell et al. (2025), SWOT ML bathymetry confidence level v1.1, doi:10.5281/zenodo.17673974, CC BY 4.0'}. ${ATTRIBUTION_SEALS}.</p>
      <p><strong>Marine life</strong> (CC BY-NC 4.0 as a whole): OBIS (2026) Ocean Biodiversity Information System, IOC-UNESCO, <a href="https://www.obis.org" target="_blank" rel="noopener">www.obis.org</a>. OBIS speciesgrids (OBIS + GBIF), CC BY-NC 4.0. Predicted richness: <a href="https://www.aquamaps.org" target="_blank" rel="noopener">AquaMaps</a> (Kaschner et al. 2019, version 10/2019), CC BY-NC 3.0.</p>
      <p><strong>Human activity at sea</strong> (each layer under its own licence):</p>
      <ul class="credits-list">
        <li>${ATTRIBUTION.cables}. Non-commercial use only; adaptations under the same licence. Only this 2022 snapshot is used.</li>
        <li>${ATTRIBUTION.shipping}, <a href="https://datacatalog.worldbank.org/search/dataset/0037580" target="_blank" rel="noopener">dataset 0037580</a>.</li>
        <li>${ATTRIBUTION.wrecks}. Photos from Wikimedia Commons, loaded only when a wreck card opens.</li>
        <li>Offshore platforms, subsea pipelines and offshore wind farms: ${ATTRIBUTION.osm.replace('OpenStreetMap', '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>')}.</li>
        <li>Submarine telecom cables from OpenStreetMap (supplement to the 2022 snapshot): ${ATTRIBUTION.osm}.</li>
      </ul>
      <p><strong>Earthquakes and seamounts</strong>: Earthquakes: USGS ANSS ComCat (public domain), doi:10.5066/F7MS3QZH; the last 30 days from the USGS real-time feed. Seamounts: SDUST2026SM (Gao et al. 2026) and SIO 2023 / Kim &amp; Wessel 2011 (Gevorgian et al. 2023), CC BY 4.0; summits from GEBCO_2026.</p>
      <p><strong>Phytoplankton, winds and currents</strong>: Chlorophyll-a: NASA OBPG, MODIS-Aqua R2022.0 climatology (doi:10.5067/AQUA/MODIS/L3M/CHL/2022.0); lakes masked with the World Ocean Atlas 2023 surface grid. Winds: NCEP/NCAR Reanalysis 1, 1991-2020 monthly means (NOAA PSL), Kalnay et al. (1996). Currents: OSCAR v2.0 (ESR, NASA PO.DAAC), 2015-2024 monthly means, doi:10.5067/OSCAR-25F20.</p>
      <p><strong>Time</strong>: Mapping history from the GEBCO_2019-GEBCO_2026 Type Identifier grids (GEBCO Compilation Group); official percentages from Seabed 2030 / GEBCO announcements. Sea level: Lambeck et al. (2014) PNAS, doi:10.1073/pnas.1411762111 (ice-volume equivalent, SI Table S3).</p>
      <p><strong>Satellite land</strong>: Esri World Imagery, ${SAT_ATTRIBUTION}. Switch it off under Layers for plain grey land and no requests to Esri.</p>
      <p>Rendered with <a href="https://maplibre.org" target="_blank" rel="noopener">MapLibre GL JS</a>. No font servers, no analytics.${synthetic ? ' <strong>These are synthetic development tiles, not real data.</strong>' : ''}</p>`;
    const stats: [string, string][] = [];
    if (Number.isFinite(mf)) stats.push([pct1(mf), 'of the seafloor has been measured directly by ships. The rest is estimated from satellite gravity.']);
    if (change) stats.push([`${mkm1(change.newly_measured_km2)}M km²`, `newly counted as measured in the 2026 grid, about ${Math.round(change.newly_measured_km2 / 357e3)} times the area of Germany.`]);
    const of = meta.stats?.ocean_fraction_of_earth;
    if (typeof of === 'number') stats.push([pct1(of), 'of Earth’s surface is ocean, by area in the GEBCO 2026 grid.']);
    $('about-stats').innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }
}

// ---------- new layers: earthquakes, seamounts, phytoplankton, winds, currents ----------
// Each module (and its data) loads the first time one of its switches is used; until then a one-shot listener
// on the switch loads it and passes the click on (the module's own listeners take over after that).
let eventsP: Promise<EventsUI> | null = null, oceanP: Promise<OceanUI> | null = null;
export function loadEvents(): Promise<EventsUI> {
  eventsP ??= import('./events-ui').then((m) => (eventsUI = new m.EventsUI({ map, dataBase, onChange: layersChanged, offerTime: () => offerTime('quakes') })));
  return eventsP;
}
export function loadOcean(): Promise<OceanUI> {
  oceanP ??= import('./ocean-ui').then((m) => {
    const o = new m.OceanUI({
      map,
      beforeChl: () => { if (seaOpen) closeSea(); if (water.open) water.close(); water.hideLayer(); if (marine.on) marine.set({ on: false }); },
      underlay: (on) => setUnderlay('chl', on),
      onChange: layersChanged,
      offerTime: () => offerTime('months'),
    });
    o.renderStatic();
    return (oceanUI = o);
  });
  return oceanP;
}
function boot<T>(inputId: string, loaded: () => boolean, load: () => Promise<T>, run: (u: T, on: boolean) => unknown) {
  $<HTMLInputElement>(inputId).addEventListener('change', async (e) => {
    if (loaded()) return;
    const on = (e.target as HTMLInputElement).checked;
    run(await load(), on);
  });
}
export function initLazyLayers() {
  boot('t-quakes', () => !!eventsUI, loadEvents, (u, on) => u.setQuakes(on));
  boot('t-seamounts', () => !!eventsUI, loadEvents, (u, on) => u.setSeamounts(on));
  boot('t-chl', () => !!oceanUI, loadOcean, (u, on) => u.setChl(on));
  boot('t-winds', () => !!oceanUI, loadOcean, (u, on) => u.setFlow('wind', on));
  boot('t-currents', () => !!oceanUI, loadOcean, (u, on) => u.setFlow('currents', on));
  if (synthetic) for (const id of ['row-quakes', 'row-seamounts']) $(id).hidden = true;
  $<HTMLInputElement>('t-amoc').addEventListener('change', (e) => setAmoc((e.target as HTMLInputElement).checked));
}

// ---------- AMOC at 26.5 N (amoc.ts): the array's line, and a card with the monthly record ----------
let amocP: Promise<AmocData | null> | null = null;
export async function setAmoc(on: boolean, card = true) {
  const t = $<HTMLInputElement>('t-amoc');
  t.checked = on;
  rowState('row-amoc', null, on);
  if (map.getLayer('amoc-line')) for (const id of ['amoc-casing', 'amoc-line']) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  if (!on) { layersChanged(); return; }
  amocP ??= getJSON<AmocData>(`${dataBase}/amoc.json`).then((d) => { if (!d) amocP = null; return d; });
  const d = await amocP;
  if (!d || !t.checked) { if (!d) { t.checked = false; rowState('row-amoc', null, false); } return; }
  if (!map.getSource('amoc')) {
    map.addSource('amoc', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: d.line.coordinates } } });
    map.addLayer({ id: 'amoc-casing', type: 'line', source: 'amoc', paint: { 'line-color': '#000000', 'line-opacity': 0.5, 'line-width': 7 } });
    map.addLayer({ id: 'amoc-line', type: 'line', source: 'amoc', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#f2b84b', 'line-width': 3, 'line-dasharray': [2, 1.2] } });
    // clicks on the line go through the map's common click handler (AMOC first, nothing while measuring or profiling);
    // the pointer shows within the same HIT_PX box as the click, not only over the 3 px line (one query per frame)
    let hoverAt: maplibregl.Point | null = null, hovering = false;
    const setHover = (on: boolean) => {
      const c = map.getCanvas().style;
      if (on && !hovering && !c.cursor) { c.cursor = 'pointer'; hovering = true; }
      else if (!on && hovering) { hovering = false; if (c.cursor === 'pointer') c.cursor = ''; }
    };
    map.on('mousemove', (e) => {
      if (!hoverAt) requestAnimationFrame(() => { const p = hoverAt; hoverAt = null; if (p) setHover(amocHit(hitBox(p))); });
      hoverAt = e.point;
    });
    map.getCanvas().addEventListener('mouseleave', () => { hoverAt = null; setHover(false); });
  }
  amocLast = d;
  for (const id of ['amoc-casing', 'amoc-line']) map.setLayoutProperty(id, 'visibility', 'visible');
  if (card) { showCard(amocCard(d)); updatePadding(); }
  layersChanged();
}

/** Something on the map changed: hash, badge, readout, the Time panel's targets, the tool-bar dot. */
export function layersChanged() {
  writeLayersHash();
  updateLayersBadge();
  timeUI?.layerChanged();
  updateTimeDot();
  if (lastPoint) renderExtra(lastPoint[0], lastPoint[1]);
}
export async function applyExtra(tokens: string[]) {
  if (tokens.includes('amoc') !== $<HTMLInputElement>('t-amoc').checked) await setAmoc(tokens.includes('amoc'), false);
  const live = tokens.includes('quakes-live'), wantQ = live || tokens.includes('quakes'), wantS = tokens.includes('seamounts');
  if (wantQ || wantS || eventsUI) {
    const u = await loadEvents();
    if (wantQ && live !== (u.quakeMode === 'live')) await u.setQuakeMode(live ? 'live' : 'history');
    if (wantQ !== u.quakesOn) await u.setQuakes(wantQ);
    if (wantS !== u.seamountsOn) await u.setSeamounts(wantS);
  }
  const wantChl = tokens.includes('chl'), flow = tokens.includes('winds') ? 'wind' as const : tokens.includes('currents') ? 'currents' as const : null;
  if (wantChl || flow || oceanUI) {
    const o = await loadOcean();
    if (wantChl !== o.chlOn) await o.setChl(wantChl);
    if (flow !== o.flow) { if (flow) await o.setFlow(flow, true); else if (o.flow) await o.setFlow(o.flow, false); }
  }
}

/** Every layer that is on, as tokens (veil, plates, new2026, the depth-certainty ids, marine, and #layers= tokens). */
export function layerTokens(): string[] {
  const t: string[] = [];
  if (tVeil.checked) t.push('veil');
  if (tPlates.checked) t.push('plates');
  if (tNew.checked) t.push('new2026');
  for (const id of CERTAINTY_IDS) if (certaintyOn.has(id)) t.push(id);
  if (marine.on) t.push('marine');
  const tok = layersToken({ ...overlays.state, extra: extraTokens() });
  if (tok) t.push(...tok.split(','));
  return t;
}
/** Exactly these layers on, every other one off. */
export async function setLayerTokens(tokens: string[]) {
  const on = new Set(tokens);
  setVeil(on.has('veil'));
  setPlates(on.has('plates'));
  if (!$('new-layer').hidden) setNew(on.has('new2026'));
  for (const id of CERTAINTY_IDS) if (certaintyOk[id] && certaintyOn.has(id) !== on.has(id)) await setCertainty(id, on.has(id));
  if (marineReady && marine.on !== on.has('marine')) await marine.set({ on: on.has('marine') });
  const ls = layersFromHash(`#layers=${tokens.join(',')}`) ?? { ids: [], allWrecks: false };
  await overlays.apply(ls);
  await applyExtra(ls.extra ?? []);
  layersChanged();
}
