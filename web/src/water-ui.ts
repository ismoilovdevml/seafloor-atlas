// "Ocean water" panel + map layer: WOA23 temperature / salinity / potential density by depth, a monthly
// animation of surface temperature, hover values and a water-column chart for a clicked point.
// The map layer is one canvas source holding a 2048 x 2048 Web Mercator image of the whole world, redrawn
// from the 0.25 deg grid (water.renderMercator) whenever the variable, depth, month or scale changes; it sits
// under the hillshade so the relief stays readable through it. Land and seafloor shallower than the chosen
// depth have no data and stay transparent.
import type { CanvasSource, Map as MlMap } from 'maplibre-gl';
import { formatDepth, formatLat, formatLon } from './geo';
import {
  buildLut, cellFor, CMAPS, columnFromChunk, decimalsFor, decodeMapLayer, formatWater, gradientCss, hashWithWater, inflate,
  layerKey, layerStep, legendTicks, MERC_WORLD, neighbours, renderMercator, sampleGrid, scaleRange, thermocline, waterFromHash,
  type CellRef, type Column, type Grid, type WaterManifest, type WaterVar,
} from './water';
import { WaterChart, type PanelSpec } from './water-chart';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SIZE = 2048;
const OPACITY = 0.9;
const SECONDS_PER_MONTH = 0.9;
const TITLES: Record<WaterVar, string> = { t: 'Temperature', s: 'Salinity', d: 'Density' };
const EMPTY_HINT = 'Click the ocean to see its water column: temperature, salinity and density from the surface to the seafloor.';

export interface WaterHost {
  map: MlMap;
  base: string;
  /** called before the panel opens, to close the other bottom-panel tools */
  beforeOpen: () => void;
  layout: () => void;
  seafloorAt: (lon: number, lat: number) => Promise<number>;
  onChange: () => void;
  /** switch the relief ramp to its neutral under-layer version (true) or back to the normal one */
  underlay: (on: boolean) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class WaterUI {
  man!: WaterManifest;
  open = false;
  v: WaterVar = 't';
  depthIdx = 0;
  month = 0; // 0 = annual mean
  stretch = false;
  playing = false;
  private grids = new Map<string, Promise<Grid | null>>();
  private ready = new Map<string, Grid | null>();
  private chunks = new Map<string, Promise<Uint8Array | null>>();
  private luts: Record<WaterVar, Uint8Array> = { t: buildLut(CMAPS.t), s: buildLut(CMAPS.s), d: buildLut(CMAPS.d) };
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private added = false;
  private drawToken = 0;
  private monthPos = 0; // 0..12 while playing (fractional = blend)
  private lastT = 0;
  private chart: WaterChart;
  private colPoint: [number, number] | null = null;
  readonly stats = { renders: 0, renderMs: [] as number[] };

  constructor(private host: WaterHost) {
    this.canvas.width = SIZE; this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false })!;
    this.img = this.ctx.createImageData(SIZE, SIZE);
    this.chart = new WaterChart($('wc-chart'));
  }

  /** Loads the manifest; false (and the button hidden) when the water files are not built. */
  async init(): Promise<boolean> {
    try {
      const r = await fetch(`${this.host.base}manifest.json`);
      if (!r.ok) throw new Error(String(r.status));
      this.man = await r.json();
    } catch {
      $('water-btn').hidden = true;
      return false;
    }
    const depths = this.man.map.depths;
    $<HTMLInputElement>('water-depth').max = String(depths.length - 1);
    const show = [0, 200, 1000, 2000, 5000];
    $('water-depth-ticks').innerHTML = depths.map((d, i) => show.includes(d)
      ? `<span style="left:${((100 * i) / (depths.length - 1)).toFixed(2)}%">${d >= 1000 ? `${d / 1000} km` : d === 0 ? '0' : `${d} m`}</span>` : '').join('');
    $('month-strip').innerHTML = `<button type="button" role="radio" data-month="0" aria-checked="true">Year</button>`
      + MONTHS.map((m, i) => `<button type="button" role="radio" data-month="${i + 1}" aria-checked="false" aria-label="${MONTH_LONG[i]}">${m[0]}</button>`).join('');
    $('water-var').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-var]');
      if (b) this.set({ v: b.dataset.var as WaterVar });
    });
    $('water-var').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const order: WaterVar[] = ['t', 's', 'd'];
      const k = (order.indexOf(this.v) + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
      this.set({ v: order[k] });
      ($('water-var').querySelector(`[data-var="${order[k]}"]`) as HTMLButtonElement).focus();
      e.preventDefault();
    });
    $<HTMLInputElement>('water-depth').addEventListener('input', (e) => this.set({ depthIdx: Number((e.target as HTMLInputElement).value) }));
    $<HTMLInputElement>('water-stretch').addEventListener('change', (e) => this.set({ stretch: (e.target as HTMLInputElement).checked }));
    $('month-strip').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-month]');
      if (b && !b.disabled) { this.setPlaying(false); this.set({ month: Number(b.dataset.month) }); }
    });
    $('water-play').addEventListener('click', () => this.setPlaying(!this.playing));
    $('water-btn').addEventListener('click', () => (this.open ? this.close() : this.show()));
    $('water-close').addEventListener('click', () => this.close());
    document.addEventListener('visibilitychange', () => { this.lastT = 0; });
    return true;
  }

  get depth(): number { return this.man.map.depths[this.depthIdx]; }
  /** month controls apply only to surface temperature (the monthly files) */
  get monthly(): boolean { return this.v === this.man.map.monthly.var && this.depth === this.man.map.monthly.depth; }
  get key(): string { return layerKey(this.v, this.depth, this.monthly ? this.month : 0); }

  async show(opts: { v?: WaterVar; depth?: number } = {}) {
    if (!this.man) return;
    this.host.beforeOpen();
    this.open = true;
    $('water').hidden = false;
    $('ui').classList.add('water-open');
    $('water-btn').setAttribute('aria-pressed', 'true');
    this.ensureLayer();
    this.host.map.setLayoutProperty('water', 'visibility', 'visible');
    this.host.underlay(true);
    const depthIdx = opts.depth !== undefined ? Math.max(0, this.man.map.depths.indexOf(opts.depth)) : this.depthIdx;
    await this.set({ v: opts.v ?? this.v, depthIdx });
    this.host.layout();
  }

  close(writeHash = true) {
    if (!this.open) return;
    this.setPlaying(false);
    this.open = false;
    $('water').hidden = true;
    $('ui').classList.remove('water-open');
    $('water-btn').setAttribute('aria-pressed', 'false');
    if (this.added) this.host.map.setLayoutProperty('water', 'visibility', 'none');
    this.host.underlay(false);
    this.host.map.getSource<import('maplibre-gl').GeoJSONSource>('water-point')?.setData({ type: 'FeatureCollection', features: [] });
    // next time the panel opens compact, with the one-line hint instead of the column chart
    this.colPoint = null;
    $('water').dataset.col = 'empty';
    $('wc-empty').hidden = false; $('wc-chart').hidden = true; $('wc-where').textContent = '';
    $('wc-empty').textContent = EMPTY_HINT;
    if (writeHash) this.writeHash();
    this.host.onChange();
    this.host.layout();
  }

  private ensureLayer() {
    if (this.added) return;
    const map = this.host.map;
    map.addSource('water', { type: 'canvas', canvas: this.canvas, coordinates: MERC_WORLD, animate: false });
    map.addLayer({ id: 'water', type: 'raster', source: 'water', paint: { 'raster-opacity': OPACITY, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, 'hillshade');
    map.addSource('water-point', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'water-point', type: 'circle', source: 'water-point', paint: { 'circle-radius': 6, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
    this.added = true;
  }

  private grid(key: string): Promise<Grid | null> {
    let p = this.grids.get(key);
    if (p) return p;
    const L = this.man.map.layers[key];
    p = (async () => {
      if (!L) return null;
      const r = await fetch(`${this.host.base}map/${key}.bin`);
      if (!r.ok) return null;
      const q = await inflate(await r.arrayBuffer());
      const m = this.man.map;
      return { values: decodeMapLayer(q, L.lo, L.step), width: m.width, height: m.height, north: m.north, west: m.west, res: m.res_deg };
    })().catch(() => null).then((g) => { this.ready.set(key, g); return g; });
    this.grids.set(key, p);
    return p;
  }

  async set(s: { v?: WaterVar; depthIdx?: number; month?: number; stretch?: boolean }) {
    if (s.v) this.v = s.v;
    if (s.depthIdx !== undefined) this.depthIdx = s.depthIdx;
    if (s.month !== undefined) this.month = s.month;
    if (s.stretch !== undefined) this.stretch = s.stretch;
    if (!this.monthly && this.playing) this.setPlaying(false);
    this.renderControls();
    if (this.open) { await this.draw(); this.writeHash(); }
    if (this.colPoint) this.chart.setMapDepth(this.depth);
    this.host.onChange();
  }

  private renderControls() {
    const meta = this.man.variables[this.v];
    $('water-var').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.var === this.v)));
    const di = $<HTMLInputElement>('water-depth');
    di.value = String(this.depthIdx);
    const dtext = this.depth === 0 ? 'surface' : `${this.depth.toLocaleString('en-US')} m`;
    di.setAttribute('aria-valuetext', dtext);
    $('water-depth-out').textContent = this.depth === 0 ? 'Surface' : `${this.depth.toLocaleString('en-US')} m`;
    // one-line state for the minimised header
    const mShown = this.monthly ? (this.playing ? Math.round(this.monthPos) % 12 + 1 : this.month) : 0;
    $('water-sum').textContent = `${TITLES[this.v]} · ${this.depth === 0 ? 'Surface' : `${this.depth.toLocaleString('en-US')} m`}${mShown ? ` · ${MONTH_LONG[mShown - 1]}` : ''}`;
    // months: surface temperature only
    const mOn = this.monthly;
    $('water-months').setAttribute('aria-disabled', String(!mOn));
    $<HTMLButtonElement>('water-play').disabled = !mOn;
    const shown = this.playing ? Math.round(this.monthPos) % 12 + 1 : this.month;
    $('month-strip').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.disabled = !mOn && b.dataset.month !== '0';
      b.setAttribute('aria-checked', String(Number(b.dataset.month) === (mOn ? shown : 0)));
    });
    // legend
    const [lo, hi] = scaleRange(this.man, this.v, this.key, this.stretch);
    const unit = meta.units ? `, ${meta.units}` : '';
    const label = this.v === 'd' ? `Potential density σ₀${unit}` : this.v === 's' ? 'Salinity (practical, no unit)' : `Temperature${unit}`;
    $('water-legend-cap').textContent = `${label}${this.stretch ? ', stretched' : ''}`;
    $('water-bar').style.background = `linear-gradient(90deg, ${gradientCss(this.v)})`;
    $<HTMLInputElement>('water-stretch').checked = this.stretch;
    const ticks = legendTicks(lo, hi, 4);
    // decimals: as many as the tick step needs (34.25 -> 2), ends shown with the same precision
    const dec = Math.min(2, Math.max(0, ...ticks.map((x) => (String(x).split('.')[1] ?? '').length)));
    const pos = (x: number) => (100 * (x - lo)) / (hi - lo);
    const items = ticks.filter((x) => pos(x) > 14 && pos(x) < 86).map((x) => `<span style="left:${pos(x).toFixed(1)}%">${fmt(x, dec)}</span>`);
    $('water-ticks').innerHTML = `<span class="end-lo" style="left:0">≤${fmt(lo, dec)}</span>${items.join('')}<span class="end-hi" style="left:100%">≥${fmt(hi, dec)}</span>`;
    // note
    const L = this.man.map.layers[layerKey(this.v, this.depth)];
    const vr = this.man.variables[this.v].range;
    let note: string;
    if (this.playing || (mOn && this.month)) note = `Surface temperature in ${MONTH_LONG[(this.playing ? Math.round(this.monthPos) % 12 : this.month - 1)]}, averaged over 1991–2020.`;
    else if (!this.stretch && L && (L.p98 - L.p2) < 0.25 * (vr[1] - vr[0]))
      note = `At ${dtext} most water spans only ${fmt(L.p2, 2)}–${fmt(L.p98, 2)}${meta.units ? ` ${meta.units}` : ''}. Stretch the colours to see its structure.`;
    else if (this.v === 'd') note = 'Potential density: the density the water would have if brought to the surface (TEOS-10), minus 1,000 kg/m³. Denser water sinks under lighter water.';
    else if (this.v === 's') note = 'Salt rises where evaporation wins (subtropics, Mediterranean, Red Sea) and falls under heavy rain and river water.';
    else note = mOn ? 'Annual mean. Pick a month or press play to see the seasons.' : 'Grey where the seafloor is shallower than this depth.';
    $('water-note').textContent = note;
  }

  private async draw() {
    const t = ++this.drawToken;
    const m = this.playing ? this.monthPos : null;
    let a: Grid | null, b: Grid | null = null, frac = 0;
    if (m !== null) {
      const m0 = Math.floor(m) % 12, m1 = (m0 + 1) % 12;
      frac = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : m - Math.floor(m);
      [a, b] = await Promise.all([this.grid(layerKey('t', 0, m0 + 1)), this.grid(layerKey('t', 0, m1 + 1))]);
    } else {
      a = await this.grid(this.key);
    }
    if (t !== this.drawToken || !a) return;
    const [lo, hi] = scaleRange(this.man, this.v, m !== null ? layerKey('t', 0) : this.key, this.stretch);
    const t0 = performance.now();
    renderMercator(this.img.data, SIZE, a, this.luts[this.v], lo, hi, 255, b, frac);
    this.ctx.putImageData(this.img, 0, 0);
    const src = this.host.map.getSource<CanvasSource>('water');
    if (src) this.upload(src);
    this.stats.renders++;
    if (this.stats.renderMs.length < 2000) this.stats.renderMs.push(performance.now() - t0);
  }

  /**
   * Push the canvas to the GPU: the source stays "playing" (texture re-uploaded each frame) for a few frames,
   * and with 3D terrain the raster is drawn into cached terrain textures that must be invalidated.
   */
  private framesLeft = 0;
  private nudge = false;
  private upload(src: CanvasSource) {
    src.play();
    // a paint change fires a style 'data' event, which makes MapLibre redraw the cached terrain textures
    // (the canvas source alone does not invalidate them); the opacity alternates by 0.001, invisible
    this.nudge = !this.nudge;
    this.host.map.setPaintProperty('water', 'raster-opacity', this.nudge ? OPACITY - 0.001 : OPACITY);
    const already = this.framesLeft > 0;
    this.framesLeft = 3;
    if (already) return;
    const onRender = () => {
      if (--this.framesLeft > 0 || this.playing) { if (this.framesLeft <= 0) this.framesLeft = 1; return; }
      this.host.map.off('render', onRender);
      src.pause();
    };
    this.host.map.on('render', onRender);
  }

  // ---------- monthly animation ----------
  setPlaying(on: boolean) {
    if (on === this.playing || (on && !this.monthly)) return;
    this.playing = on;
    $('water-play').setAttribute('aria-pressed', String(on));
    $('water-play').setAttribute('aria-label', on ? 'Pause the year' : 'Play the year, month by month');
    if (on) {
      this.monthPos = Math.max(0, this.month - 1);
      this.lastT = 0;
      // fetch all twelve months up front so the loop never waits on the network
      for (let i = 1; i <= 12; i++) this.grid(layerKey('t', 0, i));
      requestAnimationFrame((ts) => this.tick(ts));
    } else {
      this.month = Math.round(this.monthPos) % 12 + 1;
      if (this.open) { this.renderControls(); this.draw(); }
    }
  }
  /** Fetch the twelve monthly surface-temperature layers (about 6.6 MB); resolves with how many loaded. */
  async preloadMonths(): Promise<number> {
    const gs = await Promise.all(Array.from({ length: 12 }, (_, i) => this.grid(layerKey('t', 0, i + 1))));
    return gs.filter(Boolean).length;
  }
  private busy = false;
  private tick(ts: number) {
    if (!this.playing) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.lastT) {
      const dt = Math.min(0.1, (ts - this.lastT) / 1000);
      const before = Math.round(this.monthPos);
      // reduced motion: slower, and draw() shows whole months without blending
      this.monthPos = (this.monthPos + dt / (reduce ? 1.6 : SECONDS_PER_MONTH)) % 12;
      if (Math.round(this.monthPos) !== before) this.renderControls();
    }
    this.lastT = ts;
    if (!this.busy) {
      this.busy = true;
      this.draw().finally(() => { this.busy = false; this.host.onChange(); });
    }
    requestAnimationFrame((t) => this.tick(t));
  }

  // ---------- hover ----------
  /** {label, value} for the readout, or null when the panel is closed. */
  readout(lon: number, lat: number): { label: string; value: string } | null {
    if (!this.open) return null;
    const meta = this.man.variables[this.v];
    const where = this.depth === 0 ? 'surface' : `${this.depth.toLocaleString('en-US')} m`;
    const label = `${TITLES[this.v]}, ${where}`;
    let v = NaN;
    let L = this.man.map.layers[this.key];
    if (this.playing) {
      const m0 = Math.floor(this.monthPos) % 12, m1 = (m0 + 1) % 12, f = this.monthPos - Math.floor(this.monthPos);
      const a = this.ready.get(layerKey('t', 0, m0 + 1)), b = this.ready.get(layerKey('t', 0, m1 + 1));
      if (a && b) v = sampleGrid(a, lon, lat) * (1 - f) + sampleGrid(b, lon, lat) * f;
      L = this.man.map.layers[layerKey('t', 0, m0 + 1)];
    } else {
      const g = this.ready.get(this.key);
      if (g) v = sampleGrid(g, lon, lat);
    }
    if (!Number.isFinite(v)) return { label, value: this.ready.has(this.key) ? 'no water' : '…' };
    return { label, value: formatWater(v, Math.min(2, decimalsFor(layerStep(L))), meta.units) };
  }

  // ---------- water column ----------
  private chunk(c: CellRef): Promise<Uint8Array | null> {
    const k = `${c.i}_${c.j}`;
    let p = this.chunks.get(k);
    if (!p) {
      p = fetch(`${this.host.base}col/${k}.bin`).then(async (r) => (r.ok ? inflate(await r.arrayBuffer()) : null)).catch(() => null);
      this.chunks.set(k, p);
    }
    return p;
  }

  /** Water column of the 1 deg cell under lon/lat, or of the nearest ocean cell within 2 cells. */
  async columnAt(lon: number, lat: number): Promise<{ col: Column; moved: boolean } | null> {
    const cm = this.man.columns;
    const c0 = cellFor(cm, lon, lat);
    for (const c of [c0, ...neighbours(cm, c0, 2)]) {
      const bytes = await this.chunk(c);
      const col = bytes ? columnFromChunk(cm, bytes, c) : null;
      if (col) return { col, moved: c !== c0 };
    }
    return null;
  }

  async showColumn(lon: number, lat: number) {
    if (!this.open) return null;
    this.colPoint = [lon, lat];
    const [res, floor] = await Promise.all([this.columnAt(lon, lat), this.host.seafloorAt(lon, lat).catch(() => NaN)]);
    if (!this.colPoint || this.colPoint[0] !== lon || this.colPoint[1] !== lat) return null;
    const pt = this.host.map.getSource<import('maplibre-gl').GeoJSONSource>('water-point');
    if (!res) {
      $('wc-title').textContent = 'Water column';
      $('wc-where').textContent = `${fmtPlace(lon, lat)}: no ocean data in the 1° grid here.`;
      $('wc-empty').hidden = false; $('wc-chart').hidden = true;
      $('water').dataset.col = 'empty';
      $('wc-empty').textContent = 'This point is land, or too close to the coast for the 1° water-column grid. Click open water.';
      this.host.layout();
      pt?.setData({ type: 'FeatureCollection', features: [] });
      return null;
    }
    const { col, moved } = res;
    const bottom = col.depth[col.depth.length - 1];
    $('wc-title').textContent = 'Water column';
    const sea = Number.isFinite(floor) && floor < 0 ? `, seafloor ${formatDepth(floor).replace('−', '')} (GEBCO)` : '';
    const th = thermocline(col);
    const drop = th ? `. Temperature falls fastest at ${Math.round(th.depth)} m (marked)` : '';
    $('wc-where').textContent = `${moved ? 'nearest 1° ocean cell, ' : '1° cell at '}${fmtPlace(col.lon, col.lat)}, data to ${bottom.toLocaleString('en-US')} m${sea}${drop}`;
    $('wc-empty').hidden = true; $('wc-chart').hidden = false;
    $('water').dataset.col = 'shown';
    const panels: PanelSpec[] = (['t', 's', 'd'] as WaterVar[]).map((v) => ({
      v, title: v === 'd' ? 'σ₀' : TITLES[v], short: v === 't' ? 'T' : v === 's' ? 'S' : 'σ₀', units: this.man.variables[v].units, decimals: v === 't' ? 2 : 3,
      scale: this.man.variables[v].range,
    }));
    this.chart.set(col, panels, this.depth);
    if (window.innerWidth < 760) $('wc-chart').scrollIntoView({ block: 'nearest' });
    this.host.layout();
    pt?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } }] });
    return { lon: col.lon, lat: col.lat, moved, bottom, levels: col.depth.length, surface: { t: col.t[0], s: col.s[0], d: col.d[0] }, series: this.chart.seriesCount() };
  }

  // ---------- deep link ----------
  private writeHash() {
    const h = hashWithWater(location.hash, this.open ? { v: this.v, depth: this.depth } : null);
    if (h !== location.hash && !(h === '' && location.hash === '')) history.replaceState(null, '', h || location.pathname + location.search);
  }
  fromHash(hash: string) { return this.man ? waterFromHash(hash, this.man.map.depths) : null; }

  renderStats() {
    const a = [...this.stats.renderMs].sort((x, y) => x - y);
    const q = (p: number) => (a.length ? +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1) : null);
    const out = { renders: this.stats.renders, medianMs: q(0.5), p95Ms: q(0.95) };
    this.stats.renders = 0; this.stats.renderMs = [];
    return out;
  }
}

function fmt(x: number, dec: number): string { return (x < 0 ? '−' : '') + Math.abs(x).toFixed(dec); }
function fmtPlace(lon: number, lat: number) {
  return `${formatLat(lat).replace(/\.\d+/, (m) => (m === '.000' ? '' : m.slice(0, 2)))}, ${formatLon(lon).replace(/\.\d+/, (m) => (m === '.000' ? '' : m.slice(0, 2)))}`;
}
