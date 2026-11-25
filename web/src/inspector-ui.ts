// What the viewer says about a point (split from main.ts): the hover readout (depth, measured share or the ocean-water
// value, one or two extra lines for the active layers) and the point inspector (click the seafloor: how its depth is
// known, inspect.ts / point-info.ts).
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { formatLevel } from './sealevel';
import { formatDepth, formatLat, formatLon } from './geo';
import { classFromAlpha, disagreeFromAlpha, formatDisagree } from './certainty';
import { STATUS, STATUS_ORDER, type StatusKey } from './palette';
import { NOT_RATED_VERDICT, classify, pixelKm, pct, verdict } from './inspect';
import { basinAt, farVerdictCapped, inspectedCellKm, lowLandVerdict, measuredText, nearestText, searchKm, shownFraction, swotText } from './point-info';
import { $, anim, demMaxZoom, map, meta, phone, sampler, staticMaxZoom, touring } from './app-state';
import { markStory, show } from './cards-ui';
import { certaintyOn, disagreeLg, marine, oceanUI, overlays, polarMeta, probes, uncertaintyLg } from './layers-ui';
import { seaLevel, seaOpen, timeUI, water } from './tools-ui';
import { setDrawer, setTab, updatePadding } from './layout-ui';

// ---------- hover readout ----------
let readToken = 0;
let lastRead: { h: number; f: number | null; note: string | null } | null = null;
export let lastPoint: [number, number] | null = null;
// The readout answers from the static tiles first (zoom meta.maxzoom, next to the page, fast), and refines from the
// high-resolution archive only when the map itself is zoomed in that far. Reading every hover from the archive made
// the readout hang for seconds on a slow link. Coordinates update at once, the values when they arrive.
export async function readout(lon: number, lat: number) {
  const t = ++readToken;
  lastPoint = [lon, lat];
  $('readout-hint').hidden = true; $('readout-grid').hidden = false;
  $('r-lat').textContent = formatLat(lat);
  $('r-lon').textContent = formatLon(lon);
  const zFast = staticMaxZoom;
  showRead(lon, lat, await sampler.sample([[lon, lat]], zFast));
  if (t !== readToken || demMaxZoom <= zFast || map.getZoom() < zFast) return;
  const fine = await sampler.sample([[lon, lat]], demMaxZoom);
  if (t === readToken && Number.isFinite(fine.h[0])) showRead(lon, lat, fine);
  function showRead(lo: number, la: number, { h, f, note }: { h: number[]; f: (number | null)[]; note: (string | null)[] }) {
    if (t !== readToken) return;
    readLevel(lo, la, h, f, note);
  }
}
function readLevel(lon: number, lat: number, h: number[], f: (number | null)[], note: (string | null)[]) {
  lastRead = { h: h[0], f: shownFraction(f[0], h[0]), note: note[0] ?? null };
  renderDepth();
  $('r-meas').textContent = measuredText(lastRead.f, lastRead.note);
  renderWaterReadout();
  renderExtra(lon, lat);
}
/** One extra readout line for the active marine-life or depth-certainty layer (marine first, then confidence, then disagreement). */
let extraToken = 0;
export async function renderExtra(lon: number, lat: number) {
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
export function renderWaterReadout() {
  if (!lastPoint || !lastRead) return;
  const w = water.readout(lastPoint[0], lastPoint[1]);
  if (!w) {
    // back to the coverage value (it was replaced while the water panel was open)
    $('r-meas-dt').textContent = 'Measured by ship';
    $('r-meas').textContent = measuredText(lastRead.f, lastRead.note);
    return;
  }
  $('r-meas-dt').textContent = w.label;
  $('r-meas').textContent = w.value;
}
/** Depth relative to the sea level shown; with a changed sea level, today's value is kept beside it. */
export function renderDepth() {
  if (!lastRead) return;
  const h = lastRead.h, L = seaLevel;
  $('r-depth-dt').innerHTML = L === 0 ? 'Depth' : `Depth<span class="dt-sea">, sea at ${formatLevel(L)}</span>`;
  const dd = $('r-depth');
  if (!Number.isFinite(h)) { dd.textContent = 'n/a'; return; }
  dd.textContent = formatDepth(h - L);
  if (L !== 0) dd.insertAdjacentHTML('beforeend', `<span class="was">today ${formatDepth(h)}</span>`);
}
export function initReadout() {
  let pending: maplibregl.LngLat | null = null;
  map.on('mousemove', (e) => {
    if (!pending) requestAnimationFrame(() => { if (pending) readout(pending.lng, pending.lat); pending = null; });
    pending = e.lngLat;
  });
}

// ---------- point inspector: click the seafloor for how its depth is known (inspect.ts) ----------
// Reads only our tiles: depth and measured fraction like the readout (fine zoom when the map is zoomed in), the
// nearest measured cell within SEARCH_KM (less near the poles) on the 1' coverage tiles, and the two depth-certainty rasters.
const NO_POINT: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
export function initInspector() {
  for (const k of Object.keys(STATUS) as StatusKey[]) document.documentElement.style.setProperty(`--st-${k}`, STATUS[k].color);
  $('status-key').innerHTML = STATUS_ORDER.map((k) => `<li data-st="${k}"><span class="sdot" style="background:var(--st-${k})" aria-hidden="true"></span><span>${STATUS[k].label}</span></li>`).join('');
  map.addSource('inspect-pt', { type: 'geojson', data: NO_POINT });
  map.addLayer({ id: 'inspect-pt', type: 'circle', source: 'inspect-pt',
    paint: { 'circle-radius': 7, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } });
  $('insp-close').addEventListener('click', closeInspector);
}
let inspToken = 0;
export function canInspect() { return !touring && !water.open && !(phone() && (seaOpen || !!timeUI?.open)); }
function inspMarker(lon: number, lat: number, color: string) {
  (map.getSource('inspect-pt') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { c: color }, geometry: { type: 'Point', coordinates: [lon, lat] } }] });
}
export function closeInspector() {
  if ($('inspector').hidden) return;
  inspToken++;
  $('inspector').hidden = true; $('lg-status').hidden = true;
  $('ui').classList.remove('inspecting');
  (map.getSource('inspect-pt') as GeoJSONSource).setData(NO_POINT);
  updatePadding();
}
export async function inspect(lon: number, lat: number) {
  const t = ++inspToken;
  show('feature-card', false); show('story-card', false); markStory(null); overlays.clearHighlight();
  if (phone()) setTab('none'); else if ($('ui').classList.contains('layers-open')) setDrawer('layers', false, false);
  const ins = $('inspector');
  ins.style.removeProperty('--st'); delete ins.dataset.st;
  $('insp-title').textContent = 'Seafloor here';
  $('insp-meta').textContent = `${formatLat(lat)}, ${formatLon(lon)}`;
  $('insp-badge-t').textContent = 'Reading…';
  for (const id of ['it-depth', 'it-meas', 'it-near']) $(id).textContent = '…';
  $('insp-verdict').textContent = ''; $('insp-rows').replaceChildren();
  ins.hidden = false; $('ui').classList.add('inspecting');
  inspMarker(lon, lat, '#ffffff');
  updatePadding();
  const zFine = demMaxZoom > staticMaxZoom && map.getZoom() >= staticMaxZoom ? demMaxZoom : staticMaxZoom;
  // The nearest-survey search runs only over water (on land it loaded tiles for nothing) and within a radius capped
  // near the poles (point-info.searchKm: at 80-85 degrees one click loaded 18-50 tiles). The static cell, already
  // read by the hover readout, decides first, so the search still starts together with the fine read.
  const radiusKm = searchKm(lat, staticMaxZoom, meta!.tileSize);
  const wet = (q: { h: number[]; f: (number | null)[] }) => q.f[0] !== null && !(q.h[0] > 0);
  const ptP = sampler.sample([[lon, lat]], zFine);
  const swotP = uncertaintyLg ? probes.uncertainty.at(lon, lat) : Promise.resolve(null);
  const coarse = zFine === staticMaxZoom ? await ptP : await sampler.sample([[lon, lat]], staticMaxZoom);
  const nearP = wet(coarse) ? sampler.nearestMeasured(lon, lat, radiusKm, staticMaxZoom) : Promise.resolve(null);
  const [pt, swotPx] = await Promise.all([ptP, swotP]);
  let nearZ5 = await nearP;
  // on a coast the fine cell can be water where the static one is land
  if (!wet(coarse) && wet(pt)) nearZ5 = await sampler.nearestMeasured(lon, lat, radiusKm, staticMaxZoom);
  if (t !== inspToken) return;
  // without the DEM the coverage alpha cannot tell "fully measured" from land: unknown (point-info.shownFraction)
  const h = pt.h[0], f = shownFraction(pt.f[0], h);
  // poleward of inspect.RATED_TO_LAT the sampler does not rate coverage and says so (sampler.ts note)
  const notRated = pt.note?.[0] ?? null;
  const swotAlpha = swotPx ? swotPx[3] : null;
  const swotLabel = swotPx && uncertaintyLg ? classFromAlpha(swotPx[3], uncertaintyLg)?.label ?? null : null;
  // Land below sea level (inland basins such as the Caspian, Dead Sea or Death Valley, and polders such as
  // Flevoland) is land in the coverage tiles (pipeline/viewer_land.py), so f is null there; the dataset's
  // inland-component boxes give the basin its name.
  const land = f === null;
  const lowLand = land && Number.isFinite(h) && h < 0;
  let basin: { name: string } | null = null;
  if (lowLand) {
    basin = basinAt((await import('./inland-basins')).INLAND_BASINS, lon, lat);
    if (t !== inspToken) return;
  }
  // the fine cell decides "this cell": a 1' cell with a sounding somewhere else in it is half a cell away
  // poleward of RATED_TO_LAT the depth comes from the polar grid, not from the clamped Mercator tile
  const cell = inspectedCellKm(lat, zFine, meta!.tileSize, polarMeta), cellKm = cell.km;
  let near = nearZ5;
  if (f !== null && f > 0) near = 0;
  else if (near === 0) near = Math.max(0.5, pixelKm(lat, staticMaxZoom, meta!.tileSize) / 2);
  const s = classify(f, near);
  const noSurvey = land || !!notRated; // the ocean survey status (and the nearest survey) does not apply
  $('insp-title').textContent = lowLand ? (basin ? 'Inland, below sea level' : 'Land below sea level') : land ? 'Land here' : 'Seafloor here';
  $('insp-meta').textContent = `${formatLat(lat)}, ${formatLon(lon)} · cell about ${cellKm < 1 ? cellKm.toFixed(1) : Math.round(cellKm)} km`;
  if (s) { ins.style.setProperty('--st', STATUS[s].color); ins.dataset.st = s; }
  $('insp-badge-t').textContent = lowLand ? (basin?.name || 'Below sea level') : s ? STATUS[s].label : notRated ? 'Not rated' : 'No data here';
  const hLabel = lowLand ? 'Elevation' : land ? 'Height' : 'Depth';
  $('it-depth-l').textContent = hLabel;
  $('it-depth').textContent = Number.isFinite(h) ? formatDepth(h) : 'n/a';
  $('it-meas').textContent = land ? 'land' : notRated ? 'not rated' : Number.isFinite(f) ? pct(f as number) : 'n/a';
  $('it-meas-s').textContent = land || notRated ? '' : 'of the cell, by ship';
  $('it-near').textContent = noSurvey ? '–' : nearestText(near, radiusKm, true);
  $('insp-verdict').textContent = lowLand ? lowLandVerdict(basin?.name ?? null) : notRated ? NOT_RATED_VERDICT
    : s ? (s === 'far' ? farVerdictCapped(near, radiusKm) : null) ?? verdict(s, f, near) : 'No tile covers this point.';
  inspMarker(lon, lat, s ? STATUS[s].color : '#ffffff');
  $('lg-status').hidden = noSurvey || !s;
  $('status-key').querySelectorAll('li').forEach((li) => li.toggleAttribute('aria-current', li.dataset.st === s));
  // the table: every value at this point, the depth-certainty ones only where those layers exist
  const rows: [string, string][] = [
    [hLabel, Number.isFinite(h) ? formatDepth(h) : 'n/a'],
    [cell.polar ? 'Cell size (polar grid)' : 'Cell size at this zoom', `about ${cellKm < 1 ? cellKm.toFixed(2) : cellKm.toFixed(1)} km`],
    ['Measured by ship', land ? 'land' : notRated ?? (Number.isFinite(f) ? pct(f as number) : 'n/a')],
    ['Nearest measured seafloor', noSurvey ? '–' : nearestText(near, radiusKm)],
  ];
  if (!noSurvey && disagreeLg) {
    const px = await probes.disagree.at(lon, lat);
    const m = px ? disagreeFromAlpha(px[3], disagreeLg) : null;
    rows.push(['Second model (AUST_2026) differs by', !px ? 'could not be loaded' : m === null ? 'under 50 m, or not compared here' : formatDisagree(m, disagreeLg.vmax)]);
  }
  if (!land && uncertaintyLg) rows.push(['SWOT model confidence', swotText(lat, swotAlpha, swotLabel, f)]);
  rows.push(['Latitude', formatLat(lat)], ['Longitude', formatLon(lon)]);
  if (t !== inspToken) return;
  $('insp-rows').replaceChildren(...rows.map(([k, v]) => {
    const tr = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td');
    th.scope = 'row'; th.textContent = k; td.textContent = v; tr.append(th, td); return tr;
  }));
  // phone: the sheet covers the lower half; bring the point into the free band above it
  if (phone()) {
    const p = map.project([lon, lat]), top = ins.getBoundingClientRect().top;
    if (p.y > top - 24) map.easeTo(anim({ center: [lon, lat] as [number, number], duration: 500, essential: true }));
  }
}
