// Water-column chart (inline SVG): temperature, salinity and potential density against depth at one point.
// Three measures with different units -> three small panels that share one depth axis (never a dual axis).
// One series per panel, so no legend: each panel title names it. Under each x axis a thin strip shows the
// map's colour scale over that panel's range, which ties the chart to the colours on the globe.
// Depth axis: the top 1,000 m (thermocline, halocline) take 55 % of the height, deeper water the rest; the
// break is drawn as a dashed line. Hover / arrow keys move a depth crosshair across all three panels.
import { formatDepth } from './geo';
import { niceTicks } from './profile-chart';
import { buildLut, CMAPS, lutIndex, thermocline, type Column, type WaterVar } from './water';

const NS = 'http://www.w3.org/2000/svg';
function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

export const BREAK_M = 1000;
export const BREAK_FRAC = 0.55;

/** Depth (m, positive down) -> 0..1 down the plot: piecewise linear with the top 1,000 m stretched. */
export function depthFrac(z: number, zMax: number): number {
  if (zMax <= BREAK_M * 1.2) return Math.min(1, z / zMax);
  if (z <= BREAK_M) return (z / BREAK_M) * BREAK_FRAC;
  return BREAK_FRAC + ((z - BREAK_M) / (zMax - BREAK_M)) * (1 - BREAK_FRAC);
}

/** Depth ticks for a column reaching zMax. */
export function depthTicks(zMax: number): number[] {
  const cand = zMax <= BREAK_M * 1.2 ? niceTicks(0, zMax, 5) : [0, 200, 500, 1000, 2000, 3000, 4000, 5000];
  return cand.filter((z) => z <= zMax + 1e-6);
}

export interface PanelSpec { v: WaterVar; title: string; short: string; units: string; decimals: number; scale: [number, number] }

export class WaterChart {
  private col: Column | null = null;
  private panels: PanelSpec[] = [];
  private mapDepth: number | null = null;
  private svg: SVGSVGElement;
  private tip: HTMLDivElement;
  private idx: number | null = null;
  private cross: SVGGElement | null = null;
  private y = (_: number) => 0;
  private xs: ((v: number) => number)[] = [];
  private box = { l: 0, t: 0, w: 0, h: 0 };
  private luts: Record<WaterVar, Uint8Array> = { t: buildLut(CMAPS.t), s: buildLut(CMAPS.s), d: buildLut(CMAPS.d) };

  constructor(private root: HTMLElement) {
    this.svg = el('svg', { role: 'img', tabindex: 0 });
    this.tip = document.createElement('div');
    this.tip.className = 'tip'; this.tip.hidden = true;
    this.tip.setAttribute('role', 'status');
    this.tip.setAttribute('aria-live', 'polite');
    root.append(this.svg, this.tip);
    new ResizeObserver(() => this.render()).observe(root);
    this.svg.addEventListener('pointermove', (e) => this.pointer(e));
    this.svg.addEventListener('pointerleave', () => this.setIndex(null));
    this.svg.addEventListener('keydown', (e) => {
      if (!this.col) return;
      const n = this.col.depth.length;
      if (e.key === 'ArrowDown') this.setIndex(Math.min(n - 1, (this.idx ?? -1) + 1));
      else if (e.key === 'ArrowUp') this.setIndex(Math.max(0, (this.idx ?? n) - 1));
      else return;
      e.preventDefault();
    });
  }

  set(col: Column | null, panels: PanelSpec[], mapDepth: number | null) {
    this.col = col; this.panels = panels; this.mapDepth = mapDepth; this.idx = null; this.render();
  }
  setMapDepth(d: number | null) { this.mapDepth = d; this.render(); }
  /** For tests/QA: number of drawn series paths. */
  seriesCount(): number { return this.svg.querySelectorAll('path.series').length; }

  private pointer(e: PointerEvent) {
    if (!this.col) return;
    const r = this.svg.getBoundingClientRect();
    const py = e.clientY - r.top;
    let best = 0, bd = Infinity;
    this.col.depth.forEach((z, i) => { const d = Math.abs(this.y(z) - py); if (d < bd) { bd = d; best = i; } });
    this.setIndex(best);
  }
  private setIndex(i: number | null) { this.idx = i; this.drawCross(); }

  private render() {
    const svg = this.svg;
    svg.replaceChildren();
    this.cross = null;
    const W = this.root.clientWidth, H = this.root.clientHeight;
    if (!this.col || W < 120 || !this.panels.length) { this.tip.hidden = true; return; }
    const col = this.col;
    const zMax = col.depth[col.depth.length - 1] || 1;
    const narrow = W < 380;
    const M = { l: narrow ? 50 : 58, r: 8, t: 22, b: 36 };
    const gap = narrow ? 12 : 18;
    const pw = (W - M.l - M.r - gap * (this.panels.length - 1)) / this.panels.length, ph = H - M.t - M.b;
    this.box = { l: M.l, t: M.t, w: W - M.l - M.r, h: ph };
    this.y = (z) => M.t + depthFrac(z, zMax) * ph;
    const { y } = this;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const summary = this.panels.map((p) => {
      const vals = col[p.v];
      return `${p.title} ${vals[0].toFixed(p.decimals)} at the surface, ${vals[vals.length - 1].toFixed(p.decimals)} at ${formatDepth(zMax).replace('−', '')}`;
    }).join('; ');
    svg.setAttribute('aria-label', `Water column down to ${zMax.toLocaleString('en-US')} m. ${summary}. Use the up and down arrow keys to read each depth.`);

    // shared depth axis
    const ax = el('g', { class: 'axis' }, svg);
    const grid = el('g', { class: 'grid' }, svg);
    for (const z of depthTicks(zMax)) {
      const t = el('text', { x: M.l - 8, y: y(z) + 4, 'text-anchor': 'end' }, ax);
      t.textContent = z === 0 ? 'surface' : `${z.toLocaleString('en-US')} m`;
      el('line', { x1: M.l, x2: W - M.r, y1: y(z), y2: y(z) }, grid);
    }
    if (zMax > BREAK_M * 1.2) el('line', { x1: M.l, x2: W - M.r, y1: y(BREAK_M), y2: y(BREAK_M), class: 'break' }, grid);

    this.xs = [];
    this.panels.forEach((p, k) => {
      const x0 = M.l + k * (pw + gap);
      const vals = col[p.v];
      let lo = Math.min(...vals), hi = Math.max(...vals);
      const pad = Math.max((hi - lo) * 0.08, p.v === 't' ? 0.2 : 0.02);
      lo -= pad; hi += pad;
      const ticks = niceTicks(lo, hi, narrow || pw < 160 ? 2 : 3);
      const x = (v: number) => x0 + ((v - lo) / (hi - lo)) * pw;
      this.xs.push(x);
      // panel frame + title (title names the series and its unit)
      el('rect', { x: x0, y: M.t, width: pw, height: ph, class: 'wc-frame' }, svg);
      const tt = el('text', { x: x0, y: M.t - 8, class: 'wc-title' }, svg);
      const name = pw < 120 ? p.short : p.title;
      tt.textContent = p.units ? `${name}, ${p.units}` : name;
      for (const v of ticks) {
        if (x(v) < x0 + 12 || x(v) > x0 + pw - 12) continue; // keep labels of neighbouring panels apart
        el('line', { x1: x(v), x2: x(v), y1: M.t, y2: M.t + ph }, grid);
        const t = el('text', { x: x(v), y: M.t + ph + 14, 'text-anchor': 'middle' }, ax);
        t.textContent = String(+v.toFixed(3));
      }
      // the map's colour scale over this panel's range
      const strip = el('g', {}, svg);
      const N = 40;
      for (let i = 0; i < N; i++) {
        const v = lo + ((i + 0.5) / N) * (hi - lo);
        const li = lutIndex(v, p.scale[0], p.scale[1]) * 3, L = this.luts[p.v];
        el('rect', { x: x0 + (i / N) * pw, y: M.t + ph + 21, width: pw / N + 0.4, height: 6, fill: `rgb(${L[li]},${L[li + 1]},${L[li + 2]})` }, strip);
      }
      // the profile
      const d = col.depth.map((z, i) => `${i ? 'L' : 'M'}${x(vals[i]).toFixed(1)},${y(z).toFixed(1)}`).join('');
      el('path', { d, class: 'series', fill: 'none', stroke: '#e6eef0', 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
      if (p.v === 't') {
        const th = thermocline(col);
        if (th && th.depth < zMax) {
          const ty = y(th.depth);
          // tick on the panel edge, label under it, on the side away from the profile line at that height
          const ly = ty + 15;
          let li = col.depth.findIndex((z) => y(z) >= ly);
          if (li < 0) li = col.depth.length - 1;
          const right = x(vals[li]) < x0 + pw / 2;
          const ex = right ? x0 + pw : x0;
          el('line', { x1: right ? ex - 10 : ex, x2: right ? ex : ex + 10, y1: ty, y2: ty, stroke: '#e6eef0', 'stroke-width': 1.5 }, svg);
          const lt = el('text', { x: right ? ex - 4 : ex + 4, y: ly, 'text-anchor': right ? 'end' : 'start', class: 'wc-note' }, svg);
          lt.textContent = `${Math.round(th.depth)} m`;
        }
      }
    });

    // the depth shown on the map
    if (this.mapDepth !== null && this.mapDepth <= zMax) {
      const my = y(this.mapDepth);
      el('line', { x1: M.l, x2: W - M.r, y1: my, y2: my, class: 'wc-map' }, svg);
    }

    this.cross = el('g', {}, svg);
    this.drawCross();
  }

  private drawCross() {
    if (!this.cross || !this.col) return;
    this.cross.replaceChildren();
    const i = this.idx;
    if (i === null) { this.tip.hidden = true; return; }
    const col = this.col, z = col.depth[i], py = this.y(z);
    el('line', { x1: this.box.l, x2: this.box.l + this.box.w, y1: py, y2: py, stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 1 }, this.cross);
    this.panels.forEach((p, k) => {
      el('circle', { cx: this.xs[k](col[p.v][i]), cy: py, r: 4.5, fill: '#ffffff', stroke: '#04080f', 'stroke-width': 2 }, this.cross!);
    });
    this.tip.innerHTML = `<b>${z.toLocaleString('en-US')} m</b>` + this.panels.map((p) =>
      `<br>${p.title} ${(col[p.v][i] < 0 ? '−' : '') + Math.abs(col[p.v][i]).toFixed(p.decimals)}${p.units ? ` ${p.units}` : ''}`).join('');
    this.tip.hidden = false;
    const W = this.root.clientWidth;
    this.tip.style.left = `${Math.min(W - 90, Math.max(90, this.box.l + this.box.w / 2))}px`;
    this.tip.style.top = `${py < this.box.t + this.box.h / 2 ? py + 80 : py - 8}px`;
  }
}
