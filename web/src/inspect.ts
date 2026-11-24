// Point inspector: what is known about the depth at one clicked point, from our own tiles only.
// classify() turns the measured fraction of the cell and the distance to the nearest measured cell into one of the
// STATUS classes (palette.ts); nearestFlagged() finds that distance on a Web Mercator pixel grid; the text helpers
// say it in plain words. Pure functions, so they are unit-tested without tiles or a map.
import { haversineKm, lonLatToWorldPx, MAX_MERC_LAT, wrapPx } from './geo';
import type { StatusKey } from './palette';

/** A cell with no sounding still counts as "survey nearby" when measured seafloor is at most this far (km). */
export const NEAR_KM = 10;
/** How far the inspector looks for measured seafloor (km). */
export const SEARCH_KM = 200;
const R_KM = 6371.0088;
/**
 * The coverage (and DEM) tiles are real data only equatorward of this latitude: pipeline/tiles.py BLEND_FROM fades the
 * rows beyond it into one polar-cap mean (fully the mean from 84.92°, the measured fraction 0.186 in the north), so a
 * measured fraction or a distance read there would be invented. Poleward of it the atlas does not rate coverage.
 */
export const RATED_TO_LAT = 84.8;
/** Short label for the measured fraction where coverage is not rated (|lat| > RATED_TO_LAT). */
export const NOT_RATED = `poleward of ${RATED_TO_LAT}° — not rated`;
/** One sentence for the inspector at an ocean point poleward of RATED_TO_LAT. */
export const NOT_RATED_VERDICT = `This atlas does not rate ship coverage poleward of ${RATED_TO_LAT}°: its coverage grid ends there. ` +
  'The depth shown comes from the GEBCO grid itself, resampled to cells of about 0.8 km around the pole.';

/**
 * f: measured fraction of the cell (0..1), null = land, NaN = no tile; nearestKm: distance to the nearest cell with
 * any measurement, null = none within SEARCH_KM. Returns null when nothing is known (no tile).
 */
export function classify(f: number | null, nearestKm: number | null): StatusKey | null {
  if (f === null) return 'land';
  if (!Number.isFinite(f)) return null;
  if (f >= 0.5) return 'measured';
  if (f > 0) return 'partly';
  return nearestKm !== null && nearestKm <= NEAR_KM ? 'near' : 'far';
}

/** lon/lat of the global Web Mercator pixel coordinate (x, y) at zoom z. */
export function worldPxToLonLat(x: number, y: number, z: number, tileSize: number): [number, number] {
  const n = tileSize * 2 ** z;
  return [(x / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI];
}

/** Ground width of one pixel (km) at latitude lat and zoom z (Mercator pixels are square on the ground). */
export function pixelKm(lat: number, z: number, tileSize: number): number {
  return (2 * Math.PI * R_KM * Math.cos((Math.min(85.06, Math.abs(lat)) * Math.PI) / 180)) / (tileSize * 2 ** z);
}

/**
 * Pixel radius of the square window that holds every pixel within maxKm of a point at latitude lat (pixels poleward
 * of maxLat are never searched, so the window need not reach past it).
 */
export function searchRadiusPx(lat: number, z: number, tileSize: number, maxKm: number, maxLat = MAX_MERC_LAT): number {
  const n = tileSize * 2 ** z;
  // pixels are narrowest at the window's poleward edge: size the window with that width so nothing is missed
  const edge = Math.min(maxLat, 85.05, Math.abs(lat) + maxKm / 111.2);
  return Math.min(Math.ceil(maxKm / pixelKm(edge, z, tileSize)) + 1, Math.floor(n / 2));
}

/**
 * Great-circle distance (km) from lon/lat to the centre of the nearest pixel where flag(ix, iy) is true, searching
 * square rings outward; 0 when the point's own pixel is flagged; null when none lies within maxKm, and null for a point
 * poleward of maxLat (it has no pixel of its own: Web Mercator would clamp it onto the edge row, hundreds of km away).
 * Rows whose centre lies poleward of maxLat are never tested. flag receives a wrapped column and a row inside [0, n).
 */
export function nearestFlagged(flag: (ix: number, iy: number) => boolean, lon: number, lat: number, z: number,
  tileSize: number, maxKm: number, maxLat = MAX_MERC_LAT): number | null {
  if (!(Math.abs(lat) <= maxLat)) return null;
  const n = tileSize * 2 ** z;
  const [cx, cy] = lonLatToWorldPx(lon, lat, z, tileSize);
  // rows [rowMin, rowMax] have their centre within +-maxLat
  const yN = lonLatToWorldPx(0, maxLat, z, tileSize)[1], yS = lonLatToWorldPx(0, -maxLat, z, tileSize)[1];
  const rowMin = Math.max(0, Math.ceil(yN - 0.5)), rowMax = Math.min(n - 1, Math.floor(yS - 0.5));
  const ok = (iy: number) => iy >= rowMin && iy <= rowMax;
  const ix0 = Math.floor(cx), iy0 = Math.min(n - 1, Math.max(0, Math.floor(cy)));
  if (ok(iy0) && flag(wrapPx(ix0, n), iy0)) return 0;
  const edge = Math.min(maxLat, 85.05, Math.abs(lat) + maxKm / 111.2);
  const pxMin = pixelKm(edge, z, tileSize);
  const R = searchRadiusPx(lat, z, tileSize, maxKm, maxLat);
  let best = Infinity;
  const test = (ix: number, iy: number) => {
    if (!ok(iy) || !flag(wrapPx(ix, n), iy)) return;
    const d = haversineKm([lon, lat], worldPxToLonLat(ix + 0.5, iy + 0.5, z, tileSize));
    if (d < best) best = d;
  };
  for (let k = 1; k <= R; k++) {
    // every pixel of ring k is at least k - 1 narrowest pixel widths from the point
    if ((k - 1) * pxMin > Math.min(best, maxKm)) break;
    for (let dx = -k; dx <= k; dx++) { test(ix0 + dx, iy0 - k); test(ix0 + dx, iy0 + k); }
    for (let dy = -k + 1; dy <= k - 1; dy++) { test(ix0 - k, iy0 + dy); test(ix0 + k, iy0 + dy); }
  }
  return best <= maxKm ? best : null;
}

/** "about 7 km", "under 1 km", "this cell"; short: "7 km", "< 1 km", "> 200 km" for a metric tile. */
export function formatNearest(km: number | null, short = false): string {
  if (km === null) return short ? `> ${SEARCH_KM} km` : `over ${SEARCH_KM} km`;
  if (km === 0) return 'this cell';
  if (km < 1) return short ? '< 1 km' : 'under 1 km';
  const v = `${km < 20 ? Math.round(km) : Math.round(km / 5) * 5} km`;
  return short ? v : `about ${v}`;
}

export const pct = (f: number) => (f > 0 && f < 0.01 ? 'under 1%' : `${Math.round(f * 100)}%`);

/** One plain-language sentence on how the depth at this point is known. */
export function verdict(s: StatusKey, f: number | null, nearestKm: number | null): string {
  switch (s) {
    case 'land': return 'This is land. The map shows its surface height here (the ice surface on ice sheets).';
    case 'measured': return `Ships have sounded ${pct(f ?? 0)} of this cell, so the depth here is measured, not estimated.`;
    case 'partly': return `Ships crossed ${pct(f ?? 0)} of this cell; the rest of its depth is filled in between their tracks.`;
    case 'near': return `No ship has sounded this cell. Its depth is estimated, but measured seafloor lies ${formatNearest(nearestKm)} away.`;
    case 'far': return nearestKm === null
      ? `No ship has sounded anywhere within ${SEARCH_KM} km. The depth is estimated from satellite gravity, which shows only broad shapes: hills and small seamounts can be missing.`
      : `No ship has sounded within ${formatNearest(nearestKm)}. The depth is estimated from satellite gravity or interpolation, which shows only broad shapes: hills and small seamounts can be missing.`;
  }
}
