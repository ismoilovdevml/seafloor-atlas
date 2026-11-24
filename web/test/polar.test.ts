import { afterEach, describe, expect, it, vi } from 'vitest';
import { haversineKm, lonLatToWorldPx } from '../src/geo';
import { nearestFlagged, NOT_RATED, RATED_TO_LAT, worldPxToLonLat } from '../src/inspect';
import { rampColorAt, seaLevelStops } from '../src/palette';
import { ICE_STOPS, iceLand } from '../src/basemap';
import {
  capsInView, decodePolarRgba, FADE_FROM, FADE_TO, fadeBand, OVERLAY_FADE_FROM, OVERLAY_FADE_TO, discMesh, DRAW_FROM_LAT, gridLight, gridToLatLon, latLonToGrid, lightAzimuth, LOAD_FROM_LAT,
  packStops, polarDepth, rampRgb, RING_STEP, type PolarGrid,
} from '../src/polar-layer';
import { TileSampler } from '../src/sampler';

const S = 512;

describe('nearestFlagged at and near the poles', () => {
  it('returns null (not a clamped 0 km) poleward of the Mercator limit, even if the edge row is flagged', () => {
    // the old code clamped 89 N onto the 85.05 N edge row and answered 0 km "this cell" from ~440 km away
    expect(haversineKm([0, 89], [0, 85.0511])).toBeGreaterThan(430);
    expect(nearestFlagged(() => true, 0, 89, 5, S, 200)).toBeNull();
    expect(nearestFlagged(() => true, 150, -88, 5, S, 200)).toBeNull();
  });
  it('with the sampler limit (84.8) a point beyond it is not rated, and the invented cap rows never count', () => {
    expect(nearestFlagged(() => true, 0, 84.9, 5, S, 200, RATED_TO_LAT)).toBeNull();
    // only rows poleward of 84.8 flagged: a point at 84.0 N has no measured cell within reach
    const yLim = lonLatToWorldPx(0, RATED_TO_LAT, 5, S)[1];
    const capOnly = (_ix: number, iy: number) => iy + 0.5 < yLim;
    expect(nearestFlagged(capOnly, 0, 84.0, 5, S, 200)).not.toBeNull(); // default limit: the cap rows answer (~90 km)
    expect(nearestFlagged(capOnly, 0, 84.0, 5, S, 200, RATED_TO_LAT)).toBeNull();
  });
  it('still measures honest great-circle distances equatorward of the limit', () => {
    const [x, y] = lonLatToWorldPx(10, 84.5, 5, S);
    const fx = Math.floor(x), fy = Math.floor(y);
    const flag = (ix: number, iy: number) => ix === fx && iy === fy;
    const km = nearestFlagged(flag, 10, 84.0, 5, S, 200, RATED_TO_LAT)!;
    expect(km).toBeCloseTo(haversineKm([10, 84.0], worldPxToLonLat(fx + 0.5, fy + 0.5, 5, S)), 6);
    expect(km).toBeGreaterThan(54);
    expect(km).toBeLessThan(57);
    expect(nearestFlagged(() => true, 10, 60, 5, S, 200)).toBe(0);
  });
});

/** Synthetic n x n grid: h = f(X, Y) at pixel centres. */
function grid(north: boolean, n: number, radius: number, f: (X: number, Y: number) => number): PolarGrid {
  const h = new Int16Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const X = ((j + 0.5) * 2 * radius) / n - radius, Y = radius - ((i + 0.5) * 2 * radius) / n;
    h[i * n + j] = Math.round(f(X, Y));
  }
  return { north, size: n, radius, h };
}

describe('polar grid sampling', () => {
  it('lat/lon <-> grid round-trips (pipeline/polar.py polar_xy and its inverse)', () => {
    for (const north of [true, false]) for (const [lat, lon] of [[86, 0], [84.2, 135], [88.8, -90], [83.5, -179]]) {
      const la = north ? lat : -lat;
      const [X, Y] = latLonToGrid(la, lon, north);
      const [lat2, lon2] = gridToLatLon(X, Y, north);
      expect(lat2).toBeCloseTo(la, 9);
      expect(lon2).toBeCloseTo(lon, 9);
    }
  });
  it('bilinear between pixel centres: exact on a plane, the pole = mean of the four centre pixels', () => {
    const g = grid(true, 64, 7, (X, Y) => -3000 + 100 * X - 50 * Y);
    expect(polarDepth(g, 90, 0)).toBeCloseTo(-3000, 0);
    for (const [lat, lon] of [[87.5, 150], [85, -40], [89.9, 10]]) {
      const [X, Y] = latLonToGrid(lat, lon, true);
      expect(polarDepth(g, lat, lon)).toBeCloseTo(-3000 + 100 * X - 50 * Y, 0);
    }
    const c = new Int16Array(16).fill(0); c[5] = 4; c[6] = 8; c[9] = 12; c[10] = 16;
    expect(polarDepth({ north: false, size: 4, radius: 7, h: c }, -90, 0)).toBe(10);
  });
  it('NaN outside the disc or on the other hemisphere', () => {
    const g = grid(true, 16, 7, () => -1000);
    expect(polarDepth(g, 82.9, 0)).toBeNaN();
    expect(polarDepth(g, -89, 0)).toBeNaN();
  });
  it('decodes Terrarium whole metres exactly', () => {
    const px = new Uint8ClampedArray([((-4223 + 32768) >> 8), (-4223 + 32768) & 255, 0, 255, ((2828 + 32768) >> 8), (2828 + 32768) & 255, 0, 255]);
    expect([...decodePolarRgba(px, 2)]).toEqual([-4223, 2828]);
  });
});

describe('TileSampler poleward of 84.8 degrees', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reads depth from the polar grid and reports the measured fraction as not rated', async () => {
    const n = 8;
    const fill = (pole: string) => {
      const px = new Uint8ClampedArray(n * n * 4);
      for (let i = 0; i < n * n; i++) {
        const h = (pole === 'north' ? -4000 : 2800) + i; // a distinct value per pixel
        px.set([(h + 32768) >> 8, (h + 32768) & 255, 0, 255], i * 4);
      }
      return px;
    };
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      urls.push(String(u));
      if (u.endsWith('polar.json')) return new Response(JSON.stringify({ size: n, radius_deg: 7 }));
      const m = /(north|south)\.webp$/.exec(u);
      if (m) return new Response(new Blob([m[1]]));
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('createImageBitmap', async (b: Blob) => ({ width: n, height: n, pole: await b.text(), close() {} }));
    vi.stubGlobal('OffscreenCanvas', class {
      private pole = '';
      getContext() {
        return {
          drawImage: (bmp: { pole: string }) => { this.pole = bmp.pole; },
          getImageData: () => ({ data: fill(this.pole) }),
        };
      }
    });
    const s = new TileSampler('tiles-polar-test/', { tileSize: 512, maxzoom: 5, veilMax: 230 });
    const r = await s.sample([[0, 90], [150, 87.5], [0, -90], [10, 84.85], [0, 10]], 5);
    // pole: mean of the four centre pixels (indices 27, 28, 35, 36)
    expect(r.h[0]).toBeCloseTo(-4000 + (27 + 28 + 35 + 36) / 4, 6);
    expect(r.f[0]).toBeNaN();
    expect(r.note[0]).toBe(NOT_RATED);
    expect(r.h[1]).toBeLessThan(-3900);
    expect(r.note[1]).toBe(NOT_RATED);
    // Antarctica: land (the ice surface), not a "not rated" ocean
    expect(r.h[2]).toBeCloseTo(2800 + (27 + 28 + 35 + 36) / 4, 6);
    expect(r.f[2]).toBeNull();
    expect(r.note[2]).toBeNull();
    expect(r.note[3]).toBe(NOT_RATED);
    // equatorward points still come from the tiles (404 here: unknown), with no note
    expect(r.h[4]).toBeNaN();
    expect(r.note[4]).toBeNull();
    // one fetch per pole and one polar.json, shared by all points (the polar folder sits next to the tiles)
    expect(urls.filter((u) => u.includes('/polar/'))).toEqual(['tiles-polar-test/polar/polar.json', 'tiles-polar-test/polar/north.webp', 'tiles-polar-test/polar/south.webp']);
    expect(await s.nearestMeasured(0, 89, 200)).toBeNull();
  });
});

describe('disc mesh', () => {
  for (const north of [true, false]) {
    const m = discMesh(north, 7);
    const EDGE = FADE_FROM, R = 90 - FADE_FROM;
    const nv = m.vertices.length / 5;
    const V = (i: number) => Array.from(m.vertices.subarray(i * 5, i * 5 + 5));
    it(`${north ? 'north' : 'south'}: clean circular edge at FADE_FROM (alpha 0 all round), one pole vertex`, () => {
      expect(nv).toBeLessThan(65536);
      let atPole = 0, minLat = 90;
      for (let i = 0; i < nv; i++) { const l = V(i)[4]; minLat = Math.min(minLat, l); if (l === 90) atPole++; }
      expect(atPole).toBe(1);
      expect(minLat).toBeCloseTo(EDGE, 4); // float32 attribute
      // every vertex of the outer ring lies exactly at the fade start
      const outer = m.rings[m.rings.length - 1] + 1;
      for (let i = nv - outer; i < nv; i++) expect(V(i)[4]).toBeCloseTo(EDGE, 4);
    });
    it(`${north ? 'north' : 'south'}: triangles tile the disc, stay short and never span the antimeridian`, () => {
      let area = 0, maxEdge = 0, maxSpan = 0;
      const xy = (i: number) => { const [, , u, v] = V(i); return [u * 14 - 7, 7 - v * 14]; };
      for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        for (const i of [a, b, c]) expect(i).toBeLessThan(nv);
        const [p, q, r] = [xy(a), xy(b), xy(c)];
        area += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
        for (const [u, w] of [[p, q], [q, r], [r, p]]) maxEdge = Math.max(maxEdge, Math.hypot(u[0] - w[0], u[1] - w[1]));
        // the pole fan shares one vertex (no gap at the pole); in Mercator space it lies at y ~ -1.7, never on screen
        if (a === 0) continue;
        const mx = [V(a)[0], V(b)[0], V(c)[0]];
        maxSpan = Math.max(maxSpan, Math.max(...mx) - Math.min(...mx));
      }
      expect(Math.abs(area / (Math.PI * R * R) - 1)).toBeLessThan(1e-3);
      expect(maxEdge).toBeLessThan(1.5 * RING_STEP);
      expect(maxSpan).toBeLessThan(0.5);
    });
    it(`${north ? 'north' : 'south'}: u, v address the same grid point as lat, lon`, () => {
      for (let i = 0; i < nv; i += 97) {
        const [mx, , u, v, lat] = V(i);
        if (lat > 89.999) continue;
        const [la, lo] = gridToLatLon(u * 14 - 7, 7 - v * 14, north);
        expect(Math.abs(la)).toBeCloseTo(lat, 4);
        const d = Math.abs(((lo - (mx * 360 - 180)) + 540) % 360 - 180);
        expect(d).toBeLessThan(1e-3);
      }
    });
  }
});

describe('colour ramp in the shader', () => {
  const hex = (rgb: [number, number, number]) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
  const diff = (a: string, b: string) => Math.max(...[1, 3, 5].map((k) => Math.abs(parseInt(a.slice(k, k + 2), 16) - parseInt(b.slice(k, k + 2), 16))));
  it('equals the map ramp (palette.rampColorAt) at every metre near sea level and across the whole range', () => {
    for (const L of [-130, -10, 0, 1, 10, 70]) {
      for (const stops of [seaLevelStops(L), iceLand(seaLevelStops(L), Math.max(0, L))]) {
        const p = packStops(stops);
        for (let h = -11500; h <= 7500; h += h > -200 && h < 200 ? 0.25 : 37) expect(diff(hex(rampRgb(p, h)), rampColorAt(stops, h))).toBeLessThanOrEqual(1);
      }
    }
  });
  it('keeps +1 m (ice shelf / dry land) out of the water colours, and moves the coast with a +1 m sea level', () => {
    const p0 = packStops(iceLand(seaLevelStops(0), 0));
    expect(hex(rampRgb(p0, 1))).toBe(rampColorAt(ICE_STOPS, 1));
    const p1 = packStops(seaLevelStops(1));
    expect(diff(hex(rampRgb(p1, 0)), '#4f86c6')).toBeLessThanOrEqual(1); // flooded at L = +1
    expect(diff(hex(rampRgb(p1, 1)), rampColorAt(seaLevelStops(1), 1))).toBe(0);
  });
});

describe('hillshade light like MapLibre (azimuth in each point\'s north-up frame)', () => {
  const sc = lightAzimuth(315, 0, 'viewport');
  it('at lon 0 it is the old fixed grid light; at lon 180 it is turned round (the old one lit that side backwards)', () => {
    for (const north of [true, false]) {
      const [X0, Y0] = latLonToGrid(north ? 84 : -84, 0, north);
      const l0 = gridLight(X0, Y0, north, sc);
      expect(l0[0]).toBeCloseTo(-Math.SQRT1_2, 9); expect(l0[1]).toBeCloseTo(Math.SQRT1_2, 9);
      const [X1, Y1] = latLonToGrid(north ? 84 : -84, 180, north);
      const l1 = gridLight(X1, Y1, north, sc);
      expect(l1[0]).toBeCloseTo(Math.SQRT1_2, 9); expect(l1[1]).toBeCloseTo(-Math.SQRT1_2, 9);
    }
  });
  it('comes from the local north-west everywhere, plus the bearing for the viewport anchor', () => {
    for (const north of [true, false]) for (const bearing of [0, 37, -120]) for (let lon = -180; lon < 180; lon += 15) {
      const lat = north ? 85 : -85;
      const s = lightAzimuth(315, bearing, 'viewport');
      const [X, Y] = latLonToGrid(lat, lon, north);
      const L = gridLight(X, Y, north, s);
      // local east / north in the grid from finite differences of latLonToGrid
      const e = latLonToGrid(lat, lon + 1e-4, north), nn = latLonToGrid(lat + 1e-4, lon, north);
      const E = [e[0] - X, e[1] - Y], N = [nn[0] - X, nn[1] - Y];
      const nE = Math.hypot(E[0], E[1]), nN = Math.hypot(N[0], N[1]);
      const a = (315 + bearing) * Math.PI / 180;
      expect((L[0] * E[0] + L[1] * E[1]) / nE).toBeCloseTo(Math.sin(a), 5);
      expect((L[0] * N[0] + L[1] * N[1]) / nN).toBeCloseTo(Math.cos(a), 5);
    }
    expect(lightAzimuth(315, 90, 'map')).toEqual(lightAzimuth(315, 0, 'viewport'));
  });
});

describe('fade band', () => {
  it('narrow while a layer under the hillshade is visible, wide (hiding the Mercator terraces) otherwise', () => {
    const order = ['background', 'sat', 'relief', 'marine', 'water', 'hillshade', 'polar-caps', 'veil'];
    expect(fadeBand(order, () => false)).toEqual([FADE_FROM, FADE_TO]);
    expect(fadeBand(order, (id) => id === 'sat' || id === 'veil')).toEqual([FADE_FROM, FADE_TO]);
    expect(fadeBand(order, (id) => id === 'marine')).toEqual([OVERLAY_FADE_FROM, OVERLAY_FADE_TO]);
    expect(FADE_TO).toBeLessThan(83.5);
  });
  it('the overlay band ends inside the real tile rows and leaves under 1 % of the invented cap mean visible', () => {
    const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    let worst = 0;
    for (let l = 84.6; l <= 85.06; l += 1e-4) worst = Math.max(worst, (1 - ss(OVERLAY_FADE_FROM, OVERLAY_FADE_TO, l)) * ss(RATED_TO_LAT, 84.92, l));
    expect(worst).toBeLessThan(0.01);
    expect(OVERLAY_FADE_FROM).toBeLessThan(RATED_TO_LAT);
  });
});

describe('lazy loading', () => {
  it('loads a cap only once the view reaches 60 degrees on its side, draws it from 75', () => {
    expect(capsInView(50, -50)).toEqual({ load: [false, false], draw: [false, false] });
    expect(capsInView(LOAD_FROM_LAT, -10)).toEqual({ load: [true, false], draw: [false, false] });
    expect(capsInView(90, -DRAW_FROM_LAT)).toEqual({ load: [true, true], draw: [true, true] });
  });
});
