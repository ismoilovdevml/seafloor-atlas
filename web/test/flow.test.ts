import { existsSync, readFileSync } from 'node:fs';
import { FlowLayer } from '../src/flow-layer';
import { describe, expect, it } from 'vitest';
import {
  bearingTo, compass16, decodeUV, flowKey, formatFlow, inArea, mercX, mercY, Particles, particleCount, randomIn, rampAt, sampleUV, spawnArea, stepScale,
  type FlowField, type FlowManifest,
} from '../src/flow';
import { applyMask, chlKey, chlTicks, formatChl, LAKE_BOXES, oceanMask, type ChlManifest } from '../src/chl';
import { decodeMapLayer, inflate, sampleGrid, type WaterManifest } from '../src/water';

const pub = (p: string) => new URL(`../public/${p}`, import.meta.url);
const has = (p: string) => existsSync(pub(p));
const planes16 = (q: number[]) => { const n = q.length, b = new Uint8Array(2 * n); q.forEach((v, i) => { const u = v & 0xffff; b[i] = u & 255; b[n + i] = u >> 8; }); return b; };

describe('flow decoding and sampling', () => {
  it('decodes u then v int16 byte planes, -32768 = no data', () => {
    const u = [100, -250, -32768, 0], v = [-1, 32767, -32768, 5];
    const bytes = new Uint8Array([...planes16(u), ...planes16(v)]);
    const [U, V] = decodeUV(bytes, 2, 2, 0.01);
    expect([...U].map((x) => (Number.isNaN(x) ? 'nan' : +x.toFixed(2)))).toEqual([1, -2.5, 'nan', 0]);
    expect(V[1]).toBeCloseTo(327.67, 3);
    expect(() => decodeUV(bytes.slice(1), 2, 2, 0.01)).toThrow();
  });
  it('samples bilinearly, wraps longitude, and reports no data next to a gap', () => {
    const g = { res_deg: 90, width: 4, height: 2, lat0: 45, lon0: -135, scale: 1, fill: -32768 };
    const f: FlowField = { g, u: new Float32Array([0, 10, 20, 30, 0, 10, 20, 30]), v: new Float32Array(8) };
    const o = [0, 0];
    expect(sampleUV(f, -90, 45, o)).toBe(true);
    expect(o[0]).toBeCloseTo(5, 6);
    expect(sampleUV(f, 180, 0, o)).toBe(true); // between the last column (135) and the first (-135, wrapped)
    expect(o[0]).toBeCloseTo(15, 6);
    f.u[1] = NaN;
    expect(sampleUV(f, -90, 45, o)).toBe(false);
  });
  it('names winds by where they come from and currents by where they go', () => {
    expect(compass16(0)).toBe('N');
    expect(compass16(247.5)).toBe('WSW');
    expect(bearingTo(1, 0)).toBeCloseTo(90);
    // a south-west monsoon wind blows towards the north-east
    expect(formatFlow('wind', 8, 8)).toBe('11.3 m/s from the SW');
    expect(formatFlow('currents', 0, -0.3)).toBe('0.30 m/s towards the S');
    expect(formatFlow('currents', NaN, NaN)).toMatch(/no data/);
    expect(flowKey(7)).toBe('07');
    expect(flowKey(0)).toBe('annual');
  });
  it('keeps streaks the same on-screen speed at every zoom, and a bounded particle count', () => {
    expect(stepScale(3, 10) * 2).toBeCloseTo(stepScale(2, 10), 12);
    expect(particleCount(390, 844)).toBe(2194);
    expect(particleCount(1440, 900)).toBe(8640);
    expect(particleCount(5120, 2880)).toBe(9000);
    expect(mercX(-180)).toBe(0);
    expect(mercY(0)).toBeCloseTo(0.5, 9);
    expect(mercY(90)).toBeCloseTo(0, 6);
  });
  it('spawns uniformly by area inside the boxes, foreshortening weights respected', () => {
    let s = 1; const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const a = spawnArea([[0, 0, 10, 10], [170, -10, 190, 0]]);
    const pt: [number, number] = [0, 0];
    let second = 0;
    for (let i = 0; i < 4000; i++) {
      randomIn(a, rand, pt);
      const inFirst = pt[0] >= 0 && pt[0] <= 10 && pt[1] >= 0 && pt[1] <= 10;
      const inSecond = (pt[0] >= 170 || pt[0] <= -170) && pt[1] >= -10 && pt[1] <= 0;
      expect(inFirst || inSecond).toBe(true);
      expect(pt[0] >= -180 && pt[0] < 180).toBe(true);
      if (inSecond) second++;
    }
    expect(second / 4000).toBeGreaterThan(0.6); // twice the area
    const w = spawnArea([[0, 0, 10, 10], [20, 0, 30, 10]], [1, 0]);
    for (let i = 0; i < 200; i++) expect(randomIn(w, rand, pt)[0]).toBeLessThanOrEqual(10);
  });
  it('cell mask answers "in the area?" like the box list, across the antimeridian', () => {
    const boxes: [number, number, number, number][] = [[176, -4, 180, 0], [-180, -4, -176, 0], [0, 40, 4, 44]];
    const g = spawnArea(boxes, [1, 1, 1], 4), plain = spawnArea(boxes);
    for (const [lon, lat] of [[178, -2], [-178, -2], [2, 42], [5, 42], [178, 2], [-170, -2]]) expect(inArea(g, lon, lat)).toBe(inArea(plain, lon, lat));
    expect(inArea(g, -178, -2)).toBe(true);
    expect(inArea(g, 5, 42)).toBe(false);
    // boxes not aligned to -90 (the whole-globe grid starts at -84)
    const h = spawnArea([[-180, -84, -176, -80], [8, 36, 12, 40]], [1, 1], 4);
    expect([inArea(h, 10, 38), inArea(h, 10, 41), inArea(h, -178, -82), inArea(h, -178, -79)]).toEqual([true, false, true, false]);
  });
  it('advects particles with the field and respawns them at the end of life or at no data', () => {
    const g = { res_deg: 1, width: 360, height: 180, lat0: 89.5, lon0: -179.5, scale: 1, fill: -32768 };
    const u = new Float32Array(360 * 180).fill(10), v = new Float32Array(360 * 180);
    const f: FlowField = { g, u, v };
    let s = 7; const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const p = new Particles(50, rand, 40);
    const area = spawnArea([[-10, -5, 10, 5]]);
    p.seed(f, area);
    const lon0 = Float32Array.from(p.lon), age0 = Float32Array.from(p.age);
    p.step(f, area, 0.01);
    for (let i = 0; i < 50; i++) if (p.age[i] === age0[i] + 1) expect(p.lon[i] - lon0[i]).toBeGreaterThan(0.09);
    expect(p.speed[0]).toBeCloseTo(10, 4);
    for (let k = 0; k < 60; k++) p.step(f, area, 0.01);
    expect(p.respawns).toBeGreaterThan(40); // lifetimes of 22-40 frames
    u.fill(NaN);
    const before = p.respawns;
    p.step(f, area, 0.01);
    expect(p.respawns - before).toBe(50);
  });
  it('a camera move that respawns particles never joins their old and new places with a segment', () => {
    const g = { res_deg: 1, width: 360, height: 180, lat0: 89.5, lon0: -179.5, scale: 1, fill: -32768 };
    const f: FlowField = { g, u: new Float32Array(360 * 180).fill(5), v: new Float32Array(360 * 180).fill(2) };
    let area = spawnArea([[-60, -10, -40, 10]]);
    const layer = new FlowLayer({ id: 't', count: () => 200, area: () => area, smax: 1, pxPerFrame: 1 });
    layer.field = f;
    const L = layer as unknown as { map: unknown; reseed(): void; advance(n: number): void; ring: Float32Array; ages: Float32Array; head: number };
    L.map = { getZoom: () => 2, triggerRepaint() {} };
    L.reseed();
    for (let k = 0; k < 5; k++) L.advance(1);
    area = spawnArea([[100, -10, 120, 10]]); // the globe was turned to the other side
    layer.refreshArea();
    for (let k = 0; k < 3; k++) {
      L.advance(1);
      const n = 200, K = L.ring.length / (n * 3), h = L.head, prev = (h + K - 1) % K;
      for (let i = 0; i < n; i++) {
        if (L.ages[i] < 1) continue; // the shader draws segment 0 only for particles at least one frame old
        expect(Math.abs(L.ring[h * n * 3 + 3 * i] - L.ring[prev * n * 3 + 3 * i])).toBeLessThan(0.01);
      }
    }
  });
  it('speed ramp brightens monotonically', () => {
    const L = [0, 0.33, 0.66, 1].map((t) => { const [r, g, b] = rampAt(t); return 0.2126 * r + 0.7152 * g + 0.0722 * b; });
    for (let i = 1; i < L.length; i++) expect(L[i]).toBeGreaterThan(L[i - 1]);
  });
});

describe('real wind and current files (contract checks)', () => {
  const load = async (set: string, key: string): Promise<FlowField | null> => {
    if (!has(`flow/${set}/manifest.json`)) return null;
    const man: FlowManifest = JSON.parse(readFileSync(pub(`flow/${set}/manifest.json`), 'utf8'));
    const g = man.grid;
    const [u, v] = decodeUV(await inflate(readFileSync(pub(`flow/${set}/${key}.bin`))), g.width, g.height, g.scale);
    return { g, u, v };
  };
  it('Arabian Sea monsoon reverses: January from the NE, July from the SW (12 N 62 E)', async () => {
    const jan = await load('wind', '01'), jul = await load('wind', '07');
    if (!jan || !jul) return;
    const j = [0, 0];
    expect(sampleUV(jan, 62, 12, j)).toBe(true);
    expect(formatFlow('wind', j[0], j[1])).toMatch(/from the (NE|ENE|NNE)/);
    const o = [0, 0];
    sampleUV(jul, 62, 12, o);
    expect(Math.hypot(o[0], o[1])).toBeGreaterThan(10);
    expect(formatFlow('wind', o[0], o[1])).toMatch(/from the (SW|WSW|SSW)/);
  });
  it('Gulf Stream is the fastest current off Cape Hatteras, and land has no current', async () => {
    const f = await load('currents', 'annual');
    if (!f) return;
    let best = 0;
    const o = [0, 0];
    for (let la = 33; la <= 38; la += 0.25) for (let lo = -76; lo <= -68; lo += 0.25) if (sampleUV(f, lo, la, o)) best = Math.max(best, Math.hypot(o[0], o[1]));
    expect(best).toBeGreaterThan(1);
    expect(sampleUV(f, 10, 50, o)).toBe(false); // Germany
  });
});

describe('chlorophyll', () => {
  it('formats mg/m³, keys and log ticks', () => {
    expect(formatChl(0.0451)).toBe('0.045 mg/m³');
    expect(formatChl(0.32)).toBe('0.32 mg/m³');
    expect(formatChl(3.54)).toBe('3.5 mg/m³');
    expect(formatChl(14.2)).toBe('14 mg/m³');
    expect(chlKey(0)).toBe('annual');
    const t = chlTicks(0.01, 20);
    expect(t.map((x) => x.label)).toEqual(['0.01', '0.1', '1', '10']);
    expect(t[0].pos).toBe(0);
  });
  it('mask keeps cells next to WOA ocean, drops lake boxes', () => {
    const W = 8, H = 4, woa = new Float32Array(W * H).fill(NaN);
    woa[1 * W + 2] = 1;
    const m = oceanMask(woa, W, H, 90, -180, 45);
    expect(m[1 * W + 3]).toBe(1); // neighbour of an ocean cell
    expect(m[3 * W + 6]).toBe(0);
    const vals = Float32Array.from({ length: W * H }, () => 1);
    expect(applyMask(vals, m)).toBe(W * H - m.reduce((s, x) => s + x, 0));
    expect(LAKE_BOXES.length).toBe(2);
  });
  it('real files: Peru upwelling is green, the South Pacific gyre is a desert, lakes are masked', async () => {
    if (!has('chl/manifest.json') || !has('woa/manifest.json')) return;
    const man: ChlManifest = JSON.parse(readFileSync(pub('chl/manifest.json'), 'utf8'));
    const wm: WaterManifest = JSON.parse(readFileSync(pub('woa/manifest.json'), 'utf8'));
    const g = man.grid, L = wm.map.layers.t_0;
    const values = decodeMapLayer(await inflate(readFileSync(pub('chl/annual.bin'))), g.lo, g.step);
    const woa = decodeMapLayer(await inflate(readFileSync(pub('woa/map/t_0.bin'))), L.lo, L.step);
    const mask = oceanMask(woa, g.width, g.height, g.north, g.west, g.res_deg);
    const kept = mask.reduce((s, x, i) => s + (x && values[i] === values[i] ? 1 : 0), 0), all = values.reduce((s, x) => s + (x === x ? 1 : 0), 0);
    expect(kept / all).toBeGreaterThan(0.97);
    applyMask(values, mask);
    const grid = { values, width: g.width, height: g.height, north: g.north, west: g.west, res: g.res_deg };
    const at = (lon: number, lat: number) => 10 ** sampleGrid(grid, lon, lat);
    expect(at(-79, -10)).toBeGreaterThan(1.5);
    expect(at(-120, -25)).toBeLessThan(0.05);
    for (const [lon, lat] of [[-87.5, 47.6], [33, -1], [108, 53.5], [50.5, 42], [-77.8, 43.7]]) expect([lon, lat, sampleGrid(grid, lon, lat)]).toEqual([lon, lat, NaN]);
  });
});
