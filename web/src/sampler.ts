import { fetchTile } from './tilesource';
// Reads our own DEM + coverage tiles directly (not from the GL renderer) so hover readouts and profiles
// get exact values: Terrarium decoded per pixel at a chosen zoom, bilinear for depth, nearest pixel for
// the measured fraction (a fraction of one ~1 arc-minute cell; blending it across land edges would invent
// values).
//
// Premultiplied alpha: images are decoded with createImageBitmap({premultiplyAlpha: 'none'}). Canvas 2D
// still stores premultiplied pixels internally, which can perturb RGB where alpha < 255, but alpha itself
// round-trips exactly. DEM tiles have alpha 255 everywhere (RGB exact), and from the veil only alpha is
// read, so both decodes are lossless.
//
// Poles: the tiles are real only equatorward of 84.8° (inspect.ts RATED_TO_LAT; pipeline/tiles.py fades the rows
// beyond into one cap mean, and Web Mercator clamps everything past 85.05° onto that edge row). Poleward of it the
// depth comes from the polar grid the globe draws there (polar-layer.ts loadPolarGrid, GEBCO 15" binned to ~0.76 km),
// and the measured fraction is not rated: NaN with a note, never the cap's invented value.
import { bilinear, decodeTerrarium, decodeVeil, lonLatToWorldPx, wrapPx } from './geo';
import { nearestFlagged, NOT_RATED, RATED_TO_LAT, searchRadiusPx } from './inspect';
import { loadPolarGrid, polarDepth } from './polar-layer';

type Kind = 'dem' | 'coverage';
type Grid = Float32Array | Uint8Array;

export interface SamplerMeta { tileSize: number; maxzoom: number; veilMax: number }

/**
 * h: depth/height (m), NaN = unknown. f: measured fraction 0..1, null = land, NaN = unknown. note: why f is unknown
 * when the atlas does not rate it (poleward of RATED_TO_LAT: NOT_RATED), else null.
 */
export interface SampleResult { h: number[]; f: (number | null)[]; note: (string | null)[] }

/** True where the tiles stop being real data and the polar grid answers instead. */
export const isPolar = (lat: number) => Math.abs(lat) > RATED_TO_LAT;

export class TileSampler {
  private cache = new Map<string, Promise<Grid | null>>();
  private ready = new Map<string, Grid | null>();
  private polarBase: string;
  // tiles come from tilesource.fetchTile (static or PMTiles); `base` (the tiles folder) locates the polar grids
  constructor(base: string, private meta: SamplerMeta, private capacity = 96) {
    this.polarBase = `${base.replace(/\/+$/, '')}/polar/`;
  }

  private key(kind: Kind, z: number, x: number, y: number) { return `${kind}/${z}/${x}/${y}`; }

  private evict(minCapacity = this.capacity) {
    const cap = Math.max(this.capacity, minCapacity);
    while (this.cache.size > cap) {
      const old = this.cache.keys().next().value!;
      this.cache.delete(old);
      this.ready.delete(old);
    }
  }

  private load(kind: Kind, z: number, x: number, y: number, minCapacity = this.capacity): Promise<Grid | null> {
    const k = this.key(kind, z, x, y);
    const hit = this.cache.get(k);
    if (hit) {
      // True LRU refresh: move to end of Map iteration order.
      this.cache.delete(k);
      this.cache.set(k, hit);
      return hit;
    }
    const p: Promise<Grid | null> = (async () => {
      const buf = await fetchTile(kind, z, x, y);
      if (!buf) return null;
      const bmp = await createImageBitmap(new Blob([buf], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      try {
        const S = this.meta.tileSize;
        const cv = new OffscreenCanvas(S, S);
        const ctx = cv.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, S, S, { colorSpace: 'srgb' }).data;
        if (kind === 'dem') {
          const g = new Float32Array(S * S);
          for (let i = 0; i < S * S; i++) g[i] = decodeTerrarium(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
          return g;
        }
        const a = new Uint8Array(S * S);
        for (let i = 0; i < S * S; i++) a[i] = px[i * 4 + 3];
        return a;
      } finally {
        bmp.close();
      }
    })().then((g) => {
      // Only populate `ready` if this exact promise is still retained in `cache` (prevents leaked Float32Arrays on eviction).
      if (this.cache.get(k) === p) {
        if (g) this.ready.set(k, g);
        else { this.cache.delete(k); this.ready.delete(k); }
      }
      return g;
    }).catch(() => {
      if (this.cache.get(k) === p) { this.cache.delete(k); this.ready.delete(k); }
      return null;
    });
    this.cache.set(k, p);
    this.evict(minCapacity);
    return p;
  }

  /** Tiles (x, y) touched by the 2x2 bilinear footprint around each world pixel. */
  private tilesFor(points: [number, number][], z: number): [number, number][] {
    const S = this.meta.tileSize, n = S * 2 ** z, T = 2 ** z;
    const set = new Set<string>();
    for (const [x, y] of points) {
      for (const dx of [-0.5, 0.5]) for (const dy of [-0.5, 0.5]) {
        const tx = Math.floor(wrapPx(Math.floor(x + dx), n) / S);
        const ty = Math.min(T - 1, Math.max(0, Math.floor(Math.max(0, Math.min(n - 1, y + dy)) / S)));
        set.add(`${tx},${ty}`);
      }
    }
    return [...set].map((s) => s.split(',').map(Number) as [number, number]);
  }

  /**
   * Sample depth (bilinear) and measured fraction (nearest) at many lon/lat points at zoom z.
   * NaN = tile missing (unknown); fraction null = land. Poleward of RATED_TO_LAT: depth from the polar grid, fraction
   * null on land, else NaN with note NOT_RATED.
   */
  async sample(lonlats: [number, number][], z = this.meta.maxzoom): Promise<SampleResult> {
    const polar = lonlats.map(([, lat]) => isPolar(lat));
    const [tiles, north, south] = await Promise.all([
      this.sampleTiles(lonlats.filter((_, i) => !polar[i]), z),
      polar.some((p, i) => p && lonlats[i][1] > 0) ? loadPolarGrid(this.polarBase, true) : null,
      polar.some((p, i) => p && lonlats[i][1] < 0) ? loadPolarGrid(this.polarBase, false) : null,
    ]);
    const h: number[] = [], f: (number | null)[] = [], note: (string | null)[] = [];
    let k = 0;
    lonlats.forEach(([lon, lat], i) => {
      if (!polar[i]) { h.push(tiles.h[k]); f.push(tiles.f[k]); note.push(null); k++; return; }
      const g = lat > 0 ? north : south;
      const d = g ? polarDepth(g, lat, lon) : NaN;
      h.push(d);
      // land is land (the ice surface on Antarctica); over the sea the measured fraction is not rated here
      if (d >= 0) { f.push(null); note.push(null); } else { f.push(NaN); note.push(NOT_RATED); }
    });
    return { h, f, note };
  }

  private async sampleTiles(lonlats: [number, number][], z: number): Promise<{ h: number[]; f: (number | null)[] }> {
    if (!lonlats.length) return { h: [], f: [] };
    const S = this.meta.tileSize, n = S * 2 ** z;
    const world = lonlats.map(([lon, lat]) => lonLatToWorldPx(lon, lat, z, S));
    const tiles = this.tilesFor(world, z);
    const needed = Math.max(this.capacity, tiles.length * 2);
    const grids = new Map<string, Grid | null>();
    await Promise.all(tiles.flatMap(([x, y]) => [
      this.load('dem', z, x, y, needed).then((g) => grids.set(this.key('dem', z, x, y), g)),
      this.load('coverage', z, x, y, needed).then((g) => grids.set(this.key('coverage', z, x, y), g)),
    ]));
    const pxAt = (kind: Kind, ix: number, iy: number): number => {
      const g = grids.get(this.key(kind, z, Math.floor(ix / S), Math.floor(iy / S)));
      return g ? g[(iy % S) * S + (ix % S)] : NaN;
    };
    const h: number[] = [], f: (number | null)[] = [];
    for (const [x, y] of world) {
      const d = bilinear((ix, iy) => pxAt('dem', ix, iy), x, y, n);
      h.push(d);
      const ix = wrapPx(Math.floor(x), n), iy = Math.max(0, Math.min(n - 1, Math.floor(y)));
      const a = pxAt('coverage', ix, iy);
      const hNear = pxAt('dem', ix, iy);
      f.push(Number.isNaN(a) ? NaN : decodeVeil(a, this.meta.veilMax, hNear));
    }
    this.evict(this.capacity);
    return { h, f };
  }

  /**
   * Distance (km) from lon/lat to the nearest ocean cell with any direct measurement at zoom z (inspect.ts
   * nearestFlagged over the coverage + DEM tiles of a window maxKm wide); 0 = this cell; null = none within maxKm,
   * tiles missing, or a point poleward of RATED_TO_LAT (not rated: sample() says so in its note). Cells poleward of
   * RATED_TO_LAT are never counted as measured (their fraction is the invented cap mean).
   */
  async nearestMeasured(lon: number, lat: number, maxKm: number, z = this.meta.maxzoom): Promise<number | null> {
    if (isPolar(lat)) return null;
    const S = this.meta.tileSize, T = 2 ** z;
    const [cx, cy] = lonLatToWorldPx(lon, lat, z, S);
    const R = searchRadiusPx(lat, z, S, maxKm, RATED_TO_LAT);
    const tx0 = Math.floor((cx - R) / S), tx1 = Math.floor((cx + R) / S);
    const ty0 = Math.max(0, Math.floor((cy - R) / S)), ty1 = Math.min(T - 1, Math.floor((cy + R) / S));
    const set = new Set<string>();
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) set.add(`${wrapPx(tx, T)},${ty}`);
    const tiles = [...set].map((s) => s.split(',').map(Number) as [number, number]);
    const needed = Math.max(this.capacity, tiles.length * 2);
    const grids = new Map<string, Grid | null>();
    await Promise.all(tiles.flatMap(([x, y]) => (['dem', 'coverage'] as Kind[]).map((k) =>
      this.load(k, z, x, y, needed).then((g) => grids.set(this.key(k, z, x, y), g)))));
    const flag = (ix: number, iy: number): boolean => {
      const tx = Math.floor(ix / S), ty = Math.floor(iy / S), i = (iy % S) * S + (ix % S);
      const a = grids.get(this.key('coverage', z, tx, ty)), d = grids.get(this.key('dem', z, tx, ty));
      if (!a || !d) return false;
      const f = decodeVeil(a[i], this.meta.veilMax, d[i]);
      return f !== null && f > 0;
    };
    const km = nearestFlagged(flag, lon, lat, z, S, maxKm, RATED_TO_LAT);
    this.evict(this.capacity);
    return km;
  }
}
