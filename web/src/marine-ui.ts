// "Marine life" layer: three honest views of OBIS / speciesgrids / AquaMaps (pure logic in marine.ts) on one Web
// Mercator canvas under the hillshade, like the ocean-water layer; a group filter (whales, sharks, ...); hover values
// and a click card with the cell's most-recorded species. Files load on first use (~1 MB grids, cells on click).
import type { CanvasSource, Map as MlMap } from 'maplibre-gl';
import { inflate, MERC_WORLD } from './water';
import {
  cellAt, cellState, decodePlanes, describe, geohash, gradient, groupGrid, IUCN_LABEL, NO_RECORDS, NOT_ENOUGH, renderLL, SCALES, scalePos,
  type GroupDef, type LLGrid, type MarineManifest, type MarineMode,
} from './marine';
import type { CardModel } from './overlays';

const SIZE = 2048;
const OPACITY = 0.88;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** Which grid each view draws, and the ocean mask that tells "no record" from land. */
const VIEW: Record<MarineMode, { layer: string; ocean: string | null; title: string; short: string }> = {
  aquamaps: { layer: 'aquamaps_richness', ocean: null, title: 'Where species live (AquaMaps model)', short: 'Predicted species (AquaMaps)' },
  es50: { layer: 'es50_gh3', ocean: 'ocean_gh3', title: 'Species diversity, corrected', short: 'Diversity (ES50)' },
  records: { layer: 'records_gh4', ocean: 'ocean_gh4', title: 'Where nobody has looked', short: 'OBIS records' },
};
interface GroupFile { stats: Record<string, unknown>; top: { aphiaId: number; name: string; common?: string; records: number; iucn?: string | null }[]; cells: { data: number[][] } }
type CellInfo = { r: number; s: number; e: number | null; top: [number, string, number][] };

export interface MarineHost {
  map: MlMap;
  base: string; // 'data/obis/'
  /** called before the layer goes on (the ocean-water panel uses the same place on the map) */
  beforeOn: () => void;
  onChange: () => void;
}

export class MarineUI {
  man: MarineManifest | null = null;
  on = false;
  mode: MarineMode = 'aquamaps';
  group = '';
  private grids = new Map<string, Promise<LLGrid | null>>();
  private ready = new Map<string, LLGrid | null>();
  private groups = new Map<string, Promise<GroupFile | null>>();
  private groupReady = new Map<string, { file: GroupFile; grid: LLGrid } | null>();
  private cells = new Map<string, Promise<Record<string, CellInfo> | null>>();
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private added = false;
  private token = 0;
  readonly stats = { renders: 0, lastMs: 0 };
  private busy: Promise<unknown> = Promise.resolve();
  /** Resolves when the last requested view is drawn (its grids loaded): a ready signal for QA. */
  whenDrawn(): Promise<unknown> { return this.busy; }

  constructor(private host: MarineHost) {
    this.canvas.width = SIZE; this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(SIZE, SIZE);
  }

  /** Loads the manifest; false (and the row hidden) when the marine-life files are not built. */
  async init(): Promise<boolean> {
    try {
      const r = await fetch(`${this.host.base}manifest.json`);
      if (!r.ok) throw new Error(String(r.status));
      this.man = await r.json();
    } catch { $('row-marine').hidden = true; return false; }
    const sel = $<HTMLSelectElement>('marine-group');
    for (const g of this.man!.groups) sel.appendChild(new Option(g.title, g.id));
    sel.addEventListener('change', () => this.set({ group: sel.value }));
    $('marine-mode').addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'marine-mode') this.set({ mode: t.value as MarineMode });
    });
    $<HTMLInputElement>('t-marine').addEventListener('change', (e) => this.set({ on: (e.target as HTMLInputElement).checked }));
    const gap = (this.man as unknown as { stats?: { dataGap?: { gh4?: { lt1?: number } } } }).stats?.dataGap?.gh4?.lt1;
    if (typeof gap === 'number') $('marine-stat').innerHTML = `<strong>${(100 * gap).toFixed(0)}%</strong> of the ocean has no OBIS record at all within cells of about 40 × 20 km.`;
    return true;
  }

  get groupDef(): GroupDef | undefined { return this.man?.groups.find((g) => g.id === this.group); }

  private grid(layer: string): Promise<LLGrid | null> {
    const hit = this.grids.get(layer);
    if (hit) return hit;
    const L = this.man!.layers[layer];
    const p: Promise<LLGrid | null> = (async () => {
      if (!L) return null;
      const r = await fetch(`${this.host.base}${L.file}`);
      if (!r.ok) return null;
      return { values: decodePlanes(await inflate(await r.arrayBuffer()), L.dtype), def: this.man!.grids[L.grid] };
    })().catch(() => null).then((g) => {
      if (g && this.grids.get(layer) === p) this.ready.set(layer, g);
      else if (this.grids.get(layer) === p) { this.grids.delete(layer); this.ready.delete(layer); }
      return g;
    });
    this.grids.set(layer, p);
    return p;
  }
  private groupData(id: string) {
    const hit = this.groups.get(id);
    if (hit) return hit;
    const g = this.man!.groups.find((x) => x.id === id);
    const p: Promise<GroupFile | null> = g
      ? fetch(`${this.host.base}${g.file}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      : Promise.resolve(null);
    p.then((f) => {
      if (f && this.groups.get(id) === p) this.groupReady.set(id, { file: f, grid: groupGrid(this.man!.grids.gh3, f.cells.data) });
      else if (this.groups.get(id) === p) { this.groups.delete(id); this.groupReady.delete(id); }
    });
    this.groups.set(id, p);
    return p;
  }

  async set(s: { on?: boolean; mode?: MarineMode; group?: string }) {
    if (!this.man) return;
    if (s.mode) this.mode = s.mode;
    if (s.group !== undefined) this.group = s.group;
    if (s.on !== undefined && s.on !== this.on) {
      if (s.on) this.host.beforeOn();
      this.on = s.on;
    }
    this.renderControls();
    if (this.on) { this.ensureLayer(); this.busy = this.draw(); await this.busy; }
    if (this.added) this.host.map.setLayoutProperty('marine', 'visibility', this.on ? 'visible' : 'none');
    this.host.onChange();
  }

  private renderControls() {
    $<HTMLInputElement>('t-marine').checked = this.on;
    $('row-marine').classList.toggle('on', this.on);
    $('lg-marine').hidden = !this.on;
    document.querySelectorAll<HTMLInputElement>('#marine-mode input').forEach((i) => { i.checked = i.value === this.mode; i.disabled = !!this.group; });
    $('marine-mode').setAttribute('aria-disabled', String(!!this.group));
    $<HTMLSelectElement>('marine-group').value = this.group;
    $('marine-group-note').hidden = !this.group;
    // legend
    const g = this.groupDef;
    const sc = SCALES[g ? 'group' : this.mode];
    $('lg-marine-t').textContent = g ? `${g.title}: where recorded` : VIEW[this.mode].title;
    $('marine-bar').style.background = `linear-gradient(90deg, ${gradient(sc.stops)})`;
    $('marine-ticks').innerHTML = sc.ticks.map((t) => {
      const x = 100 * scalePos(sc, t);
      const lab = t >= 1e6 ? `${t / 1e6}M` : t >= 1000 ? `${t / 1000}k` : String(t);
      return `<span class="${x <= 0 ? 'first' : x >= 100 ? 'last' : ''}" style="left:${x.toFixed(1)}%">${lab}</span>`;
    }).join('');
    $('marine-unit').textContent = g ? 'OBIS records per 1.4° cell' : this.mode === 'aquamaps' ? 'predicted species per 0.5° cell (AquaMaps model)'
      : this.mode === 'es50' ? 'expected species among 50 random records, per 1.4° cell' : 'OBIS records per cell of about 40 × 20 km';
    const masked = g || this.mode !== 'aquamaps';
    $('marine-masked').hidden = !masked;
    ($('marine-masked').querySelector('.veil-chip') as HTMLElement).style.background = this.mode === 'es50' && !g ? NOT_ENOUGH : NO_RECORDS;
    $('marine-masked-t').textContent = this.mode === 'es50' && !g ? 'Fewer than 50 records: not enough data' : 'No record: nobody has looked, or nothing was reported';
  }

  private ensureLayer() {
    if (this.added) return;
    const map = this.host.map;
    map.addSource('marine', { type: 'canvas', canvas: this.canvas, coordinates: MERC_WORLD, animate: false });
    map.addLayer({ id: 'marine', type: 'raster', source: 'marine', paint: { 'raster-opacity': OPACITY, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, 'hillshade');
    this.added = true;
  }

  private framesLeft = 0;
  private async draw() {
    const t = ++this.token;
    let g: LLGrid | null, ocean: LLGrid | null = null;
    const mode: MarineMode | 'group' = this.group ? 'group' : this.mode;
    if (this.group) {
      await this.groupData(this.group);
      g = this.groupReady.get(this.group)?.grid ?? null;
      ocean = await this.grid('ocean_gh3');
    } else {
      const v = VIEW[this.mode];
      [g, ocean] = await Promise.all([this.grid(v.layer), v.ocean ? this.grid(v.ocean) : Promise.resolve(null)]);
    }
    if (t !== this.token || !g || !this.on) return;
    const t0 = performance.now();
    renderLL(this.img.data, SIZE, mode, g, ocean);
    this.ctx.putImageData(this.img, 0, 0);
    this.stats.renders++; this.stats.lastMs = Math.round(performance.now() - t0);
    const src = this.host.map.getSource<CanvasSource>('marine');
    if (src) {
      // same trick as the water layer: play for a few frames, and a tiny paint change makes MapLibre redraw the
      // terrain-draped texture cache
      src.play();
      this.host.map.setPaintProperty('marine', 'raster-opacity', this.stats.renders % 2 ? OPACITY - 0.001 : OPACITY);
      const already = this.framesLeft > 0;
      this.framesLeft = 3;
      if (!already) {
        const onRender = () => {
          if (--this.framesLeft > 0) return;
          this.host.map.off('render', onRender);
          src.pause();
        };
        this.host.map.on('render', onRender);
      }
      this.host.map.triggerRepaint();
    }
  }

  /** {label, value} for the readout, or null when the layer is off. */
  readout(lon: number, lat: number): { label: string; value: string } | null {
    if (!this.on || !this.man) return null;
    const g = this.groupDef;
    if (g) {
      const gr = this.groupReady.get(g.id), oc = this.ready.get('ocean_gh3');
      if (!gr) return { label: g.title, value: '…' };
      const c = cellAt(gr.grid.def, lon, lat);
      const raw = c ? gr.grid.values[c.row * gr.grid.def.ncol + c.col] : 0;
      const o = oc && c ? oc.values[c.row * oc.def.ncol + c.col] : 0;
      return { label: `${g.title}, records`, value: describe('group', cellState('group', raw, o)) };
    }
    const v = VIEW[this.mode], gr = this.ready.get(v.layer), oc = v.ocean ? this.ready.get(v.ocean) : null;
    if (!gr) return { label: v.short, value: '…' };
    const c = cellAt(gr.def, lon, lat), oCell = oc ? cellAt(oc.def, lon, lat) : null;
    const raw = c ? gr.values[c.row * gr.def.ncol + c.col] : 0;
    const o = oc && oCell ? oc.values[oCell.row * oc.def.ncol + oCell.col] : 0;
    return { label: v.short, value: describe(this.mode, cellState(this.mode, raw, o)) };
  }

  /** Raw grid value of the current view (test hook). */
  value(lon: number, lat: number): { mode: string; raw: number | null; text: string | null } {
    const v = this.group ? null : VIEW[this.mode];
    const g = v ? this.ready.get(v.layer) : this.groupReady.get(this.group)?.grid;
    const c = g ? cellAt(g.def, lon, lat) : null;
    return { mode: this.group || this.mode, raw: g && c ? g.values[c.row * g.def.ncol + c.col] : null, text: this.readout(lon, lat)?.value ?? null };
  }

  /** Card for the 1.4° cell under a click: its most-recorded species (common names and IUCN status where known). */
  async card(lon: number, lat: number): Promise<CardModel | null> {
    if (!this.on || !this.man) return null;
    const gh3 = geohash(lon, lat, 3), gh2 = gh3.slice(0, 2);
    let p = this.cells.get(gh2);
    if (!p) {
      const req = fetch(`${this.host.base}cells/${gh2}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        .then((res) => { if (!res && this.cells.get(gh2) === req) this.cells.delete(gh2); return res; });
      p = req;
      this.cells.set(gh2, p);
      while (this.cells.size > 48) this.cells.delete(this.cells.keys().next().value!);
    }
    // Use already-loaded group metadata for common names/IUCN without downloading all 9 bulky cell grids (~827 KB).
    // If a specific group is selected, ensure that group is loaded.
    const [cells] = await Promise.all([p, ...(this.group ? [this.groupData(this.group)] : [])]);
    const info = cells?.[gh3];
    const names = new Map<number, { common?: string; iucn?: string | null }>();
    for (const g of this.man.groups) for (const s of this.groupReady.get(g.id)?.file.top ?? []) names.set(s.aphiaId, s);
    const c = cellAt(this.man.grids.gh3, lon, lat);
    const cLon = c ? -180 + (c.col + 0.5) * this.man.grids.gh3.dlon : lon, cLat = c ? 90 - (c.row + 0.5) * this.man.grids.gh3.dlat : lat;
    const ns = (v: number, a: string, b: string) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? a : b}`;
    const facts: [string, string][] = [];
    const g = this.groupDef, gr = g ? this.groupReady.get(g.id) : null;
    if (g && gr && c) {
      const row = gr.file.cells.data.find(([cc, rr]) => cc === c.col && rr === c.row);
      facts.push([g.title, row ? `${row[2].toLocaleString('en-US')} records${g.speciesPerCell && row[3] ? `, ${row[3]} species` : ''}` : 'no record here']);
    }
    for (const [id, name, n] of info?.top ?? []) {
      const k = names.get(id);
      facts.push([k?.common ? `${k.common} (${name})` : name, `${n.toLocaleString('en-US')} records${k?.iucn ? `, ${IUCN_LABEL[k.iucn] ?? k.iucn}` : ''}`]);
    }
    const am = this.ready.get('aquamaps_richness');
    const amv = am ? cellAt(am.def, lon, lat) : null;
    const pred = am && amv ? am.values[amv.row * am.def.ncol + amv.col] : 0;
    return {
      kind: 'Marine life in this 1.4° cell',
      name: `${ns(cLat, 'N', 'S')}, ${ns(cLon, 'E', 'W')}`,
      lead: info ? `${info.s.toLocaleString('en-US')} species from ${info.r.toLocaleString('en-US')} OBIS records${info.e != null ? `, ES50 ${info.e.toFixed(1)}` : ''}${pred ? `; AquaMaps predicts ${pred.toLocaleString('en-US')}` : ''}`
        : `No species records in this cell${pred ? `; AquaMaps predicts ${pred.toLocaleString('en-US')} species` : ''}`,
      facts,
      links: [{ href: 'https://www.aquamaps.org', label: 'AquaMaps' }, { href: 'https://obis.org', label: 'OBIS' }],
      note: info?.top.length ? 'Most-recorded species, which shows what people looked for as much as what lives here.' : undefined,
      source: 'OBIS (2026) www.obis.org; OBIS speciesgrids (OBIS + GBIF), CC BY-NC 4.0; AquaMaps (www.aquamaps.org, version 10/2019), CC BY-NC 3.0',
    };
  }
}
