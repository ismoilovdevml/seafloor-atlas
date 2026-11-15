import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { depthClass, fmtUtc, liveToGeoJSON, opacityExpression, pulseEvents, quakeCard, quakesToGeoJSON, yearFilter, yearStats, type QuakeColumns } from '../src/quakes';
import { heightFilter, isMeasuredTid, seamountCard, seamountShares, seamountsToGeoJSON, type SeamountColumns } from '../src/seamounts';

const pub = (p: string) => new URL(`../public/${p}`, import.meta.url);
const quakes: QuakeColumns | null = existsSync(pub('data/quakes.json')) ? JSON.parse(readFileSync(pub('data/quakes.json'), 'utf8')) : null;
const seamounts: SeamountColumns | null = existsSync(pub('data/seamounts.json')) ? JSON.parse(readFileSync(pub('data/seamounts.json'), 'utf8')) : null;

describe('earthquakes', () => {
  const tiny: QuakeColumns = {
    metadata: { attribution: 'x', minmag: 5.5, count: 3, first: '', newest: '' }, n: 3,
    lon: [95.98, 142.37, 10], lat: [3.29, 38.3, 0], time: [1104022733450, 1299822384120, Date.UTC(2004, 5, 1)], mag: [9.1, 9.1, 5.6], depth_km: [30, 29, null],
    id: ['a', 'b', 'c'], place: ['Sumatra', 'Tohoku', 'Nowhere'],
  };
  it('zips the columns into features with year and depth (-1 = unknown)', () => {
    const fc = quakesToGeoJSON(tiny);
    expect(fc.features[0].properties).toMatchObject({ mag: 9.1, depth: 30, year: 2004, id: 'a' });
    expect(fc.features[2].properties.depth).toBe(-1);
    const s = yearStats(fc, 2000, 2012);
    expect(s.count[4]).toBe(2);
    expect(s.cum[11]).toBe(3);
    expect(s.biggest[4]?.place).toBe('Sumatra');
    expect(pulseEvents(fc, 2004).features.length).toBe(1);
  });
  it('year filter: cumulative or that year only; opacity fades earlier years', () => {
    expect(yearFilter(null, true)).toBeNull();
    expect(yearFilter(2004, true)).toEqual(['<=', ['get', 'year'], 2004]);
    expect(yearFilter(2004, false)).toEqual(['==', ['get', 'year'], 2004]);
    expect(JSON.stringify(opacityExpression(2004, true, false))).toContain('2004');
  });
  it('converts the live USGS feed, depth from the third coordinate', () => {
    const fc = liveToGeoJSON({ type: 'FeatureCollection', features: [
      { type: 'Feature', id: 'us7000abcd', geometry: { type: 'Point', coordinates: [140, 35, 42.5] }, properties: { mag: 4.6, time: 1763000000000, place: '10 km E of X' } },
      { type: 'Feature', id: 'bad', geometry: { type: 'Point', coordinates: [0, 0, 1] }, properties: { mag: null, time: 1 } },
    ] });
    expect(fc.features.length).toBe(1);
    expect(fc.features[0].properties).toMatchObject({ mag: 4.6, depth: 43, id: 'us7000abcd', live: true });
  });
  it('card: place, magnitude, depth class, UTC time and the USGS event link', () => {
    const c = quakeCard(quakesToGeoJSON(tiny).features[0].properties, 95.98, 3.29);
    expect(c.name).toBe('Sumatra');
    expect(c.lead).toBe('Magnitude 9.1, 30 km deep (shallow)');
    expect(c.facts[0][1]).toBe('26 December 2004, 00:58 UTC');
    expect(c.links[0].href).toBe('https://earthquake.usgs.gov/earthquakes/eventpage/a');
    expect(depthClass(450)).toBe('deep');
    expect(fmtUtc(0)).toBe('1 January 1970, 00:00 UTC');
  });
  it('real catalogue: 39,650 events M >= 5.5, Valdivia first, 2004 Sumatra in its year', () => {
    if (!quakes) return;
    const fc = quakesToGeoJSON(quakes);
    expect(fc.features.length).toBe(quakes.metadata.count);
    expect(fc.features[0].properties).toMatchObject({ mag: 9.5, year: 1960 });
    const s = yearStats(fc, 1900, 2026);
    expect(s.biggest[2004 - 1900]?.mag).toBe(9.1);
    expect(s.cum[s.cum.length - 1]).toBe(quakes.n);
  });
});

describe('seamounts', () => {
  it('measured = GEBCO type 10-17; zoom-stepped height filter', () => {
    expect([10, 11, 17, 40, 0].map(isMeasuredTid)).toEqual([true, true, true, false, false]);
    const f = heightFilter() as unknown[];
    expect(f[0]).toBe('step');
    expect(f[f.length - 1]).toBe(true);
  });
  it('card text: summit above sea level, measured or predicted, catalogue ids', () => {
    const c = seamountCard({ h: 4520, bd: 4500, sd: -29, tid: 0, m: 0, src: 0, cat: 'KW-123', sid: 77, name: 'Vema Seamount' });
    expect(c.lead).toBe('4,520 m tall, summit 29 m above sea level in the grid');
    expect(c.facts[0][1]).toMatch(/^No: land in the grid/);
    expect(c.facts[2][1]).toBe('SDUST2026SM no. 77; Kim & Wessel 2011 KW-123');
    const d = seamountCard({ h: 900, bd: 3000, sd: 2100, tid: 11, m: 1, src: 1, cat: 'SIO-5', sid: 0, name: '' });
    expect(d.name).toBe('Unnamed seamount');
    expect(d.facts[0][1]).toMatch(/^Yes: .*multibeam/);
  });
  it('real catalogue: 69,770 seamounts, 34.2 % summits measured, 2.7 % named (contract)', () => {
    if (!seamounts) return;
    const s = seamountShares(seamounts);
    expect(s.n).toBe(69770);
    expect(+(100 * s.measured / s.n).toFixed(1)).toBe(34.2);
    expect(+(100 * s.named / s.n).toFixed(1)).toBe(2.7);
    expect(seamountsToGeoJSON(seamounts).features[0].properties.name).toBe('Mona Seamount');
  });
});
