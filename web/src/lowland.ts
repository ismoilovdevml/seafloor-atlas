// Land below sea level in the relief colours. Polders (Flevoland) and inland basins (Death Valley, the Dead Sea, the
// Caspian) have DEM heights below 0 m, so the colour ramp painted them as shallow sea, although the coverage tiles mark
// them as land with the reserved veil alpha 1 (geo.ts LOW_LAND_ALPHA, pipeline/viewer_land.py).
//
// The relief and hillshade source ('dem-relief') reads its tiles through this protocol instead of sfa://dem: where the
// coverage tile of the same z/x/y has alpha 1, the DEM pixel is written as 0 m. The ramp then draws it as land at
// every sea level, under-layer and satellite setting with no other change (clear with satellite land on, so the Esri
// imagery shows; the low land colour with it off; flooded once the sea level is raised). The terrain mesh
// ('dem-terrain'), the hover readout, inspector and profile (sampler.ts) still read the real heights.
// Costs: the coverage tile (about a quarter of a DEM tile) is fetched only for tiles that can hold low land
// (lowland-index.ts: at z5 every tile with low land, at the whole-globe zooms z0-4 those with at least 64 such pixels,
// above z5 tiles whose z5 ancestor holds any land), and the pixels are rewritten
// only when that tile really has alpha 1; everything else is passed through as the original bytes.
// MapLibre 6.18 has no per-pixel mask between two raster sources (raster-layer-blend only offers colour blend modes,
// color-relief reads elevation only), so the DEM itself is the cheapest place to carry the land flag.
import { LOW_LAND_ALPHA } from './geo';
import { LOWLAND_INDEX } from './lowland-index';
import { fetchTile, trackTile } from './tilesource';

export const RELIEF_PROTOCOL = 'sfarelief';
/** URL template of the relief DEM source (same z/x/y as sfa://dem). */
export const reliefTemplate = () => `${RELIEF_PROTOCOL}://dem/{z}/{x}/{y}`;

/** Terrarium RGB of 0 m: h = R * 256 + G + B / 256 - 32768. */
export const TERRARIUM_ZERO: [number, number, number] = [128, 0, 0];

/**
 * Writes 0 m into every RGBA DEM pixel whose coverage pixel has the reserved low-land alpha. Both arrays are RGBA of
 * the same size; returns how many pixels changed.
 */
export function raiseLowLand(dem: Uint8ClampedArray | Uint8Array, coverage: Uint8ClampedArray | Uint8Array): number {
  let n = 0;
  for (let i = 3; i < coverage.length; i += 4) {
    if (coverage[i] !== LOW_LAND_ALPHA) continue;
    dem[i - 3] = TERRARIUM_ZERO[0]; dem[i - 2] = TERRARIUM_ZERO[1]; dem[i - 1] = TERRARIUM_ZERO[2];
    n++;
  }
  return n;
}

export interface LowlandIndex { revision: string | null; maxzoom: number; low: string[]; near: string }
const decoded = new Map<string, Uint8Array>();
/** Bit i of a base64 bitset (least significant bit first), decoded once per string. */
const bit = (b64: string, i: number) => {
  let b = decoded.get(b64);
  if (!b) { b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); decoded.set(b64, b); }
  return ((b[i >> 3] >> (i & 7)) & 1) === 1;
};

/**
 * Can relief tile z/x/y hold land below sea level (worth fetching its coverage tile)? From the index's bits for its
 * static zooms (scripts/lowland_index.mjs); above them, true when the ancestor at the index's top zoom holds land. Without a usable index (another tile build): always true.
 */
export function mayHoldLowLand(z: number, x: number, y: number, index: LowlandIndex | null): boolean {
  if (!index) return true;
  if (z <= index.maxzoom) return bit(index.low[z], y * 2 ** z + x);
  const d = 2 ** (z - index.maxzoom), Z = index.maxzoom;
  return bit(index.near, Math.floor(y / d) * 2 ** Z + Math.floor(x / d));
}

let index: LowlandIndex | null = null;
/** Use the bundled index only for the tile build it was made from (meta.json hires.revision); null: check every tile. */
export function useLowlandIndex(revision: string | null | undefined, staticMaxzoom: number) {
  index = revision && revision === LOWLAND_INDEX.revision && staticMaxzoom === LOWLAND_INDEX.maxzoom ? LOWLAND_INDEX : null;
}

const pixelsOf = async (buf: ArrayBuffer): Promise<ImageData> => {
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    // alpha is exact through the canvas; DEM alpha is 255, so its RGB is exact too (see sampler.ts)
    return ctx.getImageData(0, 0, bmp.width, bmp.height, { colorSpace: 'srgb' });
  } finally {
    bmp.close();
  }
};

/** The DEM tile with low land raised to 0 m (an ImageBitmap MapLibre takes as is), or null when nothing changes. */
async function withLowLand(dem: ArrayBuffer, coverage: ArrayBuffer): Promise<ImageBitmap | null> {
  const cov = await pixelsOf(coverage);
  let any = false;
  for (let i = 3; i < cov.data.length && !any; i += 4) any = cov.data[i] === LOW_LAND_ALPHA;
  if (!any) return null;
  const d = await pixelsOf(dem);
  if (d.width !== cov.width || d.height !== cov.height) return null;
  raiseLowLand(d.data, cov.data);
  return createImageBitmap(d, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/** MapLibre addProtocol handler for RELIEF_PROTOCOL (counted by the loading meter like sfa://). */
export async function reliefProtocolHandler(params: { url: string }, abort: AbortController): Promise<{ data: ArrayBuffer | ImageBitmap }> {
  const m = /^sfarelief:\/\/dem\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
  if (!m) throw new Error(`bad tile url ${params.url}`);
  const [z, x, y] = [+m[1], +m[2], +m[3]];
  return trackTile((async () => {
    const demP = fetchTile('dem', z, x, y, abort.signal);
    // a missing or failed coverage tile only means the plain DEM is drawn
    const covP = mayHoldLowLand(z, x, y, index) ? fetchTile('coverage', z, x, y, abort.signal).catch(() => null) : null;
    const [dem, cov] = await Promise.all([demP, covP]);
    if (!dem) throw new Error(`tile not found ${params.url}`);
    if (!cov) return { data: dem };
    try {
      return { data: (await withLowLand(dem, cov)) ?? dem };
    } catch {
      return { data: dem }; // decode failure: the plain relief, as before
    }
  })());
}
