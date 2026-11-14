import { existsSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildLut, cellFor, CMAPS, columnFromChunk, decodeMapLayer, hashWithWater, inflate, layerKey, legendTicks, lutIndex,
  mercRowLat, neighbours, renderMercator, sampleGrid, scaleRange, thermocline, waterFromHash,
  type Column, type Grid, type WaterManifest,
} from '../src/water';
import { depthFrac, depthTicks } from '../src/water-chart';
import { MAX_MERC_LAT } from '../src/geo';

const planes = (q: number[]) => { const n = q.length, b = new Uint8Array(2 * n); q.forEach((v, i) => { b[i] = v & 255; b[n + i] = v >> 8; }); return b; };

function relLum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

describe('colour scales', () => {
  it('cmocean thermal and haline get lighter, dense gets darker (perceptual ordering)', () => {
    for (const [v, dir] of [['t', 1], ['s', 1], ['d', -1]] as const) {
      const L = CMAPS[v].map(relLum);
      // allow tiny wiggles in the sampled stops, but the ends must be far apart and the trend monotone overall
      for (let i = 2; i < L.length; i++) expect(dir * (L[i] - L[i - 2])).toBeGreaterThan(-0.005);
      expect(dir * (L[L.length - 1] - L[0])).toBeGreaterThan(0.5);
    }
  });
  it('LUT hits the end stops and clamps out-of-range values', () => {
    const lut = buildLut(CMAPS.t);
    expect([lut[0], lut[1], lut[2]]).toEqual([0x04, 0x23, 0x33]);
    expect([lut[765], lut[766], lut[767]]).toEqual([0xe8, 0xfa, 0x5b]);
    expect(lutIndex(-10, -2, 32)).toBe(0);
    expect(lutIndex(99, -2, 32)).toBe(255);
    expect(lutIndex(15, -2, 32)).toBe(128);
  });
  it('legend ticks are round and inside the range', () => {
    expect(legendTicks(-2, 32)).toEqual([0, 10, 20, 30]);
    expect(legendTicks(32, 38)).toEqual([32, 34, 36, 38]);
    for (const x of legendTicks(34.41, 35.02)) expect(x >= 34.41 && x <= 35.02).toBe(true);
  });
});

describe('decoding', () => {
  it('inflates zlib (what pipeline/woa.py writes) and decodes uint16 byte planes', async () => {
    const q = [0, 1, 2, 300, 65535];
    const bytes = await inflate(deflateSync(Buffer.from(planes(q))));
    const v = decodeMapLayer(bytes, -2, 0.01);
    expect(Number.isNaN(v[0])).toBe(true);
    expect(v[1]).toBeCloseTo(-2, 6);
    expect(v[2]).toBeCloseTo(-1.99, 5);
    expect(v[3]).toBeCloseTo(0.99, 4);
    expect(v[4]).toBeCloseTo(-2 + 65534 * 0.01, 2);
  });
  it('reads one water column from a [var][level][row][col] chunk and drops levels without data', () => {
    const man = { res_deg: 1, width: 360, height: 180, chunk_deg: 2, depths: [0, 10, 20], scale: 0.001,
      offset: { t: 10, s: 20, d: 15 }, fill: -32768, vars: ['t', 's', 'd'], chunks: 1 } as WaterManifest['columns'];
    const n = 2, nl = 3, buf = new DataView(new ArrayBuffer(3 * nl * n * n * 2));
    const put = (vi: number, l: number, r: number, c: number, q: number) => buf.setInt16(2 * (((vi * nl + l) * n + r) * n + c), q, true);
    for (let vi = 0; vi < 3; vi++) for (let l = 0; l < nl; l++) for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) put(vi, l, r, c, -32768);
    // cell row 1, col 0 of the chunk: T 20, 15 degC; S 35, 35.5; sigma0 25, 26; deepest level no data
    put(0, 0, 1, 0, 10000); put(0, 1, 1, 0, 5000);
    put(1, 0, 1, 0, 15000); put(1, 1, 1, 0, 15500);
    put(2, 0, 1, 0, 10000); put(2, 1, 1, 0, 11000);
    const cell = cellFor(man, -179.5, 88.5); // row 1, col 0
    expect([cell.row, cell.col, cell.i, cell.j]).toEqual([1, 0, 0, 0]);
    const col = columnFromChunk(man, new Uint8Array(buf.buffer), cell)!;
    expect(col.depth).toEqual([0, 10]);
    expect(col.t).toEqual([20, 15]);
    expect(col.s).toEqual([35, 35.5]);
    expect(col.d).toEqual([25, 26]);
    expect(columnFromChunk(man, new Uint8Array(buf.buffer), cellFor(man, -178.5, 89.5))).toBeNull();
  });
});

describe('sampling and reprojection', () => {
  // 4 x 2 grid of 90 deg cells: north row 10, 20, NaN, 40; south row 1, 2, 3, 4
  const g: Grid = { values: new Float32Array([10, 20, NaN, 40, 1, 2, 3, 4]), width: 4, height: 2, north: 90, west: -180, res: 90 };
  it('returns the cell value at a cell centre and NaN where the nearest cell has no data', () => {
    expect(sampleGrid(g, -135, 45)).toBeCloseTo(10);
    expect(sampleGrid(g, 45, 45)).toBeNaN();
    // halfway between 10 and 20 along the row
    expect(sampleGrid(g, -90, 45)).toBeCloseTo(15);
    // next to the hole, the missing neighbour is ignored (weights renormalised)
    // (lon -10: nearest cell is the 20, its east neighbour is the hole)
    expect(sampleGrid(g, -10, 45)).toBeCloseTo(20);
    // wraps across the antimeridian: between 40 (lon 135) and 10 (lon -135)
    expect(sampleGrid(g, 180, 45)).toBeCloseTo(25);
  });
  it('Mercator rows span +-85.05 deg, symmetric about the equator', () => {
    expect(mercRowLat(-0.5, 512)).toBeCloseTo(MAX_MERC_LAT, 6);
    expect(mercRowLat(255.5, 512)).toBeCloseTo(0, 9);
    expect(mercRowLat(10, 512)).toBeCloseTo(-mercRowLat(501, 512), 9);
  });
  it('renders no-data as transparent and water with the LUT colour', () => {
    const size = 64, out = new Uint8ClampedArray(size * size * 4);
    const lut = buildLut(CMAPS.t);
    renderMercator(out, size, g, lut, 0, 40, 200);
    const px = (lon: number, row: number) => { const i = Math.floor(((lon + 180) / 360) * size); return out.slice((row * size + i) * 4, (row * size + i) * 4 + 4); };
    expect(px(45, 5)[3]).toBe(0);          // the NaN cell, north
    const i = Math.floor(((-135 + 180) / 360) * size), lon = -180 + ((i + 0.5) / size) * 360;
    const a = px(-135, 5), k = lutIndex(sampleGrid(g, lon, 80), 0, 40) * 3; // same value as the hover readout
    expect(a[3]).toBe(200);
    expect([a[0], a[1], a[2]]).toEqual([lut[k], lut[k + 1], lut[k + 2]]);
    expect(px(-135, 60)[3]).toBe(200);     // south row is all water
  });
  it('blends two grids for the monthly animation', () => {
    const size = 16, a = new Uint8ClampedArray(size * size * 4), b = new Uint8ClampedArray(size * size * 4);
    const g2: Grid = { ...g, values: g.values.map((v) => v + 20) };
    const lut = buildLut(CMAPS.t);
    renderMercator(a, size, g, lut, 0, 60, 255, g2, 0.5);
    renderMercator(b, size, { ...g, values: g.values.map((v) => v + 10) }, lut, 0, 60);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('cells, profiles and links', () => {
  const man = { res_deg: 1, width: 360, height: 180, chunk_deg: 30 } as WaterManifest['columns'];
  it('maps lon/lat to the 1 deg cell and its 30 deg chunk', () => {
    expect(cellFor(man, -20.5, 30.5)).toMatchObject({ row: 59, col: 159, i: 1, j: 5, lon: -20.5, lat: 30.5 });
    expect(cellFor(man, 180, 0).col).toBe(0); // 180 E wraps to 180 W
    expect(cellFor(man, 0, -90).row).toBe(179);
  });
  it('lists neighbours nearest first and wraps in longitude', () => {
    const c = cellFor(man, -179.5, 0.5);
    const nb = neighbours(man, c, 1);
    expect(nb).toHaveLength(8);
    expect(nb.some((x) => x.col === 359)).toBe(true);
    expect(Math.abs(nb[0].row - c.row) + Math.abs(nb[0].col - c.col) % 358).toBe(1);
  });
  it('finds the steepest temperature drop in the top 1,000 m', () => {
    const col: Column = { depth: [0, 50, 100, 150, 200, 500, 1000], t: [28, 27.8, 26, 18, 15, 9, 5], s: [], d: [], lon: 0, lat: 0 };
    expect(thermocline(col)).toEqual({ depth: 125, gradient: 0.16 });
    expect(thermocline({ ...col, t: [1, 1, 1, 1, 1, 1, 1] })).toBeNull();
  });
  it('reads and writes #water= without touching other parts', () => {
    const depths = [0, 50, 1000];
    expect(waterFromHash('#water=s-1000', depths)).toEqual({ v: 's', depth: 1000 });
    expect(waterFromHash('#story=x&water=t-50', depths)).toEqual({ v: 't', depth: 50 });
    expect(waterFromHash('#water=t-51', depths)).toBeNull();
    expect(waterFromHash('#water=x-0', depths)).toBeNull();
    expect(hashWithWater('#story=x', { v: 'd', depth: 0 })).toBe('#story=x&water=d-0');
    expect(hashWithWater('#water=d-0&sea=-120', null)).toBe('#sea=-120');
    expect(layerKey('t', 0, 3)).toBe('t_m03');
    expect(layerKey('s', 1000)).toBe('s_1000');
  });
  it('stretches the top 1,000 m of the depth axis', () => {
    expect(depthFrac(1000, 5500)).toBeCloseTo(0.55);
    expect(depthFrac(5500, 5500)).toBeCloseTo(1);
    expect(depthFrac(400, 800)).toBeCloseTo(0.5); // shallow columns stay linear
    expect(depthTicks(5500)).toEqual([0, 200, 500, 1000, 2000, 3000, 4000, 5000]);
    expect(depthTicks(3000).at(-1)).toBe(3000);
  });
});

// ---------- the real files (skipped until pipeline/woa.py build has run) ----------
const MAN = new URL('../public/woa/manifest.json', import.meta.url);
describe.skipIf(!existsSync(MAN))('built WOA23 files', () => {
  const man = JSON.parse(readFileSync(MAN, 'utf8')) as WaterManifest;
  async function grid(key: string): Promise<Grid> {
    const L = man.map.layers[key];
    const bytes = await inflate(readFileSync(new URL(`../public/woa/map/${key}.bin`, import.meta.url)));
    return { values: decodeMapLayer(bytes, L.lo, L.step), width: man.map.width, height: man.map.height, north: man.map.north, west: man.map.west, res: man.map.res_deg };
  }
  it('has every map layer the viewer asks for', () => {
    for (const v of ['t', 's', 'd'] as const) for (const d of man.map.depths) expect(man.map.layers[layerKey(v, d)]).toBeDefined();
    for (let m = 1; m <= 12; m++) expect(man.map.layers[layerKey('t', 0, m)]).toBeDefined();
    expect(scaleRange(man, 't', 't_0', false)).toEqual([-2, 32]);
    const [lo, hi] = scaleRange(man, 's', 's_1000', true);
    expect(hi - lo).toBeLessThan(3);
  });
  it('decodes to known oceanography', async () => {
    const t0 = await grid('t_0'), s1000 = await grid('s_1000'), t4000 = await grid('t_4000');
    expect(sampleGrid(t0, 150, 0)).toBeGreaterThan(28.5);                 // warm pool
    expect(sampleGrid(t0, -40, -72)).toBeLessThan(-1.6);                  // Weddell shelf
    expect(sampleGrid(t0, 10, 50)).toBeNaN();                             // Germany is land
    expect(sampleGrid(t4000, -150, 30)).toBeGreaterThan(1);
    expect(sampleGrid(t4000, -150, 30)).toBeLessThan(2);
    expect(sampleGrid(s1000, -12, 37) - sampleGrid(s1000, -60, 37)).toBeGreaterThan(0.5); // Mediterranean tongue
  });
  it('monthly surface temperature shows the seasons', async () => {
    const feb = await grid('t_m02'), aug = await grid('t_m08');
    // North Atlantic off Nova Scotia: much warmer in August
    expect(sampleGrid(aug, -60, 42) - sampleGrid(feb, -60, 42)).toBeGreaterThan(8);
  });
  it('water columns decode with the documented layout', async () => {
    const c = cellFor(man.columns, -20.5, 30.5);
    const bytes = await inflate(readFileSync(new URL(`../public/woa/col/${c.i}_${c.j}.bin`, import.meta.url)));
    const col = columnFromChunk(man.columns, bytes, c)!;
    expect(col.depth[0]).toBe(0);
    expect(col.depth.at(-1)!).toBeGreaterThanOrEqual(4000);
    expect(col.t[0]).toBeGreaterThan(col.t.at(-1)!);
    expect(col.d[0]).toBeLessThan(col.d.at(-1)!);
  });
});
