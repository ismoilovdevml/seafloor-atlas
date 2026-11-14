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
import { bilinear, decodeTerrarium, decodeVeil, lonLatToWorldPx, wrapPx } from './geo';

type Kind = 'dem' | 'coverage';
type Grid = Float32Array | Uint8Array;

export interface SamplerMeta { tileSize: number; maxzoom: number; veilMax: number }

export class TileSampler {
  private cache = new Map<string, Promise<Grid | null>>();
  private ready = new Map<string, Grid | null>();
  private order: string[] = [];
  // tiles come from tilesource.fetchTile (static or PMTiles); the first argument is kept for call-site compatibility
  constructor(_base: string, private meta: SamplerMeta, private capacity = 96) {}

  private key(kind: Kind, z: number, x: number, y: number) { return `${kind}/${z}/${x}/${y}`; }

  private load(kind: Kind, z: number, x: number, y: number): Promise<Grid | null> {
    const k = this.key(kind, z, x, y);
    let p = this.cache.get(k);
    if (p) return p;
    p = (async () => {
      const buf = await fetchTile(kind, z, x, y);
      if (!buf) return null;
      const bmp = await createImageBitmap(new Blob([buf], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const S = this.meta.tileSize;
      const cv = new OffscreenCanvas(S, S);
      const ctx = cv.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const px = ctx.getImageData(0, 0, S, S, { colorSpace: 'srgb' }).data;
      if (kind === 'dem') {
        const g = new Float32Array(S * S);
        for (let i = 0; i < S * S; i++) g[i] = decodeTerrarium(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
        return g;
      }
      const a = new Uint8Array(S * S);
      for (let i = 0; i < S * S; i++) a[i] = px[i * 4 + 3];
      return a;
    })().catch(() => null).then((g) => { this.ready.set(k, g); return g; });
    this.cache.set(k, p);
    this.order.push(k);
    while (this.order.length > this.capacity) {
      const old = this.order.shift()!;
      this.cache.delete(old); this.ready.delete(old);
    }
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

  private pixel(kind: Kind, z: number, ix: number, iy: number): number {
    const S = this.meta.tileSize;
    const g = this.ready.get(this.key(kind, z, Math.floor(ix / S), Math.floor(iy / S)));
    if (!g) return NaN;
    return g[(iy % S) * S + (ix % S)];
  }

  /**
   * Sample depth (bilinear) and measured fraction (nearest) at many lon/lat points at zoom z.
   * NaN = tile missing (unknown); fraction null = land.
   */
  async sample(lonlats: [number, number][], z = this.meta.maxzoom): Promise<{ h: number[]; f: (number | null)[] }> {
    const S = this.meta.tileSize, n = S * 2 ** z;
    const world = lonlats.map(([lon, lat]) => lonLatToWorldPx(lon, lat, z, S));
    const tiles = this.tilesFor(world, z);
    await Promise.all(tiles.flatMap(([x, y]) => [this.load('dem', z, x, y), this.load('coverage', z, x, y)]));
    // re-pin: the LRU may have evicted something during a very long profile; reload synchronously-needed ones
    for (const [x, y] of tiles) {
      if (!this.ready.has(this.key('dem', z, x, y))) await this.load('dem', z, x, y);
      if (!this.ready.has(this.key('coverage', z, x, y))) await this.load('coverage', z, x, y);
    }
    const h: number[] = [], f: (number | null)[] = [];
    for (const [x, y] of world) {
      const d = bilinear((ix, iy) => this.pixel('dem', z, ix, iy), x, y, n);
      h.push(d);
      const ix = wrapPx(Math.floor(x), n), iy = Math.max(0, Math.min(n - 1, Math.floor(y)));
      const a = this.pixel('coverage', z, ix, iy);
      const hNear = this.pixel('dem', z, ix, iy);
      f.push(Number.isNaN(a) ? NaN : decodeVeil(a, this.meta.veilMax, hNear));
    }
    return { h, f };
  }
}
