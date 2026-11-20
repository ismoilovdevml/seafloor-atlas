import { describe, expect, it } from 'vitest';
import { classify, formatNearest, nearestFlagged, NEAR_KM, pixelKm, searchRadiusPx, verdict, worldPxToLonLat } from '../src/inspect';
import { haversineKm, lonLatToWorldPx } from '../src/geo';
import { STATUS, STATUS_ORDER } from '../src/palette';
import { baseFromHash, ESRI, esriAttribution, esriSource, hashWithBase } from '../src/basemap';

describe('classify', () => {
  it('maps fraction and distance to one status', () => {
    expect(classify(null, null)).toBe('land');
    expect(classify(NaN, 3)).toBeNull();
    expect(classify(0.5, null)).toBe('measured');
    expect(classify(1, null)).toBe('measured');
    expect(classify(0.01, null)).toBe('partly');
    expect(classify(0, 0)).toBe('near');
    expect(classify(0, NEAR_KM)).toBe('near');
    expect(classify(0, NEAR_KM + 0.1)).toBe('far');
    expect(classify(0, null)).toBe('far');
  });
  it('every ocean status has a colour and a verdict', () => {
    for (const s of STATUS_ORDER) {
      expect(STATUS[s].color).toMatch(/^#[0-9a-f]{6}$/);
      expect(verdict(s, 0.3, 5).length).toBeGreaterThan(20);
    }
    expect(verdict('far', 0, null)).toContain('200 km');
  });
});

describe('pixel geometry', () => {
  it('round-trips lon/lat through world pixels', () => {
    for (const [lon, lat] of [[0, 0], [-120.5, 45.2], [179.9, -70.1]] as [number, number][]) {
      const [x, y] = lonLatToWorldPx(lon, lat, 5, 512);
      const [lo, la] = worldPxToLonLat(x, y, 5, 512);
      expect(lo).toBeCloseTo(lon, 6); expect(la).toBeCloseTo(lat, 6);
    }
  });
  it('pixel width shrinks with latitude', () => {
    expect(pixelKm(0, 5, 512)).toBeCloseTo(2.443, 2);
    expect(pixelKm(60, 5, 512)).toBeCloseTo(1.2215, 2);
  });
});

describe('nearestFlagged', () => {
  const z = 5, S = 512, n = S * 2 ** z;
  it('is 0 when the own pixel is flagged and null when nothing is in range', () => {
    const [x, y] = lonLatToWorldPx(10, 20, z, S);
    expect(nearestFlagged((ix, iy) => ix === Math.floor(x) && iy === Math.floor(y), 10, 20, z, S, 200)).toBe(0);
    expect(nearestFlagged(() => false, 10, 20, z, S, 200)).toBeNull();
  });
  it('matches a brute-force search over the window, across the dateline and at high latitude', () => {
    for (const [lon, lat] of [[179.95, -10], [30, 72], [-60, 5]] as [number, number][]) {
      // a sparse pseudo-random set of flagged pixels
      const flag = (ix: number, iy: number) => ((ix * 7919 + iy * 104729) % 997) === 0;
      const got = nearestFlagged(flag, lon, lat, z, S, 200);
      const [cx, cy] = lonLatToWorldPx(lon, lat, z, S);
      const R = searchRadiusPx(lat, z, S, 200);
      let best = Infinity;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const ix = Math.floor(cx) + dx, iy = Math.floor(cy) + dy;
        if (iy < 0 || iy >= n || !flag(((ix % n) + n) % n, iy)) continue;
        best = Math.min(best, haversineKm([lon, lat], worldPxToLonLat(ix + 0.5, iy + 0.5, z, S)));
      }
      expect(got).toBeCloseTo(best <= 200 ? best : (null as unknown as number), 9);
    }
  });
  it('formats distances', () => {
    expect(formatNearest(0)).toBe('this cell');
    expect(formatNearest(0.4)).toBe('under 1 km');
    expect(formatNearest(7.4)).toBe('about 7 km');
    expect(formatNearest(43)).toBe('about 45 km');
    expect(formatNearest(null)).toBe('over 200 km');
    expect(formatNearest(7.4, true)).toBe('7 km');
    expect(formatNearest(null, true)).toBe('> 200 km');
  });
});

describe('basemaps', () => {
  it('reads and writes base= in the hash without touching other parts', () => {
    expect(baseFromHash('')).toBe('atlas');
    expect(baseFromHash('#at=1,2,3&base=sat')).toBe('sat');
    expect(baseFromHash('#base=evil')).toBe('atlas');
    expect(hashWithBase('#at=1,2,3&layers=veil', 'ocean')).toBe('#at=1,2,3&layers=veil&base=ocean');
    expect(hashWithBase('#at=1,2,3&base=ocean', 'atlas')).toBe('#at=1,2,3');
    expect(hashWithBase('#base=topo', 'atlas')).toBe('');
  });
  it('gives every Esri source its own attribution, with Powered by Esri', () => {
    const atts = ESRI.map((b) => esriSource(b).attribution);
    expect(new Set(atts).size).toBe(ESRI.length);
    for (const b of ESRI) expect(esriAttribution(b)).toMatch(/^Powered by Esri · .*\S/);
    expect(esriSource(ESRI[0]).tiles?.[0]).toBe('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');
  });
});
