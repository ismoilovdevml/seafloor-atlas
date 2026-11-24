// Point inspector helpers that main.ts adds on top of inspect.ts: the nearest-survey search radius capped near the
// poles, the true reason when the SWOT confidence raster has no class for a point, an unknown measured share when
// the DEM tile is missing, and inland basins below sea level. Pure functions (unit-tested without tiles or a map).
import { SEARCH_KM, formatNearest, pixelKm, searchRadiusPx } from './inspect';

/**
 * Widest search window (pixels from the point) for the nearest measured cell. Near the poles the Mercator pixels
 * shrink, and SEARCH_KM spans thousands of pixels: at 85 degrees one click loaded 18-50 tiles and scanned millions of
 * pixels. 384 px keeps the window inside 3 x 3 tiles of 512 px.
 */
export const SEARCH_CAP_PX = 384;

/** Search radius (km) at this latitude: SEARCH_KM, or less where SEARCH_KM would need more than capPx pixels. */
export function searchKm(lat: number, z: number, tileSize: number, capPx = SEARCH_CAP_PX): number {
  if (searchRadiusPx(lat, z, tileSize, SEARCH_KM) <= capPx + 1) return SEARCH_KM;
  // the window is sized with the pixel width at its poleward edge (inspect.searchRadiusPx): start from the radius
  // that fits at that edge, then shrink until the window really fits
  let km = Math.floor(capPx * pixelKm(Math.min(85.05, Math.abs(lat) + SEARCH_KM / 111.2), z, tileSize));
  while (km > 1 && searchRadiusPx(lat, z, tileSize, km) > capPx + 1) km--;
  return Math.max(1, km);
}

/** formatNearest with the radius that was really searched ("> 80 km" instead of "> 200 km" near the poles). */
export function nearestText(km: number | null, radiusKm: number, short = false): string {
  if (km !== null || radiusKm >= SEARCH_KM) return formatNearest(km, short);
  return short ? `> ${radiusKm} km` : `over ${radiusKm} km`;
}

/** inspect.verdict's "far" sentence, for a search shorter than SEARCH_KM; null when the radius was not capped. */
export function farVerdictCapped(nearestKm: number | null, radiusKm: number): string | null {
  if (nearestKm !== null || radiusKm >= SEARCH_KM) return null;
  return `No ship has sounded anywhere within ${radiusKm} km (this close to the pole the search reaches no further). The depth is estimated from satellite gravity, which shows only broad shapes: hills and small seamounts can be missing.`;
}

/**
 * The measured fraction as shown: sampler.sample reads an alpha of 0 with a DEM height below 0 as "fully measured";
 * without the DEM (tile failed, height NaN) that alpha may as well be land, so the share is unknown (NaN).
 */
export function shownFraction(f: number | null, h: number): number | null {
  return f === 1 && !Number.isFinite(h) ? NaN : f;
}

/** SWOT confidence raster stops at 80 degrees (pipeline: transparent beyond 80 deg). */
export const SWOT_MAX_LAT = 80;

/**
 * Text for the "SWOT model confidence" row. alpha: the raster's alpha at the point, null when its tile could not be
 * loaded; label: the class label for that alpha (null when transparent); f: GEBCO measured fraction of the cell.
 */
export function swotText(lat: number, alpha: number | null, label: string | null, f: number | null): string {
  if (Math.abs(lat) > SWOT_MAX_LAT) return 'not rated: the model stops at 80°';
  if (alpha === null) return 'could not be loaded';
  if (label) return label.replace(' confidence', '');
  if (f === null) return 'not rated (land)';
  if (typeof f === 'number' && f > 0) return 'not rated (sounding here)';
  // no GEBCO sounding, yet the model leaves the cell out: its own data marks a sounding or land here
  return 'not rated (the model has a sounding or land here)';
}

/** SWOT leaves this cell unrated within its coverage (transparent, tile loaded). */
export function swotUnrated(lat: number, alpha: number | null, label: string | null): boolean {
  return Math.abs(lat) <= SWOT_MAX_LAT && alpha !== null && !label;
}

export type Basin = [number, number, number, number, string?];
/**
 * The inland basin whose bounding box holds lon/lat, smallest box first (a small basin inside the Caspian box
 * keeps its own name); null when none. Name '' for an unnamed basin.
 */
export function basinAt(basins: Basin[], lon: number, lat: number): { name: string } | null {
  let best: Basin | null = null, area = Infinity;
  for (const b of basins) {
    if (lat < b[0] || lat > b[1] || lon < b[2] || lon > b[3]) continue;
    const a = (b[1] - b[0]) * (b[3] - b[2]);
    if (a < area) { area = a; best = b; }
  }
  return best ? { name: best[4] ?? '' } : null;
}

/** One sentence for a point in an inland basin below sea level. */
export function inlandVerdict(name: string): string {
  return `This point is below sea level but not connected to the world ocean${name ? ` (${name})` : ''}: a lake bed or dry land below sea level, so the ocean survey status does not apply.`;
}
