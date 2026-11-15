// DOM + map side of three monthly ocean layers: Phytoplankton (chlorophyll-a, a canvas reprojected like the
// ocean-water layer) and Winds / Ocean currents (moving particles, flow-layer.ts). Loaded on first use; each
// month file is fetched when shown (chlorophyll 0.6 MB + the 0.5 MB WOA ocean mask, wind 0.13 MB, currents
// 1.1 MB). The Time panel's Months mode drives `setMonth`; otherwise the annual means are shown.
import type { CanvasSource, Map as MlMap } from 'maplibre-gl';
import { ALGAE, applyMask, chlKey, chlTicks, formatChl, oceanMask, type ChlManifest } from './chl';
import {
  decodeUV, FLOW_RAMP, flowKey, formatFlow, particleCount, sampleUV, spawnArea, type FlowField, type FlowKind, type FlowManifest, type SpawnArea,
} from './flow';
import { FlowLayer } from './flow-layer';
import { buildLut, decodeMapLayer, inflate, MERC_WORLD, renderMercator, sampleGrid, type Grid, type WaterManifest } from './water';
import { MONTH_LONG } from './timeline';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SIZE = 2048;
const CHL_OPACITY = 0.92;
/** Speed at the bright end of the streak ramp (m/s): about the 99th percentile of the monthly means. */
const SMAX: Record<FlowKind, number> = { wind: 10, currents: 1 };
const FLOW_TITLE: Record<FlowKind, string> = { wind: 'Winds at 10 m', currents: 'Surface currents' };
const FLOW_ROW: Record<FlowKind, string> = { wind: 'winds', currents: 'currents' };

export interface OceanHost {
  map: MlMap;
  /** the phytoplankton layer is about to show: other colour fields (ocean water, marine life) step aside */
  beforeChl: () => void;
  /** switch the relief to its neutral under-layer (true) or back */
  underlay: (on: boolean) => void;
  onChange: () => void;
  offerTime: (what: 'months') => void;
}

export class OceanUI {
  chlOn = false;
  flow: FlowKind | null = null;
  month = 0; // 0 = annual mean
  private chlMan: ChlManifest | null = null;
  private flowMan: Partial<Record<FlowKind, FlowManifest>> = {};
  private chlGrids = new Map<string, Promise<Grid | null>>();
  private chlReady = new Map<string, Grid | null>();
  private mask: Promise<Uint8Array | null> | null = null;
  private fields = new Map<string, Promise<FlowField | null>>();
  private fieldReady = new Map<string, FlowField | null>();
  private layers: Partial<Record<FlowKind, FlowLayer>> = {};
  private area: SpawnArea = spawnArea([[-180, -84, 180, 84]]);
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private chlAdded = false;
  private lut = buildLut(ALGAE);
  private token = 0;
  private pending = new Map<string, Promise<unknown>>();
  readonly stats = { chlRenders: 0, chlMs: 0 };
  private reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private host: OceanHost) {
    this.canvas.width = SIZE; this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(SIZE, SIZE);
    $<HTMLInputElement>('t-chl').addEventListener('change', (e) => this.setChl((e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('t-winds').addEventListener('change', (e) => this.setFlow('wind', (e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('t-currents').addEventListener('change', (e) => this.setFlow('currents', (e.target as HTMLInputElement).checked));
    const map = host.map;
    map.on('moveend', () => this.updateArea());
    map.on('resize', () => { for (const l of Object.values(this.layers)) l?.reseed(this.prerun); });
    this.reduce.addEventListener('change', () => this.applyMotion());
    document.addEventListener('visibilitychange', () => this.applyMotion());
  }

  get prerun(): number { return this.reduce.matches ? 16 : 0; }
  get monthLabel(): string { return this.month ? MONTH_LONG[this.month - 1] : 'annual mean'; }

  // ---------- loading ----------
  private async manifests(kind: 'chl' | FlowKind) {
    if (kind === 'chl') {
      this.chlMan ??= await fetch('chl/manifest.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      return this.chlMan;
    }
    this.flowMan[kind] ??= await fetch(`flow/${kind}/manifest.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null) ?? undefined;
    return this.flowMan[kind] ?? null;
  }
  /** WOA surface-temperature cells (one-cell margin) minus the Caspian and Lake Ontario: the chlorophyll ocean mask. */
  private oceanMask(): Promise<Uint8Array | null> {
    this.mask ??= (async () => {
      const man: WaterManifest | null = await fetch('woa/manifest.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const L = man?.map.layers.t_0;
      const r = L ? await fetch('woa/map/t_0.bin') : null;
      if (!man || !L || !r?.ok) return null;
      const v = decodeMapLayer(await inflate(await r.arrayBuffer()), L.lo, L.step);
      return oceanMask(v, man.map.width, man.map.height, man.map.north, man.map.west, man.map.res_deg);
    })().catch(() => null);
    return this.mask;
  }
  private chlGrid(month: number): Promise<Grid | null> {
    const key = chlKey(month);
    let p = this.chlGrids.get(key);
    if (!p) {
      p = (async () => {
        const man = await this.manifests('chl') as ChlManifest | null;
        if (!man) return null;
        const [r, mask] = await Promise.all([fetch(`chl/${key}.bin`), this.oceanMask()]);
        if (!r.ok) return null;
        const g = man.grid, values = decodeMapLayer(await inflate(await r.arrayBuffer()), g.lo, g.step);
        if (mask && mask.length === values.length) applyMask(values, mask);
        return { values, width: g.width, height: g.height, north: g.north, west: g.west, res: g.res_deg };
      })().catch(() => null).then((x) => { this.chlReady.set(key, x); return x; });
      this.chlGrids.set(key, p);
    }
    return p;
  }
  private field(kind: FlowKind, month: number): Promise<FlowField | null> {
    const key = `${kind}/${flowKey(month)}`;
    let p = this.fields.get(key);
    if (!p) {
      p = (async () => {
        const man = await this.manifests(kind) as FlowManifest | null;
        if (!man) return null;
        const r = await fetch(`flow/${key}.bin`);
        if (!r.ok) return null;
        const g = man.grid;
        const [u, v] = decodeUV(await inflate(await r.arrayBuffer()), g.width, g.height, g.scale);
        return { g, u, v };
      })().catch(() => null).then((x) => { this.fieldReady.set(key, x); return x; });
      this.fields.set(key, p);
    }
    return p;
  }
  /** Fetches the twelve months of the layers that are on (before playing the year). */
  async preloadMonths(): Promise<number> {
    const jobs: Promise<unknown>[] = [];
    for (let m = 1; m <= 12; m++) {
      if (this.chlOn) jobs.push(this.chlGrid(m));
      if (this.flow) jobs.push(this.field(this.flow, m));
    }
    return (await Promise.all(jobs)).filter(Boolean).length;
  }
  /** Resolves when the layer's current month is drawn (test hook). */
  async whenReady(id: 'chl' | FlowKind): Promise<boolean> {
    await this.pending.get(id);
    if (id === 'chl') return this.chlReady.has(chlKey(this.month)) && !!this.chlReady.get(chlKey(this.month));
    return !!this.fieldReady.get(`${id}/${flowKey(this.month)}`) && !!this.layers[id]?.field;
  }

  // ---------- phytoplankton ----------
  async setChl(on: boolean) {
    if (on === this.chlOn && (!on || this.chlAdded)) { this.renderChlControls(); return; }
    if (on) this.host.beforeChl();
    this.chlOn = on;
    this.renderChlControls();
    const map = this.host.map;
    if (on) {
      if (!this.chlAdded) {
        map.addSource('chl', { type: 'canvas', canvas: this.canvas, coordinates: MERC_WORLD, animate: false });
        map.addLayer({ id: 'chl', type: 'raster', source: 'chl', paint: { 'raster-opacity': CHL_OPACITY, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, 'hillshade');
        this.chlAdded = true;
      }
      this.host.underlay(true);
      map.setLayoutProperty('chl', 'visibility', 'visible');
      $('row-chl').setAttribute('aria-busy', 'true');
      const p = this.drawChl();
      this.pending.set('chl', p);
      await p;
      $('row-chl').removeAttribute('aria-busy');
      this.host.offerTime('months');
    } else if (this.chlAdded) {
      map.setLayoutProperty('chl', 'visibility', 'none');
      this.host.underlay(false);
    }
    this.host.onChange();
  }
  private renderChlControls() {
    $<HTMLInputElement>('t-chl').checked = this.chlOn;
    $('row-chl').classList.toggle('on', this.chlOn);
    $('lg-chl').hidden = !this.chlOn;
    $('lg-chl-t').textContent = `Phytoplankton, ${this.month ? MONTH_LONG[this.month - 1] : 'annual mean'}`;
  }
  private async drawChl() {
    const t = ++this.token;
    const g = await this.chlGrid(this.month);
    if (t !== this.token || !g || !this.chlOn) return;
    const man = this.chlMan!;
    const [lo, hi] = man.variable.range.map(Math.log10);
    const t0 = performance.now();
    renderMercator(this.img.data, SIZE, g, this.lut, lo, hi, 255);
    this.ctx.putImageData(this.img, 0, 0);
    this.stats.chlRenders++; this.stats.chlMs = Math.round(performance.now() - t0);
    const src = this.host.map.getSource<CanvasSource>('chl');
    if (src) {
      // as in the water layer: play a few frames, and a tiny paint change redraws the terrain-draped texture cache
      src.play();
      this.host.map.setPaintProperty('chl', 'raster-opacity', this.stats.chlRenders % 2 ? CHL_OPACITY - 0.001 : CHL_OPACITY);
      let n = 3;
      const onRender = () => { if (--n > 0) return; this.host.map.off('render', onRender); src.pause(); };
      this.host.map.on('render', onRender);
      this.host.map.triggerRepaint();
    }
  }

  // ---------- winds and currents ----------
  /** One flow layer at a time: switching winds on switches currents off and back. */
  async setFlow(kind: FlowKind, on: boolean) {
    const map = this.host.map;
    if (on && this.flow && this.flow !== kind) await this.setFlow(this.flow, false);
    this.flow = on ? kind : this.flow === kind ? null : this.flow;
    $<HTMLInputElement>(`t-${FLOW_ROW[kind]}`).checked = on;
    $(`row-${FLOW_ROW[kind]}`).classList.toggle('on', on);
    this.renderFlowLegend();
    if (on) {
      $(`row-${FLOW_ROW[kind]}`).setAttribute('aria-busy', 'true');
      const p = (async () => {
        const man = await this.manifests(kind) as FlowManifest | null;
        const f = await this.field(kind, this.month);
        if (!man || !f || this.flow !== kind) return;
        let layer = this.layers[kind];
        if (!layer) {
          layer = new FlowLayer({ id: `flow-${kind}`, smax: SMAX[kind], pxPerFrame: kind === 'wind' ? 1.4 : 2.4, count: () => particleCount(window.innerWidth, window.innerHeight), area: () => this.area });
          this.layers[kind] = layer;
        }
        this.computeArea();
        layer.field = f;
        if (!map.getLayer(layer.id)) map.addLayer(layer, map.getLayer('pipelines-casing') ? 'pipelines-casing' : undefined);
        layer.reseed(this.prerun);
        this.applyMotion();
      })();
      this.pending.set(kind, p);
      await p;
      $(`row-${FLOW_ROW[kind]}`).removeAttribute('aria-busy');
      this.host.offerTime('months');
    } else {
      const layer = this.layers[kind];
      if (layer && map.getLayer(layer.id)) map.removeLayer(layer.id);
      if (layer) layer.field = null;
    }
    this.host.onChange();
  }
  /** Runs while visible and motion is allowed; with reduced motion the streaks are drawn once and stay still. */
  private applyMotion() {
    for (const l of Object.values(this.layers)) {
      if (!l) continue;
      const run = !this.reduce.matches && !document.hidden;
      if (run !== l.running) { l.running = run; if (!run) l.refreshArea(this.prerun); }
      this.host.map.triggerRepaint();
    }
  }
  /**
   * Where particles start, weighted by on-screen area so their density on the screen is even: lon/lat cells
   * (4° on the whole globe, 2° and 1° closer in) that are off the horizon and inside the window, each weighted by
   * the part of its projected screen area inside the window (the foreshortened band at the globe's limb and cells
   * cut by the window edge get few particles).
   * From zoom 6 the view box is small and flat enough to use as it is.
   */
  private computeArea() {
    const map = this.host.map;
    const c = map.getCanvas(), W = c.clientWidth, H = c.clientHeight;
    const z = map.getZoom();
    // the horizon test is internal API (map._camera.transform in MapLibre 6, map.transform before); without it the
    // far side gets particles too, which the shader clips: wasted, not wrong
    type Tr = { isLocationOccluded?: (ll: { lng: number; lat: number }) => boolean };
    const m = map as unknown as { _camera?: { transform?: Tr }; transform?: Tr };
    const tr: Tr = m._camera?.transform ?? m.transform ?? {};
    const boxes: [number, number, number, number][] = [], factor: number[] = [];
    const b = map.getBounds();
    let w = b.getWest(), e = b.getEast();
    const s0 = Math.max(-84, b.getSouth()), n0 = Math.min(84, b.getNorth());
    if (e - w >= 360 || z < 3) { w = -180; e = 180; }
    if (z >= 6) {
      const w0 = ((((w + 180) % 360) + 360) % 360) - 180, e0 = w0 + (e - w);
      if (e0 > 180) boxes.push([w0, s0, 180, n0], [-180, s0, e0 - 360, n0]); else boxes.push([w0, s0, e0, n0]);
    } else {
      const S = z < 3 ? 4 : z < 4.5 ? 2 : 1, D = Math.PI / 180;
      const [la0, la1] = z < 3 ? [-84, 84] : [Math.floor(s0 / S) * S, n0];
      const lo0 = Math.floor(w / S) * S;
      const ny = Math.ceil((la1 - la0) / S), nx = Math.ceil((e - lo0) / S);
      // every grid vertex projected once and shared by its four cells
      const px = new Float64Array((ny + 1) * (nx + 1)), py = new Float64Array(px.length), vis = new Uint8Array(px.length);
      for (let r = 0; r <= ny; r++) for (let q = 0; q <= nx; q++) {
        const k = r * (nx + 1) + q, ll = { lng: lo0 + q * S, lat: Math.min(84, la0 + r * S) };
        if (tr.isLocationOccluded?.(ll)) continue;
        const p = map.project([ll.lng, ll.lat]);
        px[k] = p.x; py[k] = p.y; vis[k] = 1;
      }
      for (let r = 0; r < ny; r++) for (let q = 0; q < nx; q++) {
        const k = r * (nx + 1) + q, k1 = k + 1, k2 = k + nx + 1;
        if (!vis[k] || !vis[k1] || !vis[k2]) continue;
        // the cell's screen box (fourth corner by symmetry) and the share of it inside the window
        const x3 = px[k1] + px[k2] - px[k], y3 = py[k1] + py[k2] - py[k];
        const bx0 = Math.min(px[k], px[k1], px[k2], x3), bx1 = Math.max(px[k], px[k1], px[k2], x3);
        const by0 = Math.min(py[k], py[k1], py[k2], y3), by1 = Math.max(py[k], py[k1], py[k2], y3);
        const inside = Math.max(0, Math.min(W, bx1) - Math.max(0, bx0)) * Math.max(0, Math.min(H, by1) - Math.max(0, by0));
        const shown = inside / Math.max(1e-6, (bx1 - bx0) * (by1 - by0));
        if (!(shown > 0) || bx1 - bx0 > W) continue; // off screen, or wrapped across the antimeridian in mercator
        const screen = shown * Math.abs((px[k1] - px[k]) * (py[k2] - py[k]) - (py[k1] - py[k]) * (px[k2] - px[k]));
        const lat = la0 + r * S, lat2 = Math.min(84, lat + S), lon = lo0 + q * S;
        const sphere = S * Math.abs(Math.sin(lat2 * D) - Math.sin(lat * D));
        if (!(screen > 0) || !(sphere > 0)) continue;
        const lw = ((((lon + 180) % 360) + 360) % 360) - 180;
        boxes.push([lw, lat, lw + S, lat2]);
        factor.push(screen / sphere); // spawnArea multiplies by the sphere area again: weight = screen area
      }
    }
    this.area = boxes.length ? spawnArea(boxes, factor.length ? factor : undefined, factor.length ? (z < 3 ? 4 : z < 4.5 ? 2 : 1) : undefined) : spawnArea([[-180, -84, 180, 84]]);
  }
  private updateArea() {
    if (!this.flow) return;
    this.computeArea();
    this.layers[this.flow]?.refreshArea(this.prerun);
  }

  // ---------- months (Time panel) ----------
  async setMonth(month: number) {
    if (month === this.month) return;
    this.month = month;
    this.renderChlControls();
    this.renderFlowLegend();
    const jobs: Promise<unknown>[] = [];
    if (this.chlOn) jobs.push(this.drawChl());
    if (this.flow) {
      const kind = this.flow;
      jobs.push(this.field(kind, month).then((f) => { const l = this.layers[kind]; if (f && l && this.month === month) { l.field = f; if (!l.running) l.refreshArea(this.prerun); } }));
    }
    await Promise.all(jobs);
  }

  // ---------- readout ----------
  readout(lon: number, lat: number): { label: string; value: string }[] {
    const out: { label: string; value: string }[] = [];
    if (this.flow) {
      const f = this.fieldReady.get(`${this.flow}/${flowKey(this.month)}`);
      const uv = [NaN, NaN];
      if (f) sampleUV(f, lon, lat, uv);
      out.push({ label: `${this.flow === 'wind' ? 'Wind' : 'Current'}, ${this.month ? MONTH_LONG[this.month - 1] : 'annual mean'}`, value: f ? formatFlow(this.flow, uv[0], uv[1]) : '…' });
    }
    if (this.chlOn) {
      const g = this.chlReady.get(chlKey(this.month));
      const v = g ? sampleGrid(g, lon, lat) : NaN;
      out.push({ label: 'Chlorophyll-a', value: g ? (Number.isFinite(v) ? formatChl(10 ** v) : 'no data (land, lake, ice or cloud)') : '…' });
    }
    return out;
  }
  /** Raw values for tests: chlorophyll mg/m³ and u, v m/s. */
  value(lon: number, lat: number) {
    const g = this.chlReady.get(chlKey(this.month));
    const f = this.flow ? this.fieldReady.get(`${this.flow}/${flowKey(this.month)}`) : null;
    const uv = [NaN, NaN];
    if (f) sampleUV(f, lon, lat, uv);
    const v = g ? sampleGrid(g, lon, lat) : NaN;
    return { chl: Number.isFinite(v) ? +(10 ** v).toFixed(4) : null, u: Number.isFinite(uv[0]) ? +uv[0].toFixed(3) : null, v: Number.isFinite(uv[1]) ? +uv[1].toFixed(3) : null, text: this.readout(lon, lat) };
  }
  flowStats() { return this.flow ? this.layers[this.flow]?.takeStats() ?? null : null; }
  get flowLayer(): FlowLayer | null { return this.flow ? this.layers[this.flow] ?? null : null; }
  /** Pixel of the chlorophyll canvas (test hook). */
  chlPixel(lon: number, lat: number): number[] {
    const x = Math.floor(((lon + 180) / 360) * SIZE);
    const yn = 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
    return [...this.ctx.getImageData(x, Math.floor(yn * SIZE), 1, 1).data];
  }

  // ---------- legends ----------
  renderStatic() {
    $('chl-bar').style.background = `linear-gradient(90deg, ${ALGAE.map((c, i) => `${c} ${((100 * i) / (ALGAE.length - 1)).toFixed(1)}%`).join(', ')})`;
    $('chl-ticks').innerHTML = chlTicks(0.01, 20).map((t, i, a) => `<span class="${i === 0 ? 'first' : ''}" style="left:${(100 * t.pos).toFixed(1)}%">${t.label}${i === a.length - 1 ? ' mg/m³' : ''}</span>`).join('');
    // the streak colour follows the square root of speed, so on a linear speed bar the stops sit at (i/3)²
    $('flow-bar').style.background = `linear-gradient(90deg, ${FLOW_RAMP.map((c, i) => `${c} ${(100 * (i / (FLOW_RAMP.length - 1)) ** 2).toFixed(1)}%`).join(', ')})`;
  }
  private renderFlowLegend() {
    const k = this.flow;
    $('lg-flow').hidden = !k;
    if (!k) return;
    const smax = SMAX[k];
    const ticks = k === 'wind' ? [0, 2.5, 5, 7.5, 10] : [0, 0.25, 0.5, 0.75, 1];
    $('flow-ticks').innerHTML = ticks.map((t, i) => `<span class="${i === 0 ? 'first' : i === ticks.length - 1 ? 'last' : ''}" style="left:${((100 * t) / smax).toFixed(1)}%">${i === ticks.length - 1 ? `${t}+ m/s` : t}</span>`).join('');
    $('lg-flow-t').textContent = `${FLOW_TITLE[k]}, ${this.month ? MONTH_LONG[this.month - 1] : 'annual mean'}`;
    $('flow-cap').textContent = k === 'wind' ? 'Speed of the 1991–2020 mean wind; streaks brighten with speed' : 'Speed of the 2015–2024 mean current, top 30 m';
  }
}
