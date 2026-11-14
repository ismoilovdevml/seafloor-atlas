import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BATHY_STOPS, EXPOSED_HIGH, EXPOSED_LOW, FLOODED_DEEP, FLOODED_SHALLOW, LAND_STOPS, SEA_EPS,
  colorReliefExpression, rampColorAt, seaLevelExpression, seaLevelStops,
} from '../src/palette';
import {
  KNEE_LEVEL, KNEE_POS, PRESETS, SEA_MAX, SEA_MIN, SLIDER_MAX, formatLevel, hashWithSea, landAreaAt,
  levelToPos, posToLevel, seaFromHash, snapLevel, type Hypsometry,
} from '../src/sealevel';

/** Colour the ramp gives an elevation (same linear interpolation as the GPU ramp). */
const colourAt = (level: number, h: number) => rampColorAt(seaLevelStops(level), h);
const strictlyIncreasing = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);

describe('sea-level ramp', () => {
  it('stops strictly increase for every level the slider can produce', () => {
    for (let p = 0; p <= SLIDER_MAX; p++) {
      const L = snapLevel(posToLevel(p));
      expect(strictlyIncreasing(seaLevelStops(L).map((s) => s[0])), `L=${L}`).toBe(true);
    }
    for (const L of [SEA_MIN, -1, 0, 1, SEA_MAX]) expect(strictlyIncreasing(seaLevelStops(L).map((s) => s[0]))).toBe(true);
  });
  it('today (L = 0) is the plain ocean + land ramp and is what the style uses', () => {
    expect(colorReliefExpression()).toEqual(seaLevelExpression(0));
    expect(seaLevelExpression(0).slice(0, 3)).toEqual(['interpolate', ['linear'], ['elevation']]);
    for (const [h, c] of BATHY_STOPS) if (h < 0) expect(colourAt(0, h)).toBe(c);
    for (const [h, c] of LAND_STOPS) expect(colourAt(0, h)).toBe(c);
    expect(colourAt(0, -1)).toBe(rampColorAt(BATHY_STOPS, -1));
    expect(colourAt(0, 0)).toBe(LAND_STOPS[0][1]); // elevation 0 counts as land (data contract)
  });
  it('colours water by depth below the new sea level', () => {
    for (const L of [-120, -2500, -6000, 10, 70]) {
      for (const d of [-8000, -4500, -1500, -200, -50]) {
        const h = L + d;
        if (L > 0 && h >= 0) continue; // flooded band has its own tint
        expect(colourAt(L, h), `L=${L} depth=${d}`).toBe(rampColorAt(BATHY_STOPS, d));
      }
    }
  });
  it('tints newly exposed sea floor when the sea falls', () => {
    expect(colourAt(-120, -120)).toBe(EXPOSED_LOW);
    expect(colourAt(-120, -SEA_EPS)).toBe(EXPOSED_HIGH);
    expect(colourAt(-120, -121)).not.toBe(EXPOSED_LOW); // just below the new coast: water
    expect(colourAt(-120, 500)).toBe(rampColorAt(LAND_STOPS, 500)); // old land unchanged
  });
  it('tints flooded land when the sea rises, and keeps land above it grey', () => {
    expect(colourAt(70, 0)).toBe(FLOODED_DEEP);
    expect(colourAt(70, 70 - SEA_EPS)).toBe(FLOODED_SHALLOW);
    expect(colourAt(70, 70)).toBe(rampColorAt(LAND_STOPS, 70));
    expect(colourAt(70, 1500)).toBe(rampColorAt(LAND_STOPS, 1500));
    // today's ocean right at the old coast is 70 m deep now
    expect(colourAt(70, -1)).toBe(rampColorAt(BATHY_STOPS, -71));
  });
  it('uses no tint bands when L = 0', () => {
    const cols = seaLevelStops(0).map((s) => s[1]);
    for (const t of [EXPOSED_LOW, EXPOSED_HIGH, FLOODED_DEEP, FLOODED_SHALLOW]) expect(cols).not.toContain(t);
  });
});

describe('sea-level slider mapping', () => {
  it('hits the ends and the knee', () => {
    expect(posToLevel(0)).toBeCloseTo(SEA_MIN, 6);
    expect(posToLevel(SLIDER_MAX)).toBe(SEA_MAX);
    expect(posToLevel(KNEE_POS)).toBe(KNEE_LEVEL);
    expect(levelToPos(0)).toBe(KNEE_POS + 200);
  });
  it('gives the -200..+100 m range more than half of the track at 1 m per step', () => {
    expect((SLIDER_MAX - KNEE_POS) / SLIDER_MAX).toBeGreaterThan(0.5);
    for (let p = KNEE_POS; p < SLIDER_MAX; p++) expect(posToLevel(p + 1) - posToLevel(p)).toBeCloseTo(1, 9);
  });
  it('is monotonic and continuous, and every step changes the snapped level', () => {
    let prev = -Infinity;
    for (let p = 0; p <= SLIDER_MAX; p++) {
      const L = snapLevel(posToLevel(p));
      expect(L, `pos ${p}`).toBeGreaterThan(prev);
      prev = L;
    }
    expect(posToLevel(KNEE_POS - 1e-9)).toBeCloseTo(KNEE_LEVEL, 4);
  });
  it('round-trips levels and places every preset on the track', () => {
    for (const L of [-6000, -2500, -1000, -201, -200, -120, -1, 0, 1, 10, 70, 100]) expect(posToLevel(levelToPos(L))).toBeCloseTo(L, 6);
    for (const p of PRESETS) {
      expect(p.level).toBeGreaterThanOrEqual(SEA_MIN); expect(p.level).toBeLessThanOrEqual(SEA_MAX);
      expect(snapLevel(p.level)).toBe(p.level);
    }
  });
  it('snaps to 1 m above -1,000 m and 10 m below, and clamps', () => {
    expect(snapLevel(-120.4)).toBe(-120);
    expect(snapLevel(-2504)).toBe(-2500);
    expect(snapLevel(-9000)).toBe(SEA_MIN);
    expect(snapLevel(500)).toBe(SEA_MAX);
  });
});

describe('sea-level text, hash and area lookup', () => {
  it('formats levels with signs', () => {
    expect(formatLevel(-2500)).toBe('−2,500 m');
    expect(formatLevel(70)).toBe('+70 m');
    expect(formatLevel(0)).toBe('0 m');
  });
  it('reads and writes the #sea= deep link next to #story=', () => {
    expect(seaFromHash('#sea=-120')).toBe(-120);
    expect(seaFromHash('#story=bahamas&sea=10')).toBe(10);
    expect(seaFromHash('#sea=-99999')).toBe(SEA_MIN);
    expect(seaFromHash('#story=bahamas')).toBeNull();
    expect(seaFromHash('#sea=abc')).toBeNull();
    expect(hashWithSea('#story=bahamas', -120)).toBe('#story=bahamas&sea=-120');
    expect(hashWithSea('#story=bahamas&sea=-120', 0)).toBe('#story=bahamas');
    expect(hashWithSea('#sea=5', 70)).toBe('#sea=70');
    expect(hashWithSea('#sea=5', null)).toBe('');
  });
  it('interpolates the hypsometric table', () => {
    const h: Hypsometry = { earth_km2: 100, today_km2: 30, levels_m: [-10, 0, 10], land_km2: [50, 30, 20] };
    expect(landAreaAt(h, 0)).toBe(30);
    expect(landAreaAt(h, -5)).toBe(40);
    expect(landAreaAt(h, 5)).toBe(25);
    expect(landAreaAt(h, -99)).toBe(50);
    expect(landAreaAt(h, 99)).toBe(20);
  });
});

// The real table written by pipeline/hypsometry.py (skipped before it is built).
const HYPSO = join(__dirname, '..', 'public', 'data', 'hypsometry.json');
describe.skipIf(!existsSync(HYPSO))('hypsometry.json (GEBCO 2026)', () => {
  const h = JSON.parse(readFileSync(HYPSO, 'utf8')) as Hypsometry;
  it('is sorted, decreasing in area, and covers the slider range', () => {
    expect(strictlyIncreasing(h.levels_m)).toBe(true);
    expect(h.land_km2.every((a, i) => i === 0 || a <= h.land_km2[i - 1])).toBe(true);
    expect(h.levels_m[0]).toBeLessThanOrEqual(SEA_MIN);
    expect(h.levels_m[h.levels_m.length - 1]).toBeGreaterThanOrEqual(SEA_MAX);
    for (let L = -500; L <= 200; L++) expect(h.levels_m).toContain(L); // 1 m where the slider is fine
  });
  it('has about 29 % land today (~148 million km², Antarctic ice surface included)', () => {
    expect(h.earth_km2 / 1e6).toBeCloseTo(510.07, 1);
    expect(landAreaAt(h, 0)).toBe(h.today_km2);
    expect(h.today_km2 / h.earth_km2).toBeGreaterThan(0.285);
    expect(h.today_km2 / h.earth_km2).toBeLessThan(0.295);
  });
});
