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
  const res = await fetch(`${staticBase}${layer}/${z}/${x}/${y}.webp`, { signal });
  if (!res.ok) return null;
  return res.arrayBuffer();
}

/** Parse `sfa://dem/6/12/20` -> ['dem', 6, 12, 20]. */
export function parseTileUrl(url: string): [TileLayer, number, number, number] | null {
  const m = /^sfa:\/\/(dem|coverage|new2026)\/(\d+)\/(\d+)\/(\d+)/.exec(url);
  return m ? [m[1] as TileLayer, +m[2], +m[3], +m[4]] : null;
}

/** MapLibre addProtocol handler (v4+ signature). */
export async function protocolHandler(params: { url: string }, abort: AbortController): Promise<{ data: ArrayBuffer }> {
  const p = parseTileUrl(params.url);
  if (!p) throw new Error(`bad tile url ${params.url}`);
  const data = await fetchTile(p[0], p[1], p[2], p[3], abort.signal);
  if (!data) throw new Error(`tile not found ${params.url}`);
  return { data };
}
