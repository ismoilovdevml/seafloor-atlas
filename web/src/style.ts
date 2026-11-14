// MapLibre style built entirely from our own tiles and GeoJSON. No external servers: glyphs come from a
// bundled font file via `font-faces`, there is no sprite and no basemap.
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { maxZoomFor, tileTemplate, type HiresMeta } from './tilesource';
import { colorReliefExpression, plateColorExpression, SURVEY_LINE } from './palette';
import { overlayLayers, overlaySources, shippingLayer } from './overlays';
import labelFontUrl from '@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2?url';

export interface Meta {
  version: string; tileSize: number; minzoom: number; maxzoom: number; encoding: 'terrarium';
  veilMax: number; veilColor: string; sourceResolutionArcsec: number;
  citation: string; doi: string; licence?: string;
  stats?: Record<string, unknown>;
  change2025to2026?: { measured_2025_frac: number; measured_2026_frac: number; newly_measured_km2: number;
    no_longer_measured_km2: number; net_km2: number } | null;
  tiles?: Record<string, number>;
  /** z6+ archives (PMTiles on Hugging Face); absent = static z0..maxzoom only */
  hires?: HiresMeta | null;
}

export const LABEL_FONT = 'Atkinson Label';

// The gazetteer has ~5,400 names. Tiers by the pipeline's `rank` (feature size) keep the globe legible:
// ~30 largest at every zoom, then ~100 more from z2.5, ~400 from z3.8 and the rest from z5.5. Within a tier,
// larger features win label collisions (symbol-sort-key). Dot and label are one symbol (icon + text, neither
// optional), so a dot never appears without its name.
const RANK = ['coalesce', ['get', 'rank'], 1e9];
const TIERS: { id: string; filter: unknown[]; minzoom: number; size: [number, number] }[] = [
  { id: 'xl', filter: ['>=', RANK, 2500], minzoom: 0, size: [12.5, 15] },
  { id: 'l', filter: ['all', ['>=', RANK, 800], ['<', RANK, 2500]], minzoom: 2.5, size: [12, 14.5] },
  { id: 'm', filter: ['all', ['>=', RANK, 150], ['<', RANK, 800]], minzoom: 3.8, size: [11.5, 13.5] },
  { id: 's', filter: ['<', RANK, 150], minzoom: 5.5, size: [11.5, 13] },
];
export const FEATURE_LAYERS = TIERS.map((t) => `features-${t.id}`);
export const DOT_IMAGE = 'feature-dot';
function featureLayers(): LayerSpecification[] {
  return TIERS.map((t) => ({
    id: `features-${t.id}`, type: 'symbol', source: 'features', minzoom: t.minzoom, filter: t.filter as never,
    layout: {
      'icon-image': DOT_IMAGE, 'icon-size': 0.5,
      'text-field': ['get', 'name'], 'text-font': [LABEL_FONT],
      'text-size': ['interpolate', ['linear'], ['zoom'], 1, t.size[0], 7, t.size[1]],
      'text-max-width': 9, 'symbol-sort-key': ['-', 0, RANK] as never,
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 0.55, 'text-justify': 'auto',
      'text-padding': 3,
    },
    paint: { 'text-color': '#eef5f2', 'text-halo-color': 'rgba(4,9,18,0.9)', 'text-halo-width': 1.5, 'text-halo-blur': 0.3 },
  }) as LayerSpecification);
}

/** 2x-resolution white dot with a dark ring, drawn locally (no sprite server). */
export function makeDot(): ImageData {
  const S = 20, c = new OffscreenCanvas(S, S), g = c.getContext('2d')!;
  g.beginPath(); g.arc(S / 2, S / 2, 7, 0, Math.PI * 2);
  g.fillStyle = '#e8f3ee'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#06101c'; g.stroke();
  return g.getImageData(0, 0, S, S);
}

/** tileSize: what MapLibre is told the raster tiles measure in CSS px (256 for our 512 px files on a 2x screen). */
export interface TileOpts { tileSize: number; terrainTileSize: number }
export function buildStyle(tilesBase: string, dataBase: string, meta: Meta, opts: TileOpts = { tileSize: meta.tileSize, terrainTileSize: meta.tileSize }): StyleSpecification {
  const abs = (p: string) => new URL(p, window.location.href).href;
  // resolve the directory only: new URL() would percent-encode the {z}/{x}/{y} template braces
  const tiles = abs(`${tilesBase}/`);
  // dem + coverage go through the sfa:// protocol (static z0-5, PMTiles above); see tilesource.ts
  const dem = { type: 'raster-dem' as const, tiles: [tileTemplate('dem')], tileSize: opts.tileSize, minzoom: meta.minzoom, maxzoom: maxZoomFor('dem'), encoding: 'terrarium' as const };
  return {
    version: 8,
    'font-faces': { [LABEL_FONT]: abs(labelFontUrl) },
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#081325',
      'horizon-color': '#18375a',
      'fog-color': '#0b1a2e',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.5,
      'fog-ground-blend': 0.85,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.85, 4, 0.6, 7, 0],
    },
    // Two DEM sources pointing at the same tiles: one feeds the 3D mesh, the other the colour/hillshade
    // passes, so the two don't evict each other's tiles (MapLibre's recommendation).
    sources: {
      'dem-terrain': { ...dem, tileSize: opts.terrainTileSize },
      'dem-relief': { ...dem },
      veil: { type: 'raster', tiles: [tileTemplate('coverage')], tileSize: opts.tileSize, minzoom: meta.minzoom, maxzoom: maxZoomFor('coverage') },
      new2026: { type: 'raster', tiles: [`${tiles}new2026/{z}/{x}/{y}.webp`], tileSize: opts.tileSize, minzoom: meta.minzoom, maxzoom: meta.maxzoom },
      plates: { type: 'geojson', data: abs(`${dataBase}/plates.geojson`) },
      features: { type: 'geojson', data: abs(`${dataBase}/features.geojson`) },
      profile: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      cursor: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      // human-activity overlays (empty until switched on; see overlays.ts). Shipping tiles are only on the real set.
      ...overlaySources(abs('tiles/shipping/'), opts.tileSize),
    },
    terrain: { source: 'dem-terrain', exaggeration: 40 },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0a1424' } },
      { id: 'relief', type: 'color-relief', source: 'dem-relief', paint: { 'color-relief-color': colorReliefExpression() as never, 'color-relief-opacity': 1 } },
      {
        id: 'hillshade', type: 'hillshade', source: 'dem-relief',
        paint: {
          'hillshade-method': 'multidirectional',
          'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 0, 0.75, 6, 0.5, 9, 0.35],
          'hillshade-shadow-color': ['rgba(3,6,16,0.55)'],
          'hillshade-highlight-color': ['rgba(220,235,255,0.20)'],
          'hillshade-illumination-direction': [315],
          'hillshade-illumination-altitude': [40],
        } as never,
      },
      { id: 'veil', type: 'raster', source: 'veil', layout: { visibility: 'none' }, paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 } },
      { id: 'new2026', type: 'raster', source: 'new2026', layout: { visibility: 'none' }, paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 } },
      shippingLayer(),
      {
        id: 'plates', type: 'line', source: 'plates', layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': plateColorExpression() as never,
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 2.2, 3, 2.6, 6, 3, 9, 3.4],
          'line-opacity': 0.95,
          'line-dasharray': ['match', ['get', 'type'], 'transform', ['literal', [2, 1.5]], 'convergent', ['literal', [0.6, 1.6]], 'rift', ['literal', [3, 1.5]], ['literal', [1, 0]]] as never,
        },
      },
      // above relief, veil and plates, below the gazetteer labels (which are placed first and never hidden)
      ...overlayLayers(LABEL_FONT),
      ...featureLayers(),
      { id: 'profile-casing', type: 'line', source: 'profile', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#04080f', 'line-width': 5, 'line-opacity': 0.75 } },
      { id: 'profile-line', type: 'line', source: 'profile', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': SURVEY_LINE, 'line-width': 2.2 } },
      { id: 'profile-ends', type: 'circle', source: 'profile', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#04080f', 'circle-stroke-color': SURVEY_LINE, 'circle-stroke-width': 2.2 } },
      { id: 'cursor', type: 'circle', source: 'cursor', paint: { 'circle-radius': 5.5, 'circle-color': SURVEY_LINE, 'circle-stroke-color': '#04080f', 'circle-stroke-width': 2 } },
    ],
  };
}
