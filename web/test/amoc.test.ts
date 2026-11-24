import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AMOC_CHART, amocCard, amocChartSvg, depthLayers, monthName, monthYear, runningMean, type AmocData } from '../src/amoc';
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
    // even window: centred 2 x 2 filter, weights 0.5, 1, 0.5 over 3 values
    expect(runningMean([1, 2, 3, 4], 2)).toEqual([null, 2, 3, null]);
    expect(runningMean([1, null, 3, 4, 5], 2)).toEqual([null, null, null, 4, null]);
    // odd window: plain centred mean
    expect(runningMean([1, 2, 3, 4, 5], 3)).toEqual([null, 2, 3, 4, null]);
  });
  it('12-month mean is the centred 2 x 12 filter (13 values, half weight at the ends)', () => {
    const v = Array.from({ length: 40 }, (_, i) => i * i);
    const r = runningMean(v);
    expect(r.slice(0, 6).every((x) => x === null) && r.slice(-6).every((x) => x === null)).toBe(true);
    expect(r[6]).not.toBeNull();
    for (const i of [6, 20, 33]) {
      let s = 0.5 * v[i - 6] + 0.5 * v[i + 6];
      for (let j = i - 5; j <= i + 5; j++) s += v[j];
      expect(r[i]).toBeCloseTo(s / 12, 9);
    }
    // centred: a linear trend comes back unshifted, and a pure annual cycle is removed
    const lin = runningMean(Array.from({ length: 30 }, (_, i) => 2 * i + 1));
    expect(lin[15]).toBeCloseTo(31, 9);
    const cyc = runningMean(Array.from({ length: 48 }, (_, i) => 10 + 3 * Math.sin((2 * Math.PI * i) / 12)));
    for (let i = 6; i < 42; i++) expect(cyc[i]).toBeCloseTo(10, 9);
  });
  it('depth layers are RAPID fixed-depth classes and balance to zero', () => {
    const L = d.stats.layer_means_sv;
    const rows = depthLayers(L);
    expect(rows.map(([k]) => k)).toEqual(['0–1,100 m', '1,100–3,000 m', '3,000–5,000 m', 'Below 5,000 m']);
    expect(rows[0][1]).toBeCloseTo(L.thermocline + L.intermediate, 9);
    expect(Math.abs(rows.reduce((s, [, x]) => s + x, 0))).toBeLessThan(0.02);
    // the card shows the thermocline + intermediate sum, not Florida Current + Ekman + UMO (which reaches the
    // time-varying depth of the overturning maximum, not a fixed 1,100 m)
    expect(amocCard(d).facts.find(([k]) => k === '0–1,100 m')?.[1]).toBe(`+${(L.thermocline + L.intermediate).toFixed(1)} Sv`);
    // the monthly fixed-depth layers balance every month too
    const m = d.monthly;
    for (let i = 0; i < d.months.n; i++) {
      const s = ['thermocline', 'intermediate', 'upper_deep', 'lower_deep', 'bottom'].reduce((a, k) => a + (m[k][i] as number), 0);
      expect(Math.abs(s)).toBeLessThan(0.06);
    }
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
  it('chart labels stay readable where the card shows the image ~290 px wide (375 px phone)', () => {
    const svg = amocChartSvg(d);
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"[^>]*font-size="([\d.]+)"/);
    expect(m).not.toBeNull();
    const [w, font] = [Number(m![1]), Number(m![3])];
    expect([w, font]).toEqual([AMOC_CHART.w, AMOC_CHART.font]);
    expect((font * 290) / w).toBeGreaterThanOrEqual(9.9);   // rendered px on a phone
  });
  it('deep link #layers=amoc round-trips', () => {
    expect(layersFromHash('#layers=amoc')?.extra).toEqual(['amoc']);
    expect(hashWithLayers('', { ids: [], extra: ['amoc'] } as never)).toBe('#layers=amoc');
  });
});
