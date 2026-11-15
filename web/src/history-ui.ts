// Seafloor mapping progress, GEBCO_2019 .. GEBCO_2026 (web/public/history/, pipeline/history.py). One set of
// lossless tiles holds every release (R = first-measured code, G = bitmask of releases measured, B = 2026 share,
// A = ocean); the `sfahist://<year>/{z}/{x}/{y}` protocol decodes each tile once and recolours it for the
// release shown (timeline.recolourHistory), so stepping through the years downloads nothing new. The history
// tiles leave B empty; it is filled from the GEBCO 2026 coverage tile of the same z/x/y (measured share =
// 1 - alpha / veilMax, data contract "Web tiles"), which sets the opacity of lit pixels at coarse zooms.
import { addProtocol, type Map as MlMap, type RasterTileSource } from 'maplibre-gl';
import { mappingHeadline, parseMappingManifest, recolourHistory, type MappingManifest } from './timeline';
import { fetchTile, trackTile } from './tilesource';

const PROTO = 'sfahist';
const CACHE = 48; // decoded 512 px tiles kept (1 MB each)

export class HistoryUI {
  man: MappingManifest | null = null;
  year: number | null = null;
  private added = false;
  private decoded = new Map<string, Promise<Uint8ClampedArray | null>>();

  constructor(private map: MlMap, private tileSize: number, private veilMax: number, private base = 'history/') {}

  /** Reads the manifest; false (set hidden) when the history files are not built. */
  async init(): Promise<boolean> {
    const j = await fetch(`${this.base}manifest.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    this.man = parseMappingManifest(j);
    if (!this.man) return false;
    const t = await fetch(`${this.base}tiles/0/0/0.webp`, { method: 'HEAD' }).catch(() => null);
    return !!t?.ok;
  }

  private decode(z: string, x: string, y: string): Promise<Uint8ClampedArray | null> {
    const k = `${z}/${x}/${y}`;
    let p = this.decoded.get(k);
    if (!p) {
      p = (async () => {
        const [r, cov] = await Promise.all([fetch(`${this.base}tiles/${k}.webp`), fetchTile('coverage', +z, +x, +y).catch(() => null)]);
        if (!r.ok) return null;
        const px = async (blob: Blob) => {
          // exact channel values: no premultiplication, no colour management (history alpha is 0 or 255)
          const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true })!;
          g.drawImage(bmp, 0, 0);
          bmp.close();
          return g.getImageData(0, 0, c.width, c.height).data;
        };
        const d = await px(await r.blob());
        const v = cov ? await px(new Blob([cov], { type: 'image/webp' })) : null;
        if (v && v.length === d.length) {
          // the veil's alpha survives canvas premultiplication exactly; share = 1 - alpha / veilMax
          for (let i = 3; i < d.length; i += 4) d[i - 1] = Math.round(255 * Math.max(0, Math.min(1, 1 - v[i] / this.veilMax)));
        } else for (let i = 3; i < d.length; i += 4) d[i - 1] = 0;
        return d;
      })().catch(() => null);
      this.decoded.set(k, p);
      if (this.decoded.size > CACHE) this.decoded.delete(this.decoded.keys().next().value!);
    }
    return p;
  }

  private ensure() {
    if (this.added) return;
    addProtocol(PROTO, async (params) => {
      const m = /^sfahist:\/\/(\d{4})\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
      if (!m) throw new Error(`bad history tile url ${params.url}`);
      return trackTile((async () => {
        const src = await this.decode(m[2], m[3], m[4]);
        if (!src) return { data: new ArrayBuffer(0) };
        const side = Math.round(Math.sqrt(src.length / 4));
        const out = new ImageData(side, side);
        recolourHistory(src, out.data, Number(m[1]));
        return { data: await createImageBitmap(out) };
      })());
    });
    const t = this.man!.tiles;
    this.map.addSource('history', { type: 'raster', tiles: [`${PROTO}://2026/{z}/{x}/{y}`], tileSize: this.tileSize, minzoom: t.minzoom, maxzoom: t.maxzoom });
    this.map.addLayer({ id: 'history', type: 'raster', source: 'history', layout: { visibility: 'none' }, paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, 'shipping');
    this.added = true;
  }

  /** Shows release `year` (null hides the layer). */
  set(year: number | null) {
    if (!this.man) return;
    if (year === null) {
      this.year = null;
      if (this.added) this.map.setLayoutProperty('history', 'visibility', 'none');
      return;
    }
    this.ensure();
    const y = Math.max(this.man.years[0].year, Math.min(this.man.years[this.man.years.length - 1].year, year));
    if (y !== this.year) (this.map.getSource('history') as RasterTileSource).setTiles([`${PROTO}://${y}/{z}/{x}/{y}`]);
    this.year = y;
    this.map.setLayoutProperty('history', 'visibility', 'visible');
  }
  get range(): [number, number] { const ys = this.man!.years; return [ys[0].year, ys[ys.length - 1].year]; }
  headline(year: number) { return mappingHeadline(this.man!, year); }
  /** Our measured share per release, for the slider strip. */
  values(): number[] { return this.man!.years.map((y) => y.measured_frac); }
}
