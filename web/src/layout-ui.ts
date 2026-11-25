// Screen layout (split from main.ts): the map padding that keeps the globe centred in the free part of the window,
// the whole-globe fit, the compass rail, minimised panels, drawers, the legend dock, popovers, the keyboard, the
// phone tabs, the loading indicator and the QA layout probes.
import { diskCoverage, fitRadius, freeRect, globeDisk, inside, isGlobeScale, zoomForRadius, type Rect } from './layout';
import { LoadMeter } from './loading';
import { tileActivity } from './tilesource';
import { $, anim, map, measureTool, meta, phone, touring, visible } from './app-state';
import { input, markStory, show } from './cards-ui';
import { closeInspector } from './inspector-ui';
import { overlays } from './layers-ui';
import { closeSea, profiling, seaOpen, setProfiling, timeUI, water } from './tools-ui';

/** The compass sits just above the readout (and the phone legend), out of the way of an open side drawer or sheet. */
export function placeNav3d() {
  const el = document.getElementById('nav3d');
  if (!el) return;
  const H = window.innerHeight, W = window.innerWidth;
  const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
  const shown = (id: string) => { const e = document.getElementById(id); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; };
  const ui = document.getElementById('ui')!;
  // (no phone() here: setBase calls this before that helper is defined further down)
  const small = W <= 760;
  const busy = ui.classList.contains('touring') || shown('inspector') || (small ? !!ui.dataset.tab && ui.dataset.tab !== 'none' : shown('layers'));
  // phone: above an open card too, so the controls never sit on its text
  const anchors = (small ? ['readout', 'legend', 'feature-card', 'story-card'] : ['readout']).filter(shown).map(rect);
  el.hidden = busy || !anchors.length;
  if (el.hidden) return;
  // keep the rail below the top bar: on a short window with a tall readout there is no room, so it hides (and
  // shows again on the next layout pass with room, since hidden is recomputed above every time)
  const anchorTop = Math.min(...anchors.map((a) => a.top));
  const topLimit = rect('topbar').bottom + 8;
  if (anchorTop - 10 - el.offsetHeight < topLimit) { el.hidden = true; return; }
  el.style.bottom = `${Math.round(H - anchorTop + 10)}px`;
  el.style.right = `${Math.round(W - rect('readout').right)}px`;
  el.dataset.placed = '';
}

// ---------- keep the globe centred in the part of the screen the panels leave free ----------
const BOTTOM_PANELS = ['sea', 'water', 'profile', 'time', 'measure'];
/** The tour's panel when it is on screen (it exists only once the tour chunk has loaded). */
export function tourEl(): HTMLElement | null { const t = document.getElementById('tour'); return t && !t.hidden && getComputedStyle(t).display !== 'none' ? t : null; }
export function updatePadding() {
  const W = window.innerWidth, H = window.innerHeight;
  const r = (id: string) => $(id).getBoundingClientRect();
  placeNav3d();
  // drawers stop above the legend dock / readout that share their column
  const ui = $('ui').style;
  ui.setProperty('--legend-h', visible('legend') ? `${Math.round(r('legend').height) + 12}px` : '0px');
  ui.setProperty('--readout-h', visible('readout') ? `${Math.round(r('readout').height) + 12}px` : '0px');
  let pad;
  if (phone()) {
    const top = $('topbar').getBoundingClientRect().bottom;
    // the free band is between the top bar and whatever is highest of legend / readout / card / sheet / tabs
    const tops = ['legend', 'readout', 'story-card', 'feature-card', 'inspector', 'stories', 'layers', 'toolbar', 'time-offer', ...BOTTOM_PANELS].filter(visible).map((id) => r(id).top);
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
    // the point inspector shares the right column with the Layers drawer
    if (visible('inspector')) right = Math.max(right, W - r('inspector').left);
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
export function disk() { const c = map.getCenter(); return globeDisk((ll) => map.project(ll), [c.lng, c.lat]); }
export function fitGlobe() {
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
    // listener first: with reduced motion the move ends inside easeTo
    map.once('moveend', () => requestAnimationFrame(fitGlobe));
    map.easeTo(anim({ zoom: to, duration: 450, essential: true }));
  } else if (fitted && d.r < target * 0.97) {
    const to = Math.min(fitted.from, zoomForRadius(z, d.r, target));
    fitted = to >= fitted.from - 0.01 ? null : { from: fitted.from, to };
    map.once('moveend', () => requestAnimationFrame(fitGlobe));
    map.easeTo(anim({ zoom: to, duration: 450, essential: true }));
  }
}

// ---------- minimise the bottom panels to their header bar (remembered for the session) ----------
const MIN_KEY = 'sfa-minimised';
function minStore(): Record<string, boolean> { try { return JSON.parse(sessionStorage.getItem(MIN_KEY) ?? '{}'); } catch { return {}; } }
const MIN_LABEL: Record<string, string> = { sea: 'sea level', water: 'ocean water', profile: 'depth profile', time: 'time' };
export function setMinimised(id: string, on: boolean) {
  $(id).classList.toggle('min', on);
  const b = $(`${id}-min`);
  b.setAttribute('aria-expanded', String(!on));
  b.setAttribute('aria-label', `${on ? 'Expand' : 'Minimise'} ${MIN_LABEL[id]}`);
  try { sessionStorage.setItem(MIN_KEY, JSON.stringify({ ...minStore(), [id]: on })); } catch { /* storage blocked: state lasts until reload */ }
  updatePadding();
}

/** QA: the globe disk vs the panels covering it (every visible piece of UI, top bar items included). */
function uiRects(): (Rect & { id: string })[] {
  const els: [string, Element][] = ['stories', 'layers', 'readout', 'story-card', 'feature-card', 'inspector', 'profile', 'sea', 'water', 'time', 'time-offer', 'legend', 'toolbar', 'about', 'settings']
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
export function layoutCheck() {
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
export function mapShare() {
  const W = window.innerWidth, H = window.innerHeight, m = $('map');
  let n = 0, covered = 0;
  for (let y = 2; y < H; y += 4) for (let x = 2; x < W; x += 4) { n++; const e = document.elementFromPoint(x, y); if (e && !m.contains(e)) covered++; }
  return +(1 - covered / n).toFixed(3);
}

export function initLayout() {
  const touch = window.matchMedia('(hover: none)').matches;
  if (touch) $('readout-hint').textContent = 'Tap the seafloor to read its depth';
  for (const id of Object.keys(MIN_LABEL)) { // panels with a minimise button (measure has none)
    $(`${id}-min`).addEventListener('click', () => setMinimised(id, !$(id).classList.contains('min')));
    if (minStore()[id]) setMinimised(id, true);
  }
  {
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(updatePadding); });
    for (const id of ['ui', 'topbar', 'readout', 'stories', 'layers', 'legend', 'toolbar', 'profile', 'sea', 'water', 'time', 'time-offer', 'story-card', 'feature-card', 'measure', 'inspector']) ro.observe($(id));
  }
}

// ---------- panels: drawers, legend dock, popovers, info notes (open state remembered in localStorage) ----------
type UiKey = 'explore' | 'layers' | 'legend';
const UI_KEY = 'sfa-ui';
function uiStore(): Partial<Record<UiKey, boolean>> { try { return JSON.parse(localStorage.getItem(UI_KEY) ?? '{}'); } catch { return {}; } }
function saveUi(k: UiKey, v: boolean) { try { localStorage.setItem(UI_KEY, JSON.stringify({ ...uiStore(), [k]: v })); } catch { /* storage blocked: state lasts until reload */ } }

export function setDrawer(name: 'explore' | 'layers', open: boolean, save = true) {
  if (open && name === 'layers') closeInspector();
  $('ui').classList.toggle(`${name}-open`, open);
  $(`${name}-btn`).setAttribute('aria-expanded', String(open));
  if (save) saveUi(name, open);
  updatePadding();
}
// legend dock: one section per layer on the map; hidden when nothing needs a key
export function setLegend(open: boolean, save = true) {
  $('legend').classList.toggle('collapsed', !open);
  $('legend-toggle').setAttribute('aria-expanded', String(open));
  if (save) saveUi('legend', open);
  updatePadding();
}
export function legendSections() { return [...$('legend-body').children].filter((s) => !(s as HTMLElement).hidden) as HTMLElement[]; }
export function refreshLegend() {
  const secs = legendSections();
  $('legend').hidden = secs.length === 0;
  $('legend-n').textContent = secs.length > 1 ? String(secs.length) : '';
  updateLayersBadge();
}

/** Count of switched-on layers on the Layers button (named features, on by default, is not counted). */
export function updateLayersBadge() {
  const ids = [...document.querySelectorAll<HTMLInputElement>('#layers input[role="switch"]')].filter((t) => t.id !== 't-features' && t.id !== 't-satland' && t.checked && !t.closest('[hidden]'));
  const b = $('layers-count');
  b.hidden = ids.length === 0;
  b.textContent = String(ids.length);
  $('layers-btn').setAttribute('aria-label', ids.length ? `Layers, ${ids.length} on` : 'Layers');
}
// popovers: About this map, Map settings (one at a time; Esc or a click outside closes and returns focus)
const POPS: Record<string, string> = { about: 'about-btn', settings: 'settings-btn' };
let openPop: string | null = null;
export function setPopover(id: string | null, focusBack = false) {
  const prev = openPop;
  openPop = id;
  for (const [p, b] of Object.entries(POPS)) { $(p).hidden = p !== id; $(b).setAttribute('aria-expanded', String(p === id)); }
  if (id) {
    const first = id === 'settings' ? $('exag') : $('about');
    if (id === 'about') $('about').tabIndex = -1;
    first.focus({ preventScroll: true });
  } else if (focusBack && prev) $(POPS[prev]).focus();
}
export function focusSearch() { setPopover(null); input.focus(); input.select(); }
// ---------- phone: tabs for the bottom sheet (Explore / Layers / Tools) ----------
// tapping the open tab again folds the sheet away so more of the globe shows
const TAB_PANEL: Record<string, string> = { stories: 'stories', layers: 'layers', tools: 'toolbar' };
let tabButtons: HTMLButtonElement[] = [];
export function setTab(tab: string) {
  $('ui').dataset.tab = tab;
  tabButtons.forEach((x) => { x.setAttribute('aria-selected', String(x.dataset.tab === tab)); x.tabIndex = x.dataset.tab === tab || (tab === 'none' && x === tabButtons[0]) ? 0 : -1; });
  updatePadding();
}
// the drawers and the tool list are tab panels only on a phone
let phoneMq: MediaQueryList;
const LABELLED: Record<string, string | null> = { stories: 'stories-title', layers: 'layers-title', toolbar: null };
function applyPhoneRoles() {
  for (const [tab, panel] of Object.entries(TAB_PANEL)) {
    const el = $(panel);
    if (phoneMq.matches) { el.setAttribute('role', 'tabpanel'); el.setAttribute('aria-labelledby', `tab-${tab}`); }
    else { el.removeAttribute('role'); const l = LABELLED[panel]; if (l) el.setAttribute('aria-labelledby', l); else el.removeAttribute('aria-labelledby'); }
  }
}

export function initPanels() {
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
  $('legend-toggle').addEventListener('click', () => setLegend($('legend').classList.contains('collapsed')));
  new MutationObserver(refreshLegend).observe($('legend-body'), { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  // (i) notes in the layer rows
  document.querySelectorAll<HTMLButtonElement>('.info-btn').forEach((b) => b.addEventListener('click', () => {
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', String(open));
    $(b.getAttribute('aria-controls')!).hidden = !open;
  }));
  for (const [p, b] of Object.entries(POPS)) $(b).addEventListener('click', () => setPopover(openPop === p ? null : p));
  document.addEventListener('pointerdown', (e) => {
    if (!openPop) return;
    const t = e.target as Node;
    if (!$(openPop).contains(t) && !$(POPS[openPop]).contains(t)) setPopover(null);
  });

  // keyboard: Cmd/Ctrl+K or / focuses search, Esc closes a popover
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  if (!isMac) { $('search-key').textContent = 'Ctrl K'; $('about-cmd').textContent = 'Ctrl K'; }
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    const typing = t.matches?.('input:not([type="checkbox"]):not([type="range"]), textarea, select') || t.isContentEditable;
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); focusSearch(); return; }
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); focusSearch(); return; }
    if (e.key === 'Escape' && openPop) { e.preventDefault(); setPopover(null, true); return; }
    // Esc closes one thing per press, the most recent kind first: a card, then a bottom tool, then a drawer.
    // The tour and the measure tool handle their own Esc; a text field keeps it (it leaves the field first).
    if (e.key !== 'Escape' || e.defaultPrevented || typing || touring || measureTool.active) return;
    if (!$('inspector').hidden) { e.preventDefault(); closeInspector(); return; }
    const card = ['feature-card', 'story-card'].find((id) => !$(id).hidden);
    if (card) {
      e.preventDefault(); show(card, false);
      if (card === 'story-card') markStory(null); else overlays.clearHighlight();
      updatePadding(); return;
    }
    if (profiling) { e.preventDefault(); setProfiling(false); return; }
    if (seaOpen) { e.preventDefault(); closeSea(); return; }
    if (water.open) { e.preventDefault(); water.close(); return; }
    if (timeUI?.open) { e.preventDefault(); timeUI.close(); return; }
    if (phone()) {
      if ($('ui').dataset.tab && $('ui').dataset.tab !== 'none') { e.preventDefault(); setTab('none'); }
    } else {
      const drawer = (['layers', 'explore'] as const).find((d) => $('ui').classList.contains(`${d}-open`));
      if (drawer) { e.preventDefault(); setDrawer(drawer, false); }
    }
  });
  tabButtons = [...document.querySelectorAll<HTMLButtonElement>('.tabs button')];
  tabButtons.forEach((b) => b.addEventListener('click', () => setTab($('ui').dataset.tab === b.dataset.tab ? 'none' : b.dataset.tab!)));
  $('ui').querySelector('.tabs')!.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
    const i = tabButtons.indexOf(document.activeElement as HTMLButtonElement);
    const next = tabButtons[(i + (k === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length];
    next.focus(); setTab(next.dataset.tab!); e.preventDefault();
  });
  phoneMq = window.matchMedia('(max-width: 760px)');
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
}

// ---------- loading indicator ("Loading detail · 64%") ----------
// Counts map tile requests: the sfa:// protocol (static tiles and PMTiles range reads) and the history tiles
// through tilesource.tileActivity, every other source through MapLibre's tile events. Shown only for bursts
// longer than 300 ms, 100 % then a fade when the map is idle; it never takes pointer events.
export const meter = new LoadMeter();
const PROTOCOL_SOURCES = new Set(['dem-terrain', 'dem-relief', 'veil', 'history']);
export const loadTrace: { t: number; visible: boolean; pct: number }[] = [];
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
// MapLibre never fires 'idle' while a layer repaints every frame (winds / currents animate), so the bar would stay
// at 99 %: when every counted tile has finished, end the burst after a short quiet period as well
let loadQuietTimer = 0;
function loadFinish() {
  meter.finish();
  if (!meter.done) loadSchedule();
  clearTimeout(loadQuietTimer);
  if (meter.started > 0 && meter.finished >= meter.started) loadQuietTimer = window.setTimeout(() => { if (meter.finished >= meter.started) loadEnd(); }, 600);
}
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
export function initLoading() {
  tileActivity.start = loadStart;
  tileActivity.finish = loadFinish;
  map.on('dataloading', (e) => { const d = e as unknown as { dataType?: string; tile?: unknown; sourceId?: string }; if (d.dataType === 'source' && d.tile && !PROTOCOL_SOURCES.has(d.sourceId ?? '')) loadStart(); });
  map.on('data', (e) => { const d = e as unknown as { dataType?: string; tile?: unknown; sourceId?: string }; if (d.dataType === 'source' && d.tile && !PROTOCOL_SOURCES.has(d.sourceId ?? '')) loadFinish(); });
  map.on('idle', loadEnd);
}
