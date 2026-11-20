// The Time panel's model, no DOM (test/timeline.test.ts): three modes, one at a time.
//   years     one year drives every year-aware layer on the map (earthquakes, cables, wind farms, mapping
//             progress); the "followed" set picks the slider's range and the headline numbers
//   months    one month drives ocean surface temperature, phytoplankton, winds and currents together
//   ago       years before present since the Last Glacial Maximum drive the sea-level shading
// Deep link: #time=quakes-2004 (add -only for that year alone), #time=cables-1999, #time=month-7, #time=ago-12000.

export type TimeMode = 'years' | 'months' | 'ago';
export type YearSet = 'quakes' | 'cables' | 'wind' | 'mapping';
export const YEAR_SETS: YearSet[] = ['quakes', 'cables', 'wind', 'mapping'];
export const YEAR_SET_LABEL: Record<YearSet, string> = { quakes: 'Earthquakes', cables: 'Internet cables', wind: 'Offshore wind', mapping: 'Seafloor mapping' };

export type TimeState =
  | { mode: 'years'; set: YearSet; year: number; only: boolean }
  | { mode: 'months'; month: number }
  | { mode: 'ago'; ago: number };

export const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function timeFromHash(hash: string): TimeState | null {
  const m = /(?:^#|[#&])time=([a-z]+)-(\d+)(-only)?(?:&|$)/.exec(hash);
  if (!m) return null;
  const v = Number(m[2]);
  if (m[1] === 'month') return v >= 1 && v <= 12 ? { mode: 'months', month: v } : null;
  if (m[1] === 'ago') return v <= 100000 ? { mode: 'ago', ago: v } : null;
  if ((YEAR_SETS as string[]).includes(m[1]) && v >= 1800 && v <= 2100) return { mode: 'years', set: m[1] as YearSet, year: v, only: !!m[3] };
  return null;
}
export function timeToken(s: TimeState): string {
  if (s.mode === 'months') return `month-${s.month}`;
  if (s.mode === 'ago') return `ago-${Math.round(s.ago)}`;
  return `${s.set}-${s.year}${s.only ? '-only' : ''}`;
}
/** Writes or removes the time= part, keeping the other parts in order. */
export function hashWithTime(hash: string, s: TimeState | null): string {
  const parts = hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith('time='));
  if (s) parts.push(`time=${timeToken(s)}`);
  return parts.length ? `#${parts.join('&')}` : '';
}

/** Milliseconds per step at 1x: a full sweep of a year range takes about 25 s, but a year never flashes by. */
export function stepMs(mode: TimeMode, span: number): number {
  if (mode === 'months') return 900;
  if (mode === 'ago') return 90;
  return Math.max(250, Math.min(900, 25000 / Math.max(1, span)));
}
export const SPEEDS = [0.5, 1, 2, 4];

/** First plausible year in free text ('2018-05', 'Q4 2027', '12/2020', 'c. 1999'); null if none. */
export function yearFromText(s: unknown): number | null {
  const m = typeof s === 'string' ? /(?:^|\D)((?:18|19|20)\d{2})(?!\d)/.exec(s) : null;
  return m ? Number(m[1]) : null;
}

// ---------- sea level since the Last Glacial Maximum (data/sea-level-history.json) ----------
export interface SeaHistory { ago: number[]; level: number[]; lo?: number[]; hi?: number[]; lgm?: { ago: number; level: number }; source?: string; attribution?: string; note?: string }
/**
 * Accepts the shapes a pipeline is likely to write: {years_ago: [], level_m: []} (also sea_level_m / rsl_m /
 * level), {series: [{years_ago | ka | age, level_m | sea_level_m | rsl_m}]}, or a bare array of such points.
 * Ages in ka (`ka` field or `units: "ka"`) become years. Sorted youngest first; null when unusable.
 */
export function parseSeaHistory(j: unknown): SeaHistory | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
  let ago: number[] = [], level: number[] = [];
  const pickLevel = (p: Record<string, unknown>) => num(p.level_m ?? p.sea_level_m ?? p.rsl_m ?? p.level ?? p.m);
  const pickAge = (p: Record<string, unknown>) => ('ka' in p ? num(p.ka) * 1000 : 'kyr' in p ? num(p.kyr) * 1000 : num(p.years_bp ?? p.years_ago ?? p.age ?? p.yearsAgo ?? p.year_bp ?? p.bp));
  const band: [number, number, number][] = [];
  const arr = Array.isArray(j) ? j : Array.isArray(o.series) ? o.series : Array.isArray(o.points) ? o.points : null;
  if (arr) {
    for (const p of arr as Record<string, unknown>[]) { ago.push(pickAge(p)); level.push(pickLevel(p)); band.push([pickAge(p), num(p.lo), num(p.hi)]); }
  } else {
    const a = (o.years_ago ?? o.age ?? o.ka) as unknown[] | undefined, l = (o.level_m ?? o.sea_level_m ?? o.rsl_m ?? o.level) as unknown[] | undefined;
    if (!Array.isArray(a) || !Array.isArray(l) || a.length !== l.length) return null;
    const k = 'ka' in o && !('years_ago' in o) ? 1000 : o.units === 'ka' ? 1000 : 1;
    ago = a.map((x) => num(x) * k); level = l.map(num);
  }
  const pts = ago.map((a, i) => [a, level[i]]).filter(([a, l]) => Number.isFinite(a) && Number.isFinite(l) && a >= 0).sort((x, y) => x[0] - y[0]);
  if (pts.length < 2) return null;
  const bands = band.filter(([a, l, h]) => Number.isFinite(a) && Number.isFinite(l) && Number.isFinite(h)).sort((x, y) => x[0] - y[0]);
  const lgmRaw = o.lgm as Record<string, unknown> | undefined;
  const lgm = lgmRaw ? { ago: pickAge(lgmRaw), level: pickLevel(lgmRaw) } : undefined;
  return {
    ago: pts.map((p) => p[0]), level: pts.map((p) => p[1]),
    ...(bands.length === pts.length ? { lo: bands.map((b) => b[1]), hi: bands.map((b) => b[2]) } : {}),
    ...(lgm && Number.isFinite(lgm.ago) && Number.isFinite(lgm.level) ? { lgm } : {}),
    source: typeof o.source === 'string' ? o.source : undefined,
    attribution: typeof o.attribution === 'string' ? o.attribution : undefined,
    note: typeof o.note === 'string' ? o.note : undefined,
  };
}
/** Sea level (m, relative to today) at `ago` years before present, linear between points, clamped at the ends. */
export function levelAtAgo(h: SeaHistory, ago: number): number {
  const xs = h.ago, ys = h.level;
  if (ago <= xs[0]) return ys[0];
  if (ago >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= ago) lo = m; else hi = m; }
  return ys[lo] + ((ago - xs[lo]) / (xs[hi] - xs[lo])) * (ys[hi] - ys[lo]);
}
export function formatAgo(years: number): string {
  const y = Math.round(years);
  return y <= 0 ? 'Today' : `${y.toLocaleString('en-US')} years ago`;
}

// ---------- seafloor mapping progress (web/public/history/, pipeline/history.py) ----------
export interface MappingYear {
  year: number; measured_frac: number; measured_km2: number; ever_measured_frac?: number;
  new_vs_previous_km2: number | null; no_longer_measured_vs_previous_km2: number | null;
  official_percent?: number; official_date?: string; official_url?: string;
}
export interface MappingManifest { years: MappingYear[]; oceanKm2: number; attribution: string; tiles: { minzoom: number; maxzoom: number } }
/** The manifest's per-release statistics; null when the file is missing or unfinished. */
export function parseMappingManifest(j: unknown): MappingManifest | null {
  const o = j as { stats?: { years?: MappingYear[]; ocean_km2?: number }; attribution?: string; tiles?: { minzoom?: number; maxzoom?: number } } | null;
  const ys = o?.stats?.years;
  if (!Array.isArray(ys) || !ys.length || !ys.every((y) => Number.isInteger(y.year) && Number.isFinite(y.measured_frac))) return null;
  return {
    years: [...ys].sort((a, b) => a.year - b.year), oceanKm2: o!.stats!.ocean_km2 ?? NaN,
    attribution: o!.attribution ?? 'GEBCO Compilation Group',
    tiles: { minzoom: o!.tiles?.minzoom ?? 0, maxzoom: o!.tiles?.maxzoom ?? 5 },
  };
}
/** Headline for one release: our share, the official Seabed 2030 figure, and what changed since the last one. */
export function mappingHeadline(m: MappingManifest, year: number): { main: string; sub: string } {
  const y = m.years.find((x) => x.year === year) ?? m.years[m.years.length - 1];
  const pc = (f: number) => `${(100 * f).toFixed(1)}%`;
  const mk = (km2: number) => `${(km2 / 1e6).toFixed(1)} million km²`;
  const main = `<strong>${pc(y.measured_frac)}</strong> of the ocean floor directly measured in GEBCO_${y.year}`
    + (y.official_percent != null ? ` (Seabed 2030 announced ${y.official_percent}%)` : '');
  const sub = y.new_vs_previous_km2 != null
    ? `${mk(y.new_vs_previous_km2)} newly measured since GEBCO_${y.year - 1}${y.no_longer_measured_vs_previous_km2 ? `; ${mk(y.no_longer_measured_vs_previous_km2)} re-coded as estimated` : ''}.`
    : 'The first release with a type identifier grid in this series.';
  return { main, sub };
}

/**
 * History tile pixel (R = first-measured code, G = bitmask of releases measured, bit 0 = 2019, B = 2026
 * measured share, A = ocean) -> colour for release `year`:
 *   newly measured in that release          amber, full
 *   measured, first measured in an earlier release   cool ramp by first year (earlier = deeper blue)
 *   ocean not measured in that release      dark veil (the depth there is estimated)
 * Opacity of lit pixels follows the 2026 share (B) so coarse zooms do not glow wherever one track passes.
 */
export const HISTORY_NEW = [255, 201, 92];
export const HISTORY_OLD: [number, number, number][] = [[58, 132, 186], [84, 166, 205], [118, 196, 222], [160, 222, 236], [196, 238, 244], [214, 244, 246], [226, 248, 248]];
export const HISTORY_VEIL = [8, 14, 26, 150];
export function recolourHistory(src: Uint8ClampedArray, out: Uint8ClampedArray, year: number): void {
  const bit = 1 << (year - 2019);
  for (let p = 0; p < src.length; p += 4) {
    if (src[p + 3] < 128) { out[p + 3] = 0; continue; }
    if (!(src[p + 1] & bit)) { out[p] = HISTORY_VEIL[0]; out[p + 1] = HISTORY_VEIL[1]; out[p + 2] = HISTORY_VEIL[2]; out[p + 3] = HISTORY_VEIL[3]; continue; }
    const code = src[p], first = 2000 + (code >= 100 ? code - 100 : code), isNew = year > 2019 && first >= year;
    // at coarse zooms one track lights a whole pixel: opacity follows the measured share of the pixel (2026),
    // with a floor so a single track (or a cell measured then but re-coded since) stays visible
    const share = Math.sqrt(src[p + 2] / 255);
    const a = Math.round(255 * Math.max(isNew ? 0.5 : 0.22, share));
    const c = isNew ? HISTORY_NEW : HISTORY_OLD[Math.max(0, Math.min(HISTORY_OLD.length - 1, first - 2019))];
    out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2]; out[p + 3] = a;
  }
}
