// Sea-level control: slider mapping, presets, hypsometry lookup and the #sea= deep link (no DOM, unit-tested
// in test/sealevel.test.ts).
//
// The slider is two joined scales so the range people care about gets fine control:
//   positions 0 .. KNEE_POS          : -6,000 m .. -200 m, logarithmic in depth (each step ~1.4 % deeper)
//   positions KNEE_POS .. SLIDER_MAX : -200 m .. +100 m, linear, exactly 1 m per step
// so -200..+100 m takes 300 of 545 steps (55 % of the track) and every preset sits on the track.

export const SEA_MIN = -6000;
export const SEA_MAX = 100;
export const KNEE_LEVEL = -200;
const LINEAR_STEPS = SEA_MAX - KNEE_LEVEL; // 300, 1 m each
export const KNEE_POS = 245;
export const SLIDER_MAX = KNEE_POS + LINEAR_STEPS; // 545
const LOG_SPAN = Math.log(SEA_MIN / KNEE_LEVEL); // ln 30

/** Round a level the way the slider shows it: whole metres down to -1,000 m, then 10 m steps. */
export function snapLevel(level: number): number {
  const L = Math.min(SEA_MAX, Math.max(SEA_MIN, level));
  return L < -1000 ? Math.round(L / 10) * 10 : Math.round(L);
}

/** Slider position (0..SLIDER_MAX, may be fractional) -> sea level in metres (not snapped). */
export function posToLevel(pos: number): number {
  const p = Math.min(SLIDER_MAX, Math.max(0, pos));
  if (p >= KNEE_POS) return KNEE_LEVEL + (p - KNEE_POS);
  return KNEE_LEVEL * Math.exp(((KNEE_POS - p) / KNEE_POS) * LOG_SPAN);
}

/** Sea level in metres -> slider position (inverse of posToLevel). */
export function levelToPos(level: number): number {
  const L = Math.min(SEA_MAX, Math.max(SEA_MIN, level));
  if (L >= KNEE_LEVEL) return KNEE_POS + (L - KNEE_LEVEL);
  return KNEE_POS - (KNEE_POS * Math.log(L / KNEE_LEVEL)) / LOG_SPAN;
}

export interface Preset { level: number; name: string; note: string }
/** Conservative one-liners; the caveats (1' cell means, ice surface, no isostasy) are in the footnote. */
export const PRESETS: Preset[] = [
  { level: 0, name: 'Today', note: 'Today’s coastline in the GEBCO 2026 grid.' },
  { level: -120, name: 'Ice age', note: 'Last Glacial Maximum, about 20,000 years ago: Beringia joins Asia to America, Sundaland and Sahul are dry land, and Doggerland links Britain to Europe.' },
  { level: -2500, name: 'Ridges emerge', note: 'The crests of the mid-ocean ridges break the surface in many places, as broken chains of islands along the ridges.' },
  { level: -6000, name: 'Trenches only', note: 'Almost all of the sea floor is dry; only the trenches and a few of the deepest basins still hold water.' },
  { level: 1, name: '+1 m', note: 'Low coasts and river deltas start to flood. At this grid’s ~2 km cells and whole-metre heights, 1 m is only roughly resolved.' },
  { level: 10, name: '+10 m', note: 'Low deltas and coastal plains go under: much of the Netherlands and the Ganges–Brahmaputra and Mekong deltas.' },
  { level: 70, name: 'No land ice', note: 'About 70 m: roughly the rise if all ice on land melted, which would take many thousands of years.' },
];
export const presetFor = (level: number) => PRESETS.find((p) => p.level === level);

export interface Hypsometry { earth_km2: number; today_km2: number; levels_m: number[]; land_km2: number[] }

/** Area (km²) of the surface at or above level L, linear between tabulated levels; clamped at the ends. */
export function landAreaAt(h: Hypsometry, level: number): number {
  const xs = h.levels_m, ys = h.land_km2;
  if (level <= xs[0]) return ys[0];
  if (level >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= level) lo = m; else hi = m; }
  const t = (level - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** "+1,234 m" / "−120 m" / "0 m" with a true minus sign. */
export function formatLevel(level: number): string {
  const r = Math.round(level);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toLocaleString('en-US')} m`;
}

/** Reads `sea=<metres>` from a hash like `#sea=-120` or `#story=x&sea=10`; null when absent or invalid. */
export function seaFromHash(hash: string): number | null {
  const m = /(?:^#|[#&])sea=(-?\d+(?:\.\d+)?)(?:&|$)/.exec(hash);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? snapLevel(v) : null;
}

/** Writes or removes the sea= part of a hash, keeping other parts (story=...). */
export function hashWithSea(hash: string, level: number | null): string {
  const parts = hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith('sea='));
  if (level !== null && level !== 0) parts.push(`sea=${level}`);
  return parts.length ? `#${parts.join('&')}` : '';
}
