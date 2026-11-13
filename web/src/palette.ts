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

/** MapLibre color-relief ramp over ['elevation']. */
export function colorReliefExpression(): unknown[] {
  const e: unknown[] = ['interpolate', ['linear'], ['elevation']];
  for (const [h, c] of [...BATHY_STOPS, ...LAND_STOPS]) e.push(h, c);
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
