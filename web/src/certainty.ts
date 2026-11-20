// "How sure is the depth?" layers (pipeline/disagree.py, uncertainty.py, seals.py; docs/data-contract.md):
// model disagreement and prediction confidence as raster tiles (z0-5), seal dives deeper than the chart as points.
// Raster values are read back from the tiles' alpha channel, which the pipeline writes as an exact function of the
// value (disagree: alpha 110..235 along the log scale, losslessly coded even in lossy WebP; uncertainty: one alpha
// per class), so the readout reports the same number the colour shows.
import type { GeoJSONSource, LayerSpecification, Map as MlMap, SourceSpecification } from 'maplibre-gl';
import type { CardModel } from './overlays';

export type CertaintyId = 'disagree' | 'uncertainty' | 'seals';
export const CERTAINTY_IDS: CertaintyId[] = ['disagree', 'uncertainty', 'seals'];
/** Map layers per switch (the first one's visibility is what QA reads). */
export const CERTAINTY_LAYERS: Record<CertaintyId, string[]> = {
  disagree: ['disagree'], uncertainty: ['uncertainty'], seals: ['seals', 'seals-coverage'],
};

export interface DisagreeLegend { vmin: number; vmax: number; alphaMin: number; alphaMax: number; stops: { value: number; color: string }[];
  headline: { unmeasured_median_abs_m: number; unmeasured_p95_abs_m: number; unmeasured_share_gt_200m: number; measured_median_abs_m: number; depthFromM: number };
  attribution: string }
export interface UncertaintyLegend { classes: { class: number; label: string; color: string; alpha: number }[]; shareOfOcean: Record<string, number>; attribution: string }

// seal colours: one orange hue, light (20 m beyond the chart) to dark (300 m+). Checked with the dataviz validator as
// an ordinal ramp on the abyss #21163b: monotone lightness, hue spread 24°, dark end 4.3:1. On the mid-blue relief the
// dark end alone is only ~1.2:1, so every dot has a near-black ring. Not a relief hue; the oil-overlay orange is close
// but the two do not share a region (Southern Ocean vs. shelf seas).
export const SEAL_STOPS: [number, string][] = [[20, '#fcbf8e'], [100, '#f5844f'], [300, '#e0502a']];
export const SEAL_COVERAGE = '#d8e2e6';

/** `tilesUrl` = absolute URL of the tiles folder, ending in a slash. */
export function certaintySources(tilesUrl: string, tileSize: number): Record<string, SourceSpecification> {
  const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
  return {
    disagree: { type: 'raster', tiles: [`${tilesUrl}disagree/{z}/{x}/{y}.webp`], tileSize, minzoom: 0, maxzoom: 5 },
    uncertainty: { type: 'raster', tiles: [`${tilesUrl}uncertainty/{z}/{x}/{y}.webp`], tileSize, minzoom: 0, maxzoom: 5 },
    seals: { type: 'geojson', data: empty },
    'seals-coverage': { type: 'geojson', data: empty },
  };
}
export function certaintyRasterLayers(): LayerSpecification[] {
  return [
    { id: 'disagree', type: 'raster', source: 'disagree', layout: { visibility: 'none' }, paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } },
    { id: 'uncertainty', type: 'raster', source: 'uncertainty', layout: { visibility: 'none' }, paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } },
  ];
}
export function sealLayers(): LayerSpecification[] {
  const r = (a: number, b: number, c: number) => ['interpolate', ['linear'], ['zoom'], 1, a, 4, b, 7, c] as never;
  return [
    { id: 'seals-coverage', type: 'circle', source: 'seals-coverage', layout: { visibility: 'none' },
      paint: { 'circle-radius': r(1, 2.4, 9), 'circle-color': SEAL_COVERAGE, 'circle-opacity': ['interpolate', ['linear'], ['zoom'], 1, 0.05, 3, 0.16, 5, 0.28] as never, 'circle-pitch-alignment': 'map' } },
    { id: 'seals', type: 'circle', source: 'seals', layout: { visibility: 'none', 'circle-sort-key': ['get', 'x'] },
      paint: {
        'circle-radius': r(1.4, 2.6, 6),
        'circle-color': ['interpolate', ['linear'], ['get', 'x'], ...SEAL_STOPS.flat()] as never,
        'circle-stroke-color': '#0b0712', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 2, 0.3, 6, 0.8] as never,
        'circle-pitch-alignment': 'map',
      } },
  ];
}

/** Disagreement in metres from the tile alpha (log scale between vmin and vmax), null where transparent. */
export function disagreeFromAlpha(a: number, lg: Pick<DisagreeLegend, 'vmin' | 'vmax' | 'alphaMin' | 'alphaMax'>): number | null {
  if (a < lg.alphaMin - 2) return null;
  const t = Math.max(0, Math.min(1, (a - lg.alphaMin) / (lg.alphaMax - lg.alphaMin)));
  return 10 ** (Math.log10(lg.vmin) + t * (Math.log10(lg.vmax) - Math.log10(lg.vmin)));
}
/** Round a disagreement for display: two significant figures, "1,000 m or more" at the top of the scale. */
export function formatDisagree(m: number, vmax: number): string {
  if (m >= vmax * 0.98) return `${vmax.toLocaleString('en-US')} m or more`;
  const p = 10 ** Math.max(0, Math.floor(Math.log10(m)) - 1);
  return `about ${(Math.round(m / p) * p).toLocaleString('en-US')} m`;
}
/** Confidence class from the tile alpha (exact for lossless tiles), null where transparent. */
export function classFromAlpha(a: number, lg: Pick<UncertaintyLegend, 'classes'>): UncertaintyLegend['classes'][number] | null {
  if (a < 10) return null;
  return lg.classes.reduce((b, c) => (Math.abs(c.alpha - a) < Math.abs(b.alpha - a) ? c : b));
}

/** Pixel of a z-level tile under lon/lat (Web Mercator, longitude wrapped to [-180, 180)). */
export function tilePixel(lon: number, lat: number, z: number, size: number): { x: number; y: number; px: number; py: number } {
  const n = 2 ** z, la = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
  const wrappedLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const fx = ((wrappedLon + 180) / 360) * n, fy = ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n;
  const x = Math.min(n - 1, Math.max(0, Math.floor(fx))), y = Math.min(n - 1, Math.max(0, Math.floor(fy)));
  return { x, y, px: Math.min(size - 1, Math.max(0, Math.floor((fx - x) * size))), py: Math.min(size - 1, Math.max(0, Math.floor((fy - y) * size))) };
}

/** Reads RGBA from our raster tiles at their top zoom (decoded once, a small LRU cache). */
export class RasterProbe {
  private cache = new Map<string, Promise<ImageData | null>>();
  constructor(private base: string, private z = 5, private size = 512) {}
  async at(lon: number, lat: number): Promise<[number, number, number, number] | null> {
    const t = tilePixel(lon, lat, this.z, this.size);
    const key = `${this.z}/${t.x}/${t.y}`;
    let p = this.cache.get(key);
    if (p) {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, p);
    } else {
      const req = fetch(`${this.base}${key}.webp`).then(async (r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        try {
          const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true })!;
          g.drawImage(bmp, 0, 0);
          return g.getImageData(0, 0, bmp.width, bmp.height);
        } finally {
          bmp.close();
        }
      }).catch(() => {
        if (this.cache.get(key) === req) this.cache.delete(key);
        return null;
      });
      p = req;
      this.cache.set(key, p);
      if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
    }
    const img = await p;
    if (!img) return null;
    const i = (t.py * img.width + t.px) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  }
}

export interface SealProps { n: number; d: number; dp: number; x: number; md: number; cd: number }
const fmtM = (m: number) => `${Math.round(m).toLocaleString('en-US')} m`;
export function sealCard(p: SealProps, lon: number, lat: number, attribution: string): CardModel {
  const share = p.n ? (100 * p.d) / p.n : 0;
  const ns = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? pos : neg}`;
  const chartDepth = p.cd < 0
    ? `${fmtM(-p.cd)} above sea level (chart says land/ice, mean)`
    : `${fmtM(p.cd)} (mean)`;
  return {
    kind: 'Seal dives deeper than the chart',
    name: `${ns(lat, 'N', 'S')}, ${ns(lon, 'E', 'W')}`,
    lead: `${p.d.toLocaleString('en-US')} of ${p.n.toLocaleString('en-US')} dives (${share < 1 ? share.toFixed(1) : Math.round(share)}%) went more than 20 m deeper than GEBCO 2026 allows here`,
    facts: [
      ['Deepest dive', fmtM(p.md)],
      ['Chart depth at the dives', chartDepth],
      ['Largest excess', fmtM(p.x)],
      ['Deeper at the exact point', p.dp.toLocaleString('en-US')],
    ],
    links: [],
    note: 'A dive can only show that the chart is too shallow, never too deep. The test allows for the position error of each dive (0.1° bin).',
    source: attribution,
  };
}

/** Loads the seal files once and reports the headline share (dives deeper than the chart / all reliable dives). */
export async function loadSeals(map: MlMap, dataBase: string): Promise<{ deeper: number; dives: number; attribution: string } | null> {
  const [a, b] = await Promise.all(['seals.geojson', 'seals-coverage.geojson'].map((f) => fetch(`${dataBase}/${f}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  if (!a || !b) return null;
  (map.getSource('seals') as GeoJSONSource).setData(a);
  (map.getSource('seals-coverage') as GeoJSONSource).setData(b);
  const deeper = (a.features as GeoJSON.Feature<GeoJSON.Point, SealProps>[]).reduce((s, f) => s + (f.properties.d ?? 0), 0);
  return { deeper, dives: Number(a.metadata?.dives_in_file) || NaN, attribution: String(a.metadata?.attribution ?? '') };
}
