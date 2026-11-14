// Ocean water layer (World Ocean Atlas 2023, 1991-2020): file decoding, colour scales, sampling and the
// Mercator reprojection of the 0.25 deg grids. No DOM here, so it is unit-tested in test/water.test.ts.
// Formats: docs/data-contract.md ("Ocean water"); written by pipeline/woa.py.
import { MAX_MERC_LAT } from './geo';

export type WaterVar = 't' | 's' | 'd';
export const WATER_VARS: WaterVar[] = ['t', 's', 'd'];

export interface LayerInfo { lo: number; step: number; hi: number; p2: number; p98: number; bytes: number; ocean_cells: number }
export interface WaterManifest {
  period: string;
  citations: Record<string, string>;
  licence: string;
  variables: Record<WaterVar, { name: string; units: string; long: string; range: [number, number]; cmap: string }>;
  map: { res_deg: number; width: number; height: number; north: number; west: number; depths: number[];
    monthly: { var: WaterVar; depth: number; months: number[] }; layers: Record<string, LayerInfo> };
  columns: { res_deg: number; width: number; height: number; chunk_deg: number; depths: number[];
    scale: number; offset: Record<WaterVar, number>; fill: number; vars: WaterVar[]; chunks: number };
}

/** Map-layer key in the manifest and file name: `t_1000`, monthly surface temperature `t_m03`. */
export function layerKey(v: WaterVar, depth: number, month = 0): string {
  return month ? `${v}_m${String(month).padStart(2, '0')}` : `${v}_${depth}`;
}

// ---------- colour scales ----------
// cmocean (Thyng et al. 2016, doi:10.5670/oceanog.2016.66) thermal / haline / dense, 17 evenly spaced samples
// each; lightness rises monotonically along thermal and haline and falls along dense.
export const CMAPS: Record<WaterVar, string[]> = {
  t: ['#042333', '#082e54', '#19337c', '#39339e', '#563b9c', '#6d4694', '#83508f', '#995889', '#b15f82', '#c96775', '#df7064', '#f07f50', '#f99341', '#fcac3c', '#f9c641', '#f2e14d', '#e8fa5b'],
  s: ['#2a186c', '#2e1d93', '#2034a2', '#0f4a98', '#0f5b90', '#1c6a8c', '#297789', '#338588', '#3c9387', '#44a284', '#50b07e', '#61bf74', '#7acb67', '#9ed65c', '#c4dd65', '#e3e67e', '#fdef9a'],
  d: ['#e6f1f1', '#cbe4e8', '#b1d6e3', '#9ac8e2', '#86b9e3', '#79a9e4', '#7397e4', '#7584df', '#7871d5', '#795ec5', '#784db2', '#753c9c', '#6e2d84', '#65216a', '#591750', '#481237', '#360e24'],
};

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 256-entry RGB lookup table (linear interpolation between the stops). */
export function buildLut(stops: string[]): Uint8Array {
  const lut = new Uint8Array(256 * 3), rgb = stops.map(hex), k = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * k, j = Math.min(k - 1, Math.floor(x)), t = x - j;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(rgb[j][c] + (rgb[j + 1][c] - rgb[j][c]) * t);
  }
  return lut;
}

/** LUT index for value v on the scale [lo, hi] (clamped). */
export function lutIndex(v: number, lo: number, hi: number): number {
  const t = (v - lo) / (hi - lo || 1);
  return Math.max(0, Math.min(255, Math.round(t * 255)));
}

/** CSS linear-gradient stops for a legend bar. */
export function gradientCss(v: WaterVar): string {
  const s = CMAPS[v];
  return s.map((c, i) => `${c} ${((100 * i) / (s.length - 1)).toFixed(1)}%`).join(', ');
}

/** Scale used for colouring: the fixed range of the variable, or the 2nd-98th percentile of this layer. */
export function scaleRange(man: WaterManifest, v: WaterVar, key: string, stretch: boolean): [number, number] {
  const L = man.map.layers[key];
  if (stretch && L && L.p98 > L.p2) return [L.p2, L.p98];
  return man.variables[v].range;
}

/** ~5 round tick values inside [lo, hi]. */
export function legendTicks(lo: number, hi: number, target = 5): number[] {
  const span = hi - lo, raw = span / target, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= target) ?? 10 * mag;
  const out: number[] = [];
  for (let x = Math.ceil(lo / step - 1e-9) * step; x <= hi + 1e-9; x += step) out.push(+x.toFixed(6));
  return out;
}

// ---------- decoding ----------
/** zlib (RFC 1950) inflate with the platform's DecompressionStream (browsers and Node >= 18). */
export async function inflate(buf: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Map layer -> values (NaN = no data). The file is uint16 q as two byte planes (all low bytes, then all
 * high bytes); q = 0 is no data, otherwise value = lo + (q - 1) * step.
 */
export function decodeMapLayer(planes: Uint8Array, lo: number, step: number): Float32Array {
  const n = planes.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const q = planes[i] | (planes[n + i] << 8);
    out[i] = q === 0 ? NaN : lo + (q - 1) * step;
  }
  return out;
}

/** Quantisation step of a layer (the readout does not show more digits than this supports). */
export function layerStep(L: LayerInfo): number { return L.step; }

/** Decimals for a value with quantisation step `step` (at least 1, at most 3). */
export function decimalsFor(step: number): number {
  return Math.max(1, Math.min(3, Math.ceil(-Math.log10(Math.max(step, 1e-6)))));
}

export function formatWater(v: number, decimals: number, units: string): string {
  if (!Number.isFinite(v)) return 'no data';
  const s = (v < 0 ? '−' : '') + Math.abs(v).toFixed(decimals);
  return units ? `${s} ${units}` : s;
}

export interface Grid { values: Float32Array; width: number; height: number; north: number; west: number; res: number }

/**
 * Value at lon/lat from a north-up grid. Bilinear over the valid neighbours (weights renormalised), but NaN
 * when the nearest cell has no data, so coasts and the seafloor cut-off stay where the grid puts them.
 */
export function sampleGrid(g: Grid, lon: number, lat: number): number {
  const x = (((lon - g.west) % 360) + 360) % 360 / g.res - 0.5;
  const y = (g.north - lat) / g.res - 0.5;
  const W = g.width, H = g.height;
  const yc = Math.max(0, Math.min(H - 1, y));
  const near = g.values[Math.round(yc) * W + ((Math.round(x) % W) + W) % W];
  if (Number.isNaN(near)) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(yc), tx = x - x0, ty = yc - y0;
  let s = 0, w = 0;
  for (let dy = 0; dy < 2; dy++) {
    const yy = Math.min(H - 1, y0 + dy), wy = dy ? ty : 1 - ty;
    for (let dx = 0; dx < 2; dx++) {
      const v = g.values[yy * W + (((x0 + dx) % W) + W) % W];
      const ww = (dx ? tx : 1 - tx) * wy;
      if (!Number.isNaN(v) && ww > 0) { s += v * ww; w += ww; }
    }
  }
  return w > 0 ? s / w : near;
}

/** Latitude of the centre of output row `row` of a square Web Mercator world image of `size` rows. */
export function mercRowLat(row: number, size: number): number {
  const yn = 0.5 - (row + 0.5) / size; // +0.5 at the top edge
  return (Math.atan(Math.sinh(yn * 2 * Math.PI)) * 180) / Math.PI;
}

/** Corners of the full Web Mercator world for a MapLibre image/canvas source. */
export const MERC_WORLD: [[number, number], [number, number], [number, number], [number, number]] = [
  [-180, MAX_MERC_LAT], [180, MAX_MERC_LAT], [180, -MAX_MERC_LAT], [-180, -MAX_MERC_LAT],
];

/**
 * Reproject a north-up lat/lon grid into a square Web Mercator RGBA image (out.length = size*size*4).
 * Optional `b` + `t` blend two grids (monthly animation): v = a(1 - t) + b t.
 * No data -> alpha 0. `alpha` is the opacity of water pixels (0..255).
 */
export function renderMercator(out: Uint8ClampedArray, size: number, a: Grid, lut: Uint8Array, lo: number, hi: number,
  alpha = 255, b: Grid | null = null, t = 0): void {
  const W = a.width, H = a.height, A = a.values, B = b?.values;
  // separable lookups: per output column the two source columns + weight, per row the two rows + weight
  const cx0 = new Int32Array(size), cx1 = new Int32Array(size), cw = new Float32Array(size), cn = new Int32Array(size);
  for (let i = 0; i < size; i++) {
    const lon = -180 + ((i + 0.5) / size) * 360;
    const x = (((lon - a.west) % 360) + 360) % 360 / a.res - 0.5;
    const x0 = Math.floor(x);
    cx0[i] = ((x0 % W) + W) % W; cx1[i] = (((x0 + 1) % W) + W) % W; cw[i] = x - x0;
    cn[i] = ((Math.round(x) % W) + W) % W;
  }
  const scale = 255 / (hi - lo || 1);
  for (let r = 0; r < size; r++) {
    const lat = mercRowLat(r, size);
    const y = Math.max(0, Math.min(H - 1, (a.north - lat) / a.res - 0.5));
    const y0 = Math.floor(y), y1 = Math.min(H - 1, y0 + 1), ty = y - y0, yn = Math.round(y);
    const o0 = y0 * W, o1 = y1 * W, on = yn * W;
    let p = r * size * 4;
    for (let i = 0; i < size; i++, p += 4) {
      if (Number.isNaN(A[on + cn[i]])) { out[p + 3] = 0; continue; }
      const tx = cw[i], i00 = o0 + cx0[i], i10 = o0 + cx1[i], i01 = o1 + cx0[i], i11 = o1 + cx1[i];
      let v00 = A[i00], v10 = A[i10], v01 = A[i01], v11 = A[i11];
      if (B) { v00 = v00 * (1 - t) + B[i00] * t; v10 = v10 * (1 - t) + B[i10] * t; v01 = v01 * (1 - t) + B[i01] * t; v11 = v11 * (1 - t) + B[i11] * t; }
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      let s = 0, w = 0;
      // NaN !== NaN: skip missing neighbours and renormalise the remaining weights
      if (v00 === v00) { s += v00 * w00; w += w00; }
      if (v10 === v10) { s += v10 * w10; w += w10; }
      if (v01 === v01) { s += v01 * w01; w += w01; }
      if (v11 === v11) { s += v11 * w11; w += w11; }
      if (w <= 0) { out[p + 3] = 0; continue; }
      const li = Math.max(0, Math.min(255, Math.round((s / w - lo) * scale))) * 3;
      out[p] = lut[li]; out[p + 1] = lut[li + 1]; out[p + 2] = lut[li + 2]; out[p + 3] = alpha;
    }
  }
}

// ---------- water columns (1 deg) ----------
export interface CellRef { i: number; j: number; row: number; col: number; lon: number; lat: number }

/** 1 deg cell (and its 30 x 30 deg chunk) containing lon/lat; lon/lat returned are the cell centre. */
export function cellFor(man: WaterManifest['columns'], lon: number, lat: number): CellRef {
  const res = man.res_deg, n = Math.round(man.chunk_deg / res);
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  const row = Math.max(0, Math.min(man.height - 1, Math.floor((90 - lat) / res)));
  const col = Math.max(0, Math.min(man.width - 1, Math.floor((l + 180) / res)));
  return { i: Math.floor(row / n), j: Math.floor(col / n), row, col, lon: -180 + (col + 0.5) * res, lat: 90 - (row + 0.5) * res };
}

/** Cells within `radius` cells of `c`, nearest first (for clicks on a coast the 1 deg grid calls land). */
export function neighbours(man: WaterManifest['columns'], c: CellRef, radius: number): CellRef[] {
  const out: { d: number; ref: CellRef }[] = [];
  const res = man.res_deg, n = Math.round(man.chunk_deg / res);
  for (let dr = -radius; dr <= radius; dr++) for (let dc = -radius; dc <= radius; dc++) {
    if (!dr && !dc) continue;
    const row = c.row + dr;
    if (row < 0 || row >= man.height) continue;
    const col = ((c.col + dc) % man.width + man.width) % man.width;
    const lat = 90 - (row + 0.5) * res;
    const d = Math.hypot(dr, dc * Math.cos((lat * Math.PI) / 180));
    out.push({ d, ref: { i: Math.floor(row / n), j: Math.floor(col / n), row, col, lon: -180 + (col + 0.5) * res, lat } });
  }
  return out.sort((x, y) => x.d - y.d).map((x) => x.ref);
}

export interface Column { depth: number[]; t: number[]; s: number[]; d: number[]; lon: number; lat: number }

/** One column from an inflated chunk ([var][level][row][col] little-endian int16). Levels without data are dropped. */
export function columnFromChunk(man: WaterManifest['columns'], bytes: Uint8Array, c: CellRef): Column | null {
  const n = Math.round(man.chunk_deg / man.res_deg), nl = man.depths.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength !== 3 * nl * n * n * 2) throw new Error(`chunk size ${bytes.byteLength} != ${3 * nl * n * n * 2}`);
  const r = c.row % n, k = c.col % n;
  const col: Column = { depth: [], t: [], s: [], d: [], lon: c.lon, lat: c.lat };
  for (let l = 0; l < nl; l++) {
    const vals = man.vars.map((v, vi) => {
      const q = view.getInt16(2 * (((vi * nl + l) * n + r) * n + k), true);
      return q === man.fill ? NaN : man.offset[v] + q * man.scale;
    });
    if (vals.some(Number.isNaN)) continue;
    col.depth.push(man.depths[l]);
    vals.forEach((x, vi) => col[man.vars[vi]].push(+x.toFixed(4)));
  }
  return col.depth.length ? col : null;
}

/** Depth of the steepest temperature drop in the top 1,000 m (the main thermocline), if it is a clear one. */
export function thermocline(col: Column, minGradient = 0.02): { depth: number; gradient: number } | null {
  let best: { depth: number; gradient: number } | null = null;
  for (let i = 1; i < col.depth.length && col.depth[i] <= 1000; i++) {
    const g = (col.t[i - 1] - col.t[i]) / (col.depth[i] - col.depth[i - 1]);
    if (g > minGradient && (!best || g > best.gradient)) best = { depth: (col.depth[i] + col.depth[i - 1]) / 2, gradient: g };
  }
  return best;
}

// ---------- deep link: #water=t-1000 (variable letter, depth in m) ----------
export function waterFromHash(hash: string, depths: number[]): { v: WaterVar; depth: number } | null {
  const m = /(?:^#|[#&])water=([tsd])-(\d+)(?:&|$)/.exec(hash);
  if (!m) return null;
  const d = Number(m[2]);
  return depths.includes(d) ? { v: m[1] as WaterVar, depth: d } : null;
}
export function hashWithWater(hash: string, w: { v: WaterVar; depth: number } | null): string {
  const parts = hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith('water='));
  if (w) parts.push(`water=${w.v}-${w.depth}`);
  return parts.length ? `#${parts.join('&')}` : '';
}
