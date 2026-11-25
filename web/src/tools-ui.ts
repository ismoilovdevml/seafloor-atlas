// The bottom tools (split from main.ts): depth profile, sea level, ocean water (the panel object and its Layers row)
// and the Time panel with its offer, plus the tool state the tour reads and restores. One tool at a time is
// app-state.closeTools().
import type { GeoJSONSource } from 'maplibre-gl';
import { ProfileChart } from './profile-chart';
import { EXPOSED_HIGH, EXPOSED_LOW, FLOODED_DEEP, FLOODED_SHALLOW } from './palette';
import {
  KNEE_LEVEL, PRESETS, SEA_MAX, SEA_MIN, SLIDER_MAX, formatLevel, hashWithSea, landAreaAt, levelToPos, posToLevel, presetFor, snapLevel,
  type Hypsometry,
} from './sealevel';
import { formatDepth, greatCircle, haversineKm, profileZoom, unwrapPath } from './geo';
import { WaterUI } from './water-ui';
import type { OverlayUI } from './overlay-ui';
import { ATTRIBUTION } from './overlays';
import { parseSeaHistory, type TimeMode, type TimeState, type YearSet } from './timeline';
import type { HistoryUI } from './history-ui';
import type { MonthId, MonthTarget, TimeUI, YearTarget } from './time-ui';
import type { TourTool } from './tour-model';
import { $, closeTools, demMaxZoom, getJSON, map, meta, phone, rasterTileSize, sampler, staticMaxZoom, synthetic, touring } from './app-state';
import { show } from './cards-ui';
import { renderDepth, renderWaterReadout } from './inspector-ui';
import { eventsUI, layersChanged, loadEvents, loadOcean, marine, oceanUI, overlays, paintRelief, setUnderlay } from './layers-ui';
import { setTab, updateLayersBadge, updatePadding } from './layout-ui';

// ---------- ocean water (WOA23) ----------
export let water: WaterUI;
export let waterReady = false;
/** Creates the ocean-water panel; its manifest downloads with the other start-up files (main.ts awaits the result). */
export function initWater(): Promise<boolean> {
  water = new WaterUI({
    map, base: 'woa/',
    beforeOpen: () => { closeTools('water'); if (marine.on) marine.set({ on: false }); if (oceanUI?.chlOn) oceanUI.setChl(false); },
    layout: () => updatePadding(),
    // static tiles only: the water-column caption should not wait on the high-resolution archive
    seafloorAt: async (lon, lat) => (await sampler.sample([[lon, lat]], staticMaxZoom)).h[0],
    onChange: () => { renderWaterReadout(); syncWaterRow(); },
    underlay: (on) => setUnderlay('water', on),
  });
  return water.init();
}
// "Ocean water" is a tool (bottom panel) and also a row in the Layers drawer; both drive the same panel
let tWater: HTMLInputElement;
export function syncWaterRow() {
  tWater.checked = water.open;
  $('row-water').classList.toggle('on', water.open);
  updateLayersBadge();
}
export function initWaterRow(ready: boolean) {
  waterReady = ready;
  tWater = $<HTMLInputElement>('t-water');
  tWater.addEventListener('change', () => { if (tWater.checked) water.show(); else water.close(); });
  if (!waterReady) $('row-water').hidden = true;
}

// ---------- depth profile tool ----------
export let chart: ProfileChart;
export let profiling = false;
export let profileA: [number, number] | null = null;
export let profilePts: [number, number][] | null = null;
const SAMPLES = 400;
export function setProfileSource(a: [number, number] | null, b: [number, number] | null) {
  const feats: GeoJSON.Feature[] = [];
  if (a) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: a } });
  if (a && b) {
    feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: b } });
    feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: unwrapPath(greatCircle(a, b, 200)) } });
  }
  (map.getSource('profile') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
}
export function setProfiling(on: boolean) {
  if (on) closeTools('profile');
  profiling = on;
  $('profile-btn').setAttribute('aria-pressed', String(on));
  $('ui').classList.toggle('profiling', on);
  show('profile', on);
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
  if (!on) { profileA = null; profilePts = null; setProfileSource(null, null); chart.set(null); $('profile-stats').hidden = true; }
  else { $('profile-status').textContent = 'Click a start point on the globe.'; $('profile-status').hidden = false; }
}
export async function runProfile(a: [number, number], b: [number, number]) {
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
/** A click on the map with no start point yet (or after a finished profile): a new start point. */
export function setProfileStart(p: [number, number]) { profileA = p; profilePts = null; chart.set(null); setProfileSource(p, null); }
/** QA and the tour: the profile tool open with the line a-b drawn. */
export async function showProfile(a: [number, number], b: [number, number]) { setProfiling(true); profileA = a; return runProfile(a, b); }
export function initProfile() {
  chart = new ProfileChart($('profile-chart'), (i) => {
    const src = map.getSource('cursor') as GeoJSONSource;
    src.setData({ type: 'FeatureCollection', features: i === null || !profilePts ? [] : [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: profilePts[i] } }] });
  });
  $('profile-btn').addEventListener('click', () => setProfiling(!profiling));
  $('profile-close').addEventListener('click', () => setProfiling(false));
}

// ---------- sea level ----------
// The relief ramp is rebuilt for a sea level L (palette.seaLevelExpression) and swapped in with
// setPaintProperty. At most one swap is in flight: the next one waits for the map's 'render' event, so a
// fast drag or the animation never queues more ramp rebuilds than the GPU draws.
let hypso: Hypsometry | null = null;
/** The sea level the relief is drawn at (0 = today); the relief ramp reads it from the first paint. */
export let seaLevel = 0;
let seaApplied = 0;
let seaRenderPending = false;
export let seaOpen = false;
let seaRange: HTMLInputElement;
export const seaStats = { applies: 0, frames: [] as number[], applyToRender: [] as number[] };
/** layers-ui.setUnderlay repainted the relief for the current level: nothing left to apply. */
export function markSeaPainted() { seaApplied = seaLevel; }

function applySeaPaint() {
  if (seaRenderPending || seaApplied === seaLevel) return;
  seaApplied = seaLevel;
  seaRenderPending = true;
  const t0 = performance.now();
  paintRelief();
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

export function setSeaLevel(level: number, opts: { fromSlider?: boolean; hash?: boolean } = {}) {
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
export function setPlaying(on: boolean) {
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

export function openSea(level?: number) {
  closeTools('sea');
  // the colour fields draw today's ocean over the relief and switch it to the neutral under-layer: with them on,
  // the sea-level ramp could not be seen (and the slider looked dead), so they go off as for ocean water
  if (oceanUI?.chlOn) void oceanUI.setChl(false);
  water.hideLayer();
  seaOpen = true;
  show('sea', true);
  $('ui').classList.add('sea-open');
  $('sea-btn').setAttribute('aria-pressed', 'true');
  setSeaLevel(level ?? seaLevel);
  updatePadding();
}
export function closeSea(hash = true) {
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
export function initSea(h: Hypsometry | null) {
  hypso = h;
  // legend chips use the same tint colours as the map ramp
  for (const [k, v] of Object.entries({ '--exposed-lo': EXPOSED_LOW, '--exposed-hi': EXPOSED_HIGH, '--flooded-lo': FLOODED_DEEP, '--flooded-hi': FLOODED_SHALLOW })) document.documentElement.style.setProperty(k, v);
  seaRange = $<HTMLInputElement>('sea-range');
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
}

// ---------- the Time panel ----------
export let timeUI: TimeUI | null = null;
export let historyUI: HistoryUI | null = null;
const timeAware = () => !!(eventsUI?.quakesOn && eventsUI.quakeMode === 'history') || overlays.on.has('cables') || overlays.on.has('wind') || !!oceanUI?.chlOn || !!oceanUI?.flow;
export function updateTimeDot() { $('time-dot').hidden = !!timeUI?.open || !timeAware(); }
const OFFER: Record<YearSet | 'months', string> = {
  quakes: 'Earthquakes since 1900 can play year by year.',
  cables: 'Cables can appear in the year they entered service.',
  wind: 'Wind farms can appear in the year they started.',
  mapping: 'See how much of the seafloor each GEBCO release had measured.',
  months: 'This layer changes with the seasons, month by month.',
};
let offerWhat: YearSet | 'months' = 'quakes', offerTimer = 0;
export function hideOffer() { clearTimeout(offerTimer); if (!$('time-offer').hidden) { $('time-offer').hidden = true; updatePadding(); } }
/** A time-aware layer went on: offer the Time panel once per layer and session (the tool-bar dot stays). */
export function offerTime(what: YearSet | 'months') {
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
let historyP: Promise<HistoryUI | null> | null = null;
export function loadHistory(): Promise<HistoryUI | null> {
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
export function loadTime(): Promise<TimeUI> {
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
        label: 'Phytoplankton', period: '2002–2026', available: true, attribution: CHL_ATT,
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
      beforeOpen: () => { hideOffer(); closeTools('time', { seaHash: false }); },
      layout: () => updatePadding(),
      onChange: () => { updateTimeDot(); eventsUI?.refreshLegend(); updateLayersBadge(); },
    }, years, months, ago);
    timeUI = t;
    return t;
  })();
  return timeP;
}
export async function openTime(s?: TimeState | { mode: TimeMode; set?: YearSet }) { const t = await loadTime(); await t.show(s); }
export function initTime() {
  $('time-offer-go').addEventListener('click', () => { hideOffer(); openTime(offerWhat === 'months' ? { mode: 'months' } : { mode: 'years', set: offerWhat }); });
  $('time-offer-x').addEventListener('click', hideOffer);
  document.querySelectorAll<HTMLButtonElement>('[data-time]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.time!;
    if (phone()) setTab('none');
    openTime(k === 'months' ? { mode: 'months' } : { mode: 'years', set: k as YearSet });
  }));
  $('time-btn').addEventListener('click', () => { if (!timeUI) openTime(); });
}

// ---------- tool state for the guided tour ----------
export function toolState(): TourTool {
  if (profiling) return profileA && profilePts ? { kind: 'profile', a: profileA, b: profilePts[profilePts.length - 1] } : { kind: 'profile' };
  if (seaOpen) return { kind: 'sea', level: seaLevel };
  if (water.open) return { kind: 'water', v: water.v, depth: water.depth };
  if (timeUI?.open) return { kind: 'time', state: timeUI.state };
  return { kind: 'none' };
}
export async function setToolState(t: TourTool) {
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
