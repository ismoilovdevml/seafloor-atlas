// Cards, guided views and search (split from main.ts): the feature card (gazetteer names, plate boundaries, overlay
// and AMOC cards), the story card and list, and the search box over stories, names, cables and wrecks.
import type { GeoJSONSource } from 'maplibre-gl';
import { langFromHash } from './tour-lang';
import { PLATE_STYLE } from './palette';
import { formatDepth, formatLat, formatLon } from './geo';
import { normName, searchRank, hashWithLayers, type CardModel, type SearchEntry } from './overlays';
import { hashWithLand } from './basemap';
import { $, anim, map, measureTool, setExagAuto, applyExaggeration } from './app-state';
import { closeInspector } from './inspector-ui';
import { extraTokens, overlays, satLand, setVeil, tVeil } from './layers-ui';
import { closeSea, profiling, setProfiling, timeUI, water } from './tools-ui';
import { placeNav3d, setTab, updatePadding } from './layout-ui';

export interface Story { id: string; title: string; blurb: string; center: [number, number]; zoom: number; pitch: number; bearing: number; exaggeration: number; veil?: boolean }
export interface FeatureProps { name: string; kind: string; depth_m: number; blurb: string; source: string }

// ---------- cards ----------
export function show(id: string, on: boolean) {
  const card = id === 'feature-card' || id === 'story-card';
  if (on && card) closeInspector();
  $(id).hidden = !on;
  if (card) requestAnimationFrame(placeNav3d); // the phone's map controls sit above an open card
}
export function initCards() {
  document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => b.addEventListener('click', () => {
    show(b.dataset.close!, false);
    if (b.dataset.close === 'story-card') markStory(null);
    if (b.dataset.close === 'feature-card') overlays.clearHighlight();
  }));
}
/** Clears the parts of the feature card that only overlay cards use. */
export function resetCard() {
  $('f-facts').hidden = true; $('f-facts').replaceChildren();
  $('f-links').hidden = true; $('f-links').replaceChildren();
  $('f-photo').hidden = true; $<HTMLImageElement>('f-img').removeAttribute('src');
}
/** Overlay card: all text goes in through textContent (the data comes from third-party registries). */
export function showCard(c: CardModel) {
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
    $('f-photo').classList.toggle('chart', c.image.src.startsWith('data:image/svg+xml'));
    $('f-img-cap').textContent = c.image.credit;
    $('f-photo').hidden = false;
  }
  $('f-source').textContent = `Source: ${c.source}`;
  show('feature-card', true);
}

const KIND_LABEL: Record<string, string> = {};
export function kindLabel(k: string) { return KIND_LABEL[k] ?? (k ? k[0].toUpperCase() + k.slice(1).replace(/_/g, ' ') : ''); }
export function showFeature(p: FeatureProps) {
  show('story-card', false);
  resetCard(); overlays.clearHighlight();
  $('f-kind').textContent = kindLabel(p.kind);
  $('f-name').textContent = p.name;
  $('f-depth').textContent = Number.isFinite(Number(p.depth_m)) ? `${formatDepth(Number(p.depth_m))} in the GEBCO 2026 grid` : '';
  $('f-blurb').textContent = p.blurb ?? '';
  $('f-source').textContent = p.source ? `Source: ${p.source}` : '';
  show('feature-card', true);
}
export function showPlate(p: Record<string, unknown>) {
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
export let stories: Story[] = [];
let storyList: HTMLElement;
function where([lon, lat]: [number, number]) { return `${formatLat(lat).replace('.000', '').replace(/(\.\d)\d+/, '$1')}, ${formatLon(lon).replace(/(\.\d)\d+/, '$1')}`; }
export function markStory(id: string | null) {
  storyList.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.story === id)));
}
export let currentStory: Story | null = null;
export function playStory(s: Story, instant = false) {
  timeUI?.close(false); // stories are told at today's sea level, with every layer at its full extent
  closeSea(false);
  water.close(false); // and over the plain relief
  if (profiling) setProfiling(false);
  measureTool.stop();
  currentStory = s;
  markStory(s.id);
  show('feature-card', false);
  $('story-title').textContent = s.title;
  $('story-blurb').textContent = s.blurb;
  $('story-veil').hidden = !s.veil || tVeil.checked;
  const card = $('story-card');
  card.hidden = false; card.classList.remove('entering'); void card.offsetWidth; card.classList.add('entering');
  setExagAuto(false);
  applyExaggeration(s.exaggeration);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cam = { center: s.center, zoom: s.zoom - (window.innerWidth < 760 ? 0.6 : 0), pitch: s.pitch, bearing: s.bearing };
  if (window.innerWidth < 760) setTab('none');
  updatePadding();
  if (instant || reduce) map.jumpTo(cam); else map.flyTo({ ...cam, duration: 5200, curve: 1.6, essential: true });
  // keep #lang= and the extra layer tokens (quakes, winds, ...) when a story rewrites the address
  const lang = langFromHash(location.hash);
  history.replaceState(null, '', hashWithLand(hashWithLayers(`#story=${s.id}${lang ? `&lang=${lang}` : ''}`, { ...overlays.state, extra: extraTokens() }), satLand));
}
/** The tour clears the story it replaced. */
export function clearCurrentStory() { currentStory = null; }
export function initStories(list: Story[]) {
  stories = list;
  storyList = $('story-list');
  storyList.replaceChildren(...stories.map((s) => {
    const li = document.createElement('li'), b = document.createElement('button'), w = document.createElement('span');
    b.dataset.story = s.id; b.setAttribute('aria-current', 'false'); b.textContent = s.title;
    w.className = 'where'; w.textContent = where(s.center);
    b.appendChild(w); li.appendChild(b); return li;
  }));
  storyList.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-story]');
    const s = b && stories.find((x) => x.id === b.dataset.story);
    if (s) playStory(s);
  });
  $('story-veil').addEventListener('click', () => { setVeil(true); $('story-veil').hidden = true; });
}

// ---------- features + search ----------
let features: GeoJSON.Feature<GeoJSON.Point, FeatureProps>[] = [];
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export let input: HTMLInputElement;
let results: HTMLUListElement;
// one index over guided views, gazetteer names and, once loaded, cable names and notable wreck names (marked by kind)
let searchIndex: SearchEntry[] = [];
let overlaySearch: Promise<void> | null = null;
export function loadOverlaySearch() {
  overlaySearch ??= overlays.searchEntries().then((xs) => { searchIndex = searchIndex.concat(xs); if (!results.hidden || input.value.trim()) renderResults(); });
  return overlaySearch;
}
let hits: SearchEntry[] = [], active = -1;
export function renderResults() {
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
    map.flyTo(anim({ center: f.geometry.coordinates as [number, number], zoom: Math.max(map.getZoom(), 5), pitch: 45, duration: 3500, essential: true }));
    return;
  }
  const r = await overlays.focus(e);
  if (!r) return;
  showCard(r.card);
  updatePadding();
  const below = belowCard();
  if (r.feature.geometry.type === 'Point') {
    map.flyTo(anim({ center: r.feature.geometry.coordinates as [number, number], zoom: Math.max(map.getZoom(), 5.5), pitch: 30, duration: 3500, essential: true, offset: [0, below] as [number, number] }));
  } else {
    const b = lineBounds(r.feature.geometry as GeoJSON.MultiLineString);
    map.fitBounds(b, anim({ padding: { top: 60 + 2 * below, bottom: 60, left: 60, right: 60 }, maxZoom: 5.5, duration: 3000, essential: true }));
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
export function initSearch(featureData: GeoJSON.FeatureCollection<GeoJSON.Point, FeatureProps> | null) {
  features = featureData?.features ?? [];
  // one download feeds both the map labels and the search index
  if (featureData) (map.getSource('features') as GeoJSONSource).setData(featureData);
  $('features-stat').innerHTML = features.length ? `<strong>${features.length.toLocaleString('en-US')}</strong> named undersea features.` : '';
  input = $<HTMLInputElement>('search-input'); results = $<HTMLUListElement>('search-results');
  searchIndex = [
    ...stories.map((s) => ({ name: s.title, label: 'Guided view', kind: 'story' as const, key: s.id, n: normName(s.title) })),
    ...features.map((f, i) => ({ name: f.properties.name, label: kindLabel(f.properties.kind), kind: 'feature' as const, key: String(i), n: normName(f.properties.name) })),
  ];
  input.addEventListener('focus', () => { loadOverlaySearch(); }, { once: true });
  input.addEventListener('input', renderResults);
  input.addEventListener('keydown', (e) => {
    if (results.hidden) { if (e.key === 'Escape') input.blur(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return; // only the disabled "nothing found" row: nothing to select
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      results.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
      input.setAttribute('aria-activedescendant', `opt-${active}`);
    } else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); results.hidden = true; input.setAttribute('aria-expanded', 'false'); }
  });
  results.addEventListener('pointerdown', (e) => { const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-i]'); if (li) { e.preventDefault(); choose(Number(li.dataset.i)); } });
  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; input.setAttribute('aria-expanded', 'false'); }, 120));
}
