// Pure geometry + tile-decoding helpers (no DOM). Unit-tested in test/geo.test.ts.

export const EARTH_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;
export const MAX_MERC_LAT = 85.0511287798066;

/** Terrarium: h = R*256 + G + B/256 - 32768 (metres). */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Veil alpha -> measured fraction (data contract): alpha 0 over land (DEM h > 0) means land (null);
 * otherwise f = 1 - alpha / veilMax.
 */
export function decodeVeil(alpha: number, veilMax: number, demHeight: number): number | null {
  if (alpha === 0 && demHeight > 0) return null;
  return Math.min(1, Math.max(0, 1 - alpha / veilMax));
}

/** lon/lat -> global Web Mercator pixel coordinates at zoom z (continuous, 0..tileSize*2^z). */
export function lonLatToWorldPx(lon: number, lat: number, z: number, tileSize: number): [number, number] {
  const n = tileSize * 2 ** z;
  const la = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat));
  const x = ((lon + 180) / 360) * n;
  const s = Math.sin(la * RAD);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return [x, y];
}

/** Wrap a global pixel column into [0, n). */
export function wrapPx(x: number, n: number): number {
  return ((x % n) + n) % n;
}

/**
 * Bilinear sample over a pixel grid given by `get(ix, iy)` (ix already wrapped by the caller's getter
 * is not required: this function wraps x and clamps y). Pixel centres sit at integer + 0.5.
 * Returns NaN if any contributing pixel is NaN.
 */
export function bilinear(get: (ix: number, iy: number) => number, x: number, y: number, n: number): number {
  const fx = x - 0.5, fy = Math.max(0, Math.min(n - 1, y - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const y1 = Math.min(n - 1, y0 + 1);
  const xa = wrapPx(x0, n), xb = wrapPx(x0 + 1, n);
  const v00 = get(xa, y0), v10 = get(xb, y0), v01 = get(xa, y1), v11 = get(xb, y1);
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

/** Great-circle distance in km (haversine). */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const [l1, p1] = [a[0] * RAD, a[1] * RAD], [l2, p2] = [b[0] * RAD, b[1] * RAD];
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** n points (n >= 2) evenly spaced along the great circle from a to b, endpoints included. */
export function greatCircle(a: [number, number], b: [number, number], n: number): [number, number][] {
  const [l1, p1] = [a[0] * RAD, a[1] * RAD], [l2, p2] = [b[0] * RAD, b[1] * RAD];
  const d = haversineKm(a, b) / EARTH_RADIUS_KM;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    if (d < 1e-12) { out.push([a[0], a[1]]); continue; }
    const A = Math.sin((1 - t) * d) / Math.sin(d), B = Math.sin(t * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD]);
  }
  return out;
}

/** Split a lon/lat path where it crosses the antimeridian, so it draws without a world-wide stroke. */
export function unwrapPath(path: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let off = 0;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const d = path[i][0] - path[i - 1][0];
      if (d > 180) off -= 360; else if (d < -180) off += 360;
    }
    out.push([path[i][0] + off, path[i][1]]);
  }
  return out;
}

/**
 * Lowest zoom (<= maxZoom) whose pixel is no larger than the sample spacing, so a long profile
 * doesn't pull hundreds of max-zoom tiles for detail it cannot show.
 */
export function profileZoom(lengthKm: number, samples: number, maxZoom: number, tileSize: number): number {
  const spacingKm = lengthKm / Math.max(1, samples - 1);
  for (let z = 0; z <= maxZoom; z++) {
    const pxKm = (2 * Math.PI * EARTH_RADIUS_KM) / (tileSize * 2 ** z);
    if (pxKm <= spacingKm) return z;
  }
  return maxZoom;
}

export function formatLat(lat: number): string {
  return `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}`;
}
export function formatLon(lon: number): string {
  const l = ((lon + 540) % 360) - 180;
  return `${Math.abs(l).toFixed(3)}° ${l >= 0 ? 'E' : 'W'}`;
}
/** "−10,934 m" with a true minus sign and thousands separators. */
export function formatDepth(h: number): string {
  const r = Math.round(h);
  return `${r < 0 ? '−' : ''}${Math.abs(r).toLocaleString('en-US')} m`;
}
