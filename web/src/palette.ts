// Colour scales. The bathymetric ramp is a single-hue-family sequential ramp (pale shelf -> violet-black
// abyss, after cmocean "deep"), lightness strictly decreasing with depth so depth reads without a legend
// lookup. Its stops are dense near the surface because the shelf (0-200 m) is a tiny share of depth
// range but a large share of what people look at. Land is a muted, low-chroma grey so the ocean reads first.

/** [elevation m, colour]; elevation increasing (expression requirement). */
export const BATHY_STOPS: [number, string][] = [
  [-11000, '#140a22'],
  [-8000, '#21163b'],
  [-6500, '#2c2655'],
  [-5500, '#33386f'],
  [-4500, '#374f8a'],
  [-3500, '#3a689c'],
  [-2500, '#3f84a6'],
  [-1500, '#4c9fad'],
  [-700, '#62b8b1'],
  [-200, '#86ccb5'],
  [-50, '#b3dfbd'],
  [0, '#d4ecc6'],
];

export const LAND_STOPS: [number, string][] = [
  [0.01, '#33352f'],
  [400, '#3c3d37'],
  [1500, '#4a4a43'],
  [3500, '#5d5c54'],
  [6000, '#747168'],
];

/** MapLibre color-relief ramp over ['elevation'] for today's sea level. */
export function colorReliefExpression(): unknown[] {
  return seaLevelExpression(0);
}

// ---------- sea level ----------
// A changed sea level L is drawn by rebuilding the ramp: cells below L are water, coloured by their depth
// below L (the bathymetric ramp shifted by L); cells at or above L are land in the usual greys. Two tints
// make the change obvious: sea floor that is dry at L < 0 ("newly exposed"), and land that is under water
// at L > 0 ("flooded"). color-relief only accepts a linear interpolate over ['elevation'], so the hard
// coastline is a pair of stops SEA_EPS apart (MapLibre packs stops in the DEM encoding, 1/256 m steps).

/** Gap between the last water stop and the first land stop, metres. */
export const SEA_EPS = 0.05;
/** Newly exposed sea floor: muted sand, darker at the new coast, lighter toward today's coast. */
export const EXPOSED_LOW = '#6b5f45';
export const EXPOSED_HIGH = '#8c7b56';
/** Flooded land: a clearly bluer water than the teal-green shelf, so the old coastline stays visible. */
export const FLOODED_DEEP = '#4f86c6';
export const FLOODED_SHALLOW = '#93bfec';

type Rgb = [number, number, number];
function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}
/** Linear RGB-space interpolation of a stop list (what MapLibre does between ramp stops), clamped at the ends. */
export function rampColorAt(stops: [number, string][], h: number): string {
  if (h <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (h >= last[0]) return last[1];
  let i = 1;
  while (stops[i][0] < h) i++;
  const [h0, c0] = stops[i - 1], [h1, c1] = stops[i];
  const t = (h - h0) / (h1 - h0), a = hexToRgb(c0), b = hexToRgb(c1);
  return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

/**
 * Ramp stops for sea level L (metres, integer; L = 0 is today). Elevations strictly increase.
 * Water: elevation < L, colour = BATHY at (elevation - L). Land: elevation >= L, colour = LAND greys at the
 * cell's own elevation, except the tinted bands [L, 0) when L < 0 and [0, L) when L > 0.
 */
export function seaLevelStops(level: number): [number, string][] {
  const L = Math.round(level);
  const s: [number, string][] = [];
  const waterTop = Math.min(0, L) - SEA_EPS; // highest elevation that keeps its plain ocean colour
  // ocean (today's sea floor still under water): bathymetric ramp shifted down/up by L
  for (const [h, c] of BATHY_STOPS) if (h + L < waterTop) s.push([h + L, c]);
  s.push([waterTop, rampColorAt(BATHY_STOPS, waterTop - L)]);
  if (L > 0) {
    // flooded land, 0 <= elevation < L
    s.push([0, FLOODED_DEEP], [L - SEA_EPS, FLOODED_SHALLOW]);
  } else if (L < 0) {
    // newly exposed sea floor, L <= elevation < 0
    s.push([L, EXPOSED_LOW], [-SEA_EPS, EXPOSED_HIGH]);
  }
  // land above the new (or today's) coast, in the usual greys by absolute elevation
  const landFrom = Math.max(0, L);
  s.push([landFrom, rampColorAt(LAND_STOPS, landFrom)]);
  for (const [h, c] of LAND_STOPS) if (h > landFrom) s.push([h, c]);
  return s;
}

/** MapLibre color-relief ramp for sea level L. */
export function seaLevelExpression(level: number): unknown[] {
  const e: unknown[] = ['interpolate', ['linear'], ['elevation']];
  for (const [h, c] of seaLevelStops(level)) e.push(h, c);
  return e;
}

// ---------- under the ocean-water layer ----------
// While temperature / salinity / density are shown, the relief ramp drops its hue: the seafloor becomes a
// low-chroma slate (darker with depth) and land keeps its greys, so every hue on the globe belongs to the
// water layer, and seafloor that rises above the chosen depth (no water there) reads as plain rock.
export const UNDERLAY_STOPS: [number, string][] = [
  [-11000, '#0d131c'],
  [-6000, '#131b26'],
  [-4000, '#18222f'],
  [-2000, '#1f2a38'],
  [-500, '#283444'],
  [-0.05, '#303c4b'],
];
export function underlayExpression(): unknown[] {
  const e: unknown[] = ['interpolate', ['linear'], ['elevation']];
  for (const [h, c] of [...UNDERLAY_STOPS, ...LAND_STOPS]) e.push(h, c);
  return e;
}

/** Plate boundary classes as written by pipeline/plates.py (plus the contract's "trench" alias). */
export type PlateClass = 'ridge' | 'rift' | 'subduction' | 'transform' | 'convergent' | 'other';
export const PLATE_STYLE: Record<'ridge' | 'subduction' | 'transform' | 'convergent', { color: string; label: string; note: string }> = {
  ridge: { color: '#ff6a3d', label: 'Spreading ridge / rift', note: 'plates move apart, new seafloor forms' },
  subduction: { color: '#ffd84d', label: 'Subduction trench', note: 'one plate dives under another' },
  transform: { color: '#5cc8ff', label: 'Transform fault', note: 'plates slide past each other' },
  convergent: { color: '#d9d2c3', label: 'Other convergent', note: 'collision without a trench' },
};
/** match expression: PB2002 type -> colour. */
export function plateColorExpression(): unknown[] {
  return ['match', ['get', 'type'],
    ['ridge', 'rift'], PLATE_STYLE.ridge.color,
    ['subduction', 'trench'], PLATE_STYLE.subduction.color,
    'transform', PLATE_STYLE.transform.color,
    PLATE_STYLE.convergent.color];
}

/** Profile / measuring line: white so it never collides with a plate class colour. */
export const SURVEY_LINE = '#ffffff';

/**
 * One status scale for the point inspector: how the depth at a clicked point is known. The badge, the metric
 * tiles, the dot on the map and the legend all take their colour from here (main.ts copies them to --st-* CSS
 * variables), so a colour means the same thing everywhere.
 */
export const STATUS = {
  measured: { color: '#10b981', label: 'Measured by ship' },
  partly: { color: '#facc15', label: 'Partly measured' },
  near: { color: '#f97316', label: 'Estimated, survey nearby' },
  far: { color: '#ef4444', label: 'Estimated, no survey nearby' },
  land: { color: '#94a3b8', label: 'Land' },
} as const;
export type StatusKey = keyof typeof STATUS;
/** The ocean classes in order, best known first (legend order). */
export const STATUS_ORDER: StatusKey[] = ['measured', 'partly', 'near', 'far'];
