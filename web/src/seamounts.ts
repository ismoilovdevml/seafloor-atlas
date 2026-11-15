// Seamounts: SDUST2026SM + SIO 2023 (Kim & Wessel census) merged by pipeline/seamounts.py into columnar
// data/seamounts.json, with GEBCO_2026 summit depth and TID. Decoding, layer spec and card. No DOM
// (test/seamounts.test.ts). Contract: docs/data-contract.md, "Seamounts".
import type { LayerSpecification } from 'maplibre-gl';
import type { CardModel } from './overlays';

export const SEAMOUNT_ATTRIBUTION = 'Seamounts: SDUST2026SM (Gao et al. 2026) and SIO 2023 / Kim & Wessel 2011 (Gevorgian et al. 2023), CC BY 4.0; summits from GEBCO_2026';

export interface SeamountColumns {
  metadata: { attribution: string; count: number; stats?: Record<string, unknown> };
  n: number; lon: number[]; lat: number[]; height_m: number[]; base_depth_m: number[]; summit_depth_m: (number | null)[];
  tid: number[]; src: number[]; cat: string[]; sdust_id: number[]; name: string[];
}
export interface SeamountProps { h: number; bd: number; sd: number | null; tid: number; m: 0 | 1; src: number; cat: string; sid: number; name: string }

/** GEBCO type identifier 10-17 = a direct measurement in the cell. */
export const isMeasuredTid = (tid: number) => tid >= 10 && tid <= 17;

export function seamountsToGeoJSON(d: SeamountColumns): GeoJSON.FeatureCollection<GeoJSON.Point, SeamountProps> {
  const features = new Array(d.n);
  for (let i = 0; i < d.n; i++) {
    features[i] = {
      type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [d.lon[i], d.lat[i]] },
      properties: { h: d.height_m[i], bd: d.base_depth_m[i], sd: d.summit_depth_m[i], tid: d.tid[i], m: isMeasuredTid(d.tid[i]) ? 1 : 0, src: d.src[i], cat: d.cat[i], sid: d.sdust_id[i], name: d.name[i] },
    };
  }
  return { type: 'FeatureCollection', features };
}

/** Shares for the (i) note: measured summits and named seamounts. */
export function seamountShares(d: SeamountColumns): { n: number; measured: number; named: number } {
  let measured = 0, named = 0;
  for (let i = 0; i < d.n; i++) { if (isMeasuredTid(d.tid[i])) measured++; if (d.name[i]) named++; }
  return { n: d.n, measured, named };
}

/**
 * Two states, told apart by shape first: a measured summit is a filled cream dot with a dark ring (solid =
 * sounded); an unmeasured summit is an open steel-blue ring (hollow = predicted from gravity). All-pairs
 * normal-vision dE 25.6, CVD dE 23.4, both >= 3:1 on the abyss (dataviz validator); the blue sits under the
 * categorical chroma floor on purpose, because the ring shape carries the identity.
 */
export const SEAMOUNT_COLOR = { measured: '#f3efe4', unmeasured: '#7fa6c4', casing: '#050a14' } as const;

/** Height filter by zoom: the tallest first, every seamount from z5 (69,770 would be a fog on the whole globe). */
export const HEIGHT_BY_ZOOM: [number, number][] = [[0, 1500], [3, 1000], [4, 500], [5, 0]];
export function heightFilter(): unknown[] {
  // zoom only as the input of a top-level step (filters are evaluated per tile zoom, integer steps)
  const test = (h: number) => (h > 0 ? ['>=', ['get', 'h'], h] : true);
  return ['step', ['zoom'], test(HEIGHT_BY_ZOOM[0][1]), ...HEIGHT_BY_ZOOM.slice(1).flatMap(([z, h]) => [z, test(h)])];
}

export function seamountLayers(): LayerSpecification[] {
  const r = (k: number) => ['interpolate', ['linear'], ['sqrt', ['max', 100, ['get', 'h']]], 10, 1.2 * k, 30, 2.4 * k, 50, 3.6 * k, 80, 5.6 * k];
  return [{
    id: 'seamounts', type: 'circle', source: 'seamounts', filter: heightFilter() as never,
    layout: { visibility: 'none', 'circle-sort-key': ['get', 'h'] } as never,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, r(0.8), 4, r(1.2), 8, r(2)] as never,
      'circle-color': ['case', ['==', ['get', 'm'], 1], SEAMOUNT_COLOR.measured, SEAMOUNT_COLOR.unmeasured] as never,
      'circle-opacity': ['case', ['==', ['get', 'm'], 1], 0.95, 0] as never,
      'circle-stroke-color': ['case', ['==', ['get', 'm'], 1], SEAMOUNT_COLOR.casing, SEAMOUNT_COLOR.unmeasured] as never,
      'circle-stroke-width': ['case', ['==', ['get', 'm'], 1], 0.8, 1.3] as never,
      'circle-stroke-opacity': 0.9,
      'circle-pitch-alignment': 'map',
    },
  }] as LayerSpecification[];
}

export const TID_LABEL: Record<number, string> = {
  0: 'land in the grid', 10: 'singlebeam sonar', 11: 'multibeam sonar', 12: 'seismic', 13: 'isolated sounding', 14: 'chart sounding (ENC)',
  15: 'lidar', 16: 'optical sensor', 17: 'combination of direct methods', 40: 'predicted from satellite gravity', 41: 'interpolated',
  42: 'digitised chart contours', 43: 'chart contours (ENC)', 44: 'bathymetric sounding, position uncertain', 45: 'predicted by flight-based gravity', 46: 'other GEBCO grid',
  70: 'pre-generated grid', 71: 'unknown source', 72: 'steering points',
};

export function seamountCard(p: SeamountProps): CardModel {
  const m = (v: number) => `${Math.round(v).toLocaleString('en-US')} m`;
  const summit = p.sd == null ? 'summit depth not in the grid'
    : p.sd < 0 ? `summit ${m(-p.sd)} above sea level in the grid` : `summit ${m(p.sd)} below the surface`;
  const measured = isMeasuredTid(p.tid)
    ? `Yes: the summit cell holds a ${TID_LABEL[p.tid] ?? `type ${p.tid}`} measurement`
    : `No: ${TID_LABEL[p.tid] ?? `type ${p.tid}`} (GEBCO type ${p.tid})`;
  const cats: string[] = [];
  if (p.src === 0 && p.sid) cats.push(`SDUST2026SM no. ${p.sid}`);
  if (p.cat) cats.push(p.cat.startsWith('KW-') ? `Kim & Wessel 2011 ${p.cat}` : `SIO 2023 ${p.cat}`);
  return {
    kind: p.src === 1 ? 'Seamount (SIO 2023 catalogue only)' : 'Seamount',
    name: p.name || 'Unnamed seamount',
    lead: `${m(p.h)} tall, ${summit}`,
    facts: [
      ['Summit measured', measured],
      ['Base depth', m(p.bd)],
      ['Catalogues', cats.join('; ') || 'n/a'],
    ],
    links: [],
    note: 'Positions and heights come from satellite gravity; the summit is the shallowest GEBCO 2026 cell near the catalogue centre.',
    source: p.src === 1 ? 'SIO 2023 (Gevorgian et al. 2023), CC BY 4.0; GEBCO_2026' : 'SDUST2026SM (Gao et al. 2026, in review), CC BY 4.0; GEBCO_2026',
  };
}
