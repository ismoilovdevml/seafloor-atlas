import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { buildStyle, DOT_IMAGE, FEATURE_LAYERS, makeDot, type Meta } from './style';
import { TileSampler } from './sampler';
import { ProfileChart } from './profile-chart';
import { BATHY_STOPS, PLATE_STYLE } from './palette';
import { formatDepth, formatLat, formatLon, greatCircle, haversineKm, profileZoom, unwrapPath } from './geo';

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
const sampler = new TileSampler(tilesBase, meta);

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

const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(tilesBase, dataBase, meta),
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
function setVisible(layer: string | string[], on: boolean) {
  for (const id of ([] as string[]).concat(layer)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
const tVeil = $<HTMLInputElement>('t-veil'), tPlates = $<HTMLInputElement>('t-plates'), tFeatures = $<HTMLInputElement>('t-features');
function setVeil(on: boolean) { tVeil.checked = on; setVisible('veil', on); if (on) $('story-veil').hidden = true; }
function setPlates(on: boolean) { tPlates.checked = on; setVisible('plates', on); $('plate-key').classList.toggle('off', !on); }
tVeil.addEventListener('change', () => setVeil(tVeil.checked));
tPlates.addEventListener('change', () => setPlates(tPlates.checked));
tFeatures.addEventListener('change', () => setVisible(FEATURE_LAYERS, tFeatures.checked));
// newly measured between the GEBCO_2025 and GEBCO_2026 grids (pipeline/change.py); hidden if not built
const tNew = $<HTMLInputElement>('t-new');
const change = meta.change2025to2026;
function setNew(on: boolean) { tNew.checked = on; setVisible('new2026', on); }
tNew.addEventListener('change', () => setNew(tNew.checked));
if (change && (meta.tiles?.new2026 ?? 0) > 0) {
  const mkm = (km2: number) => (km2 / 1e6).toFixed(1);
  $('new-stat').innerHTML = `<strong>${mkm(change.newly_measured_km2)} million km²</strong> of seafloor are newly counted as directly measured `
    + `in the 2026 grid (new surveys and older ones newly shared; measured share ${(100 * change.measured_2025_frac).toFixed(1)}% → ${(100 * change.measured_2026_frac).toFixed(1)}%).`;
} else {
  $('new-layer').hidden = true;
}
setPlates(false);

// measured statistic (meta.stats.measured_fraction_area, area-weighted, TID 10-17)
const mfRaw = meta.stats?.measured_fraction_area;
const mf = typeof mfRaw === 'number' ? mfRaw : NaN;
$('measured-stat').innerHTML = Number.isFinite(mf)
  ? `Ships have directly measured <strong>${(mf * 100).toFixed(1)}%</strong> of the seafloor (Seabed 2030 counts 28.7% for GEBCO 2026 with a slightly different method). The rest is estimated from satellite gravity or interpolation.`
  : 'Coverage statistics are not available for these tiles.';

// plate key (line samples match the map's dash patterns)
const DASH: Record<string, string> = { ridge: '', subduction: '', transform: '4 3', convergent: '1.2 3.2' };
$('plate-key').innerHTML = (Object.keys(PLATE_STYLE) as (keyof typeof PLATE_STYLE)[]).map((k) =>
  `<li><svg width="26" height="10" aria-hidden="true"><line x1="1" y1="5" x2="25" y2="5" stroke="${PLATE_STYLE[k].color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${DASH[k]}"/></svg><span>${PLATE_STYLE[k].label}</span></li>`).join('');

// depth ramp legend: stops spaced evenly, as the colour scale is
{
  const deep = [...BATHY_STOPS].reverse(); // 0 m at top
  const grad = deep.map(([, c], i) => `${c} ${((i / (deep.length - 1)) * 100).toFixed(1)}%`).join(', ');
  $('ramp').innerHTML = `<div class="bar" style="background: linear-gradient(${grad})"></div>` +
    deep.map(([h]) => `<div class="tick">${h === 0 ? '0 m' : formatDepth(h).replace('−', '')}</div>`).join('');
  ($('ramp').querySelector('.bar') as HTMLElement).style.gridRow = `1 / span ${deep.length}`;
}

// credits from meta.json + plates attribution
{
  const doi = meta.doi;
  $('credits-body').innerHTML = `
    <p><strong>Bathymetry</strong>: ${meta.citation}${synthetic ? '' : ''}, <a href="https://doi.org/${doi}" target="_blank" rel="noopener">doi:${doi}</a>. ${meta.licence ?? 'Open Government Licence v3'}: <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener">OGL v3</a>. Shown at ${meta.sourceResolutionArcsec / 60} arc-minute resolution. “Measured” = GEBCO type identifier 10–17 (direct survey).</p>
    <p><strong>Plate boundaries</strong>: Bird, P. (2003) An updated digital model of plate boundaries, <em>G³</em> 4(3), 1027, <a href="https://doi.org/10.1029/2001GC000252" target="_blank" rel="noopener">doi:10.1029/2001GC000252</a> (PB2002), ODC-By 1.0.</p>
    <p>Rendered with <a href="https://maplibre.org" target="_blank" rel="noopener">MapLibre GL JS</a>.${synthetic ? ' <strong>These are synthetic development tiles, not real data.</strong>' : ''}</p>`;
}

// ---------- cards ----------
function show(id: string, on: boolean) { $(id).hidden = !on; }
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => b.addEventListener('click', () => {
  show(b.dataset.close!, false);
  if (b.dataset.close === 'story-card') markStory(null);
}));

const KIND_LABEL: Record<string, string> = {};
function kindLabel(k: string) { return KIND_LABEL[k] ?? (k ? k[0].toUpperCase() + k.slice(1).replace(/_/g, ' ') : ''); }
function showFeature(p: FeatureProps) {
  show('story-card', false);
  $('f-kind').textContent = kindLabel(p.kind);
  $('f-name').textContent = p.name;
  $('f-depth').textContent = Number.isFinite(Number(p.depth_m)) ? `${formatDepth(Number(p.depth_m))} in the GEBCO 2026 grid` : '';
  $('f-blurb').textContent = p.blurb ?? '';
  $('f-source').textContent = p.source ? `Source: ${p.source}` : '';
  show('feature-card', true);
}
function showPlate(p: Record<string, unknown>) {
  show('story-card', false);
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
  history.replaceState(null, '', `#story=${s.id}`);
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
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const input = $<HTMLInputElement>('search-input'), results = $<HTMLUListElement>('search-results');
let hits: typeof features = [], active = -1;
function renderResults() {
  const q = norm(input.value.trim());
  if (!q) { results.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
  hits = features.filter((f) => norm(f.properties.name).includes(q))
    .sort((a, b) => Number(!norm(a.properties.name).startsWith(q)) - Number(!norm(b.properties.name).startsWith(q)) || a.properties.name.localeCompare(b.properties.name))
    .slice(0, 12);
  active = hits.length ? 0 : -1;
  results.innerHTML = hits.length
    ? hits.map((f, i) => `<li role="option" id="opt-${i}" aria-selected="${i === active}" data-i="${i}"><span>${f.properties.name}</span><span class="k">${kindLabel(f.properties.kind)}</span></li>`).join('')
    : `<li class="empty" role="option" aria-disabled="true">No feature named “${input.value.trim()}”. Try a trench, ridge or seamount name.</li>`;
  results.hidden = false; input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', active >= 0 ? `opt-${active}` : '');
}
function choose(i: number) {
  const f = hits[i]; if (!f) return;
  results.hidden = true; input.setAttribute('aria-expanded', 'false'); input.value = f.properties.name;
  markStory(null); show('story-card', false);
  showFeature(f.properties);
  updatePadding();
  map.flyTo({ center: f.geometry.coordinates as [number, number], zoom: Math.max(map.getZoom(), 5), pitch: 45, duration: 3500, essential: true });
}
input.addEventListener('input', renderResults);
input.addEventListener('keydown', (e) => {
  if (results.hidden) return;
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
async function readout(lon: number, lat: number) {
  const t = ++readToken;
  const { h, f } = await sampler.sample([[lon, lat]]);
  if (t !== readToken) return;
  $('readout-hint').hidden = true; $('readout-grid').hidden = false;
  $('r-lat').textContent = formatLat(lat);
  $('r-lon').textContent = formatLon(lon);
  $('r-depth').textContent = Number.isFinite(h[0]) ? formatDepth(h[0]) : 'n/a';
  $('r-meas').textContent = f[0] === null ? 'land' : Number.isNaN(f[0]) ? 'n/a' : `${Math.round(f[0] * 100)}%`;
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
  profiling = on;
  $('profile-btn').setAttribute('aria-pressed', String(on));
  $('profile-btn').textContent = on ? 'Stop drawing profiles' : 'Draw a depth profile';
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
  const z = profileZoom(len, SAMPLES, meta!.maxzoom, meta!.tileSize);
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
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
  const layers = [...FEATURE_LAYERS, ...(tPlates.checked ? ['plates'] : [])];
  const hit: MapGeoJSONFeature | undefined = map.queryRenderedFeatures(box, { layers })[0];
  if (!hit) return;
  if (hit.layer.id === 'plates') showPlate(hit.properties); else showFeature(hit.properties as FeatureProps);
});
for (const id of FEATURE_LAYERS) {
  map.on('mouseenter', id, () => { if (!profiling) map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', id, () => { if (!profiling) map.getCanvas().style.cursor = ''; });
}

// ---------- keep the globe centred in the part of the screen the panels leave free ----------
const touch = window.matchMedia('(hover: none)').matches;
if (touch) $('readout-hint').textContent = 'Tap the seafloor to read its depth.';
function updatePadding() {
  const W = window.innerWidth, H = window.innerHeight;
  const r = (id: string) => $(id).getBoundingClientRect();
  let pad;
  if (W < 760) {
    const top = document.querySelector('.masthead')!.getBoundingClientRect().bottom;
    // the free band is between the masthead and whatever is highest of readout / open card
    const tops = ['readout', 'story-card', 'feature-card'].filter((id) => !$(id).hidden && getComputedStyle($(id)).display !== 'none').map((id) => r(id).top);
    pad = { top: Math.round(top), bottom: Math.round(H - Math.min(...tops)), left: 0, right: 0 };
  } else {
    pad = { top: 0, bottom: 0, left: Math.round(r('stories').right), right: Math.round(W - r('layers').left) };
  }
  const cur = map.getPadding();
  if (cur.top === pad.top && cur.bottom === pad.bottom && cur.left === pad.left && cur.right === pad.right) return;
  map.setPadding(pad); // note: this stops a running camera animation, so callers set it before flying
}
{
  let raf = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(updatePadding); });
  for (const id of ['ui', 'readout', 'stories', 'layers', 'profile', 'story-card', 'feature-card']) ro.observe($(id));
}
updatePadding();

// ---------- phone tabs ----------
// tapping the open tab again folds the sheet away so more of the globe shows
function setTab(tab: string) {
  $('ui').dataset.tab = tab;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === tab)));
}
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.addEventListener('click', () => {
  setTab($('ui').dataset.tab === b.dataset.tab ? 'none' : b.dataset.tab!);
}));

// ---------- deep link ----------
function storyFromHash() {
  const m = /story=([\w-]+)/.exec(location.hash);
  return m ? stories.find((s) => s.id === m[1]) : undefined;
}
const linked = storyFromHash();
if (linked) playStory(linked, true);
// a pasted or edited #story= link in an already open tab does not reload the page
window.addEventListener('hashchange', () => {
  const s = storyFromHash();
  if (s && s.id !== currentStory?.id) playStory(s);
});

// ---------- test/capture hooks ----------
function idle(): Promise<void> { return new Promise((res) => { if (map.loaded() && map.areTilesLoaded()) map.once('idle', () => res()); else map.once('idle', () => res()); map.triggerRepaint(); }); }
Object.assign(window, {
  __seafloor: {
    map, meta, synthetic, idle,
    playStory: (id: string, instant = true) => { const s = stories.find((x) => x.id === id); if (s) playStory(s, instant); return !!s; },
    setVeil, setPlates, setNew,
    profile: async (a: [number, number], b: [number, number]) => { setProfiling(true); profileA = a; return runProfile(a, b); },
    hoverChart: (frac: number) => { const svg = $('profile-chart').querySelector('svg')!; const r = svg.getBoundingClientRect(); svg.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 60 + frac * (r.width - 72), clientY: r.top + 40 })); },
    readout,
    current: () => currentStory?.id ?? null,
  },
});
