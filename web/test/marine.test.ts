import { describe, expect, it } from 'vitest';
import { cellAt, cellState, decodePlanes, describe as describeCell, geohash, groupGrid, renderLL, scalePos, SCALES, valueAt, type GridDef } from '../src/marine';
import { classFromAlpha, disagreeFromAlpha, formatDisagree, sealCard, tilePixel } from '../src/certainty';

const GH3: GridDef = { ncol: 256, nrow: 128, dlon: 1.40625, dlat: 1.40625, west: -180, north: 90 };

describe('marine-life grids', () => {
  it('decodes little-endian byte planes', () => {
    // two uint16 values 0x0102 and 0x0304: low bytes first, then high bytes
    expect([...decodePlanes(new Uint8Array([0x02, 0x04, 0x01, 0x03]), 'uint16')]).toEqual([0x0102, 0x0304]);
    // one uint32 value 0x01020304
    expect([...decodePlanes(new Uint8Array([0x04, 0x03, 0x02, 0x01]), 'uint32')]).toEqual([0x01020304]);
    expect([...decodePlanes(new Uint8Array([7, 9]), 'uint8')]).toEqual([7, 9]);
  });
  it('geohash matches known values and the gh3 grid', () => {
    expect(geohash(-5.6, 42.6, 5)).toBe('ezs42'); // the classic example
    expect(geohash(0.1, 51.5, 3)).toBe('u10');
    // a gh3 cell centre maps back to the same geohash-3 (grid is cell-aligned with geohashes)
    const c = cellAt(GH3, 124.5, -2.1)!;
    const lon = -180 + (c.col + 0.5) * GH3.dlon, lat = 90 - (c.row + 0.5) * GH3.dlat;
    expect(geohash(lon, lat, 3)).toBe(geohash(124.5, -2.1, 3));
  });
  it('cells: row 0 is north, column 0 is 180 W, outside is null', () => {
    expect(cellAt(GH3, -179.9, 89.9)).toEqual({ col: 0, row: 0 });
    expect(cellAt(GH3, 179.9, -89.9)).toEqual({ col: 255, row: 127 });
    expect(cellAt(GH3, 0, -91)).toBeNull();
    const g = groupGrid(GH3, [[255, 127, 12, 3]]);
    expect(valueAt(g, 179.9, -89.9)).toBe(12);
  });
  it('cell states: ES50 decoding, masked ocean, transparent land', () => {
    expect(cellState('es50', 4101, 255)).toEqual({ v: 41 });
    expect(cellState('es50', 0, 255)).toBe('masked');
    expect(cellState('records', 0, 0)).toBeNull();
    expect(cellState('aquamaps', 0, 255)).toBeNull();
    expect(describeCell('es50', 'masked')).toBe('not enough records');
    expect(describeCell('aquamaps', { v: 2403 })).toBe('2,403 species');
    expect(scalePos(SCALES.aquamaps, 10)).toBeCloseTo(0, 6);
    expect(scalePos(SCALES.aquamaps, 10000)).toBeCloseTo(1, 6);
  });
  it('renders a lat/lon grid to Web Mercator (transparent where no value)', () => {
    const def: GridDef = { ncol: 2, nrow: 1, dlon: 180, dlat: 180, west: -180, north: 90 };
    const g = { values: new Uint16Array([0, 1000]), def };
    const out = new Uint8ClampedArray(8 * 8 * 4);
    renderLL(out, 8, 'aquamaps', g, null);
    const px = (x: number, y: number) => [...out.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
    expect(px(1, 4)[3]).toBe(0); // western half: 0 = no prediction
    expect(px(6, 4)[3]).toBeGreaterThan(200);
  });
});

describe('depth certainty', () => {
  const lg = { vmin: 50, vmax: 1000, alphaMin: 110, alphaMax: 235 };
  it('disagreement from tile alpha follows the log scale', () => {
    expect(disagreeFromAlpha(0, lg)).toBeNull();
    expect(disagreeFromAlpha(110, lg)).toBeCloseTo(50, 6);
    expect(disagreeFromAlpha(235, lg)).toBeCloseTo(1000, 6);
    expect(disagreeFromAlpha(172.5, lg)).toBeCloseTo(Math.sqrt(50 * 1000), 3);
    expect(formatDisagree(223.6, 1000)).toBe('about 220 m');
    expect(formatDisagree(1000, 1000)).toBe('1,000 m or more');
  });
  it('confidence class from alpha', () => {
    const classes = [{ class: 1, label: 'High confidence', color: '', alpha: 70 }, { class: 2, label: 'Medium confidence', color: '', alpha: 160 }, { class: 3, label: 'Low confidence', color: '', alpha: 225 }];
    expect(classFromAlpha(0, { classes })).toBeNull();
    expect(classFromAlpha(160, { classes })?.label).toBe('Medium confidence');
    expect(classFromAlpha(224, { classes })?.label).toBe('Low confidence');
  });
  it('tile pixel addressing', () => {
    expect(tilePixel(0, 0, 0, 512)).toEqual({ x: 0, y: 0, px: 256, py: 256 });
    expect(tilePixel(-180, 85, 5, 512).x).toBe(0);
    expect(tilePixel(179.99, -85, 5, 512)).toMatchObject({ x: 31, y: 31 });
  });
  it('seal card says how many dives beat the chart', () => {
    const c = sealCard({ n: 130, d: 94, dp: 112, x: 1636, md: 1629, cd: -75 }, -37.15, -54.25, 'SO-ABBA');
    expect(c.lead).toMatch(/^94 of 130 dives \(72%\)/);
    expect(c.name).toBe('54.3° S, 37.1° W');
    expect(c.facts.find(([k]) => k === 'Largest excess')?.[1]).toBe('1,636 m');
  });
});
