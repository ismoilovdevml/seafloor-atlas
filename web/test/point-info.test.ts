import { describe, expect, it } from 'vitest';
import { SEARCH_KM, searchRadiusPx } from '../src/inspect';
import { INLAND_BASINS } from '../src/inland-basins';
import { SEARCH_CAP_PX, basinAt, farVerdictCapped, inlandVerdict, nearestText, searchKm, shownFraction, swotText, swotUnrated } from '../src/point-info';

describe('searchKm', () => {
  it('keeps the full radius at low and mid latitudes', () => {
    for (const lat of [0, -30, 45, 70]) expect(searchKm(lat, 5, 512)).toBe(SEARCH_KM);
  });
  it('caps the window near the poles so one click reads at most 3 x 3 tiles', () => {
    for (const lat of [78, 80, 82.5, 84, 85, 86, -84]) {
      const km = searchKm(lat, 5, 512);
      expect(km).toBeLessThan(SEARCH_KM);
      expect(km).toBeGreaterThan(50);
      const R = searchRadiusPx(lat, 5, 512, km);
      expect(R).toBeLessThanOrEqual(SEARCH_CAP_PX + 1);
      // a window 2R+1 px wide touches at most ceil(w / 512) + 1 tiles per side
      expect(Math.ceil((2 * R + 1) / 512) + 1).toBeLessThanOrEqual(3);
    }
    // uncapped at 85 degrees the same search needed a ~950 px radius (4-5 tiles per side)
    expect(searchRadiusPx(85, 5, 512, SEARCH_KM)).toBeGreaterThan(900);
  });
});

describe('nearestText / farVerdictCapped', () => {
  it('names the radius really searched', () => {
    expect(nearestText(null, SEARCH_KM, true)).toBe(`> ${SEARCH_KM} km`);
    expect(nearestText(null, 81, true)).toBe('> 81 km');
    expect(nearestText(null, 81)).toBe('over 81 km');
    expect(nearestText(12, 81)).toBe('about 12 km');
    expect(nearestText(0, 81, true)).toBe('this cell');
  });
  it('only rewrites the far verdict when the search was capped and found nothing', () => {
    expect(farVerdictCapped(null, SEARCH_KM)).toBeNull();
    expect(farVerdictCapped(40, 81)).toBeNull();
    expect(farVerdictCapped(null, 81)).toContain('within 81 km');
  });
});

describe('shownFraction', () => {
  it('reports an unknown share when the DEM is missing and the alpha read as fully measured', () => {
    expect(shownFraction(1, NaN)).toBeNaN();
    expect(shownFraction(1, -40)).toBe(1);
    expect(shownFraction(0.3, NaN)).toBe(0.3);
    expect(shownFraction(null, 120)).toBeNull();
  });
});

describe('swotText', () => {
  it('gives the true reason for an unrated point', () => {
    expect(swotText(84, 0, null, 0)).toMatch(/stops at 80/);
    expect(swotText(-81, null, null, 0)).toMatch(/stops at 80/);
    expect(swotText(10, null, null, 0)).toBe('could not be loaded');
    expect(swotText(10, 0, null, 0.4)).toBe('not rated (sounding here)');
    expect(swotText(10, 0, null, 0)).toBe('not rated (the model has a sounding or land here)');
    expect(swotText(10, 160, 'Medium confidence', 0)).toBe('Medium');
  });
  it('unrated only inside the model coverage with its tile loaded', () => {
    expect(swotUnrated(30, 0, null)).toBe(true);
    expect(swotUnrated(30, null, null)).toBe(false);
    expect(swotUnrated(30, 160, 'Medium confidence')).toBe(false);
    expect(swotUnrated(82, 0, null)).toBe(false);
  });
});

describe('inland basins', () => {
  it('finds the dataset basins at the audit points', () => {
    expect(basinAt(INLAND_BASINS, -116.87, 36.25)?.name).toBe('Death Valley');
    expect(basinAt(INLAND_BASINS, 35.5, 31.5)?.name).toBe('Dead Sea and Jordan Valley');
    expect(basinAt(INLAND_BASINS, 27.1, 29.6)?.name).toBe('Qattara Depression');
    expect(basinAt(INLAND_BASINS, 89.25, 42.7)?.name).toBe('Turpan Depression');
    expect(basinAt(INLAND_BASINS, 50.5, 41.5)?.name).toBe('Caspian Sea and Caspian Depression');
  });
  it('is not found in the open ocean', () => {
    for (const [lon, lat] of [[-30, -20], [0, 0], [150, 30], [-40, 82.5]]) expect(basinAt(INLAND_BASINS, lon, lat)).toBeNull();
  });
  it('prefers the smallest box that holds the point', () => {
    const b: [number, number, number, number, string?][] = [[0, 10, 0, 10, 'big'], [4, 5, 4, 5, 'small']];
    expect(basinAt(b, 4.5, 4.5)?.name).toBe('small');
    expect(basinAt(b, 1, 1)?.name).toBe('big');
    expect(basinAt([[0, 1, 0, 1]], 0.5, 0.5)?.name).toBe('');
  });
  it('every row is a valid box', () => {
    expect(INLAND_BASINS.length).toBe(185);
    for (const [a, b, c, d] of INLAND_BASINS) { expect(a).toBeLessThanOrEqual(b); expect(c).toBeLessThanOrEqual(d); }
  });
  it('says what the point is', () => {
    expect(inlandVerdict('Dead Sea and Jordan Valley')).toContain('(Dead Sea and Jordan Valley)');
    expect(inlandVerdict('')).not.toContain('()');
  });
});
