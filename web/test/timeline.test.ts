import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatAgo, hashWithTime, HISTORY_NEW, HISTORY_VEIL, levelAtAgo, mappingHeadline, parseMappingManifest, parseSeaHistory, recolourHistory, stepMs,
  timeFromHash, yearFromText,
} from '../src/timeline';
import { LoadMeter } from '../src/loading';
import { cablesInService, hashWithLayers, layersFromHash, windInService, yearFilterOn } from '../src/overlays';

const pub = (p: string) => new URL(`../public/${p}`, import.meta.url);

describe('time deep link', () => {
  it('parses and writes #time= next to other parts', () => {
    expect(timeFromHash('#time=quakes-2004')).toEqual({ mode: 'years', set: 'quakes', year: 2004, only: false });
    expect(timeFromHash('#story=x&time=quakes-2011-only&sea=-10')).toEqual({ mode: 'years', set: 'quakes', year: 2011, only: true });
    expect(timeFromHash('#time=month-7')).toEqual({ mode: 'months', month: 7 });
    expect(timeFromHash('#time=month-13')).toBeNull();
    expect(timeFromHash('#time=ago-12000')).toEqual({ mode: 'ago', ago: 12000 });
    expect(timeFromHash('#time=bogus-2000')).toBeNull();
    expect(hashWithTime('#layers=cables&time=month-1', { mode: 'years', set: 'cables', year: 1999, only: false })).toBe('#layers=cables&time=cables-1999');
    expect(hashWithTime('#time=month-1', null)).toBe('');
  });
  it('keeps new layer tokens in layers= without touching the overlay tests contract', () => {
    expect(layersFromHash('#layers=quakes,cables-osm,winds')).toEqual({ ids: ['cables'], allWrecks: false, osm: true, extra: ['quakes', 'winds'] });
    expect(hashWithLayers('', { ids: ['cables'], allWrecks: false, osm: true, extra: ['seamounts'] })).toBe('#layers=seamounts,cables-osm');
  });
  it('step speed: a sweep takes about 25 s but a year never flashes by', () => {
    expect(stepMs('years', 126)).toBe(250);
    expect(stepMs('years', 37)).toBeCloseTo(675.7, 0);
    expect(stepMs('years', 7)).toBe(900);
    expect(stepMs('months', 12)).toBe(900);
  });
  it('reads a year from free text', () => {
    expect(yearFromText('Q4 2027')).toBe(2027);
    expect(yearFromText('12/2020')).toBe(2020);
    expect(yearFromText('2018-05-01')).toBe(2018);
    expect(yearFromText('unknown')).toBeNull();
    expect(yearFromText(undefined)).toBeNull();
  });
});

describe('cables and wind farms by year', () => {
  it('counts in service and new, and filters on the property', () => {
    const feats = [{ properties: { rfs_year: 1999, length_km: 100 } }, { properties: { rfs_year: 2001, length_km: 50, planned: true } }, { properties: {} }];
    expect(cablesInService(feats, 2000)).toEqual({ cables: 1, km: 100, added: 0, planned: 0 });
    expect(cablesInService(feats, 2001)).toEqual({ cables: 2, km: 150, added: 1, planned: 1 });
    expect(windInService([{ properties: { start_year: 2010, capacity_mw: 300 } }, { properties: {} }], 2012)).toEqual({ farms: 1, mw: 300, added: 0, dated: 1 });
    expect(yearFilterOn('rfs_year', null)).toBeNull();
    expect(yearFilterOn('rfs_year', 2000)).toEqual(['all', ['has', 'rfs_year'], ['<=', ['get', 'rfs_year'], 2000]]);
  });
});

describe('sea level since the Last Glacial Maximum', () => {
  it('accepts several shapes and interpolates linearly', () => {
    const h = parseSeaHistory({ points: [{ years_bp: 20000, sea_level_m: -130, lo: -134, hi: -126 }, { years_bp: 0, sea_level_m: 0, lo: 0, hi: 0 }], lgm: { years_bp: 20000, sea_level_m: -130 } })!;
    expect(h.ago).toEqual([0, 20000]);
    expect(levelAtAgo(h, 10000)).toBe(-65);
    expect(levelAtAgo(h, 30000)).toBe(-130);
    expect(h.lo).toEqual([0, -134]);
    expect(h.lgm).toEqual({ ago: 20000, level: -130 });
    expect(parseSeaHistory({ ka: [0, 21], level_m: [0, -125] })!.ago).toEqual([0, 21000]);
    expect(parseSeaHistory({ nonsense: true })).toBeNull();
    expect(formatAgo(12000)).toBe('12,000 years ago');
    expect(formatAgo(0)).toBe('Today');
  });
  it('real file: LGM -134.3 m at 20.5 ka, 14.0 ka -86.9 m, today 0 (contract spot checks)', () => {
    if (!existsSync(pub('data/sea-level-history.json'))) return;
    const h = parseSeaHistory(JSON.parse(readFileSync(pub('data/sea-level-history.json'), 'utf8')))!;
    expect(h.ago.length).toBe(276);
    expect(levelAtAgo(h, 0)).toBe(0);
    expect(levelAtAgo(h, 14000)).toBeCloseTo(-86.9, 0);
    expect(h.lgm!.level).toBeCloseTo(-134.3, 1);
    expect(Math.min(...h.level)).toBeCloseTo(-134.3, 0);
  });
});

describe('mapping history', () => {
  it('recolours a tile: newly measured amber, earlier blue by first year, unmeasured veiled, land clear', () => {
    // pixels: land; ocean never measured; first 2019 and measured in 2022; first 2022; measured 2019-2020 then re-coded (code 119, bits 0-1)
    const src = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255, 19, 0b1111, 255, 255, 22, 0b1000, 0, 255, 119, 0b11, 0, 255]);
    const out = new Uint8ClampedArray(src.length);
    recolourHistory(src, out, 2022);
    expect(out[3]).toBe(0);
    expect([...out.slice(4, 8)]).toEqual(HISTORY_VEIL);
    expect(out[8]).toBeLessThan(120); // 2019: deepest blue, full share -> opaque
    expect(out[11]).toBe(255);
    expect([...out.slice(12, 15)]).toEqual(HISTORY_NEW);
    expect([...out.slice(16, 20)]).toEqual(HISTORY_VEIL); // not measured in 2022 any more
    recolourHistory(src, out, 2020);
    expect(out[19]).toBeGreaterThan(0);
    expect([...out.slice(16, 19)]).not.toEqual(HISTORY_VEIL.slice(0, 3));
  });
  it('real manifest: 2019 12.4 %, 2026 30.8 % vs 28.7 % announced', () => {
    if (!existsSync(pub('history/manifest.json'))) return;
    const m = parseMappingManifest(JSON.parse(readFileSync(pub('history/manifest.json'), 'utf8')))!;
    expect(m.years.map((y) => y.year)).toEqual([2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    const h = mappingHeadline(m, 2026);
    expect(h.main).toContain('30.8%');
    expect(h.main).toContain('28.7%');
    expect(h.sub).toMatch(/^6\.6 million km² newly measured since GEBCO_2025; 2\.5 million km²/);
    expect(mappingHeadline(m, 2019).main).toContain('12.4%');
    expect(parseMappingManifest({ stats: {} })).toBeNull();
  });
});

describe('loading meter', () => {
  it('shows only after the delay, counts within a burst, ends on idle', () => {
    let t = 0;
    const m = new LoadMeter(() => t, 300);
    m.start(); m.start(); m.start(); m.finish();
    expect(m.view()).toEqual({ visible: false, pct: 33, done: false });
    t = 320;
    expect(m.view().visible).toBe(true);
    m.finish(); m.finish(); m.finish();
    expect(m.pct).toBe(99); // never 100 % before the map says idle (aborted tiles never report)
    expect(m.end()).toBe(true);
    expect(m.view()).toEqual({ visible: false, pct: 100, done: true });
    expect(m.log[0]).toEqual({ ms: 320, shown: true, tiles: 3 });
    expect(m.end()).toBe(false);
    m.start();
    expect(m.started).toBe(1); // a new burst
    t = 400; m.end();
    expect(m.log[1].shown).toBe(false);
  });
});
