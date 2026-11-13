// Depth-profile chart (inline SVG). One series, so no legend box: the panel title names it.
// Form: a filled seabed silhouette under a 2px line (a cross-section is the natural form for depth vs
// distance); sea level drawn as a dashed reference; a thin strip under the plot shows, per sample, the
// fraction of the cell that ships measured (shelf colour, opacity = fraction; grey = land).
// Hover / arrow keys move a crosshair and tooltip, and report the index so the map can mark the spot.
import { formatDepth } from './geo';

export interface ProfileData { dist: number[]; h: number[]; f: (number | null)[] }

const NS = 'http://www.w3.org/2000/svg';
function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

/** "Nice" tick values covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  const span = hi - lo || 1;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= target + 0.5) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-9 ? 0 : v);
  return out;
}

export class ProfileChart {
  private data: ProfileData | null = null;
  private svg: SVGSVGElement;
  private tip: HTMLDivElement;
  private idx: number | null = null;
  private x = (_: number) => 0;
  private y = (_: number) => 0;
  private cross: SVGGElement | null = null;

  constructor(private root: HTMLElement, private onHover: (i: number | null) => void) {
    this.svg = el('svg', { role: 'img', tabindex: 0 });
    this.tip = document.createElement('div');
    this.tip.className = 'tip'; this.tip.hidden = true;
    root.append(this.svg, this.tip);
    new ResizeObserver(() => this.render()).observe(root);
    this.svg.addEventListener('pointermove', (e) => this.pointer(e));
    this.svg.addEventListener('pointerleave', () => this.setIndex(null));
    this.svg.addEventListener('keydown', (e) => {
      if (!this.data) return;
      const n = this.data.h.length;
      const step = e.shiftKey ? 20 : 1;
      if (e.key === 'ArrowRight') this.setIndex(Math.min(n - 1, (this.idx ?? -1) + step));
      else if (e.key === 'ArrowLeft') this.setIndex(Math.max(0, (this.idx ?? n) - step));
      else return;
      e.preventDefault();
    });
  }

  set(data: ProfileData | null) { this.data = data; this.idx = null; this.render(); }

  private pointer(e: PointerEvent) {
    if (!this.data) return;
    const r = this.svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    const { dist } = this.data;
    // nearest sample by x
    let best = 0, bd = Infinity;
    for (let i = 0; i < dist.length; i++) { const d = Math.abs(this.x(dist[i]) - px); if (d < bd) { bd = d; best = i; } }
    this.setIndex(best);
  }

  private setIndex(i: number | null) {
    this.idx = i;
    this.onHover(i);
    this.drawCross();
  }

  private render() {
    const svg = this.svg;
    svg.replaceChildren();
    this.cross = null;
    const W = this.root.clientWidth, H = this.root.clientHeight;
    if (!this.data || W < 50) { this.tip.hidden = true; return; }
    const { dist, h, f } = this.data;
    const valid = h.filter((v) => Number.isFinite(v));
    if (!valid.length) return;
    const narrow = W < 520;
    const M = { l: narrow ? 62 : 72, r: 12, t: 12, b: 46 };
    const pw = W - M.l - M.r, ph = H - M.t - M.b;
    const len = dist[dist.length - 1] || 1;
    const hMin = Math.min(...valid), hMax = Math.max(0, ...valid);
    // sea level always on the chart (depth is measured from it); 24 px under the deepest point for its label
    const room = 24 / Math.max(40, ph - 24);
    const yt = niceTicks(hMin - (hMax - hMin) * room, hMax, narrow ? 4 : 5);
    const yLo = Math.min(yt[0], hMin - (hMax - hMin) * room), yHi = Math.max(yt[yt.length - 1], hMax);
    this.x = (d) => M.l + (d / len) * pw;
    this.y = (v) => M.t + ((yHi - v) / (yHi - yLo || 1)) * ph;
    const { x, y } = this;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-label', `Depth profile, ${Math.round(len).toLocaleString('en-US')} km long, deepest ${formatDepth(hMin)}. Use left and right arrow keys to read values.`);

    // grid + y axis (units on every tick: there is no room for a rotated axis title)
    const grid = el('g', { class: 'grid' }, svg);
    const ax = el('g', { class: 'axis' }, svg);
    for (const v of yt) {
      if (y(v) < M.t - 1 || y(v) > M.t + ph + 1) continue;
      el('line', { x1: M.l, x2: M.l + pw, y1: y(v), y2: y(v), class: v === 0 ? 'zero' : '' }, grid);
      const t = el('text', { x: M.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, ax);
      t.textContent = v === 0 ? 'sea level' : formatDepth(v);
    }
    // x axis: km on the last tick only
    const xt = niceTicks(0, len, narrow ? 4 : 7).filter((d) => x(d) <= M.l + pw - (narrow ? 34 : 40) || d === 0);
    xt.forEach((d, i) => {
      const t = el('text', { x: x(d), y: M.t + ph + 16, 'text-anchor': i === 0 ? 'start' : 'middle' }, ax);
      t.textContent = d.toLocaleString('en-US');
    });
    const xl = el('text', { x: M.l + pw, y: M.t + ph + 16, 'text-anchor': 'end' }, ax);
    xl.textContent = 'km';

    // water column + seabed silhouette
    const pts = dist.map((d, i) => [x(d), y(Number.isFinite(h[i]) ? h[i] : hMin)] as const);
    const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
    el('path', { d: `M${x(0)},${y(0)}${pts.map(([px, py]) => `L${px.toFixed(1)},${Math.max(py, y(0)).toFixed(1)}`).join('')}L${x(len)},${y(0)}Z`, fill: 'rgba(98,184,177,0.10)' }, svg);
    el('path', { d: `${line}L${x(len)},${M.t + ph}L${x(0)},${M.t + ph}Z`, fill: '#1b2638' }, svg);
    el('path', { d: line, fill: 'none', stroke: '#e6eef0', 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);

    // measured strip under the x labels: one cell per sample
    const sy = M.t + ph + 26, sh = 8;
    const strip = el('g', {}, svg);
    for (let i = 0; i < dist.length; i++) {
      const x0 = i === 0 ? x(0) : (x(dist[i - 1]) + x(dist[i])) / 2;
      const x1 = i === dist.length - 1 ? x(len) : (x(dist[i]) + x(dist[i + 1])) / 2;
      const fi = f[i];
      if (fi !== null && Number.isNaN(fi)) continue; // coverage unknown: leave the cell empty
      el('rect', { x: x0, y: sy, width: Math.max(0.5, x1 - x0 + 0.3), height: sh, fill: fi === null ? '#4a4a43' : '#a8e0c2', 'fill-opacity': fi === null ? 0.9 : 0.1 + 0.9 * fi }, strip);
    }
    const sl = el('text', { x: M.l - 8, y: sy + sh - 0.5, 'text-anchor': 'end' }, ax);
    sl.textContent = 'measured';

    // deepest point, direct-labelled underneath (the 12% headroom keeps it inside the plot)
    const iMin = h.indexOf(hMin);
    const mx = x(dist[iMin]);
    el('circle', { cx: mx, cy: y(hMin), r: 4, fill: '#ffffff', stroke: '#04080f', 'stroke-width': 2 }, svg);
    const anchor = mx > M.l + pw * 0.85 ? 'end' : mx < M.l + pw * 0.15 ? 'start' : 'middle';
    const ml = el('text', { x: mx, y: y(hMin) + 18, 'text-anchor': anchor, style: 'fill: var(--ink); font: 600 12.5px var(--sans); font-variant-numeric: tabular-nums' }, svg);
    ml.textContent = `deepest ${formatDepth(hMin)}`;

    // vertical exaggeration of the chart itself (km per px horizontally vs vertically)
    const ve = (len / pw) / ((yHi - yLo) / 1000 / ph);
    const vt = el('text', { x: M.l + pw - 4, y: M.t + 14, 'text-anchor': 'end', style: 'fill: var(--ink-3); font: 12px var(--sans)' }, svg);
    vt.textContent = `vertical scale ×${ve >= 10 ? Math.round(ve).toLocaleString('en-US') : ve.toFixed(1)}`;

    this.cross = el('g', {}, svg);
    this.drawCross();
  }

  private drawCross() {
    if (!this.cross || !this.data) return;
    this.cross.replaceChildren();
    const i = this.idx;
    if (i === null) { this.tip.hidden = true; return; }
    const { dist, h, f } = this.data;
    const px = this.x(dist[i]), py = this.y(h[i]);
    const H = this.root.clientHeight;
    el('line', { x1: px, x2: px, y1: 12, y2: H - 46, stroke: 'rgba(255,255,255,0.45)', 'stroke-width': 1 }, this.cross);
    el('circle', { cx: px, cy: py, r: 5, fill: '#ffffff', stroke: '#04080f', 'stroke-width': 2 }, this.cross);
    const fi = f[i];
    this.tip.innerHTML = `<b>${formatDepth(h[i])}</b> at ${dist[i].toLocaleString('en-US', { maximumFractionDigits: 0 })} km<br>${fi === null ? 'land' : Number.isNaN(fi) ? 'coverage unknown' : `measured ${Math.round(fi * 100)}%`}`;
    this.tip.hidden = false;
    const W = this.root.clientWidth;
    this.tip.style.left = `${Math.min(W - 70, Math.max(70, px))}px`;
    this.tip.style.top = `${Math.max(48, py - 10)}px`;
  }
}
