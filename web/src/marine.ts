// Marine life (OBIS / speciesgrids / AquaMaps, pipeline/obis.py): pure logic, no DOM (test/marine.test.ts).
// Grids are regular lat/lon, row 0 = 90 N, col 0 = 180 W, stored as zlib byte planes of little-endian unsigned ints
// (docs/data-contract.md, "Marine life"). The viewer reprojects them to one Web Mercator canvas, like the WOA layer.
import { buildLut, mercRowLat } from './water';

export type MarineMode = 'aquamaps' | 'es50' | 'records';
export const MARINE_MODES: MarineMode[] = ['aquamaps', 'es50', 'records'];
export interface GridDef { ncol: number; nrow: number; dlon: number; dlat: number; west: number; north: number }
export interface LayerDef { file: string; grid: string; dtype: 'uint8' | 'uint16' | 'uint32'; bytes: number; value: string }
export interface GroupDef { id: string; title: string; taxa: string; file: string; records: number; species: number; cells: number; speciesPerCell: boolean; topSpecies: string }
export interface MarineManifest {
  grids: Record<string, GridDef>;
  layers: Record<string, LayerDef>;
  groups: GroupDef[];
  attributionByLayer?: Record<string, string>;
  licence?: string;
  caveats?: string[];
}
export interface LLGrid { values: Uint32Array | Uint16Array | Uint8Array; def: GridDef }

/** Byte planes (all byte 0s, then all byte 1s, ...) -> little-endian unsigned ints. */
export function decodePlanes(planes: Uint8Array, dtype: LayerDef['dtype']): Uint32Array | Uint16Array | Uint8Array {
  const k = dtype === 'uint32' ? 4 : dtype === 'uint16' ? 2 : 1;
  const n = Math.floor(planes.length / k);
  if (k === 1) return planes.slice(0, n);
  const out = k === 4 ? new Uint32Array(n) : new Uint16Array(n);
  for (let b = 0; b < k; b++) {
    const off = b * n, shift = 8 * b;
    for (let i = 0; i < n; i++) out[i] += planes[off + i] * 2 ** shift;
  }
  return out;
}

/** Cell (col, row) under lon/lat, or null outside the grid. */
export function cellAt(def: GridDef, lon: number, lat: number): { col: number; row: number } | null {
  const x = ((((lon - def.west) % 360) + 360) % 360) / def.dlon;
  const y = (def.north - lat) / def.dlat;
  const col = Math.floor(x), row = Math.floor(y);
  if (row < 0 || row >= def.nrow || col < 0 || col >= def.ncol) return null;
  return { col, row };
}
export function valueAt(g: LLGrid, lon: number, lat: number): number | null {
  const c = cellAt(g.def, lon, lat);
  return c ? g.values[c.row * g.def.ncol + c.col] : null;
}

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
/** Standard geohash (lon bit first). */
export function geohash(lon: number, lat: number, precision: number): string {
  let lo = [-180, 180], la = [-90, 90], even = true, bit = 0, ch = 0, out = '';
  while (out.length < precision) {
    const r = even ? lo : la, v = even ? lon : lat, mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch <<= 1; r[1] = mid; }
    even = !even;
    if (++bit === 5) { out += B32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

// ---------- colour ----------
export const VIRIDIS = ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'];
// magma, cut before its pale end so "many records" is never confused with the pale "no records" colour
export const MAGMA = ['#1d1147', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d'];
/** No OBIS record in an ocean cell: a pale, paper-like grey (in "Where nobody has looked" the blank is the subject). */
export const NO_RECORDS = '#ddd8cc';
/** ES50 masked: fewer than 50 records. */
export const NOT_ENOUGH = '#59606e';

export interface ScaleSpec { kind: 'log' | 'linear'; lo: number; hi: number; stops: string[]; unit: string; ticks: number[] }
/** Colour scale per view; log scales are log10 of the value (manifest.scales). */
export const SCALES: Record<MarineMode | 'group', ScaleSpec> = {
  aquamaps: { kind: 'log', lo: 1, hi: 4, stops: VIRIDIS, unit: 'predicted species', ticks: [10, 100, 1000, 10000] },
  es50: { kind: 'linear', lo: 1, hi: 50, stops: VIRIDIS, unit: 'expected species in 50 records', ticks: [1, 10, 20, 30, 40, 50] },
  records: { kind: 'log', lo: 0, hi: 6, stops: MAGMA, unit: 'OBIS records per cell', ticks: [1, 100, 10000, 1000000] },
  group: { kind: 'log', lo: 0, hi: 5, stops: MAGMA, unit: 'OBIS records per cell', ticks: [1, 100, 10000, 100000] },
};
/** 0..1 position of a value on a scale (clamped). */
export function scalePos(s: ScaleSpec, v: number): number {
  const x = s.kind === 'log' ? Math.log10(Math.max(v, 1e-9)) : v;
  return Math.max(0, Math.min(1, (x - s.lo) / (s.hi - s.lo)));
}
export function gradient(stops: string[]): string {
  return stops.map((c, i) => `${c} ${((100 * i) / (stops.length - 1)).toFixed(1)}%`).join(', ');
}

/** What the view's grid value means for a cell: a value to colour, "masked" (grey) or nothing (transparent). */
export type CellState = { v: number } | 'masked' | null;
export function cellState(mode: MarineMode | 'group', raw: number, ocean: number): CellState {
  if (mode === 'aquamaps') return raw > 0 ? { v: raw } : null;
  if (mode === 'es50') return raw > 0 ? { v: (raw - 1) / 100 } : ocean > 0 ? 'masked' : null;
  return raw > 0 ? { v: raw } : ocean > 0 ? 'masked' : null; // records / group records: blank ocean = no record
}

const hexRgb = (c: string): [number, number, number] => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/**
 * Reproject a lat/lon grid (nearest cell) to a square Web Mercator RGBA image of the whole world.
 * `ocean` (optional, same or finer grid def) decides where a zero is "masked" (drawn grey) rather than transparent.
 */
export function renderLL(out: Uint8ClampedArray, size: number, mode: MarineMode | 'group', g: LLGrid, ocean: LLGrid | null, alpha = 235): void {
  const s = SCALES[mode], lut = buildLut(s.stops);
  const masked = hexRgb(mode === 'es50' ? NOT_ENOUGH : NO_RECORDS), maskedAlpha = mode === 'es50' ? 200 : 185;
  const { ncol, nrow, dlon, dlat, west, north } = g.def;
  const cols = new Int32Array(size), ocols = new Int32Array(size);
  for (let i = 0; i < size; i++) {
    const lon = -180 + ((i + 0.5) / size) * 360;
    cols[i] = Math.min(ncol - 1, Math.floor(((((lon - west) % 360) + 360) % 360) / dlon));
    if (ocean) ocols[i] = Math.min(ocean.def.ncol - 1, Math.floor(((((lon - ocean.def.west) % 360) + 360) % 360) / ocean.def.dlon));
  }
  // value -> lut index, cached per raw value (most cells repeat a small set of values)
  const cache = new Map<number, number>();
  const idx = (raw: number, v: number) => { let k = cache.get(raw); if (k === undefined) { k = Math.round(scalePos(s, v) * 255); cache.set(raw, k); } return k; };
  for (let r = 0; r < size; r++) {
    const lat = mercRowLat(r, size);
    const row = Math.floor((north - lat) / dlat);
    let p = r * size * 4;
    if (row < 0 || row >= nrow) { for (let i = 0; i < size; i++, p += 4) out[p + 3] = 0; continue; }
    const orow = ocean ? Math.min(ocean.def.nrow - 1, Math.max(0, Math.floor((ocean.def.north - lat) / ocean.def.dlat))) : 0;
    const base = row * ncol, obase = orow * (ocean?.def.ncol ?? 0);
    for (let i = 0; i < size; i++, p += 4) {
      const raw = g.values[base + cols[i]];
      const st = cellState(mode, raw, ocean ? ocean.values[obase + ocols[i]] : 0);
      if (st === null) { out[p + 3] = 0; continue; }
      if (st === 'masked') { out[p] = masked[0]; out[p + 1] = masked[1]; out[p + 2] = masked[2]; out[p + 3] = maskedAlpha; continue; }
      const k = idx(raw, st.v) * 3;
      out[p] = lut[k]; out[p + 1] = lut[k + 1]; out[p + 2] = lut[k + 2]; out[p + 3] = alpha;
    }
  }
}

/** Group cells ([col, row, records, species] on gh3) -> a dense records grid. */
export function groupGrid(def: GridDef, data: number[][]): LLGrid {
  const values = new Uint32Array(def.ncol * def.nrow);
  for (const [c, r, rec] of data) if (r >= 0 && r < def.nrow && c >= 0 && c < def.ncol) values[r * def.ncol + c] = Math.max(1, rec);
  return { values, def };
}

/** Readout text for a cell. */
export function describe(mode: MarineMode | 'group', st: CellState): string {
  if (st === null) return 'no data';
  if (st === 'masked') return mode === 'es50' ? 'not enough records' : 'no records';
  if (mode === 'es50') return st.v.toFixed(1);
  return `${Math.round(st.v).toLocaleString('en-US')}${mode === 'aquamaps' ? ' species' : ''}`;
}

export const IUCN_LABEL: Record<string, string> = {
  CR: 'Critically endangered', EN: 'Endangered', VU: 'Vulnerable', NT: 'Near threatened', LC: 'Least concern', DD: 'Data deficient', EX: 'Extinct', EW: 'Extinct in the wild',
};
