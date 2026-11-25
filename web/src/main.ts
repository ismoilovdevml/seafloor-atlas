// Seafloor Atlas viewer: start-up. Loads meta.json and the start-up JSON, creates the map, then wires the UI modules in
// a fixed order (each init function below runs where its code ran when this was one module, between the same awaits),
// runs the guided tour's host, applies the deep link and finally replays clicks held during start-up.
//   app-state.ts     shared start-up objects, helpers, flags, exaggeration, one tool at a time
//   layers-ui.ts     relief ramp, satellite land, layer switches, overlays, certainty, marine life, AMOC, legends
//   cards-ui.ts      feature / story cards, guided views, search
//   inspector-ui.ts  hover readout and point inspector
//   click-router.ts  map click dispatch, pointer cursors, right-click menu
//   tools-ui.ts      depth profile, sea level, ocean water, Time panel, tour tool state
//   layout-ui.ts     padding, globe fit, drawers, legend dock, popovers, keyboard, phone tabs, loading indicator
//   qa-hook.ts       window.__seafloor
import '@fontsource-variable/newsreader/opsz.css';
import { atFromHash } from './at';
import { tourLang } from './tour-lang';
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { buildStyle, DOT_IMAGE, makeDot, type Meta } from './style';
import { TileSampler } from './sampler';
import { configureTiles, maxZoomFor, PROTOCOL, protocolHandler, type ChunkedHires } from './tilesource';
import { seaFromHash, type Hypsometry } from './sealevel';
import type { DisagreeLegend, UncertaintyLegend } from './certainty';
import { hashWithLayers, layersFromHash } from './overlays';
import { hashWithTime, timeFromHash } from './timeline';
import { tourFromHash } from './tour-model';
import type { Tour, TourHost } from './tour';
import { FrameGovernor, startQuality } from './quality';
import { mountNav3d } from './nav3d';
import { amocCard } from './amoc';
import { MeasureTool } from './measure';
import { satLandFromHash } from './basemap';
import { RELIEF_PROTOCOL, reliefProtocolHandler, useLowlandIndex } from './lowland';
import { $, appReady, applyExaggeration, autoExaggeration, closeTools, exagAuto, exagValue, getJSON, idle, initExaggeration, markReady,
  phone, reduceMotion, setCore, setExagAuto, setMeasureTool, setTouringFlag } from './app-state';
import { clearCurrentStory, currentStory, initCards, initSearch, initStories, input, loadOverlaySearch, markStory, renderResults, playStory, show, showCard, stories,
  type FeatureProps, type Story } from './cards-ui';
import { closeInspector, initInspector, initReadout, inspect } from './inspector-ui';
import { initClickRouter, initContextMenu } from './click-router';
import { amocLast, applyExtra, extraTokens, initCertainty, initLazyLayers, initMarine, initOverlays, initPolarAndLand, initSatLand,
  initSeafloorLayers, layerTokens, overlays, renderStaticText, satLand, setLayerTokens, setSatLand } from './layers-ui';
import { hideOffer, initProfile, initSea, initTime, initWater, initWaterRow, openSea, openTime, seaLevel, seaOpen, setPlaying, setToolState,
  timeUI, toolState, water, waterReady } from './tools-ui';
import { fitGlobe, initLayout, initLoading, initPanels, setDrawer, setPopover, setTab, updatePadding } from './layout-ui';
import { installQaHook } from './qa-hook';

maplibregl.setWorkerUrl(workerUrl);

const params = new URLSearchParams(location.search);

// Start-up runs through several downloads before every control is wired (the end of this module sets appReady).
// A click on one of these buttons before then is held and replayed once everything is wired, instead of being lost.
// (appReady lives in app-state.ts, false until then: the listener below can run during any of the awaits.)
const EARLY_BUTTONS = new Set(['explore-btn', 'layers-btn', 'tour-btn', 'time-btn', 'sea-btn', 'profile-btn', 'water-btn', 'about-btn', 'settings-btn', 'tab-stories', 'tab-layers', 'tab-tools']);
const earlyClicks: string[] = [];
function holdEarlyClick(e: MouseEvent) {
  if (appReady) return;
  const b = (e.target as Element | null)?.closest?.('button');
  if (!b || !EARLY_BUTTONS.has(b.id)) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const i = earlyClicks.indexOf(b.id);
  if (i >= 0) earlyClicks.splice(i, 1); else earlyClicks.push(b.id); // a second click undoes the first
  b.toggleAttribute('aria-busy', i < 0);
}
document.addEventListener('click', holdEarlyClick, true);

// ---------- tiles: real by default, synthetic on ?tiles=synthetic or when real tiles are absent ----------
// ?tiles=synthetic forces the dev set from scripts/make_synthetic_tiles.mjs
const TILESETS: Record<string, string> = { synthetic: 'tiles-synthetic' };
let tilesBase = TILESETS[params.get('tiles') ?? ''] ?? 'tiles';
// the start-up JSON with fixed paths is requested together with meta.json (one round trip instead of a chain);
// the real-tile ones are dropped if the page falls back to the synthetic set
const realFirst = tilesBase === 'tiles';
const hiresP = realFirst ? getJSON<ChunkedHires>('hires/manifest.json') : Promise.resolve(null);
const legendsP = realFirst
  ? Promise.all([getJSON<DisagreeLegend>('tiles/disagree/legend.json'), getJSON<UncertaintyLegend>('tiles/uncertainty/legend.json')])
  : Promise.resolve([null, null] as const);
const storiesP = getJSON<Story[]>('data/stories.json');
const hypsoP = getJSON<Hypsometry>('data/hypsometry.json');
let meta = await getJSON<Meta>(`${tilesBase}/meta.json`);
if (!meta && tilesBase === 'tiles') { tilesBase = 'tiles-synthetic'; meta = await getJSON<Meta>(`${tilesBase}/meta.json`); }
if (!meta) {
  const dev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  document.body.insertAdjacentHTML('beforeend', dev
    ? '<p class="fatal" style="position:fixed;inset:auto 0 50%;text-align:center">No tiles found. Build them with the pipeline (web/public/tiles) or run <code>npm run synth</code>.</p>'
    : '<p class="fatal" role="alert" style="position:fixed;inset:auto 0 50%;text-align:center">The map data could not be loaded. Check your connection and reload the page.</p>');
  throw new Error('no tiles');
}
const synthetic = tilesBase === 'tiles-synthetic';
const dataBase = synthetic ? 'tiles-synthetic/data' : 'data';
// static z0..meta.maxzoom next to the page, PMTiles above it when meta.hires is set (tilesource.ts)
// the high-resolution archives as static pieces next to the page when the deploy added them (Cloudflare Pages),
// else straight from Hugging Face with range requests (GitHub Pages mirror, local dev)
const chunkedHires = synthetic ? null : await hiresP;
configureTiles(tilesBase, meta.maxzoom, synthetic ? null : meta.hires, chunkedHires);
maplibregl.addProtocol(PROTOCOL, protocolHandler);
// the relief colours read land below sea level as land (lowland.ts); its tile index applies to this tile build only
maplibregl.addProtocol(RELIEF_PROTOCOL, reliefProtocolHandler);
useLowlandIndex(synthetic ? null : (meta.hires as { revision?: string } | null | undefined)?.revision, meta.maxzoom);
const demMaxZoom = maxZoomFor('dem');
/** highest zoom of the static tiles next to the page (fast); above it tiles come from the PMTiles archive */
const staticMaxZoom = Math.min(meta.maxzoom, demMaxZoom);
const sampler = new TileSampler(tilesBase, { ...meta, maxzoom: demMaxZoom });

// ---------- map ----------
// Sharp rasters on high-density screens: our tiles are 512 px; declared as 256 px tiles on a 2x screen MapLibre
// picks one zoom level higher and draws each tile pixel to one device pixel instead of stretching it 2x.
// The files, their zoom levels (z0-5 static, z6-7 PMTiles) and the sampler (which reads the files at their real
// 512 px) are unchanged. ?tilesize=512|256 forces either (QA compares the two).
// pixel ratio and antialiasing for slow GPUs (quality.ts); ?pr= and ?aa= override
const quality = startQuality(window.devicePixelRatio, window.matchMedia('(pointer: coarse)').matches, params);
const forcedTile = Number(params.get('tilesize'));
const rasterTileSize = forcedTile === 256 || forcedTile === 512 ? forcedTile : quality.pixelRatio >= 1.5 ? meta.tileSize / 2 : meta.tileSize;
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
  canvasContextAttributes: { antialias: quality.antialias },
  pixelRatio: quality.pixelRatio,
});
// step the pixel ratio down while the globe moves too slowly on this device (quality.ts)
const governor = new FrameGovernor(quality.pixelRatio, Number(params.get('pr')) > 0);
document.documentElement.dataset.pixelRatio = String(quality.pixelRatio);
let lastMovingFrame = 0;
map.on('render', () => {
  if (!map.isMoving()) { lastMovingFrame = 0; return; }
  const now = performance.now();
  const next = lastMovingFrame ? governor.push(now - lastMovingFrame) : null;
  lastMovingFrame = now;
  if (next !== null) { map.setPixelRatio(next); document.documentElement.dataset.pixelRatio = String(next); lastMovingFrame = 0; }
});
map.setMissingStyleImageResolver((id) => { if (id === DOT_IMAGE && !map.hasImage(DOT_IMAGE)) map.addImage(DOT_IMAGE, makeDot(), { pixelRatio: 2 }); });
setCore({ map, meta, synthetic, tilesBase, dataBase, sampler, demMaxZoom, staticMaxZoom, rasterTileSize, terrainTileSize });
initExaggeration();

// start the start-up JSON downloads now, so they overlap with the style and first tiles instead of queuing after them
// (stories, hypsometry and the depth-certainty legends started with meta.json above)
const featureDataP = getJSON<GeoJSON.FeatureCollection<GeoJSON.Point, FeatureProps>>(`${dataBase}/features.geojson`);
// Wait for the style only, not for 'load': 'load' fires after every first-view tile has arrived, and on a slow
// connection that held back the rest of this module (the Tour button, layers, panels) for tens of seconds.
// Sources and layers can be added as soon as the style is in.
await new Promise<void>((res) => (map.isStyleLoaded() ? res() : map.once('style.load', () => res())));
mountNav3d(map, document.body);
initPolarAndLand();
// "Measure distance" (measure.ts): the ruler under the compass, or right-click on the map
// the ruler works from the first frame, but the panels it closes and the layout code are created further down:
// until the end of this module has run (appReady) there is nothing to close and nothing to lay out yet
const measureTool = new MeasureTool(map, {
  beforeStart: () => { if (appReady) closeTools('measure'); },
  layout: () => { if (appReady) updatePadding(); },
}, document.getElementById('ui')!, document.getElementById('nav-measure') as HTMLButtonElement);
setMeasureTool(measureTool);
initContextMenu();
applyExaggeration(exagValue);

initSatLand();
initSeafloorLayers();
initOverlays();
// how sure is the depth? real tiles only
initCertainty(synthetic ? [null, null] : await legendsP);
// the manifests of marine life and ocean water download alongside the other start-up files (awaited further down)
const marineInitP = initMarine();
const waterInitP = initWater();
renderStaticText();
initCards();
initStories((await storiesP) ?? []);
initSearch(await featureDataP);
initReadout();
initProfile();
initClickRouter();
initInspector();
initSea(await hypsoP);
initWaterRow(await waterInitP);
initLayout();
initPanels();
initLazyLayers();
initTime();
initLoading();

// ---------- guided tour (tour.ts and its chapters load on first use) ----------
// The tour drives the same functions as the controls: layers by their #layers= tokens (plus the seafloor
// switches), one tool at a time, the camera, the exaggeration and the drawers. Exiting puts them back.
const tourHost: TourHost = {
  phone,
  reduceMotion: () => reduceMotion.matches,
  getLayers: layerTokens,
  setLayers: setLayerTokens,
  getTool: toolState,
  setTool: setToolState,
  getExaggeration: () => (exagAuto ? 'auto' : exagValue),
  setExaggeration: (v) => {
    setExagAuto(v === 'auto');
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
    setTouringFlag(on);
    $('ui').classList.toggle('touring', on);
    $('tour-btn').setAttribute('aria-pressed', String(on));
    if (on) { setPopover(null); hideOffer(); setTab('none'); show('story-card', false); show('feature-card', false); closeInspector(); markStory(null); clearCurrentStory(); }
    updatePadding();
  },
  onUserMove: (cb) => {
    const h = (e: { originalEvent?: unknown }) => { if (e.originalEvent) cb(); };
    map.on('movestart', h);
    return () => { map.off('movestart', h); };
  },
  timePlay: (on) => { if (timeUI?.open || !on) timeUI?.setPlaying(on); },
  focusStart: () => $('tour-btn').focus({ preventScroll: true }),
  // a chapter that opens the point inspector or the AMOC card; null closes what a chapter opened
  open: (o) => {
    if (o?.kind === 'inspect') { void inspect(o.at[0], o.at[1]); return; } // inspect() opens the panel and pads synchronously
    if (o?.kind === 'card' && o.id === 'amoc' && amocLast) { showCard(amocCard(amocLast)); updatePadding(); return; }
    show('feature-card', false); closeInspector(); updatePadding();
  },
};
let tour: Tour | null = null;
let tourP: Promise<Tour> | null = null;
function loadTour(): Promise<Tour> {
  const uz = tourLang(navigator.languages ?? [navigator.language], location.hash) === 'uz';
  tourP ??= Promise.all([import('./tour'), uz ? import('./tour-text-uz').then((m) => m.TEXT_UZ) : undefined])
    .then(([m, text]) => (tour = new m.Tour(tourHost, undefined, text)));
  return tourP;
}
async function startTour(n = 1) { await (await loadTour()).start(n); }
$('tour-btn').addEventListener('click', () => { if (tour?.active) tour.exit(); else startTour(1); });

// ---------- deep link ----------
await marineInitP; // the marine-life switch and the tour's layer tokens need its manifest
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
  const sl = satLandFromHash(location.hash);
  if (sl !== satLand) setSatLand(sl, false);
  const at = s ? null : atFromHash(location.hash);
  if (at) map.flyTo({ center: [at.lon, at.lat], zoom: at.zoom, pitch: 0, bearing: 0, essential: true });
});

// ---------- test/capture hooks ----------
installQaHook({ start: startTour, get: () => tour });

// every control above is wired; hooks that ran earlier (the ruler) may now reach the other panels
markReady();
updatePadding();
// replay the clicks held during start-up (holdEarlyClick), and search for what was typed meanwhile
document.removeEventListener('click', holdEarlyClick, true);
for (const id of earlyClicks.splice(0)) { $(id).removeAttribute('aria-busy'); $(id).click(); }
if (document.activeElement === input) { loadOverlaySearch(); if (input.value.trim()) renderResults(); }

