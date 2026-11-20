// AMOC at 26.5° N (RAPID-MOCHA-WBTS, data/amoc.json written by pipeline/amoc.py): the array's line on the globe and a
// card with the monthly overturning strength since 2004 (drawn as an SVG image) and how it splits by depth.
// No DOM here, so it is unit-tested in test/amoc.test.ts.
import type { CardModel } from './overlays';

export interface AmocData {
  doi: string; citation: string; licence: string;
  line: { coordinates: [number, number][]; note: string };
  months: { first: string; last: string; n: number };
  monthly: Record<string, (number | null)[]> & { amoc: (number | null)[] };
  layer_labels: Record<string, string>;
  stats: {
    mean_sv: number; sd_sv: number; n_months: number; heat_mean_pw: number;
    min: { sv: number; month: string }; max: { sv: number; month: string };
    annual: { year: number; mean: number }[];
    layer_means_sv: Record<string, number>;
  };
}

/** Centred running mean over `w` values; null where the window is not full or holds a gap. */
export function runningMean(v: (number | null)[], w = 12): (number | null)[] {
  const h = Math.floor(w / 2);
  return v.map((_, i) => {
    const a = i - h, b = a + w;
    if (a < 0 || b > v.length) return null;
    let s = 0;
    for (let j = a; j < b; j++) { const x = v[j]; if (x === null || !Number.isFinite(x)) return null; s += x; }
    return s / w;
  });
}

/** Decimal year of month index i counted from "YYYY-MM" (mid-month). */
export function monthYear(first: string, i: number): number {
  const [y, m] = first.split('-').map(Number);
  return y + (m - 1 + i + 0.5) / 12;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
export const shortMonth = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1].slice(0, 3)} ${y}`; };

/** Line chart of the monthly AMOC (thin) and its 12-month running mean (thick), 0-30 Sv. Returns SVG markup. */
export function amocChartSvg(d: AmocData, w = 560, h = 230): string {
  const M = { l: 40, r: 12, t: 14, b: 26 }, pw = w - M.l - M.r, ph = h - M.t - M.b;
  const v = d.monthly.amoc, n = v.length;
  const y0 = monthYear(d.months.first, 0), y1 = monthYear(d.months.first, n - 1);
  const X = (t: number) => M.l + ((t - y0) / (y1 - y0)) * pw, Y = (s: number) => M.t + ph - (Math.max(0, Math.min(30, s)) / 30) * ph;
  const path = (vals: (number | null)[]) => {
    let out = '', pen = false;
    vals.forEach((s, i) => {
      if (s === null || !Number.isFinite(s)) { pen = false; return; }
      out += `${pen ? 'L' : 'M'}${X(monthYear(d.months.first, i)).toFixed(1)},${Y(s).toFixed(1)}`; pen = true;
    });
    return out;
  };
  const grid = [0, 10, 20, 30].map((s) => `<line x1="${M.l}" x2="${w - M.r}" y1="${Y(s)}" y2="${Y(s)}" stroke="#2a3a52" stroke-width="1"/><text x="${M.l - 6}" y="${Y(s) + 4}" text-anchor="end">${s}</text>`).join('');
  const years: number[] = [];
  for (let y = Math.ceil(y0 / 5) * 5; y <= y1; y += 5) years.push(y);
  const xt = years.map((y) => `<line x1="${X(y)}" x2="${X(y)}" y1="${M.t + ph}" y2="${M.t + ph + 4}" stroke="#8a9ea8"/><text x="${X(y)}" y="${h - 8}" text-anchor="middle">${y}</text>`).join('');
  const mean = d.stats.mean_sv;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="system-ui, sans-serif" font-size="11" fill="#b0c1c9">`
    + `<rect width="${w}" height="${h}" fill="#0b1626"/>${grid}${xt}`
    + `<text x="${M.l}" y="${M.t - 3}" fill="#8a9ea8">Sv (million m³/s), northward</text>`
    + `<line x1="${M.l}" x2="${w - M.r}" y1="${Y(mean)}" y2="${Y(mean)}" stroke="#a8e0c2" stroke-dasharray="4 4" stroke-width="1"/>`
    + `<path d="${path(v)}" fill="none" stroke="#5c7fb3" stroke-width="1"/>`
    + `<path d="${path(runningMean(v))}" fill="none" stroke="#e6eef0" stroke-width="2.2" stroke-linejoin="round"/>`
    + `</svg>`;
}

const sv = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)} Sv`;

export function amocCard(d: AmocData): CardModel {
  const s = d.stats, L = s.layer_means_sv;
  const upper = L.florida_current + L.ekman + L.upper_mid_ocean;
  const svg = amocChartSvg(d);
  return {
    kind: 'Ocean circulation, measured',
    name: 'AMOC at 26.5° N',
    lead: `The Atlantic overturning moved ${s.mean_sv.toFixed(1)} million m³ of water per second northward on average, `
      + `${monthName(d.months.first)} to ${monthName(d.months.last)}: warm water north near the surface, cold water back south at depth.`,
    facts: [
      ['Mean', `${s.mean_sv.toFixed(1)} Sv, ±${s.sd_sv.toFixed(1)} month to month`],
      ['Weakest month', `${s.min.sv.toFixed(1)} Sv, ${shortMonth(s.min.month)}`],
      ['Strongest month', `${s.max.sv.toFixed(1)} Sv, ${shortMonth(s.max.month)}`],
      ['Heat carried north', `${s.heat_mean_pw.toFixed(2)} PW`],
      ['0–1,100 m', sv(upper)],
      ['1,100–3,000 m', sv(L.upper_deep)],
      ['3,000–5,000 m', sv(L.lower_deep)],
      ['Below 5,000 m', sv(L.bottom)],
    ],
    links: [{ label: 'Data: BODC', href: `https://doi.org/${d.doi}` }, { label: 'RAPID project', href: 'https://rapid.ac.uk/' }],
    image: { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, alt: `Monthly AMOC at 26.5° N, ${d.months.first} to ${d.months.last}, with a 12-month running mean around ${s.mean_sv.toFixed(1)} Sv`, credit: 'Thin: monthly; thick: 12-month running mean; dashed: long-term mean' },
    note: 'By depth (positive = north): the Gulf Stream, the wind-driven layer and the gyre carry water north in the top 1,100 m; North Atlantic Deep Water returns south below; Antarctic Bottom Water creeps north along the floor. Measured by moorings from Florida and the Bahamas to Africa (the line on the globe is approximate). 1 Sv = a million m³ per second, about five Amazons.',
    source: `RAPID-MOCHA-WBTS v2024-2, ${d.licence} (doi:${d.doi})`,
  };
}
