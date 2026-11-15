// One tile source per layer, two homes: z0..lowMax are static files next to the page (GitHub Pages),
// z(lowMax+1)..hires.maxzoom come from a PMTiles archive on Hugging Face via HTTP range requests.
// The map (custom `sfa://` protocol) and the depth sampler both go through fetchTile, so the
// readout and profiles see exactly the tiles the map draws.
import { PMTiles } from 'pmtiles';

export type TileLayer = 'dem' | 'coverage' | 'new2026';

export interface HiresMeta {
  maxzoom: number;
  dem?: string;      // absolute URL of a PMTiles archive (Terrarium WebP)
  coverage?: string; // absolute URL of a PMTiles archive (veil RGBA WebP)
}

export const PROTOCOL = 'sfa';

let staticBase = 'tiles/';
let lowMax = 5;
const archives = new Map<TileLayer, PMTiles>();
let hiresMax = 5;

export function configureTiles(base: string, lowMaxZoom: number, hires?: HiresMeta | null) {
  staticBase = base.endsWith('/') ? base : `${base}/`;
  lowMax = lowMaxZoom;
  archives.clear();
  hiresMax = lowMax;
  if (hires && hires.maxzoom > lowMax) {
    for (const layer of ['dem', 'coverage'] as const) {
      const url = hires[layer];
      if (url) archives.set(layer, new PMTiles(url));
    }
    if (archives.size) hiresMax = hires.maxzoom;
  }
}

/** Highest zoom available for a layer (static only, or static + PMTiles). */
export function maxZoomFor(layer: TileLayer): number {
  return archives.has(layer) ? hiresMax : lowMax;
}

/** URL template for a MapLibre source. */
export function tileTemplate(layer: TileLayer): string {
  return `${PROTOCOL}://${layer}/{z}/{x}/{y}`;
}

export async function fetchTile(layer: TileLayer, z: number, x: number, y: number, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  if (z > lowMax) {
    const pm = archives.get(layer);
    if (!pm) return null;
    const r = await pm.getZxy(z, x, y, signal);
    return r ? r.data : null;
  }
  const url = `${staticBase}${layer}/${z}/${x}/${y}.webp`;
  // GitHub Pages occasionally answers 503 under load (seen in live QA); retry transient failures
  // with backoff, but not 4xx (a real miss) and not an aborted request.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return res.arrayBuffer();
      if (res.status < 500 || attempt >= RETRIES) return null;
    } catch (e) {
      if (signal?.aborted || attempt >= RETRIES) throw e;
    }
    await sleep(RETRY_BASE_MS * 2 ** attempt, signal);
  }
}

export const RETRIES = 3;
export const RETRY_BASE_MS = 250;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });
}

/** Parse `sfa://dem/6/12/20` -> ['dem', 6, 12, 20]. */
export function parseTileUrl(url: string): [TileLayer, number, number, number] | null {
  const m = /^sfa:\/\/(dem|coverage|new2026)\/(\d+)\/(\d+)\/(\d+)/.exec(url);
  return m ? [m[1] as TileLayer, +m[2], +m[3], +m[4]] : null;
}

/**
 * Map tile activity for the loading indicator (loading.ts): every tile the map asks for through a protocol
 * handler (static files, PMTiles range reads on Hugging Face, recoloured history tiles) counts as started, and
 * as finished when it resolves, fails or is aborted. The depth sampler's own reads are not counted.
 */
export const tileActivity: { start: () => void; finish: () => void } = { start: () => {}, finish: () => {} };
export async function trackTile<T>(p: Promise<T>): Promise<T> {
  tileActivity.start();
  try { return await p; } finally { tileActivity.finish(); }
}

/** MapLibre addProtocol handler (v4+ signature). */
export async function protocolHandler(params: { url: string }, abort: AbortController): Promise<{ data: ArrayBuffer }> {
  const p = parseTileUrl(params.url);
  if (!p) throw new Error(`bad tile url ${params.url}`);
  const data = await trackTile(fetchTile(p[0], p[1], p[2], p[3], abort.signal));
  if (!data) throw new Error(`tile not found ${params.url}`);
  return { data };
}
