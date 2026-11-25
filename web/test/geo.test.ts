import { describe, expect, it } from 'vitest';
import {
  bilinear, decodeTerrarium, decodeVeil, formatDepth, greatCircle, haversineKm, lonLatToWorldPx, profileZoom, unwrapPath, wrapPx,
} from '../src/geo';
import { BATHY_STOPS, LAND_STOPS, colorReliefExpression } from '../src/palette';

describe('Terrarium', () => {
  it('decodes the contract formula', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    // -10,920 m -> v = 21848 -> R=85, G=88
    expect(decodeTerrarium(85, 88, 0)).toBe(-10920);
    expect(decodeTerrarium(128, 0, 128)).toBe(0.5);
    expect(decodeTerrarium(162, 144, 0)).toBe(162 * 256 + 144 - 32768);
  });
  it('round-trips the pipeline encoder (B carries 1/256 m)', () => {
    for (const h of [-10935.27, -4000, -0.4, 0, 8848.9]) {
      const v = Math.round((h + 32768) * 256);
      const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
      expect(decodeTerrarium(r, g, b)).toBeCloseTo(h, 2);
    }
  });
});

describe('veil', () => {
  it('maps alpha to measured fraction per contract', () => {
    expect(decodeVeil(230, 230, -4000)).toBe(0); // fully veiled = not measured
    expect(decodeVeil(0, 230, -4000)).toBe(1); // no veil over ocean = fully measured
    expect(decodeVeil(115, 230, -4000)).toBeCloseTo(0.5, 6);
    expect(decodeVeil(0, 230, 120)).toBeNull(); // land
    expect(decodeVeil(0, 230, -2)).toBe(1); // below-sea-level ocean cell, fully measured
    expect(decodeVeil(1, 230, -3)).toBeNull(); // reserved alpha: land below sea level (Flevoland)
    expect(decodeVeil(2, 230, -3)).toBeCloseTo(1 - 2 / 230, 6);
    expect(decodeVeil(3, 230, -400)).toBeNull(); // reserved alpha: inland water (Caspian bed)
  });
});

describe('tile math', () => {
  it('projects to Web Mercator pixels', () => {
    expect(lonLatToWorldPx(-180, 0, 0, 512)).toEqual([0, 256]);
    const [x, y] = lonLatToWorldPx(0, 85.0511287798066, 2, 512);
    expect(x).toBeCloseTo(1024, 6); expect(y).toBeCloseTo(0, 6);
    expect(lonLatToWorldPx(0, 89.9, 0, 512)[1]).toBeCloseTo(0, 6); // clamped
  });
  it('wraps columns', () => { expect(wrapPx(-1, 512)).toBe(511); expect(wrapPx(512, 512)).toBe(0); });
  it('bilinear hits pixel centres exactly and interpolates between them', () => {
    const grid = (ix: number, iy: number) => ix * 10 + iy;
    expect(bilinear(grid, 2.5, 3.5, 16)).toBeCloseTo(23, 9);
    expect(bilinear(grid, 3.0, 3.5, 16)).toBeCloseTo(28, 9);
    expect(bilinear(grid, 2.5, 4.0, 16)).toBeCloseTo(23.5, 9);
  });
  it('bilinear wraps across the antimeridian', () => {
    const grid = (ix: number) => (ix === 0 ? 100 : ix === 15 ? 0 : NaN);
    expect(bilinear((ix) => grid(ix), 16.0, 4, 16)).toBeCloseTo(50, 9); // between col 15 and col 0
  });
});

describe('great circle', () => {
  it('haversine matches known distances', () => {
    expect(haversineKm([0, 0], [90, 0])).toBeCloseTo(10007.5, 0);
    expect(haversineKm([-0.1278, 51.5074], [2.3522, 48.8566])).toBeCloseTo(343.5, 0);
  });
  it('samples evenly with endpoints included', () => {
    const p = greatCircle([0, 0], [90, 0], 4);
    expect(p.length).toBe(4);
    expect(p[0][0]).toBeCloseTo(0, 9); expect(p[3][0]).toBeCloseTo(90, 9); expect(p[1][0]).toBeCloseTo(30, 9);
    const q = greatCircle([-30, 40], [100, 10], 400);
    const steps = q.slice(1).map((pt, i) => haversineKm(q[i], pt));
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(1e-6);
  });
  it('unwraps antimeridian crossings', () => {
    const p = unwrapPath(greatCircle([170, 0], [-170, 0], 5));
    expect(p.map((c) => Math.round(c[0]))).toEqual([170, 175, 180, 185, 190]);
  });
  it('picks a coarser zoom for long profiles', () => {
    expect(profileZoom(300, 400, 5, 512)).toBe(5);
    expect(profileZoom(15000, 400, 5, 512)).toBeLessThan(5);
  });
});

describe('palette', () => {
  it('stops increase strictly (interpolate requirement) and darken with depth', () => {
    const all = [...BATHY_STOPS, ...LAND_STOPS].map((s) => s[0]);
    for (let i = 1; i < all.length; i++) expect(all[i]).toBeGreaterThan(all[i - 1]);
    const L = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
    for (let i = 1; i < BATHY_STOPS.length; i++) expect(L(BATHY_STOPS[i][1])).toBeGreaterThan(L(BATHY_STOPS[i - 1][1]));
    expect(colorReliefExpression().slice(0, 3)).toEqual(['interpolate', ['linear'], ['elevation']]);
  });
  it('formats depth with a true minus sign', () => {
    expect(formatDepth(-10934.6)).toBe('−10,935 m');
    expect(formatDepth(12)).toBe('12 m');
  });
});

describe('chart ticks', async () => {
  const { niceTicks } = await import('../src/profile-chart');
  it('covers the range with round steps', () => {
    expect(niceTicks(-10900, 0, 5)).toEqual([-10000, -8000, -6000, -4000, -2000, 0]);
    expect(niceTicks(0, 283, 7)).toEqual([0, 50, 100, 150, 200, 250]);
  });
});
