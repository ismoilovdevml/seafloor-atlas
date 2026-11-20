import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { amocCard, amocChartSvg, monthName, monthYear, runningMean, type AmocData } from '../src/amoc';
import { hashWithLayers, layersFromHash } from '../src/overlays';

const d: AmocData = JSON.parse(readFileSync('public/data/amoc.json', 'utf8'));

describe('AMOC at 26.5 N', () => {
  it('published file: 248 months from April 2004, mean about 17 Sv, heat about 1.2 PW, layers balance', () => {
    expect(d.months).toEqual({ first: '2004-04', last: '2024-11', n: 248 });
    expect(d.monthly.amoc).toHaveLength(248);
    expect(d.stats.mean_sv).toBeGreaterThan(16); expect(d.stats.mean_sv).toBeLessThan(18.5);
    expect(d.stats.heat_mean_pw).toBeGreaterThan(1.0); expect(d.stats.heat_mean_pw).toBeLessThan(1.4);
    const L = d.stats.layer_means_sv;
    // northward upper limb = Florida Current + Ekman + upper mid-ocean, and it is close to the AMOC itself
    expect(Math.abs(L.florida_current + L.ekman + L.upper_mid_ocean - d.stats.mean_sv)).toBeLessThan(0.5);
    expect(L.upper_deep).toBeLessThan(0); expect(L.lower_deep).toBeLessThan(0); expect(L.bottom).toBeGreaterThan(0);
  });
  it('running mean needs a full window without gaps', () => {
    expect(runningMean([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    expect(runningMean([1, null, 3, 4], 2)).toEqual([null, null, null, 3.5]);
  });
  it('dates: mid-month decimal years and month names', () => {
    expect(monthYear('2004-04', 0)).toBeCloseTo(2004 + 3.5 / 12, 9);
    expect(monthYear('2004-04', 9)).toBeCloseTo(2005 + 0.5 / 12, 9);
    expect(monthName('2009-12')).toBe('December 2009');
  });
  it('chart and card', () => {
    const svg = amocChartSvg(d);
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<path /g) ?? []).length).toBe(2);
    const c = amocCard(d);
    expect(c.name).toBe('AMOC at 26.5° N');
    expect(c.image?.src.startsWith('data:image/svg+xml')).toBe(true);
    expect(c.facts.find(([k]) => k === 'Below 5,000 m')?.[1]).toMatch(/^\+/);
    expect(c.facts.find(([k]) => k === '3,000–5,000 m')?.[1]).toMatch(/^−/);
    expect(c.source).toContain(d.doi);
  });
  it('deep link #layers=amoc round-trips', () => {
    expect(layersFromHash('#layers=amoc')?.extra).toEqual(['amoc']);
    expect(hashWithLayers('', { ids: [], extra: ['amoc'] } as never)).toBe('#layers=amoc');
  });
});
