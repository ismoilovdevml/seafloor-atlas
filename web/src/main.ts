import '@fontsource-variable/newsreader/opsz.css';
import { atFromHash } from './at';
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { buildStyle, DOT_IMAGE, FEATURE_LAYERS, makeDot, type Meta } from './style';
import { TileSampler } from './sampler';
import { configureTiles, maxZoomFor, PROTOCOL, protocolHandler, tileActivity } from './tilesource';
import { ProfileChart } from './profile-chart';
import { BATHY_STOPS, EXPOSED_HIGH, EXPOSED_LOW, FLOODED_DEEP, FLOODED_SHALLOW, PLATE_STYLE, seaLevelExpression, underlayExpression } from './palette';
import {
  KNEE_LEVEL, PRESETS, SEA_MAX, SEA_MIN, SLIDER_MAX, formatLevel, hashWithSea, landAreaAt, levelToPos, posToLevel, presetFor, seaFromHash, snapLevel,
  type Hypsometry,
} from './sealevel';
import { formatDepth, formatLat, formatLon, greatCircle, haversineKm, profileZoom, unwrapPath } from './geo';
import { diskCoverage, fitRadius, freeRect, globeDisk, inside, isGlobeScale, zoomForRadius, type Rect } from './layout';
import { WaterUI } from './water-ui';
import { OverlayUI } from './overlay-ui';
import { CERTAINTY_IDS, CERTAINTY_LAYERS, RasterProbe, SEAL_STOPS, certaintyRasterLayers, certaintySources, classFromAlpha, disagreeFromAlpha, formatDisagree, loadSeals, sealCard, sealLayers,
  type CertaintyId, type DisagreeLegend, type SealProps, type UncertaintyLegend } from './certainty';
import { MarineUI } from './marine-ui';
import { ATTRIBUTION, hashWithLayers, layersFromHash, layersToken, normName, searchRank, type CardModel, type LayerState, type SearchEntry } from './overlays';
import { LoadMeter } from './loading';
import { hashWithTime, parseSeaHistory, timeFromHash, type TimeMode, type TimeState, type YearSet } from './timeline';
import type { EventsUI } from './events-ui';
import type { OceanUI } from './ocean-ui';
import type { HistoryUI } from './history-ui';
import type { MonthId, MonthTarget, TimeUI, YearTarget } from './time-ui';
import { tourFromHash, type TourTool } from './tour-model';
import type { Tour, TourHost } from './tour';

maplibregl.setWorkerUrl(workerUrl);

interface Story { id: string; title: string; blurb: string; center: [number, number]; zoom: number; pitch: number; bearing: number; exaggeration: number; veil?: boolean }
interface FeatureProps { name: string; kind: string; depth_m: number; blurb: string; source: string }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

async function getJSON<T>(url: string): Promise<T | null> {
  try { const r = await fetch(url); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}

// ---------- tiles: real by default, synthetic on ?tiles=synthetic or when real tiles are absent ----------
// ?tiles=synthetic forces the dev set from scripts/make_synthetic_tiles.mjs
const TILESETS: Record<string, string> = { synthetic: 'tiles-synthetic' };
let tilesBase = TILESETS[params.get('tiles') ?? ''] ?? 'tiles';
let meta = await getJSON<Meta>(`${tilesBase}/meta.json`);
if (!meta && tilesBase === 'tiles') { tilesBase = 'tiles-synthetic'; meta = await getJSON<Meta>(`${tilesBase}/meta.json`); }
if (!meta) {
  document.body.insertAdjacentHTML('beforeend', '<p class="fatal" style="position:fixed;inset:auto 0 50%;text-align:center">No tiles found. Build them with the pipeline (web/public/tiles) or run <code>npm run synth</code>.</p>');
  throw new Error('no tiles');
}
const synthetic = tilesBase === 'tiles-synthetic';
const dataBase = synthetic ? 'tiles-synthetic/data' : 'data';
// static z0..meta.maxzoom next to the page, PMTiles above it when meta.hires is set (tilesource.ts)
configureTiles(tilesBase, meta.maxzoom, synthetic ? null : meta.hires);
maplibregl.addProtocol(PROTOCOL, protocolHandler);
const demMaxZoom = maxZoomFor('dem');
const sampler = new TileSampler(tilesBase, { ...meta, maxzoom: demMaxZoom });

// ---------- map ----------
const AUTO_EXAG: [number, number][] = [[0, 60], [2, 50], [3.5, 30], [5, 14], [6.5, 6], [8, 3]];
function autoExaggeration(z: number): number {
  if (z <= AUTO_EXAG[0][0]) return AUTO_EXAG[0][1];
  for (let i = 1; i < AUTO_EXAG.length; i++) {
    const [z0, e0] = AUTO_EXAG[i - 1], [z1, e1] = AUTO_EXAG[i];
    if (z <= z1) return e0 + ((z - z0) / (z1 - z0)) * (e1 - e0);
  }
  return AUTO_EXAG[AUTO_EXAG.length - 1][1];
}

// Sharp rasters on high-density screens: our tiles are 512 px; declared as 256 px tiles on a 2x screen MapLibre
// picks one zoom level higher and draws each tile pixel to one device pixel instead of stretching it 2x.
// The files, their zoom levels (z0-5 static, z6-7 PMTiles) and the sampler (which reads the files at their real
// 512 px) are unchanged. ?tilesize=512|256 forces either (QA compares the two).
const forcedTile = Number(params.get('tilesize'));
const rasterTileSize = forcedTile === 256 || forcedTile === 512 ? forcedTile : window.devicePixelRatio >= 1.5 ? meta.tileSize / 2 : meta.tileSize;
const forcedTerrain = Number(params.get('terraintile'));
// the terrain mesh stays at the files' 512 px: same sharpness on a 2x screen (mesh resolution only), 9 fewer
// requests and 2.2 MB less at the first view (measured, see README)
const terrainTileSize = forcedTerrain === 256 || forcedTerrain === 512 ? forcedTerrain : meta.tileSize;
const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(tilesBase, dataBase, meta, { tileSize: rasterTileSize, terrainTileSize }),
  center: [-150, 8],
  zoom: window.innerWidth < 760 ? 0.75 : 2.05,
  pitch: 0,
  maxPitch: 78,
  maxZoom: 9.5,
  attributionControl: false,
  canvasContextAttributes: { antialias: true },
});
map.setMissingStyleImageResolver((id) => { if (id === DOT_IMAGE && !map.hasImage(DOT_IMAGE)) map.addImage(DOT_IMAGE, makeDot(), { pixelRatio: 2 }); });
let exagAuto = true;
/** the guided tour is running (tour.ts sets it through its host) */
let touring = false;
let exagValue = autoExaggeration(map.getZoom());
function applyExaggeration(v: number) {
  exagValue = Math.round(v);
  map.setTerrain({ source: 'dem-terrain', exaggeration: exagValue });
  $<HTMLInputElement>('exag').value = String(exagValue);
  $<HTMLOutputElement>('exag-out').textContent = `×${exagValue}`;
}
map.on('zoomend', () => { if (exagAuto) applyExaggeration(autoExaggeration(map.getZoom())); });
$<HTMLInputElement>('exag').addEventListener('input', (e) => {
  exagAuto = false; $<HTMLInputElement>('exag-auto').checked = false;
  applyExaggeration(Number((e.target as HTMLInputElement).value));
});
$<HTMLInputElement>('exag-auto').addEventListener('change', (e) => {
  exagAuto = (e.target as HTMLInputElement).checked;
  if (exagAuto) applyExaggeration(autoExaggeration(map.getZoom()));
});

const loaded = new Promise<void>((res) => map.once('load', () => res()));
await loaded;
applyExaggeration(exagValue);

// ---------- layer toggles ----------
// Each layer is a compact row in the Layers drawer (switch, name, (i) for a short note); what is on the map gets a
// section in the legend dock. The row's `on` class and the legend section follow the map layer.
function setVisible(layer: string | string[], on: boolean) {
  for (const id of ([] as string[]).concat(layer)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
const tVeil = $<HTMLInputElement>('t-veil'), tPlates = $<HTMLInputElement>('t-plates'), tFeatures = $<HTMLInputElement>('t-features');
function rowState(row: string, legend: string | null, on: boolean) {
  $(row).classList.toggle('on', on);
  if (legend) $(legend).hidden = !on;
}
function setVeil(on: boolean) { tVeil.checked = on; setVisible('veil', on); rowState('row-veil', 'lg-veil', on); if (on) $('story-veil').hidden = true; }
function setPlates(on: boolean) { tPlates.checked = on; setVisible('plates', on); rowState('row-plates', 'lg-plates', on); }
function setFeatures(on: boolean) { tFeatures.checked = on; setVisible(FEATURE_LAYERS, on); rowState('row-features', null, on); }
tVeil.addEventListener('change', () => setVeil(tVeil.checked));
tPlates.addEventListener('change', () => setPlates(tPlates.checked));
tFeatures.addEventListener('change', () => setFeatures(tFeatures.checked));
// newly measured between the GEBCO_2025 and GEBCO_2026 grids (pipeline/change.py); hidden if not built
const tNew = $<HTMLInputElement>('t-new');
const change = meta.change2025to2026;
function setNew(on: boolean) { tNew.checked = on; setVisible('new2026', on); rowState('new-layer', 'lg-new', on); }
tNew.addEventListener('change', () => setNew(tNew.checked));
const pct1 = (f: number) => `${(100 * f).toFixed(1)}%`;
const mkm1 = (km2: number) => (km2 / 1e6).toFixed(1);
if (change && (meta.tiles?.new2026 ?? 0) > 0) {
  $('new-stat').innerHTML = `<strong>${mkm1(change.newly_measured_km2)} million km²</strong> newly counted as measured; the measured share went from ${pct1(change.measured_2025_frac)} to ${pct1(change.measured_2026_frac)}.`;
} else {
  $('new-layer').hidden = true;
}
setPlates(false);

// human-activity overlays (cables, shipping, wrecks, platforms, pipelines, wind); off by default, #layers= deep link
// Modules loaded on first use (main.ts imports them dynamically, so the first page load does not grow):
// earthquakes + seamounts, phytoplankton + winds + currents, the Time panel and the mapping-history layer.
let eventsUI: EventsUI | null = null;
let oceanUI: OceanUI | null = null;
let timeUI: TimeUI | null = null;
let historyUI: HistoryUI | null = null;
// new layers outside "Human activity" (earthquakes, seamounts, phytoplankton, winds, currents) share the list
function extraTokens(): string[] {
  const t: string[] = [];
  if (eventsUI?.quakesOn) t.push(eventsUI.quakeMode === 'live' ? 'quakes-live' : 'quakes');
  if (eventsUI?.seamountsOn) t.push('seamounts');
  if (oceanUI?.chlOn) t.push('chl');
  if (oceanUI?.flow) t.push(oceanUI.flow === 'wind' ? 'winds' : 'currents');
  return t;
}
function writeLayersHash(st: LayerState = overlays.state) {
  const h = hashWithLayers(location.hash, { ...st, extra: extraTokens() });
  if (h !== location.hash && !(h === '' && location.hash === '')) history.replaceState(null, '', h || location.pathname + location.search);
}
let prevOverlays = new Set<string>();
const overlays = new OverlayUI({ map, dataBase, shippingLegend: 'tiles/shipping/legend.json', onChange: (st) => {
  writeLayersHash(st);
  // a time-aware overlay just went on: the Time panel offers itself once
  for (const id of ['cables', 'wind'] as const) if (st.ids.includes(id) && !prevOverlays.has(id)) offerTime(id);
  prevOverlays = new Set(st.ids);
  layersChanged();
} });

const ATTRIBUTION_SEALS = 'Seal dives: SO-ABBA v1.0 (Hindell, McMahon, Jonsen et al. 2026, doi:10.5281/zenodo.19121676), CC BY 4.0; compared with GEBCO 2026';
// ---------- how sure is the depth? (model disagreement, prediction confidence, seal soundings) ----------
// real tiles only; each switch shows its layer and legend section, the readout adds the value under the cursor
const tilesUrl = new URL(`${tilesBase}/`, location.href).href;
const [disagreeLg, uncertaintyLg] = synthetic ? [null, null]
  : await Promise.all([getJSON<DisagreeLegend>('tiles/disagree/legend.json'), getJSON<UncertaintyLegend>('tiles/uncertainty/legend.json')]);
const certaintyOk: Record<CertaintyId, boolean> = { disagree: !!disagreeLg, uncertainty: !!uncertaintyLg, seals: !synthetic };
{
  const srcs = certaintySources(tilesUrl, rasterTileSize);
  for (const [id, src] of Object.entries(srcs)) if (certaintyOk[id.startsWith('seals') ? 'seals' : id as CertaintyId]) map.addSource(id, src);
  for (const l of certaintyRasterLayers()) if (certaintyOk[l.id as CertaintyId]) map.addLayer(l, 'shipping');
  if (certaintyOk.seals) for (const l of sealLayers()) map.addLayer(l, 'plates');
  for (const id of CERTAINTY_IDS) if (!certaintyOk[id]) $(`row-${id}`).hidden = true;
  if (!CERTAINTY_IDS.some((id) => certaintyOk[id])) $('sub-certainty').hidden = true;
}
const probes = { disagree: new RasterProbe(`${tilesUrl}disagree/`), uncertainty: new RasterProbe(`${tilesUrl}uncertainty/`) };
const certaintyOn = new Set<CertaintyId>();
let sealsLoaded: Promise<unknown> | null = null;
async function setCertainty(id: CertaintyId, on: boolean) {
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
for (const id of CERTAINTY_IDS) $<HTMLInputElement>(`t-${id}`).addEventListener('change', (e) => setCertainty(id, (e.target as HTMLInputElement).checked));
map.on('mouseenter', 'seals', () => { if (!profiling) map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'seals', () => { if (!profiling) map.getCanvas().style.cursor = ''; });
// legends and the short notes, from each layer's own legend.json
const tickRow = (vals: number[], pos: (v: number) => number, label: (v: number) => string) => vals.map((v, i) =>
  `<span class="${i === 0 ? 'first' : i === vals.length - 1 ? 'last' : ''}" style="left:${(100 * pos(v)).toFixed(1)}%">${label(v)}</span>`).join('');
if (disagreeLg) {
  const L = Math.log10, pos = (v: number) => (L(v) - L(disagreeLg.vmin)) / (L(disagreeLg.vmax) - L(disagreeLg.vmin));
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

// ---------- marine life (OBIS, speciesgrids, AquaMaps) ----------
const marine = new MarineUI({
  map, base: `${dataBase}/obis/`,
  beforeOn: () => { if (water.open) water.close(); water.hideLayer(); if (oceanUI?.chlOn) oceanUI.setChl(false); },
  onChange: () => { updateLayersBadge(); if (lastPoint) renderExtra(lastPoint[0], lastPoint[1]); },
});
const marineReady = synthetic ? false : await marine.init();
if (!marineReady) $('row-marine').hidden = true;

// measured statistic (meta.stats.measured_fraction_area, area-weighted, TID 10-17)
const mfRaw = meta.stats?.measured_fraction_area;
const mf = typeof mfRaw === 'number' ? mfRaw : NaN;
$('measured-stat').innerHTML = Number.isFinite(mf)
  ? `<strong>${pct1(mf)}</strong> of the seafloor is directly measured by ships (Seabed 2030 counts 28.7% for GEBCO 2026, with a slightly different method).`
  : 'Coverage statistics are not available for these tiles.';

// plate key (line samples match the map's dash patterns)
const DASH: Record<string, string> = { ridge: '', subduction: '', transform: '4 3', convergent: '1.2 3.2' };
const PLATE_SHORT: Record<string, string> = { ridge: 'Spreading', subduction: 'Subduction', transform: 'Transform', convergent: 'Collision' };
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
    <p><strong>Bathymetry</strong>: ${meta.citation}, <a href="https://doi.org/${doi}" target="_blank" rel="noopener">doi:${doi}</a>. ${meta.licence ?? 'Open Government Licence v3'}: <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener">OGL v3</a>. Shown at ${meta.sourceResolutionArcsec / 60} arc-minute resolution. “Measured” = GEBCO type identifier 10–17 (direct survey).</p>
    <p><strong>Plate boundaries</strong>: Bird, P. (2003) An updated digital model of plate boundaries, <em>G³</em> 4(3), 1027, <a href="https://doi.org/10.1029/2001GC000252" target="_blank" rel="noopener">doi:10.1029/2001GC000252</a> (PB2002), ODC-By 1.0.</p>
    <p><strong>Undersea feature names</strong>: IHO-IOC GEBCO Gazetteer of Undersea Feature Names.</p>
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
    <p>Rendered with <a href="https://maplibre.org" target="_blank" rel="noopener">MapLibre GL JS</a>. No basemap, tile or font servers, no analytics.${synthetic ? ' <strong>These are synthetic development tiles, not real data.</strong>' : ''}</p>`;
  const stats: [string, string][] = [];
  if (Number.isFinite(mf)) stats.push([pct1(mf), 'of the seafloor has been measured directly by ships. The rest is estimated from satellite gravity.']);
  if (change) stats.push([`${mkm1(change.newly_measured_km2)}M km²`, `newly counted as measured in the 2026 grid, about ${Math.round(change.newly_measured_km2 / 357e3)} times the area of Germany.`]);
  const of = meta.stats?.ocean_fraction_of_earth;
  if (typeof of === 'number') stats.push([pct1(of), 'of Earth’s surface is ocean, by area in the GEBCO 2026 grid.']);
  $('about-stats').innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

// ---------- cards ----------
function show(id: string, on: boolean) { $(id).hidden = !on; }
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => b.addEventListener('click', () => {
  show(b.dataset.close!, false);
  if (b.dataset.close === 'story-card') markStory(null);
  if (b.dataset.close === 'feature-card') overlays.clearHighlight();
}));
/** Clears the parts of the feature card that only overlay cards use. */
function resetCard() {
  $('f-facts').hidden = true; $('f-facts').replaceChildren();
  $('f-links').hidden = true; $('f-links').replaceChildren();
  $('f-photo').hidden = true; $<HTMLImageElement>('f-img').removeAttribute('src');
}
/** Overlay card: all text goes in through textContent (the data comes from third-party registries). */
function showCard(c: CardModel) {
  show('story-card', false);
  resetCard();
  $('f-kind').textContent = c.kind;
  $('f-name').textContent = c.name;
  $('f-depth').textContent = c.lead;
  if (c.facts.length) {
    $('f-facts').replaceChildren(...c.facts.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
    $('f-facts').hidden = false;
  }
  $('f-blurb').textContent = c.note ?? '';
  if (c.links.length) {
    $('f-links').replaceChildren(...c.links.map((l) => { const a = document.createElement('a'); a.href = l.href; a.textContent = l.label; a.target = '_blank'; a.rel = 'noopener'; return a; }));
    $('f-links').hidden = false;
  }
  if (c.image) {
    const img = $<HTMLImageElement>('f-img');
    img.onerror = () => { $('f-photo').hidden = true; };
    img.alt = c.image.alt; img.src = c.image.src;
    $('f-img-cap').textContent = c.image.credit;
    $('f-photo').hidden = false;
  }
  $('f-source').textContent = `Source: ${c.source}`;
  show('feature-card', true);
}

const KIND_LABEL: Record<string, string> = {};
function kindLabel(k: string) { return KIND_LABEL[k] ?? (k ? k[0].toUpperCase() + k.slice(1).replace(/_/g, ' ') : ''); }
function showFeature(p: FeatureProps) {
  show('story-card', false);
  resetCard(); overlays.clearHighlight();
  $('f-kind').textContent = kindLabel(p.kind);
  $('f-name').textContent = p.name;
  $('f-depth').textContent = Number.isFinite(Number(p.depth_m)) ? `${formatDepth(Number(p.depth_m))} in the GEBCO 2026 grid` : '';
  $('f-blurb').textContent = p.blurb ?? '';
  $('f-source').textContent = p.source ? `Source: ${p.source}` : '';
  show('feature-card', true);
}
function showPlate(p: Record<string, unknown>) {
  show('story-card', false);
  resetCard(); overlays.clearHighlight();
  const t = String(p.type);
  const style = t === 'ridge' || t === 'rift' ? PLATE_STYLE.ridge : t === 'subduction' || t === 'trench' ? PLATE_STYLE.subduction : t === 'transform' ? PLATE_STYLE.transform : PLATE_STYLE.convergent;
  $('f-kind').textContent = t === 'rift' ? 'Continental rift' : style.label;
  $('f-name').textContent = String(p.plates ?? p.boundary ?? 'Plate boundary');
  $('f-depth').textContent = p.rate_mm_yr != null ? `Relative motion about ${p.rate_mm_yr} mm per year` : '';
  $('f-blurb').textContent = `${style.note[0].toUpperCase()}${style.note.slice(1)}.`;
  $('f-source').textContent = `Source: Bird (2003) PB2002, boundary ${p.boundary ?? ''} (${p.cls ?? ''})`;
  show('feature-card', true);
}

// ---------- stories ----------
const stories = (await getJSON<Story[]>('data/stories.json')) ?? [];
const storyList = $('story-list');
function where([lon, lat]: [number, number]) { return `${formatLat(lat).replace('.000', '').replace(/(\.\d)\d+/, '$1')}, ${formatLon(lon).replace(/(\.\d)\d+/, '$1')}`; }
storyList.innerHTML = stories.map((s) => `<li><button data-story="${s.id}" aria-current="false">${s.title}<span class="where">${where(s.center)}</span></button></li>`).join('');
function markStory(id: string | null) {
  storyList.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.story === id)));
}
let currentStory: Story | null = null;
function playStory(s: Story, instant = false) {
  timeUI?.close(false); // stories are told at today's sea level, with every layer at its full extent
  closeSea(false);
  water.close(false); // and over the plain relief
  currentStory = s;
  markStory(s.id);
  show('feature-card', false);
  $('story-title').textContent = s.title;
  $('story-blurb').textContent = s.blurb;
  $('story-veil').hidden = !s.veil || tVeil.checked;
  const card = $('story-card');
  card.hidden = false; card.classList.remove('entering'); void card.offsetWidth; card.classList.add('entering');
  exagAuto = false; $<HTMLInputElement>('exag-auto').checked = false;
  applyExaggeration(s.exaggeration);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cam = { center: s.center, zoom: s.zoom - (window.innerWidth < 760 ? 0.6 : 0), pitch: s.pitch, bearing: s.bearing };
  if (window.innerWidth < 760) setTab('none');
  updatePadding();
  if (instant || reduce) map.jumpTo(cam); else map.flyTo({ ...cam, duration: 5200, curve: 1.6, essential: true });
  history.replaceState(null, '', hashWithLayers(`#story=${s.id}`, overlays.state));
}
storyList.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-story]');
  const s = b && stories.find((x) => x.id === b.dataset.story);
  if (s) playStory(s);
});
$('story-veil').addEventListener('click', () => { setVeil(true); $('story-veil').hidden = true; });

// ---------- features + search ----------
const featureData = await getJSON<GeoJSON.FeatureCollection<GeoJSON.Point, FeatureProps>>(`${dataBase}/features.geojson`);
const features = featureData?.features ?? [];
$('features-stat').innerHTML = features.length ? `<strong>${features.length.toLocaleString('en-US')}</strong> named undersea features.` : '';
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const input = $<HTMLInputElement>('search-input'), results = $<HTMLUListElement>('search-results');
// one index over guided views, gazetteer names and, once loaded, cable names and notable wreck names (marked by kind)
let searchIndex: SearchEntry[] = [
  ...stories.map((s) => ({ name: s.title, label: 'Guided view', kind: 'story' as const, key: s.id, n: normName(s.title) })),
  ...features.map((f, i) => ({ name: f.properties.name, label: kindLabel(f.properties.kind), kind: 'feature' as const, key: String(i), n: normName(f.properties.name) })),
];
let overlaySearch: Promise<void> | null = null;
function loadOverlaySearch() {
  overlaySearch ??= overlays.searchEntries().then((xs) => { searchIndex = searchIndex.concat(xs); if (!results.hidden || input.value.trim()) renderResults(); });
  return overlaySearch;
}
input.addEventListener('focus', () => { loadOverlaySearch(); }, { once: true });
let hits: SearchEntry[] = [], active = -1;
function renderResults() {
  const raw = input.value.trim();
  if (!raw) { results.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
  hits = searchRank(searchIndex, raw, 12);
  active = hits.length ? 0 : -1;
  results.innerHTML = hits.length
    ? hits.map((f, i) => `<li role="option" id="opt-${i}" aria-selected="${i === active}" data-i="${i}" data-kind="${f.kind}"><span>${esc(f.name)}</span><span class="k">${esc(f.label)}</span></li>`).join('')
    : `<li class="empty" role="option" aria-disabled="true">Nothing named “${esc(raw)}”. Try a trench, a seamount, a cable or a ship’s name.</li>`;
  results.hidden = false; input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', active >= 0 ? `opt-${active}` : '');
}
async function choose(i: number) {
  const e = hits[i]; if (!e) return;
  results.hidden = true; input.setAttribute('aria-expanded', 'false'); input.value = e.name;
  if (e.kind === 'story') {
    const s = stories.find((x) => x.id === e.key);
    if (s) { input.blur(); playStory(s); }
    return;
  }
  markStory(null); show('story-card', false);
  if (e.kind === 'feature') {
    const f = features[Number(e.key)];
    showFeature(f.properties);
    updatePadding();
    map.flyTo({ center: f.geometry.coordinates as [number, number], zoom: Math.max(map.getZoom(), 5), pitch: 45, duration: 3500, essential: true });
    return;
  }
  const r = await overlays.focus(e);
  if (!r) return;
  showCard(r.card);
  updatePadding();
  const below = belowCard();
  if (r.feature.geometry.type === 'Point') {
    map.flyTo({ center: r.feature.geometry.coordinates as [number, number], zoom: Math.max(map.getZoom(), 5.5), pitch: 30, duration: 3500, essential: true, offset: [0, below] });
  } else {
    const b = lineBounds(r.feature.geometry as GeoJSON.MultiLineString);
    map.fitBounds(b, { padding: { top: 60 + 2 * below, bottom: 60, left: 60, right: 60 }, maxZoom: 5.5, duration: 3000, essential: true });
  }
}
/** Desktop: how far to push a flown-to place down so it lands in the free space under a tall open card (px). */
function belowCard(): number {
  if (window.innerWidth < 760 || $('feature-card').hidden) return 0;
  const pad = map.getPadding(), H = window.innerHeight;
  const top = pad.top ?? 0, bottom = H - (pad.bottom ?? 0), mid = (top + bottom) / 2;
  const cardBottom = $('feature-card').getBoundingClientRect().bottom;
  return cardBottom > mid - 40 ? Math.round((cardBottom + bottom) / 2 - mid) : 0;
}
/** Bounds of a (multi)line, with longitudes unwrapped so a trans-Pacific cable does not span the whole globe. */
function lineBounds(g: GeoJSON.MultiLineString | GeoJSON.LineString): [[number, number], [number, number]] {
  const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
  const ref = lines[0][0][0];
  let w = Infinity, e = -Infinity, sth = Infinity, n = -Infinity;
  for (const l of lines) for (const [x0, y] of l) {
    let x = x0; while (x - ref > 180) x -= 360; while (x - ref < -180) x += 360;
    w = Math.min(w, x); e = Math.max(e, x); sth = Math.min(sth, y); n = Math.max(n, y);
  }
  return [[w, sth], [e, n]];
}
input.addEventListener('input', renderResults);
input.addEventListener('keydown', (e) => {
  if (results.hidden) { if (e.key === 'Escape') input.blur(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(1, hits.length);
    results.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    input.setAttribute('aria-activedescendant', `opt-${active}`);
  } else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
  else if (e.key === 'Escape') { results.hidden = true; input.setAttribute('aria-expanded', 'false'); }
});
results.addEventListener('pointerdown', (e) => { const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-i]'); if (li) { e.preventDefault(); choose(Number(li.dataset.i)); } });
input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; input.setAttribute('aria-expanded', 'false'); }, 120));

// ---------- hover readout ----------
let readToken = 0;
let lastRead: { h: number; f: number | null } | null = null;
let lastPoint: [number, number] | null = null;
async function readout(lon: number, lat: number) {
  const t = ++readToken;
  lastPoint = [lon, lat];
  const { h, f } = await sampler.sample([[lon, lat]]);
  if (t !== readToken) return;
  $('readout-hint').hidden = true; $('readout-grid').hidden = false;
  $('r-lat').textContent = formatLat(lat);
  $('r-lon').textContent = formatLon(lon);
  lastRead = { h: h[0], f: f[0] };
  renderDepth();
  $('r-meas').textContent = f[0] === null ? 'land' : Number.isNaN(f[0]) ? 'n/a' : `${Math.round(f[0] * 100)}%`;
  renderWaterReadout();
  renderExtra(lon, lat);
}
/** One extra readout line for the active marine-life or depth-certainty layer (marine first, then confidence, then disagreement). */
let extraToken = 0;
async function renderExtra(lon: number, lat: number) {
  const t = ++extraToken;
  const lines: { label: string; value: string }[] = [];
  const m = marine.readout(lon, lat);
  if (m) lines.push(m);
  if (oceanUI) lines.push(...oceanUI.readout(lon, lat));
  let out: { label: string; value: string } | null = null;
  if (certaintyOn.has('uncertainty') && uncertaintyLg) {
    const px = await probes.uncertainty.at(lon, lat);
    const c = px ? classFromAlpha(px[3], uncertaintyLg) : null;
    out = { label: 'Prediction confidence', value: c ? c.label.replace(' confidence', '') : 'sounding or land' };
  }
  if (!out && certaintyOn.has('disagree') && disagreeLg) {
    const px = await probes.disagree.at(lon, lat);
    const m = px ? disagreeFromAlpha(px[3], disagreeLg) : null;
    out = { label: 'Models differ by', value: m === null ? 'under 50 m or not shown' : formatDisagree(m, disagreeLg.vmax) };
  }
  if (t !== extraToken) return;
  if (out) lines.push(out);
  // the depth-certainty line first when that layer is on (it reads the seafloor under the cursor), at most two
  const shown = (out ? [out, ...lines.filter((x) => x !== out)] : lines).slice(0, 2);
  for (const [i, id] of ['r-extra', 'r-extra2'].entries()) {
    $(id).hidden = !shown[i];
    if (shown[i]) { $(`${id}-dt`).textContent = shown[i].label; $(`${id}-dd`).textContent = shown[i].value; }
  }
  return shown[0] ?? null;
}
/** While the ocean-water panel is open, the second readout cell shows the water value instead of coverage. */
function renderWaterReadout() {
  if (!lastPoint || !lastRead) return;
  const w = water.readout(lastPoint[0], lastPoint[1]);
  if (!w) {
    // back to the coverage value (it was replaced while the water panel was open)
    const f = lastRead.f;
    $('r-meas-dt').textContent = 'Measured by ship';
    $('r-meas').textContent = f === null ? 'land' : Number.isNaN(f) ? 'n/a' : `${Math.round(f * 100)}%`;
    return;
  }
  $('r-meas-dt').textContent = w.label;
  $('r-meas').textContent = w.value;
}
/** Depth relative to the sea level shown; with a changed sea level, today's value is kept beside it. */
function renderDepth() {
  if (!lastRead) return;
  const h = lastRead.h, L = seaLevel;
  $('r-depth-dt').innerHTML = L === 0 ? 'Depth' : `Depth<span class="dt-sea">, sea at ${formatLevel(L)}</span>`;
  const dd = $('r-depth');
  if (!Number.isFinite(h)) { dd.textContent = 'n/a'; return; }
  dd.textContent = formatDepth(h - L);
  if (L !== 0) dd.insertAdjacentHTML('beforeend', `<span class="was">today ${formatDepth(h)}</span>`);
}
let pending: maplibregl.LngLat | null = null;
map.on('mousemove', (e) => {
  if (!pending) requestAnimationFrame(() => { if (pending) readout(pending.lng, pending.lat); pending = null; });
  pending = e.lngLat;
});

// ---------- depth profile tool ----------
const chart = new ProfileChart($('profile-chart'), (i) => {
  const src = map.getSource('cursor') as GeoJSONSource;
  src.setData({ type: 'FeatureCollection', features: i === null || !profilePts ? [] : [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: profilePts[i] } }] });
});
let profiling = false;
let profileA: [number, number] | null = null;
let profilePts: [number, number][] | null = null;
const SAMPLES = 400;
function setProfileSource(a: [number, number] | null, b: [number, number] | null) {
  const feats: GeoJSON.Feature[] = [];
  if (a) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: a } });
  if (a && b) {
    feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: b } });
    feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: unwrapPath(greatCircle(a, b, 200)) } });
  }
  (map.getSource('profile') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
}
function setProfiling(on: boolean) {
  if (on) { closeSea(); water.close(); timeUI?.close(); }
  profiling = on;
  $('profile-btn').setAttribute('aria-pressed', String(on));
  $('ui').classList.toggle('profiling', on);
  show('profile', on);
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
  if (!on) { profileA = null; profilePts = null; setProfileSource(null, null); chart.set(null); $('profile-stats').hidden = true; }
  else { $('profile-status').textContent = 'Click a start point on the globe.'; $('profile-status').hidden = false; }
}
$('profile-btn').addEventListener('click', () => setProfiling(!profiling));
$('profile-close').addEventListener('click', () => setProfiling(false));

async function runProfile(a: [number, number], b: [number, number]) {
  setProfileSource(a, b);
  const pts = greatCircle(a, b, SAMPLES);
  const len = haversineKm(a, b);
  const z = profileZoom(len, SAMPLES, demMaxZoom, meta!.tileSize);
  $('profile-status').textContent = 'Reading depths…';
  const { h, f } = await sampler.sample(pts, z);
  const dist = pts.map((_, i) => (len * i) / (SAMPLES - 1));
  profilePts = pts;
  chart.set({ dist, h, f });
  const ocean = f.filter((v): v is number => v !== null && !Number.isNaN(v));
  const meas = ocean.length ? ocean.reduce((s, v) => s + v, 0) / ocean.length : NaN;
  $('p-len').textContent = `${len.toLocaleString('en-US', { maximumFractionDigits: len < 100 ? 1 : 0 })} km`;
  $('p-min').textContent = formatDepth(Math.min(...h.filter(Number.isFinite)));
  $('p-meas').textContent = Number.isFinite(meas) ? `${Math.round(meas * 100)}%` : 'n/a';
  $('profile-stats').hidden = false;
  $('profile-status').hidden = true;
  return { len, z, min: Math.min(...h), meas };
}
map.on('click', (e) => {
  if (profiling) {
    const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    if (!profileA || profilePts) {
      profileA = p; profilePts = null; chart.set(null); setProfileSource(p, null);
      $('profile-stats').hidden = true; $('profile-status').hidden = false;
      $('profile-status').textContent = 'Now click the end point.';
    } else { runProfile(profileA, p); }
    return;
  }
  readout(e.lngLat.lng, e.lngLat.lat);
  if (water.open) water.showColumn(e.lngLat.lng, e.lngLat.lat);
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
  const layers = [...FEATURE_LAYERS, ...overlays.clickableLayers(), ...(eventsUI?.clickable ?? []), ...(certaintyOn.has('seals') ? ['seals'] : []), ...(tPlates.checked ? ['plates'] : [])];
  const hit: MapGeoJSONFeature | undefined = map.queryRenderedFeatures(box, { layers })[0];
  if (!hit) {
    if (marine.on) marine.card(e.lngLat.lng, e.lngLat.lat).then((c) => { if (c) { showCard(c); updatePadding(); } });
    return;
  }
  if (hit.layer.id === 'plates') showPlate(hit.properties);
  else if (hit.layer.id === 'seals') { const [lon, lat] = (hit.geometry as GeoJSON.Point).coordinates; showCard(sealCard(hit.properties as SealProps, lon, lat, ATTRIBUTION_SEALS)); updatePadding(); }
  else if (FEATURE_LAYERS.includes(hit.layer.id)) showFeature(hit.properties as FeatureProps);
  else if (eventsUI && (hit.layer.id === 'quakes' || hit.layer.id === 'seamounts')) {
    const r = eventsUI.card(hit);
    if (r) { showCard(r.card); overlays.highlightGeometry(r.geometry); updatePadding(); }
  }
  else overlays.cardFor(hit).then((c) => { if (c && c !== 'cluster') { showCard(c); updatePadding(); } });
});
for (const id of FEATURE_LAYERS) {
  map.on('mouseenter', id, () => { if (!profiling) map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', id, () => { if (!profiling) map.getCanvas().style.cursor = ''; });
}

// ---------- sea level ----------
// The relief ramp is rebuilt for a sea level L (palette.seaLevelExpression) and swapped in with
// setPaintProperty. At most one swap is in flight: the next one waits for the map's 'render' event, so a
// fast drag or the animation never queues more ramp rebuilds than the GPU draws.
const hypso = await getJSON<Hypsometry>('data/hypsometry.json');
// legend chips use the same tint colours as the map ramp
for (const [k, v] of Object.entries({ '--exposed-lo': EXPOSED_LOW, '--exposed-hi': EXPOSED_HIGH, '--flooded-lo': FLOODED_DEEP, '--flooded-hi': FLOODED_SHALLOW })) document.documentElement.style.setProperty(k, v);
let seaLevel = 0;
let seaApplied = 0;
let seaRenderPending = false;
let seaOpen = false;
const seaRange = $<HTMLInputElement>('sea-range');
const seaStats = { applies: 0, frames: [] as number[], applyToRender: [] as number[] };

function applySeaPaint() {
  if (seaRenderPending || seaApplied === seaLevel) return;
  seaApplied = seaLevel;
  seaRenderPending = true;
  const t0 = performance.now();
  map.setPaintProperty('relief', 'color-relief-color', seaLevelExpression(seaLevel) as never);
  seaStats.applies++;
  map.once('render', () => {
    seaStats.applyToRender.push(performance.now() - t0);
    seaRenderPending = false;
    if (seaApplied !== seaLevel) applySeaPaint();
  });
}

const mkm = (km2: number) => (km2 / 1e6).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function renderSeaStat() {
  if (!hypso) { $('sea-stat').textContent = 'Land-area figures are not available.'; return; }
  const a = landAreaAt(hypso, seaLevel), d = a - hypso.today_km2;
  const pct = (100 * a / hypso.earth_km2).toFixed(1);
  const change = Math.abs(d) < 5e4 ? 'The same as today'
    : `${mkm(Math.abs(d))} million km² ${d > 0 ? 'more' : 'less'} than today`;
  const key = seaLevel < 0 ? '<span class="sea-key"><span class="sea-chip exposed"></span>newly exposed sea floor</span>'
    : seaLevel > 0 ? '<span class="sea-key"><span class="sea-chip flooded"></span>flooded land</span>' : '';
  $('sea-stat').innerHTML = `<span class="sea-area"><strong>${mkm(a)}</strong> million km² above the sea, <strong>${pct}%</strong> of Earth</span><span class="sea-change">${change}${key}</span>`;
}

let hashTimer = 0;
function writeSeaHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    const h = hashWithSea(location.hash, seaOpen ? seaLevel : null);
    if (h !== location.hash && !(h === '' && location.hash === '')) history.replaceState(null, '', h || location.pathname + location.search);
  }, 250);
}

function setSeaLevel(level: number, opts: { fromSlider?: boolean; hash?: boolean } = {}) {
  seaLevel = snapLevel(level);
  if (!opts.fromSlider) seaRange.value = String(Math.round(levelToPos(seaLevel)));
  seaRange.setAttribute('aria-valuetext', formatLevel(seaLevel));
  $('sea-out').textContent = formatLevel(seaLevel);
  $('sea').dataset.dir = seaLevel < 0 ? 'down' : seaLevel > 0 ? 'up' : 'today';
  renderSeaStat();
  const pre = presetFor(seaLevel);
  $('sea-presets').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.level) === seaLevel)));
  $('sea-note').textContent = pre ? pre.note
    : `Drag the slider or press play. Water is coloured by its depth below a sea ${seaLevel < 0 ? 'lowered' : 'raised'} by ${Math.abs(seaLevel).toLocaleString('en-US')} m.`;
  $('sea-marker').style.left = `${(100 * levelToPos(seaLevel)) / SLIDER_MAX}%`;
  $('depth-legend-cap').textContent = seaLevel === 0 ? 'Depth below sea level' : `Depth below the sea at ${formatLevel(seaLevel)}`;
  renderDepth();
  applySeaPaint();
  if (opts.hash !== false) writeSeaHash();
}

// presets, tick labels and the land-share curve, all placed by the slider's own mapping
{
  const order = [...PRESETS].sort((a, b) => a.level - b.level);
  $('sea-presets').innerHTML = order.map((p) =>
    `<button type="button" data-level="${p.level}" aria-pressed="false" aria-label="${p.name}, ${formatLevel(p.level)}">${p.name}${/^[+−-]?\d/.test(p.name) ? '' : `<span>${formatLevel(p.level).replace(' m', '')}</span>`}</button>`).join('');
  const ticks = [SEA_MIN, -2500, -1000, -200, -120, 0, 70, SEA_MAX];
  $('sea-ticks').innerHTML = ticks.map((L) =>
    `<span class="${L === 0 ? 'today' : [SEA_MIN, KNEE_LEVEL, SEA_MAX].includes(L) ? '' : 'minor'}" style="left:${((100 * levelToPos(L)) / SLIDER_MAX).toFixed(2)}%">${L === 0 ? 'today' : formatLevel(L).replace(' m', '')}</span>`).join('');
  let curve = '';
  if (hypso) {
    // land share of Earth vs slider position; y from 24 % (bottom) to 100 % (top) on a square-root scale,
    // which spreads out the 25-45 % range the fine part of the slider covers
    const pts: string[] = [];
    for (let p = 0; p <= SLIDER_MAX; p += 1) {
      const frac = landAreaAt(hypso, posToLevel(p)) / hypso.earth_km2;
      pts.push(`${p},${(40 * (1 - Math.sqrt(Math.max(0, frac - 0.24) / 0.76))).toFixed(2)}`);
    }
    curve = `<svg viewBox="0 0 ${SLIDER_MAX} 40" preserveAspectRatio="none"><path class="land" d="M0,40 L${pts.join(' L')} L${SLIDER_MAX},40 Z"/><path class="edge" d="M${pts.join(' L')}" vector-effect="non-scaling-stroke"/></svg>`;
  }
  $('sea-curve').innerHTML = `${curve}<span class="sea-marker" id="sea-marker"></span><span class="sea-curve-label">share of Earth that is land</span>`;
}

// animation: the slider position moves at constant speed and bounces at the ends, so the fine
// -200..+100 m part of the scale plays slowly and the deep part quickly
const SWEEP_S = 18; // seconds for one end-to-end pass
let playing = false, playDir = -1, playPos = 0, lastT = 0;
function tick(t: number) {
  if (!playing) return;
  if (lastT) {
    const dt = Math.min(0.1, (t - lastT) / 1000);
    if (seaStats.frames.length < 5000) seaStats.frames.push(t - lastT);
    playPos += playDir * (SLIDER_MAX / SWEEP_S) * dt;
    if (playPos <= 0) { playPos = 0; playDir = 1; } else if (playPos >= SLIDER_MAX) { playPos = SLIDER_MAX; playDir = -1; }
    seaRange.value = String(Math.round(playPos));
    setSeaLevel(posToLevel(playPos), { fromSlider: true, hash: false });
  }
  lastT = t;
  requestAnimationFrame(tick);
}
function setPlaying(on: boolean) {
  if (on === playing) return;
  playing = on;
  $('sea-play').setAttribute('aria-pressed', String(on));
  $('sea-play').setAttribute('aria-label', on ? 'Pause sea-level animation' : 'Play sea-level animation');
  if (on) {
    playPos = levelToPos(seaLevel);
    if (playPos <= 0) playDir = 1; else if (playPos >= SLIDER_MAX) playDir = -1;
    lastT = 0;
    requestAnimationFrame(tick);
  } else writeSeaHash();
}

function openSea(level?: number) {
  if (profiling) setProfiling(false);
  water.close();
  timeUI?.close();
  seaOpen = true;
  show('sea', true);
  $('ui').classList.add('sea-open');
  $('sea-btn').setAttribute('aria-pressed', 'true');
  setSeaLevel(level ?? seaLevel);
  updatePadding();
}
function closeSea(hash = true) {
  setPlaying(false);
  const wasOpen = seaOpen;
  seaOpen = false;
  show('sea', false);
  $('ui').classList.remove('sea-open');
  $('sea-btn').setAttribute('aria-pressed', 'false');
  if (seaLevel !== 0) setSeaLevel(0, { hash });
  else if (hash && wasOpen) writeSeaHash();
  updatePadding();
}
$('sea-btn').addEventListener('click', () => (seaOpen ? closeSea() : openSea()));
$('sea-close').addEventListener('click', () => closeSea());
$('sea-play').addEventListener('click', () => setPlaying(!playing));
seaRange.addEventListener('input', () => { setPlaying(false); setSeaLevel(posToLevel(Number(seaRange.value)), { fromSlider: true }); });
$('sea-presets').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-level]');
  if (b) { setPlaying(false); setSeaLevel(Number(b.dataset.level)); }
});
// a hidden tab gets no animation frames; resume cleanly instead of jumping
document.addEventListener('visibilitychange', () => { lastT = 0; });

// ---------- ocean water (WOA23) ----------
const water = new WaterUI({
  map, base: 'woa/',
  beforeOpen: () => { timeUI?.close(); if (seaOpen) closeSea(); if (profiling) setProfiling(false); if (marine.on) marine.set({ on: false }); if (oceanUI?.chlOn) oceanUI.setChl(false); },
  layout: () => updatePadding(),
  seafloorAt: async (lon, lat) => (await sampler.sample([[lon, lat]])).h[0],
  onChange: () => { renderWaterReadout(); syncWaterRow(); },
  underlay: (on) => setUnderlay(on),
});
/** The relief's neutral under-layer while a colour field (ocean water, phytoplankton) is on. */
function setUnderlay(on: boolean) {
  map.setPaintProperty('relief', 'color-relief-color', (on ? underlayExpression() : seaLevelExpression(seaLevel)) as never);
  seaApplied = seaLevel;
  $('depth-legend').hidden = on; // the depth ramp legend does not describe the neutral under-layer
}
const waterReady = await water.init();
// "Ocean water" is a tool (bottom panel) and also a row in the Layers drawer; both drive the same panel
const tWater = $<HTMLInputElement>('t-water');
function syncWaterRow() {
  tWater.checked = water.open;
  $('row-water').classList.toggle('on', water.open);
  updateLayersBadge();
}
tWater.addEventListener('change', () => { if (tWater.checked) water.show(); else water.close(); });
if (!waterReady) $('row-water').hidden = true;

// ---------- keep the globe centred in the part of the screen the panels leave free ----------
const touch = window.matchMedia('(hover: none)').matches;
if (touch) $('readout-hint').textContent = 'Tap the seafloor to read its depth';
const visible = (id: string) => !$(id).hidden && getComputedStyle($(id)).display !== 'none';
const BOTTOM_PANELS = ['sea', 'water', 'profile', 'time'];
/** The tour's panel when it is on screen (it exists only once the tour chunk has loaded). */
function tourEl(): HTMLElement | null { const t = document.getElementById('tour'); return t && !t.hidden && getComputedStyle(t).display !== 'none' ? t : null; }
const phone = () => window.innerWidth <= 760;
function updatePadding() {
  const W = window.innerWidth, H = window.innerHeight;
  const r = (id: string) => $(id).getBoundingClientRect();
  // drawers stop above the legend dock / readout that share their column
  const ui = $('ui').style;
  ui.setProperty('--legend-h', visible('legend') ? `${Math.round(r('legend').height) + 12}px` : '0px');
  ui.setProperty('--readout-h', visible('readout') ? `${Math.round(r('readout').height) + 12}px` : '0px');
  let pad;
  if (phone()) {
    const top = $('topbar').getBoundingClientRect().bottom;
    // the free band is between the top bar and whatever is highest of legend / readout / card / sheet / tabs
    const tops = ['legend', 'readout', 'story-card', 'feature-card', 'stories', 'layers', 'toolbar', 'time-offer', ...BOTTOM_PANELS].filter(visible).map((id) => r(id).top);
    const tabs = document.querySelector('.tabs')!.getBoundingClientRect();
    if (tabs.height) tops.push(tabs.top);
    const tour = tourEl();
    if (tour) tops.push(tour.getBoundingClientRect().top);
    pad = { top: Math.round(top), bottom: Math.round(H - Math.min(H, ...tops)), left: 0, right: 0 };
  } else {
    // padding from where the panels really are: the open drawers pad the sides, the tool bar and an open bottom
    // panel (sea level, ocean water, profile) pad the bottom, the same panel docked right (short windows) the right
    let bottom = visible('toolbar') ? H - r('toolbar').top + 8 : 0;
    let right = visible('layers') ? W - r('layers').left : 0;
    let left = visible('stories') ? r('stories').right : 0;
    const tour = tourEl();
    if (tour) left = Math.max(left, tour.getBoundingClientRect().right); // the tour's bubble sits in the left column
    // a tall open legend (several layers on) is treated like a side panel, so the globe centres beside it
    if (visible('legend') && !$('legend').classList.contains('collapsed') && r('legend').height > 0.28 * H) left = Math.max(left, r('legend').right);
    for (const id of BOTTOM_PANELS) {
      if (!visible(id)) continue;
      const b = r(id);
      if (b.left > W * 0.55) right = Math.max(right, W - b.left);
      else bottom = Math.max(bottom, H - b.top + 12);
    }
    pad = { top: Math.round($('topbar').getBoundingClientRect().bottom + 4), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right) };
  }
  // the loading bar sits at the bottom of the free map area, above whatever UI is lowest there
  const lb = phone() || !visible('time-offer') ? pad.bottom : Math.max(pad.bottom, H - r('time-offer').top);
  $('loading').style.setProperty('--load-bottom', `${lb + 10}px`);
  $('loading').style.setProperty('--load-x', `${Math.round((pad.left + W - pad.right) / 2)}px`);
  const cur = map.getPadding();
  if (cur.top === pad.top && cur.bottom === pad.bottom && cur.left === pad.left && cur.right === pad.right) return;
  map.setPadding(pad); // note: this stops a running camera animation, so callers set it before flying
  fitGlobe();
}

// When the whole Earth is in view and a panel takes part of the window, zoom out just enough that the globe fits
// the free area (padding already centres it there); zoom back when the panel goes, unless the user moved since.
// Zoomed in on a place, only the padding shifts the view.
let fitted: { from: number; to: number } | null = null;
function disk() { const c = map.getCenter(); return globeDisk((ll) => map.project(ll), [c.lng, c.lat]); }
function fitGlobe() {
  if (map.isMoving()) return;
  const W = window.innerWidth, H = window.innerHeight, z = map.getZoom();
  if (fitted && Math.abs(z - fitted.to) > 0.02) fitted = null; // the user zoomed since: leave it
  const d = disk();
  if (!isGlobeScale(d, W, H)) return;
  const free = freeRect(W, H, map.getPadding());
  // a free area this small means the layout is mid-change (or a phone sheet): never chase it
  if (free.right - free.left < 0.3 * W || free.bottom - free.top < 0.3 * H) return;
  const target = fitRadius(free);
  if (d.r > target * 1.01) {
    const to = Math.max(z - 1.5, zoomForRadius(z, d.r, target));
    fitted = { from: fitted?.from ?? z, to };
    map.easeTo({ zoom: to, duration: 450, essential: true });
    map.once('moveend', () => requestAnimationFrame(fitGlobe));
  } else if (fitted && d.r < target * 0.97) {
    const to = Math.min(fitted.from, zoomForRadius(z, d.r, target));
    fitted = to >= fitted.from - 0.01 ? null : { from: fitted.from, to };
    map.easeTo({ zoom: to, duration: 450, essential: true });
    map.once('moveend', () => requestAnimationFrame(fitGlobe));
  }
}

// ---------- minimise the bottom panels to their header bar (remembered for the session) ----------
const MIN_KEY = 'sfa-minimised';
function minStore(): Record<string, boolean> { try { return JSON.parse(sessionStorage.getItem(MIN_KEY) ?? '{}'); } catch { return {}; } }
const MIN_LABEL: Record<string, string> = { sea: 'sea level', water: 'ocean water', profile: 'depth profile', time: 'time' };
function setMinimised(id: string, on: boolean) {
  $(id).classList.toggle('min', on);
  const b = $(`${id}-min`);
  b.setAttribute('aria-expanded', String(!on));
  b.setAttribute('aria-label', `${on ? 'Expand' : 'Minimise'} ${MIN_LABEL[id]}`);
  try { sessionStorage.setItem(MIN_KEY, JSON.stringify({ ...minStore(), [id]: on })); } catch { /* storage blocked: state lasts until reload */ }
  updatePadding();
}
for (const id of BOTTOM_PANELS) {
  $(`${id}-min`).addEventListener('click', () => setMinimised(id, !$(id).classList.contains('min')));
  if (minStore()[id]) setMinimised(id, true);
}

/** QA: the globe disk vs the panels covering it (every visible piece of UI, top bar items included). */
function uiRects(): (Rect & { id: string })[] {
  const els: [string, Element][] = ['stories', 'layers', 'readout', 'story-card', 'feature-card', 'profile', 'sea', 'water', 'time', 'time-offer', 'legend', 'toolbar', 'about', 'settings']
    .filter(visible).map((id) => [id, $(id)]);
  const tour = tourEl();
  if (tour) els.push(['tour', tour]);
  for (const sel of ['.brand', '.search', '#explore-btn', '#tour-btn', '#layers-btn', '#about-btn', '#settings-btn', '.tabs']) {
    const e = document.querySelector(sel)!;
    if (getComputedStyle(e).display !== 'none') els.push([sel, e]);
  }
  return els.map(([id, e]) => { const b = e.getBoundingClientRect(); return { id, left: b.left, top: b.top, right: b.right, bottom: b.bottom }; })
    .filter((x) => x.right > x.left && x.bottom > x.top);
}
function layoutCheck() {
  const W = window.innerWidth, H = window.innerHeight;
  const d = disk();
  const rects = uiRects();
  const cov = diskCoverage(d, rects, { left: 0, top: 0, right: W, bottom: H });
  const free = freeRect(W, H, map.getPadding());
  return { W, H, zoom: +map.getZoom().toFixed(2), disk: { cx: Math.round(d.cx), cy: Math.round(d.cy), r: Math.round(d.r) }, globeScale: isGlobeScale(d, W, H),
    pad: map.getPadding(), free, centreFree: inside(d.cx, d.cy, free) && !rects.some((rc) => inside(d.cx, d.cy, rc)),
    freeFrac: +cov.freeFrac.toFixed(3), panels: rects.map((x) => ({ id: x.id, top: Math.round(x.top), left: Math.round(x.left), h: Math.round(x.bottom - x.top), w: Math.round(x.right - x.left) })) };
}
/** QA: share of the window where the map is not under any UI (4 px grid, by hit testing). */
function mapShare() {
  const W = window.innerWidth, H = window.innerHeight, m = $('map');
  let n = 0, covered = 0;
  for (let y = 2; y < H; y += 4) for (let x = 2; x < W; x += 4) { n++; const e = document.elementFromPoint(x, y); if (e && !m.contains(e)) covered++; }
  return +(1 - covered / n).toFixed(3);
}
{
  let raf = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(updatePadding); });
  for (const id of ['ui', 'topbar', 'readout', 'stories', 'layers', 'legend', 'toolbar', 'profile', 'sea', 'water', 'time', 'time-offer', 'story-card', 'feature-card']) ro.observe($(id));
}

// ---------- panels: drawers, legend dock, popovers, info notes (open state remembered in localStorage) ----------
type UiKey = 'explore' | 'layers' | 'legend';
const UI_KEY = 'sfa-ui';
function uiStore(): Partial<Record<UiKey, boolean>> { try { return JSON.parse(localStorage.getItem(UI_KEY) ?? '{}'); } catch { return {}; } }
function saveUi(k: UiKey, v: boolean) { try { localStorage.setItem(UI_KEY, JSON.stringify({ ...uiStore(), [k]: v })); } catch { /* storage blocked: state lasts until reload */ } }

function setDrawer(name: 'explore' | 'layers', open: boolean, save = true) {
  $('ui').classList.toggle(`${name}-open`, open);
  $(`${name}-btn`).setAttribute('aria-expanded', String(open));
  if (save) saveUi(name, open);
  updatePadding();
}
for (const name of ['explore', 'layers'] as const) {
  $(`${name}-btn`).addEventListener('click', () => {
    const open = !$('ui').classList.contains(`${name}-open`);
    setDrawer(name, open);
    if (open) ($(name === 'explore' ? 'stories' : 'layers').querySelector('button, input') as HTMLElement | null)?.focus({ preventScroll: true });
  });
}
document.querySelectorAll<HTMLButtonElement>('[data-drawer]').forEach((b) => b.addEventListener('click', () => {
  if (phone()) { setTab('none'); return; }
  const name = b.dataset.drawer === 'stories' ? 'explore' : 'layers';
  setDrawer(name, false);
  $(`${name}-btn`).focus();
}));

// legend dock: one section per layer on the map; hidden when nothing needs a key
function setLegend(open: boolean, save = true) {
  $('legend').classList.toggle('collapsed', !open);
  $('legend-toggle').setAttribute('aria-expanded', String(open));
  if (save) saveUi('legend', open);
  updatePadding();
}
$('legend-toggle').addEventListener('click', () => setLegend($('legend').classList.contains('collapsed')));
function legendSections() { return [...$('legend-body').children].filter((s) => !(s as HTMLElement).hidden) as HTMLElement[]; }
function refreshLegend() {
  const secs = legendSections();
  $('legend').hidden = secs.length === 0;
  $('legend-n').textContent = secs.length > 1 ? String(secs.length) : '';
  updateLayersBadge();
}
new MutationObserver(refreshLegend).observe($('legend-body'), { subtree: true, attributes: true, attributeFilter: ['hidden'] });

/** Count of switched-on layers on the Layers button (named features, on by default, is not counted). */
function updateLayersBadge() {
  const ids = [...document.querySelectorAll<HTMLInputElement>('#layers input[role="switch"]')].filter((t) => t.id !== 't-features' && t.checked && !t.closest('[hidden]'));
  const b = $('layers-count');
  b.hidden = ids.length === 0;
  b.textContent = String(ids.length);
  $('layers-btn').setAttribute('aria-label', ids.length ? `Layers, ${ids.length} on` : 'Layers');
}

// (i) notes in the layer rows
document.querySelectorAll<HTMLButtonElement>('.info-btn').forEach((b) => b.addEventListener('click', () => {
  const open = b.getAttribute('aria-expanded') !== 'true';
  b.setAttribute('aria-expanded', String(open));
  $(b.getAttribute('aria-controls')!).hidden = !open;
}));

// popovers: About this map, Map settings (one at a time; Esc or a click outside closes and returns focus)
const POPS: Record<string, string> = { about: 'about-btn', settings: 'settings-btn' };
let openPop: string | null = null;
function setPopover(id: string | null, focusBack = false) {
  const prev = openPop;
  openPop = id;
  for (const [p, b] of Object.entries(POPS)) { $(p).hidden = p !== id; $(b).setAttribute('aria-expanded', String(p === id)); }
  if (id) {
    const first = id === 'settings' ? $('exag') : $('about');
    if (id === 'about') $('about').tabIndex = -1;
    first.focus({ preventScroll: true });
  } else if (focusBack && prev) $(POPS[prev]).focus();
}
for (const [p, b] of Object.entries(POPS)) $(b).addEventListener('click', () => setPopover(openPop === p ? null : p));
document.addEventListener('pointerdown', (e) => {
  if (!openPop) return;
  const t = e.target as Node;
  if (!$(openPop).contains(t) && !$(POPS[openPop]).contains(t)) setPopover(null);
});

// keyboard: Cmd/Ctrl+K or / focuses search, Esc closes a popover
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
if (!isMac) { $('search-key').textContent = 'Ctrl K'; $('about-cmd').textContent = 'Ctrl K'; }
function focusSearch() { setPopover(null); input.focus(); input.select(); }
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const typing = t.matches?.('input:not([type="checkbox"]):not([type="range"]), textarea, select') || t.isContentEditable;
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); focusSearch(); return; }
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); focusSearch(); return; }
  if (e.key === 'Escape' && openPop) { e.preventDefault(); setPopover(null, true); }
});

// ---------- phone: tabs for the bottom sheet (Explore / Layers / Tools) ----------
// tapping the open tab again folds the sheet away so more of the globe shows
const TAB_PANEL: Record<string, string> = { stories: 'stories', layers: 'layers', tools: 'toolbar' };
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('.tabs button')];
function setTab(tab: string) {
  $('ui').dataset.tab = tab;
  tabButtons.forEach((x) => { x.setAttribute('aria-selected', String(x.dataset.tab === tab)); x.tabIndex = x.dataset.tab === tab || (tab === 'none' && x === tabButtons[0]) ? 0 : -1; });
  updatePadding();
}
tabButtons.forEach((b) => b.addEventListener('click', () => setTab($('ui').dataset.tab === b.dataset.tab ? 'none' : b.dataset.tab!)));
$('ui').querySelector('.tabs')!.addEventListener('keydown', (e) => {
  const k = (e as KeyboardEvent).key;
  if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
  const i = tabButtons.indexOf(document.activeElement as HTMLButtonElement);
  const next = tabButtons[(i + (k === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length];
  next.focus(); setTab(next.dataset.tab!); e.preventDefault();
});
// the drawers and the tool list are tab panels only on a phone
const phoneMq = window.matchMedia('(max-width: 760px)');
const LABELLED: Record<string, string | null> = { stories: 'stories-title', layers: 'layers-title', toolbar: null };
function applyPhoneRoles() {
  for (const [tab, panel] of Object.entries(TAB_PANEL)) {
    const el = $(panel);
    if (phoneMq.matches) { el.setAttribute('role', 'tabpanel'); el.setAttribute('aria-labelledby', `tab-${tab}`); }
    else { el.removeAttribute('role'); const l = LABELLED[panel]; if (l) el.setAttribute('aria-labelledby', l); else el.removeAttribute('aria-labelledby'); }
  }
}
phoneMq.addEventListener('change', () => { applyPhoneRoles(); updatePadding(); });
applyPhoneRoles();
// on a phone a tool closes the sheet it was opened from
for (const id of ['profile-btn', 'sea-btn', 'water-btn', 'time-btn']) $(id).addEventListener('click', () => { if (phone()) setTab('none'); });

// restore remembered panel state (desktop drawers closed and the legend open the first time; phone legend folded)
{
  const st = uiStore();
  setDrawer('explore', st.explore ?? false, false);
  setDrawer('layers', st.layers ?? false, false);
  setLegend(st.legend ?? !phone(), false);
  setTab('none');
  refreshLegend();
}
updatePadding();
// map first: the opening globe fills the free area (a deep-linked story or place moves the camera afterwards)
{
  const W = window.innerWidth, H = window.innerHeight, d = disk();
  const target = 0.96 * fitRadius(freeRect(W, H, map.getPadding()));
  if (isGlobeScale(d, W, H) && d.r < 0.97 * target) map.jumpTo({ zoom: zoomForRadius(map.getZoom(), d.r, target) });
}

// ---------- new layers: earthquakes, seamounts, phytoplankton, winds, currents ----------
// Each module (and its data) loads the first time one of its switches is used; until then a one-shot listener
// on the switch loads it and passes the click on (the module's own listeners take over after that).
let eventsP: Promise<EventsUI> | null = null, oceanP: Promise<OceanUI> | null = null;
function loadEvents(): Promise<EventsUI> {
  eventsP ??= import('./events-ui').then((m) => (eventsUI = new m.EventsUI({ map, dataBase, onChange: layersChanged, offerTime: () => offerTime('quakes') })));
  return eventsP;
}
function loadOcean(): Promise<OceanUI> {
  oceanP ??= import('./ocean-ui').then((m) => {
    const o = new m.OceanUI({
      map,
      beforeChl: () => { if (water.open) water.close(); water.hideLayer(); if (marine.on) marine.set({ on: false }); },
      underlay: (on) => setUnderlay(on),
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
boot('t-quakes', () => !!eventsUI, loadEvents, (u, on) => u.setQuakes(on));
boot('t-seamounts', () => !!eventsUI, loadEvents, (u, on) => u.setSeamounts(on));
boot('t-chl', () => !!oceanUI, loadOcean, (u, on) => u.setChl(on));
boot('t-winds', () => !!oceanUI, loadOcean, (u, on) => u.setFlow('wind', on));
boot('t-currents', () => !!oceanUI, loadOcean, (u, on) => u.setFlow('currents', on));
if (synthetic) for (const id of ['row-quakes', 'row-seamounts']) $(id).hidden = true;

/** Something on the map changed: hash, badge, readout, the Time panel's targets, the tool-bar dot. */
function layersChanged() {
  writeLayersHash();
  updateLayersBadge();
  timeUI?.layerChanged();
  updateTimeDot();
  if (lastPoint) renderExtra(lastPoint[0], lastPoint[1]);
}
async function applyExtra(tokens: string[]) {
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

// ---------- the Time panel ----------
const timeAware = () => !!(eventsUI?.quakesOn && eventsUI.quakeMode === 'history') || overlays.on.has('cables') || overlays.on.has('wind') || !!oceanUI?.chlOn || !!oceanUI?.flow;
function updateTimeDot() { $('time-dot').hidden = !!timeUI?.open || !timeAware(); }
const OFFER: Record<YearSet | 'months', string> = {
  quakes: 'Earthquakes since 1900 can play year by year.',
  cables: 'Cables can appear in the year they entered service.',
  wind: 'Wind farms can appear in the year they started.',
  mapping: 'See how much of the seafloor each GEBCO release had measured.',
  months: 'This layer changes with the seasons, month by month.',
};
let offerWhat: YearSet | 'months' = 'quakes', offerTimer = 0;
function hideOffer() { clearTimeout(offerTimer); if (!$('time-offer').hidden) { $('time-offer').hidden = true; updatePadding(); } }
/** A time-aware layer went on: offer the Time panel once per layer and session (the tool-bar dot stays). */
function offerTime(what: YearSet | 'months') {
  updateTimeDot();
  if (touring || timeUI?.open || seaOpen || water.open || profiling) return;
  try { if (sessionStorage.getItem(`sfa-offer-${what}`)) return; sessionStorage.setItem(`sfa-offer-${what}`, '1'); } catch { /* storage blocked: offer every time */ }
  offerWhat = what;
  $('time-offer-text').textContent = OFFER[what];
  $('time-offer').hidden = false;
  updatePadding();
  clearTimeout(offerTimer);
  offerTimer = window.setTimeout(hideOffer, 10000);
}
$('time-offer-go').addEventListener('click', () => { hideOffer(); openTime(offerWhat === 'months' ? { mode: 'months' } : { mode: 'years', set: offerWhat }); });
$('time-offer-x').addEventListener('click', hideOffer);
document.querySelectorAll<HTMLButtonElement>('[data-time]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.time!;
  if (phone()) setTab('none');
  openTime(k === 'months' ? { mode: 'months' } : { mode: 'years', set: k as YearSet });
}));

let historyP: Promise<HistoryUI | null> | null = null;
function loadHistory(): Promise<HistoryUI | null> {
  historyP ??= synthetic ? Promise.resolve(null) : import('./history-ui').then(async (m) => {
    const h = new m.HistoryUI(map, rasterTileSize, meta!.veilMax);
    return (await h.init()) ? (historyUI = h) : null;
  }).catch(() => null);
  return historyP;
}
function renderHistoryKey(y: number) {
  const chip = (c: string) => `<span class="history-chip" style="background:${c}" aria-hidden="true"></span>`;
  $('history-key').innerHTML = `<li>${chip('#ffc95c')}<span>Newly measured in GEBCO_${y}</span></li>`
    + `<li>${chip('linear-gradient(90deg, #3a84ba, #c4eef4)')}<span>Measured in an earlier release (darker = earlier)</span></li>`
    + `<li><span class="veil-chip dim" aria-hidden="true"></span><span>Not measured in ${y}: depth estimated</span></li>`;
  $('lg-history-t').textContent = `Seafloor measured, GEBCO_${y}`;
}
const fmtN = (n: number) => Math.round(n).toLocaleString('en-US');
const QUAKE_ATT = 'Earthquakes: USGS ANSS ComCat (public domain)';
const CHL_ATT = 'Chlorophyll-a: NASA OBPG, MODIS-Aqua R2022.0 climatology (doi:10.5067/AQUA/MODIS/L3M/CHL/2022.0)';
const WIND_ATT = 'Winds: NCEP/NCAR Reanalysis 1, 1991-2020 monthly means (NOAA PSL)';
const CURRENT_ATT = 'Currents: OSCAR v2.0 (ESR, NASA PO.DAAC), 2015-2024 monthly means';
const SEA_ATT = 'Sea level: Lambeck et al. (2014) PNAS, doi:10.1073/pnas.1411762111';

let timeP: Promise<TimeUI> | null = null;
function loadTime(): Promise<TimeUI> {
  timeP ??= (async () => {
    const [m, seaJson, hist] = await Promise.all([import('./time-ui'), synthetic ? null : getJSON<unknown>('data/sea-level-history.json'), loadHistory()]);
    const sea = parseSeaHistory(seaJson);
    let cablesT: Awaited<ReturnType<OverlayUI['cableTimeline']>> | null = null;
    let windT: Awaited<ReturnType<OverlayUI['windTimeline']>> | null = null;
    const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    const years: Record<YearSet, YearTarget | null> = {
      quakes: synthetic ? null : {
        available: true, supportsOnly: true,
        isOn: () => !!eventsUI?.quakesOn,
        turnOn: async () => { const u = await loadEvents(); if (u.quakeMode === 'live') await u.setQuakeMode('history'); await u.setQuakes(true); },
        timeline: async () => { const t = await (await loadEvents()).timeline(); return { first: t.first, last: t.last, values: t.count, unit: 'earthquakes per year' }; },
        apply: async (y, only) => { const u = await loadEvents(); await u.setYear(y, only); u.refreshLegend(); },
        headline: (y, only) => eventsUI!.headline(y, only),
        pulse: (y) => eventsUI?.pulse(y),
        note: `${QUAKE_ATT}. Older catalogues miss more of the smaller events, so part of the rise over the century is better detection.`,
      },
      cables: {
        available: true,
        isOn: () => overlays.on.has('cables'),
        turnOn: () => overlays.set('cables', true),
        timeline: async () => { cablesT = await overlays.cableTimeline(); return { first: cablesT.first, last: cablesT.last, values: span(cablesT.first, cablesT.last).map(cablesT.perYear), unit: 'cables entering service per year' }; },
        apply: (y) => overlays.setCableYear(y),
        headline: (y) => {
          const c = cablesT!.at(y);
          return { main: `<strong>${fmtN(c.cables)}</strong> cables in service, ${fmtN(c.km)} km of them`,
            sub: `${fmtN(c.added)} entered service in ${y} (drawn wider)${c.planned ? `; ${fmtN(c.planned)} were still planned in the 2022 snapshot, dashed` : ''}.` };
        },
        note: `${ATTRIBUTION.cables}. Ready-for-service years as listed in November 2022; cables laid since are missing.`,
      },
      wind: {
        available: true,
        isOn: () => overlays.on.has('wind'),
        turnOn: () => overlays.set('wind', true),
        timeline: async () => { windT = await overlays.windTimeline(); return { first: windT.first, last: windT.last, values: span(windT.first, windT.last).map(windT.perYear), unit: 'farms started per year' }; },
        apply: (y) => overlays.setWindYear(y),
        headline: (y) => {
          const w = windT!.at(y);
          return { main: `<strong>${fmtN(w.farms)}</strong> offshore wind farms, ${(w.mw / 1000).toFixed(1)} GW`,
            sub: `${fmtN(w.added)} started in ${y}. Only the ${fmtN(w.dated)} of ${fmtN(windT!.total)} farms with a start year in OpenStreetMap are shown.` };
        },
        note: `Offshore wind farms: ${ATTRIBUTION.osm}. Start years as tagged by mappers.`,
      },
      mapping: hist ? {
        available: true,
        isOn: () => timeUI?.open === true && timeUI.mode === 'years' && timeUI.set === 'mapping',
        turnOn: async () => {},
        timeline: async () => { const [a, b] = hist.range; return { first: a, last: b, values: hist.values(), unit: 'share of the seafloor measured' }; },
        apply: (y) => { hist.set(y); $('lg-history').hidden = y === null; if (y !== null) renderHistoryKey(hist.year ?? y); },
        headline: (y) => hist.headline(y),
        note: `${hist.man!.attribution}. Ours counts 15″ cells holding a direct measurement (GEBCO type 10–17); Seabed 2030 counts cells of a depth-dependent grid, so the two figures differ.`,
      } : null,
    };
    const months: Record<MonthId, MonthTarget | null> = {
      temp: waterReady ? {
        label: 'Sea temperature', period: '1991–2020', available: true, attribution: 'Sea temperature: World Ocean Atlas 2023 (NOAA NCEI), 1991–2020',
        isOn: () => water.headless,
        setOn: async (on) => {
          if (on) { if (oceanUI?.chlOn) await oceanUI.setChl(false); if (marine.on) await marine.set({ on: false }); await water.showLayer(timeUI?.month ?? 0); }
          else water.hideLayer();
          layersChanged();
        },
        apply: async (mo) => { if (!water.headless) return; if (mo) await water.showLayer(mo); else water.hideLayer(); },
      } : null,
      chl: {
        label: 'Phytoplankton', period: '2003–2026', available: true, attribution: CHL_ATT,
        isOn: () => !!oceanUI?.chlOn,
        setOn: async (on) => { const o = await loadOcean(); await o.setMonth(timeUI?.month ?? 0); await o.setChl(on); },
        apply: async (mo) => { if (oceanUI) await oceanUI.setMonth(mo); },
      },
      wind: {
        label: 'Winds', period: '1991–2020', available: true, attribution: WIND_ATT,
        isOn: () => oceanUI?.flow === 'wind',
        setOn: async (on) => { const o = await loadOcean(); await o.setMonth(timeUI?.month ?? 0); await o.setFlow('wind', on); },
        apply: async (mo) => { if (oceanUI) await oceanUI.setMonth(mo); },
      },
      currents: {
        label: 'Currents', period: '2015–2024', available: true, attribution: CURRENT_ATT,
        isOn: () => oceanUI?.flow === 'currents',
        setOn: async (on) => { const o = await loadOcean(); await o.setMonth(timeUI?.month ?? 0); await o.setFlow('currents', on); },
        apply: async (mo) => { if (oceanUI) await oceanUI.setMonth(mo); },
      },
    };
    const ago = sea ? {
      history: sea,
      attribution: sea.attribution ?? SEA_ATT,
      apply: (L: number | null) => { if (L === null) { if (!seaOpen) setSeaLevel(0, { hash: false }); } else setSeaLevel(L, { hash: false }); },
      landNote: (L: number) => {
        if (!hypso) return '';
        const d = landAreaAt(hypso, L) - hypso.today_km2;
        return Math.abs(d) < 5e4 ? 'about today’s coastline' : `${mkm(Math.abs(d))} million km² ${d > 0 ? 'more' : 'less'} land than today`;
      },
    } : null;
    const t = new m.TimeUI({
      beforeOpen: () => { hideOffer(); if (seaOpen) closeSea(false); water.close(); if (profiling) setProfiling(false); },
      layout: () => updatePadding(),
      onChange: () => { updateTimeDot(); eventsUI?.refreshLegend(); updateLayersBadge(); },
    }, years, months, ago);
    timeUI = t;
    return t;
  })();
  return timeP;
}
async function openTime(s?: TimeState | { mode: TimeMode; set?: YearSet }) { const t = await loadTime(); await t.show(s); }
$('time-btn').addEventListener('click', () => { if (!timeUI) openTime(); });

// ---------- loading indicator ("Loading detail · 64%") ----------
// Counts map tile requests: the sfa:// protocol (static tiles and PMTiles range reads) and the history tiles
// through tilesource.tileActivity, every other source through MapLibre's tile events. Shown only for bursts
// longer than 300 ms, 100 % then a fade when the map is idle; it never takes pointer events.
const meter = new LoadMeter();
const PROTOCOL_SOURCES = new Set(['dem-terrain', 'dem-relief', 'veil', 'history']);
const loadTrace: { t: number; visible: boolean; pct: number }[] = [];
let loadShowTimer = 0, loadHideTimer = 0, loadRaf = 0, loadAnnounced = false;
const loadLabel = () => (map.getZoom() > meta!.maxzoom + 0.4 ? 'Loading detail' : 'Loading map');
function loadDraw() {
  loadRaf = 0;
  const v = meter.view(), el = $('loading');
  if (v.visible) {
    clearTimeout(loadHideTimer);
    if (el.hidden) { el.hidden = false; void el.offsetWidth; }
    el.classList.add('on');
    $('loading-text').textContent = loadLabel();
    $('loading-pct').textContent = `${v.pct}%`;
    $('loading-fill').style.width = `${v.pct}%`;
    if (!loadAnnounced) { loadAnnounced = true; $('loading-live').textContent = `${loadLabel()}…`; }
    if (loadTrace.length < 4000) loadTrace.push({ t: Math.round(performance.now()), visible: true, pct: v.pct });
  }
}
const loadSchedule = () => { if (!loadRaf) loadRaf = requestAnimationFrame(loadDraw); };
function loadStart() {
  const fresh = meter.done;
  meter.start();
  if (fresh) { clearTimeout(loadShowTimer); loadShowTimer = window.setTimeout(loadSchedule, meter.delay + 5); } else loadSchedule();
}
function loadFinish() { meter.finish(); if (!meter.done) loadSchedule(); }
function loadEnd() {
  const shown = meter.shown;
  if (!meter.end()) return;
  clearTimeout(loadShowTimer);
  if (!shown) return;
  $('loading-pct').textContent = '100%';
  $('loading-fill').style.width = '100%';
  loadTrace.push({ t: Math.round(performance.now()), visible: true, pct: 100 });
  clearTimeout(loadHideTimer);
  loadHideTimer = window.setTimeout(() => {
    $('loading').classList.remove('on');
    loadTrace.push({ t: Math.round(performance.now()), visible: false, pct: 100 });
    loadAnnounced = false;
    $('loading-live').textContent = '';
    window.setTimeout(() => { if (meter.done) $('loading').hidden = true; }, 300);
  }, 450);
}
tileActivity.start = loadStart;
tileActivity.finish = loadFinish;
map.on('dataloading', (e) => { const d = e as unknown as { dataType?: string; tile?: unknown; sourceId?: string }; if (d.dataType === 'source' && d.tile && !PROTOCOL_SOURCES.has(d.sourceId ?? '')) loadStart(); });
map.on('data', (e) => { const d = e as unknown as { dataType?: string; tile?: unknown; sourceId?: string }; if (d.dataType === 'source' && d.tile && !PROTOCOL_SOURCES.has(d.sourceId ?? '')) loadFinish(); });
map.on('idle', loadEnd);

// ---------- guided tour (tour.ts and its chapters load on first use) ----------
// The tour drives the same functions as the controls: layers by their #layers= tokens (plus the seafloor
// switches), one tool at a time, the camera, the exaggeration and the drawers. Exiting puts them back.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
/** Every layer that is on, as tokens (veil, plates, new2026, the depth-certainty ids, marine, and #layers= tokens). */
function layerTokens(): string[] {
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
async function setLayerTokens(tokens: string[]) {
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
function toolState(): TourTool {
  if (profiling) return profileA && profilePts ? { kind: 'profile', a: profileA, b: profilePts[profilePts.length - 1] } : { kind: 'profile' };
  if (seaOpen) return { kind: 'sea', level: seaLevel };
  if (water.open) return { kind: 'water', v: water.v, depth: water.depth };
  if (timeUI?.open) return { kind: 'time', state: timeUI.state };
  return { kind: 'none' };
}
async function setToolState(t: TourTool) {
  setPlaying(false);
  if (t.kind !== 'profile' && profiling) setProfiling(false);
  if (t.kind !== 'sea' && seaOpen) closeSea();
  if (t.kind !== 'water' && water.open) water.close();
  if (t.kind !== 'time' && timeUI?.open) timeUI.close();
  if (t.kind === 'profile') {
    if (!profiling) setProfiling(true);
    if (t.a && t.b) { profileA = t.a; await runProfile(t.a, t.b); }
  } else if (t.kind === 'sea') openSea(t.level);
  else if (t.kind === 'water' && waterReady) {
    await water.show({ v: t.v, depth: t.depth });
    if (t.column) await water.showColumn(t.column[0], t.column[1]);
  } else if (t.kind === 'time') { await openTime(t.state); await timeUI?.ready(); }
}
const tourHost: TourHost = {
  phone,
  reduceMotion: () => reduceMotion.matches,
  getLayers: layerTokens,
  setLayers: setLayerTokens,
  getTool: toolState,
  setTool: setToolState,
  getExaggeration: () => (exagAuto ? 'auto' : exagValue),
  setExaggeration: (v) => {
    exagAuto = v === 'auto';
    $<HTMLInputElement>('exag-auto').checked = exagAuto;
    applyExaggeration(v === 'auto' ? autoExaggeration(map.getZoom()) : v);
  },
  getDrawers: () => ({ explore: $('ui').classList.contains('explore-open'), layers: $('ui').classList.contains('layers-open') }),
  setDrawers: (d) => { setDrawer('explore', d.explore, false); setDrawer('layers', d.layers, false); },
  camera: () => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat, zoom: map.getZoom() }; },
  fly: (cam, instant) => new Promise<void>((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; clearTimeout(guard); res(); } };
    const guard = window.setTimeout(fin, 9000);
    map.stop(); // ends a running move first, so its moveend does not resolve this one
    if (instant) { map.jumpTo(cam); requestAnimationFrame(() => fin()); return; }
    map.once('moveend', fin);
    // a fixed duration (as the guided views use): MapLibre's maxDuration would turn a long flight into a jump
    map.flyTo({ ...cam, duration: 4200, curve: 1.42, essential: true });
  }),
  stop: () => { map.stop(); },
  idle: (maxMs) => Promise.race([idle(), new Promise<void>((r) => setTimeout(r, maxMs))]),
  layout: updatePadding,
  fit: () => fitGlobe(),
  setTouring: (on) => {
    touring = on;
    $('ui').classList.toggle('touring', on);
    $('tour-btn').setAttribute('aria-pressed', String(on));
    if (on) { setPopover(null); hideOffer(); setTab('none'); show('story-card', false); show('feature-card', false); markStory(null); currentStory = null; }
    updatePadding();
  },
  onUserMove: (cb) => {
    const h = (e: { originalEvent?: unknown }) => { if (e.originalEvent) cb(); };
    map.on('movestart', h);
    return () => { map.off('movestart', h); };
  },
  timePlay: (on) => { if (timeUI?.open || !on) timeUI?.setPlaying(on); },
  focusStart: () => $('tour-btn').focus({ preventScroll: true }),
};
let tour: Tour | null = null;
let tourP: Promise<Tour> | null = null;
function loadTour(): Promise<Tour> {
  tourP ??= import('./tour').then((m) => (tour = new m.Tour(tourHost)));
  return tourP;
}
async function startTour(n = 1) { await (await loadTour()).start(n); }
$('tour-btn').addEventListener('click', () => { if (tour?.active) tour.exit(); else startTour(1); });

// ---------- deep link ----------
function storyFromHash() {
  const m = /story=([\w-]+)/.exec(location.hash);
  return m ? stories.find((s) => s.id === m[1]) : undefined;
}
const linked = storyFromHash();
const linkedSea = seaFromHash(location.hash); // read before playStory rewrites the hash
const linkedLayers = layersFromHash(location.hash);
// read before playStory rewrites the hash, so #story=x&water=t-0 keeps its water part
const linkedWater = waterReady ? water.fromHash(location.hash) : null;
const linkedTime = timeFromHash(location.hash);
if (linkedLayers) { overlays.apply(linkedLayers); if (linkedLayers.extra) applyExtra(linkedLayers.extra); }
if (linked) playStory(linked, true);
// #at=lon,lat[,zoom] opens the globe at a place (EEZ report-card links); a story takes precedence
const linkedAt = linked ? null : atFromHash(location.hash);
if (linkedAt) map.jumpTo({ center: [linkedAt.lon, linkedAt.lat], zoom: linkedAt.zoom, pitch: 0, bearing: 0 });
// #sea=<metres> opens the sea-level panel at that level (after a story, which resets it)
if (linkedSea !== null) openSea(linkedSea);
// #water=t-1000 opens the ocean-water panel on that variable and depth
if (linkedWater) water.show({ v: linkedWater.v, depth: linkedWater.depth });
// #time=quakes-2004, #time=month-7, #time=ago-12000 open the Time panel there
if (linkedTime) openTime(linkedTime);
// #tour=5 starts the guided tour at chapter 5 (after the other parts, so exiting returns to them)
const linkedTour = tourFromHash(location.hash);
if (linkedTour) startTour(linkedTour);
// a pasted or edited #story= / #sea= link in an already open tab does not reload the page
window.addEventListener('hashchange', () => {
  const s = storyFromHash();
  if (s && s.id !== currentStory?.id) playStory(s);
  const sea = seaFromHash(location.hash);
  if (sea !== null && (!seaOpen || sea !== seaLevel)) { setPlaying(false); openSea(sea); }
  const w = water.fromHash(location.hash);
  if (w && (!water.open || w.v !== water.v || w.depth !== water.depth)) water.show({ v: w.v, depth: w.depth });
  const ls = layersFromHash(location.hash);
  if (ls && hashWithLayers('', ls) !== hashWithLayers('', { ...overlays.state, extra: extraTokens() })) { overlays.apply(ls); applyExtra(ls.extra ?? []); }
  const ts = timeFromHash(location.hash);
  if (ts && (!timeUI?.open || hashWithTime('', ts) !== hashWithTime('', timeUI.state))) openTime(ts);
  const tn = tourFromHash(location.hash);
  if (tn && (!tour?.active || tour.index !== tn - 1)) startTour(tn);
  const at = s ? null : atFromHash(location.hash);
  if (at) map.flyTo({ center: [at.lon, at.lat], zoom: at.zoom, pitch: 0, bearing: 0, essential: true });
});

// ---------- test/capture hooks ----------
function idle(): Promise<void> { return new Promise((res) => { if (map.loaded() && map.areTilesLoaded()) map.once('idle', () => res()); else map.once('idle', () => res()); map.triggerRepaint(); }); }
Object.assign(window, {
  __seafloor: {
    map, meta, synthetic, idle, rasterTileSize, terrainTileSize,
    playStory: (id: string, instant = true) => { const s = stories.find((x) => x.id === id); if (s) playStory(s, instant); return !!s; },
    setVeil, setPlates, setNew, setFeatures,
    profile: async (a: [number, number], b: [number, number]) => { setProfiling(true); profileA = a; return runProfile(a, b); },
    hoverChart: (frac: number) => { const svg = $('profile-chart').querySelector('svg')!; const r = svg.getBoundingClientRect(); svg.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 60 + frac * (r.width - 72), clientY: r.top + 40 })); },
    readout,
    current: () => currentStory?.id ?? null,
    openSea, closeSea, setSeaLevel: (L: number) => setSeaLevel(L), play: setPlaying,
    seaLevel: () => seaLevel,
    layoutCheck,
    mapShare,
    setMinimised,
    ui: {
      setDrawer: (name: 'explore' | 'layers', open: boolean) => setDrawer(name, open),
      setLegend: (open: boolean) => setLegend(open),
      setTab,
      popover: (id: 'about' | 'settings' | null) => setPopover(id),
      legend: () => ({ shown: !$('legend').hidden, collapsed: $('legend').classList.contains('collapsed'), sections: legendSections().map((x) => x.id) }),
      exaggeration: () => ({ value: exagValue, auto: exagAuto, terrain: map.getTerrain()?.exaggeration ?? null }),
    },
    overlays: {
      set: (id: Parameters<OverlayUI['set']>[0], on: boolean) => overlays.set(id, on),
      /** resolves when a layer's data has loaded and is on the map (true) */
      ready: (id: Parameters<OverlayUI['whenReady']>[0]) => overlays.whenReady(id),
      osm: (on: boolean) => overlays.setOsm(on),
      cableYear: () => ({ ...overlays.year }),
      allWrecks: (on: boolean) => overlays.setAllWrecks(on),
      state: () => ({ ...overlays.state, loadMs: overlays.loadMs,
        visibility: Object.fromEntries(['shipping', 'cables', 'landing-points', 'pipelines', 'platforms', 'wind', 'wrecks'].map((id) => [id, map.getLayoutProperty(id, 'visibility')])) }),
      find: async (key: Parameters<OverlayUI['find']>[0], re: string) => { const f = await overlays.find(key, new RegExp(re)); return f ? { props: f.properties, geometry: f.geometry } : null; },
      /** rendered features of the clickable layers (and labels) in a 6 px box around a screen point */
      hitsAt: (x: number, y: number) => map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: [...FEATURE_LAYERS, ...overlays.clickableLayers()] })
        .map((f) => ({ layer: f.layer.id, name: f.properties?.name ?? null })),
    },
    /** rAF intervals while the camera eases by dLng degrees over ms milliseconds */
    panFrames: (dLng: number, ms: number) => new Promise((res) => {
      const dt: number[] = []; let last = 0, live = true;
      const loop = (t: number) => { if (last) dt.push(t - last); last = t; if (live) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      const c = map.getCenter();
      map.once('moveend', () => {
        live = false;
        const a = [...dt].sort((x, y) => x - y), q = (p: number) => +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2);
        res({ frames: a.length, medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: q(1), over20ms: a.filter((x) => x > 20).length });
      });
      map.easeTo({ center: [c.lng + dLng, c.lat], duration: ms, easing: (t) => t });
    }),
    certainty: {
      ok: certaintyOk,
      set: (id: CertaintyId, on: boolean) => setCertainty(id, on),
      state: () => Object.fromEntries(CERTAINTY_IDS.map((id) => [id, certaintyOk[id] ? map.getLayoutProperty(CERTAINTY_LAYERS[id][0], 'visibility') : 'absent'])),
      probe: async (id: 'disagree' | 'uncertainty', lon: number, lat: number) => {
        const px = await probes[id].at(lon, lat);
        if (!px) return null;
        return id === 'disagree' ? { alpha: px[3], m: disagreeLg ? disagreeFromAlpha(px[3], disagreeLg) : null } : { alpha: px[3], cls: uncertaintyLg ? classFromAlpha(px[3], uncertaintyLg)?.label ?? null : null };
      },
      seals: () => { const src = map.getSource('seals') as GeoJSONSource | undefined; return src ? map.querySourceFeatures('seals').length : 0; },
    },
    marine: {
      ready: marineReady,
      set: (s: Parameters<MarineUI['set']>[0]) => marine.set(s),
      value: (lon: number, lat: number) => marine.value(lon, lat),
      card: (lon: number, lat: number) => marine.card(lon, lat),
      /** resolves when the last requested marine view is drawn */
      drawn: () => marine.whenDrawn().then(() => true),
      state: () => ({ on: marine.on, mode: marine.mode, group: marine.group, renders: marine.stats.renders, lastMs: marine.stats.lastMs,
        visibility: map.getLayer('marine') ? map.getLayoutProperty('marine', 'visibility') : null }),
    },
    extra: (lon: number, lat: number) => renderExtra(lon, lat),
    events: {
      set: async (id: 'quakes' | 'seamounts', on: boolean) => { const u = await loadEvents(); await (id === 'quakes' ? u.setQuakes(on) : u.setSeamounts(on)); return true; },
      mode: async (m: 'history' | 'live') => { await (await loadEvents()).setQuakeMode(m); return true; },
      ready: async (id: 'quakes' | 'seamounts') => (await loadEvents()).whenReady(id),
      state: () => eventsUI && ({ quakes: eventsUI.quakesOn, mode: eventsUI.quakeMode, seamounts: eventsUI.seamountsOn, year: eventsUI.year, only: eventsUI.only,
        liveCount: eventsUI.liveCount, liveError: eventsUI.liveError, loadMs: eventsUI.loadMs,
        visibility: { quakes: map.getLayoutProperty('quakes', 'visibility'), seamounts: map.getLayoutProperty('seamounts', 'visibility') }, filter: map.getFilter('quakes') ?? null }),
      findQuake: async (re: string) => (await loadEvents()).findQuake(new RegExp(re)),
      findSeamount: async (re: string) => (await loadEvents()).findSeamount(new RegExp(re)),
    },
    ocean: {
      set: async (id: 'chl' | 'wind' | 'currents', on: boolean) => { const o = await loadOcean(); await (id === 'chl' ? o.setChl(on) : o.setFlow(id, on)); return true; },
      ready: async (id: 'chl' | 'wind' | 'currents') => (await loadOcean()).whenReady(id),
      month: async (mo: number) => { await (await loadOcean()).setMonth(mo); return true; },
      value: (lon: number, lat: number) => oceanUI?.value(lon, lat) ?? null,
      chlPixel: (lon: number, lat: number) => oceanUI?.chlPixel(lon, lat) ?? null,
      flowStats: () => oceanUI?.flowStats() ?? null,
      preloadMonths: () => oceanUI?.preloadMonths() ?? 0,
      state: () => oceanUI && ({ chl: oceanUI.chlOn, flow: oceanUI.flow, month: oceanUI.month, chlMs: oceanUI.stats.chlMs, running: oceanUI.flowLayer?.running ?? null,
        particles: oceanUI.flowLayer?.particles?.n ?? 0,
        // custom layers are not part of getStyle(): ask the map for each
        layers: ['chl', 'flow-wind', 'flow-currents'].filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none') }),
      /** screen positions of a few particles (to check they sit on the visible globe) */
      sample: (n = 200) => {
        const p = oceanUI?.flowLayer?.particles; if (!p) return [];
        const out: [number, number][] = [];
        for (let i = 0; i < Math.min(n, p.n); i++) { const q = map.project([p.lon[i], p.lat[i]]); out.push([Math.round(q.x), Math.round(q.y)]); }
        return out;
      },
    },
    time: {
      open: async (st?: TimeState | { mode: TimeMode; set?: YearSet }) => { await openTime(st); await timeUI!.ready(); return true; },
      close: () => timeUI?.close(),
      seek: async (v: number) => { await timeUI?.seek(v); await timeUI?.ready(); return true; },
      step: async (dir: number) => { timeUI?.step(dir); await timeUI?.ready(); return true; },
      follow: async (set: YearSet) => { await timeUI?.follow(set); await timeUI?.ready(); return true; },
      only: async (on: boolean) => { document.querySelector<HTMLButtonElement>(`#time-only [data-only="${on ? 1 : 0}"]`)?.click(); await timeUI?.ready(); return true; },
      play: (on: boolean) => timeUI?.setPlaying(on),
      speed: (x: number) => { if (timeUI) timeUI.speed = x; },
      ready: async () => { await timeUI?.ready(); return true; },
      stats: () => timeUI?.takeStats() ?? null,
      state: () => timeUI && ({ open: timeUI.open, mode: timeUI.mode, set: timeUI.set, year: timeUI.year, only: timeUI.only, month: timeUI.month, ago: timeUI.ago, playing: timeUI.playing,
        value: $('time-value').textContent, unit: $('time-unit').textContent, headline: $('time-headline').textContent, sub: $('time-sub').textContent, note: $('time-note').textContent,
        modes: [...document.querySelectorAll<HTMLButtonElement>('#time-modes button')].map((b) => `${b.dataset.mode}:${b.disabled ? 0 : 1}`), seaLevel, hash: location.hash }),
    },
    history: {
      ready: () => loadHistory().then((h) => !!h),
      state: () => ({ year: historyUI?.year ?? null, visibility: map.getLayer('history') ? map.getLayoutProperty('history', 'visibility') : null }),
    },
    tour: {
      /** loads the tour chunk and starts at chapter n; resolves when that chapter has settled */
      start: (n = 1) => startTour(n).then(() => true),
      loaded: () => !!tour,
      chapters: () => tour?.chapters ?? null,
      state: () => tour?.state() ?? null,
      next: async () => { await tour?.next(); return true; },
      back: async () => { await tour?.back(); return true; },
      go: async (i: number) => { await tour?.go(i); return true; },
      play: (on: boolean) => tour?.setPlaying(on),
      voice: (on: boolean) => tour?.setVoice(on),
      exit: async () => { await tour?.exit(); return true; },
      layers: layerTokens,
      tool: toolState,
      snapshot: () => ({ layers: layerTokens(), tool: toolState(), exaggeration: exagAuto ? 'auto' : exagValue,
        drawers: { explore: $('ui').classList.contains('explore-open'), layers: $('ui').classList.contains('layers-open') } }),
    },
    loading: {
      state: () => ({ ...meter.view(), started: meter.started, finished: meter.finished, shown: meter.shown, log: meter.log.slice(-12),
        el: { hidden: $('loading').hidden, on: $('loading').classList.contains('on'), text: $('loading').textContent?.replace(/\s+/g, ' ').trim(), bottom: $('loading').getBoundingClientRect().bottom } }),
      trace: () => loadTrace.slice(),
      clear: () => { loadTrace.length = 0; },
    },
    /** waits until the machine is quiet: rAF intervals over a 0.5 s window with p95 under 20 ms (or gives up) */
    waitQuiet: (maxMs = 8000) => new Promise((res) => {
      const t0 = performance.now(); let win: number[] = [], last = 0;
      const loop = (t: number) => {
        if (last) win.push(t - last); last = t;
        if (win.length >= 30) {
          const a = [...win].sort((x, y) => x - y), p95 = a[Math.floor(0.95 * a.length)];
          if (p95 < 20 || t - t0 > maxMs) { res({ p95: +p95.toFixed(1), waitedMs: Math.round(t - t0) }); return; }
          win = [];
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }),
    /** rAF intervals for ms milliseconds (no camera move) */
    frames: (ms: number) => new Promise((res) => {
      const dt: number[] = []; let last = 0; const t0 = performance.now();
      const loop = (t: number) => { if (last) dt.push(t - last); last = t; if (t - t0 < ms) requestAnimationFrame(loop); else {
        const a = [...dt].sort((x, y) => x - y), q = (p: number) => +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2);
        res({ frames: a.length, medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), over20ms: a.filter((x) => x > 20).length }); } };
      requestAnimationFrame(loop);
    }),
    water: {
      ready: waterReady,
      show: (v?: 't' | 's' | 'd', depth?: number) => water.show({ v, depth }),
      close: () => water.close(),
      set: (s: Parameters<WaterUI['set']>[0]) => water.set(s),
      month: (m: number) => water.set({ month: m }),
      play: (on: boolean) => water.setPlaying(on),
      preloadMonths: () => water.preloadMonths(),
      column: (lon: number, lat: number) => water.showColumn(lon, lat),
      value: (lon: number, lat: number) => water.readout(lon, lat),
      state: () => ({ open: water.open, v: water.v, depth: water.open ? water.depth : null, month: water.month, playing: water.playing,
        visibility: map.getLayer('water') ? map.getLayoutProperty('water', 'visibility') : null }),
      stats: () => water.renderStats(),
    },
    /** frame-time summary since the last call (rAF intervals while playing, ramp swap -> next render) */
    seaStats: () => {
      const q = (xs: number[], p: number) => { const a = [...xs].sort((x, y) => x - y); return a.length ? +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2) : null; };
      const out = { frames: seaStats.frames.length, frameMedianMs: q(seaStats.frames, 0.5), frameP95Ms: q(seaStats.frames, 0.95), frameMaxMs: q(seaStats.frames, 1),
        applies: seaStats.applies, applyToRenderMedianMs: q(seaStats.applyToRender, 0.5), applyToRenderP95Ms: q(seaStats.applyToRender, 0.95) };
      seaStats.frames = []; seaStats.applyToRender = []; seaStats.applies = 0;
      return out;
    },
  },
});
