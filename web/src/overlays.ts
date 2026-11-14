// "Human activity at sea" overlays: submarine cables + landing points, shipping density, shipwrecks, offshore
// platforms, subsea pipelines and offshore wind farms (data and licences in docs/data-contract.md,
// "Context overlays"). This module has no DOM: MapLibre layer specs, colours, filters, the #layers= deep link,
// card text and search ranking, unit-tested in test/overlays.test.ts. The DOM side is overlay-ui.ts.
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';

export type OverlayId = 'cables' | 'shipping' | 'wrecks' | 'platforms' | 'pipelines' | 'wind';
/** Panel order (also the order of tokens in the hash). */
export const OVERLAY_IDS: OverlayId[] = ['cables', 'shipping', 'wrecks', 'platforms', 'pipelines', 'wind'];
export type DataKey = 'cables' | 'landing' | 'wrecks' | 'platforms' | 'pipelines' | 'wind';
export const DATA_FILES: Record<DataKey, string> = {
  cables: 'cables.geojson', landing: 'landing-points.geojson', wrecks: 'wrecks.geojson',
  platforms: 'platforms.geojson', pipelines: 'pipelines.geojson', wind: 'windfarms.geojson',
};
/** Which GeoJSON files an overlay needs (shipping is raster tiles). */
export const OVERLAY_DATA: Record<OverlayId, DataKey[]> = {
  cables: ['cables', 'landing'], shipping: [], wrecks: ['wrecks'], platforms: ['platforms'], pipelines: ['pipelines'], wind: ['wind'],
};

/** Attribution lines, verbatim from the data contract's licence table (also in each file's metadata). */
export const ATTRIBUTION = {
  shipping: 'Shipping density: World Bank / IMF (Cerdeiro, Komaromi, Liu & Saeed 2020), CC BY 4.0',
  wrecks: 'Shipwrecks: Wikidata (CC0)',
  cables: 'Submarine cables: TeleGeography Submarine Cable Map data, snapshot 2022-11-14, CC BY-NC-SA 3.0 (submarinecablemap.com)',
  osm: '© OpenStreetMap contributors (ODbL)',
} as const;
export const OVERLAY_ATTRIBUTION: Record<OverlayId, string> = {
  cables: ATTRIBUTION.cables, shipping: ATTRIBUTION.shipping, wrecks: ATTRIBUTION.wrecks,
  platforms: ATTRIBUTION.osm, pipelines: ATTRIBUTION.osm, wind: ATTRIBUTION.osm,
};
export const CABLE_SNAPSHOT = '2022-11-14';

// Colours. Three hue slots (cable orchid, gas gold, oil orange) validated as a set with the dataviz validator
// against the abyss (#21163b), all pairs: CVD dE >= 11.5 (deutan) / 8.5 (tritan), normal-vision dE >= 17.5,
// contrast >= 3:1. They sit lighter than a chart's mark band on purpose: the marks lie on both the violet abyss
// and the pale shelf, so each has a dark casing / ring and a mid-high lightness. None of them is a relief hue
// (teal -> blue -> violet, grey land). Pipelines and platforms share the substance colours, so one key reads for
// both; wind and wrecks are told apart by glyph shape, not hue. Pipeline substance is also dash-coded.
export const OV_COLOR = {
  cable: '#e872c8',
  gas: '#e9b62c',
  oil: '#f26a2e',
  unknown: '#b9b2a4',
  wind: '#f2f8ff',
  windInk: '#0b2f3a',
  wreck: '#ecdcb4',
  other: '#a3adb6',
  casing: '#050a14',
  highlight: '#ffffff',
} as const;

export const NOTABLE_MIN_SITELINKS = 1;
/** Default wreck view: items with at least one Wikimedia sitelink (an article in some wiki); "all" adds the bulk imports. */
export function isNotableWreck(p: { sitelinks?: number }): boolean { return (p.sitelinks ?? 0) >= NOTABLE_MIN_SITELINKS; }
export function wreckFilter(all: boolean): unknown[] {
  return all ? ['boolean', true] : ['>=', ['coalesce', ['get', 'sitelinks'], 0], NOTABLE_MIN_SITELINKS];
}

/** Map layers per overlay; the first id is the one whose visibility tests read. */
export const OVERLAY_LAYERS: Record<OverlayId, string[]> = {
  shipping: ['shipping'],
  pipelines: ['pipelines', 'pipelines-casing'],
  cables: ['cables', 'cables-casing', 'landing-points'],
  platforms: ['platforms', 'platforms-cluster', 'platforms-count'],
  wind: ['wind'],
  wrecks: ['wrecks'],
};
/** Layers a click or hover can hit, topmost first. */
export const CLICKABLE_LAYERS = ['wrecks', 'wind', 'platforms', 'platforms-cluster', 'landing-points', 'cables', 'pipelines'];

export const ICONS = {
  oil: 'pf-oil', gas: 'pf-gas', oilGas: 'pf-oilgas', windSub: 'pf-wind', other: 'pf-other', windFarm: 'wind-farm', wreck: 'wreck',
} as const;

/** Raster + GeoJSON sources, all empty until a layer is first switched on (no download at page load). */
export function overlaySources(shippingBase: string, tileSize = 512): Record<string, SourceSpecification> {
  const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
  return {
    shipping: { type: 'raster', tiles: [`${shippingBase}{z}/{x}/{y}.webp`], tileSize, minzoom: 0, maxzoom: 5 },
    pipelines: { type: 'geojson', data: empty },
    cables: { type: 'geojson', data: empty },
    landing: { type: 'geojson', data: empty },
    platforms: { type: 'geojson', data: empty, cluster: true, clusterRadius: 38, clusterMaxZoom: 6, clusterMinPoints: 3 },
    wind: { type: 'geojson', data: empty },
    wrecks: { type: 'geojson', data: empty },
    'ov-hl': { type: 'geojson', data: empty },
  };
}

const NONE = { visibility: 'none' as const };
const zoomWidth = (stops: [number, number][], add = 0) => ['interpolate', ['linear'], ['zoom'], ...stops.flatMap(([z, w]) => [z, w + add])];
const PIPE_W: [number, number][] = [[0, 1.2], [4, 1.8], [7, 2.6], [9, 3.2]];
const CABLE_W: [number, number][] = [[0, 0.9], [3, 1.2], [6, 1.7], [9, 2.4]];
const SL = ['coalesce', ['get', 'sitelinks'], 0];

/** The raster shipping layer: goes above the coverage veil / new-2026 layers. */
export function shippingLayer(): LayerSpecification {
  return { id: 'shipping', type: 'raster', source: 'shipping', layout: NONE, paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } };
}

/** Vector overlay layers, bottom to top; inserted above plate boundaries and below the feature labels. */
export function overlayLayers(labelFont: string): LayerSpecification[] {
  const text = { 'text-font': [labelFont], 'text-optional': true, 'text-variable-anchor': ['left', 'right', 'top'], 'text-radial-offset': 0.7, 'text-justify': 'auto', 'text-max-width': 9, 'text-padding': 2 };
  const halo = { 'text-halo-color': 'rgba(4,9,18,0.92)', 'text-halo-width': 1.4, 'text-halo-blur': 0.3 };
  return [
    {
      id: 'pipelines-casing', type: 'line', source: 'pipelines', layout: { ...NONE, 'line-join': 'round' },
      paint: { 'line-color': OV_COLOR.casing, 'line-opacity': ['case', ['==', ['get', 'status'], 'disused'], 0.35, 0.6], 'line-width': zoomWidth(PIPE_W, 2) },
    },
    {
      id: 'pipelines', type: 'line', source: 'pipelines', layout: { ...NONE, 'line-join': 'round', 'line-cap': 'butt' },
      paint: {
        'line-color': ['match', ['get', 'substance'], 'gas', OV_COLOR.gas, ['oil', 'oil_gas'], OV_COLOR.oil, OV_COLOR.unknown],
        'line-dasharray': ['match', ['get', 'substance'], 'gas', ['literal', [1, 0]], ['oil', 'oil_gas'], ['literal', [2.6, 1.4]], ['literal', [0.7, 1.6]]],
        'line-opacity': ['case', ['==', ['get', 'status'], 'disused'], 0.5, 0.95],
        'line-width': zoomWidth(PIPE_W),
      },
    },
    {
      id: 'cables-casing', type: 'line', source: 'cables', layout: { ...NONE, 'line-join': 'round' },
      paint: { 'line-color': OV_COLOR.casing, 'line-opacity': 0.5, 'line-width': zoomWidth(CABLE_W, 1.6) },
    },
    {
      id: 'cables', type: 'line', source: 'cables', layout: { ...NONE, 'line-join': 'round' },
      paint: {
        'line-color': OV_COLOR.cable, 'line-opacity': 0.92, 'line-width': zoomWidth(CABLE_W),
        'line-dasharray': ['case', ['==', ['get', 'planned'], true], ['literal', [2.2, 1.6]], ['literal', [1, 0]]],
      },
    },
    {
      id: 'landing-points', type: 'circle', source: 'landing', minzoom: 2.5, layout: NONE,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2.5, 1.8, 6, 3.2, 9, 4.6],
        'circle-color': OV_COLOR.cable, 'circle-stroke-color': OV_COLOR.casing, 'circle-stroke-width': 1,
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: 'platforms-cluster', type: 'circle', source: 'platforms', filter: ['has', 'point_count'], layout: NONE,
      paint: {
        'circle-radius': ['step', ['get', 'point_count'], 8, 10, 10.5, 50, 13, 200, 16, 1000, 19],
        'circle-color': 'rgba(9,16,28,0.86)', 'circle-stroke-color': '#d9b98a', 'circle-stroke-width': 1.5,
      },
    },
    {
      id: 'platforms-count', type: 'symbol', source: 'platforms', filter: ['has', 'point_count'],
      layout: { ...NONE, 'text-field': ['get', 'point_count_abbreviated'], 'text-font': [labelFont], 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#f3ece0' },
    },
    {
      id: 'platforms', type: 'symbol', source: 'platforms', filter: ['!', ['has', 'point_count']],
      layout: {
        ...NONE,
        'icon-image': ['match', ['get', 'type'], 'oil', ICONS.oil, 'gas', ICONS.gas, 'oil_gas', ICONS.oilGas, 'wind', ICONS.windSub, ICONS.other],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 7, 1, 9, 1.2],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'text-field': ['step', ['zoom'], '', 8, ['coalesce', ['get', 'name'], '']], 'text-size': 11.5, ...text,
      },
      paint: { 'icon-opacity': ['case', ['==', ['get', 'status'], 'abandoned'], 0.55, 1], 'text-color': '#f1e2c8', ...halo },
    },
    {
      id: 'wind', type: 'symbol', source: 'wind',
      layout: {
        ...NONE,
        'icon-image': ICONS.windFarm,
        // glyph area grows with capacity (square-root scale), unknown capacity = smallest
        'icon-size': ['interpolate', ['linear'], ['zoom'],
          2, ['*', 0.7, ['interpolate', ['linear'], ['coalesce', ['get', 'capacity_mw'], 0], 0, 0.55, 100, 0.62, 400, 0.78, 1000, 0.95, 3000, 1.25]],
          7, ['interpolate', ['linear'], ['coalesce', ['get', 'capacity_mw'], 0], 0, 0.55, 100, 0.62, 400, 0.78, 1000, 0.95, 3000, 1.25]],
        'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'capacity_mw'], 0]],
        'icon-padding': 0,
        'text-field': ['step', ['zoom'], '', 6, ['coalesce', ['get', 'label'], ['get', 'name'], '']], 'text-size': 11.5, ...text,
      },
      paint: { 'text-color': '#e4f4ff', ...halo },
    },
    {
      id: 'wrecks', type: 'symbol', source: 'wrecks', filter: wreckFilter(false) as never,
      layout: {
        ...NONE,
        'icon-image': ICONS.wreck,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 1, ['case', ['>=', SL, 20], 0.85, 0.7], 7, ['case', ['>=', SL, 20], 1.05, 0.9]],
        'symbol-sort-key': ['-', 0, SL],
        'icon-padding': 1,
        // names of the most notable wrecks first, everything named from z7
        'text-field': ['step', ['zoom'], '',
          3, ['case', ['>=', SL, 40], ['get', 'name'], ''],
          4.2, ['case', ['>=', SL, 10], ['get', 'name'], ''],
          5.5, ['case', ['>=', SL, 1], ['get', 'name'], ''],
          7, ['coalesce', ['get', 'name'], '']],
        'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 8, 12.5], ...text,
      },
      paint: { 'text-color': OV_COLOR.wreck, ...halo },
    },
    { id: 'ov-hl-casing', type: 'line', source: 'ov-hl', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': OV_COLOR.casing, 'line-width': 6, 'line-opacity': 0.7 } },
    { id: 'ov-hl-line', type: 'line', source: 'ov-hl', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': OV_COLOR.highlight, 'line-width': 2.6 } },
    { id: 'ov-hl-point', type: 'circle', source: 'ov-hl', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 11, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': OV_COLOR.highlight, 'circle-stroke-width': 2.2 } },
  ] as LayerSpecification[];
}

// ---------- #layers= deep link ----------
export interface LayerState { ids: OverlayId[]; allWrecks: boolean }
/** `#layers=cables,wrecks` (alone or with story= / sea= / water=); `wrecks-all` = wrecks incl. bulk records. */
export function layersFromHash(hash: string): LayerState | null {
  const m = /(?:^#|[#&])layers=([\w,-]*)(?:&|$)/.exec(hash);
  if (!m) return null;
  const toks = m[1].split(',').filter(Boolean);
  const allWrecks = toks.includes('wrecks-all');
  const ids = OVERLAY_IDS.filter((id) => toks.includes(id) || (id === 'wrecks' && allWrecks));
  return { ids, allWrecks };
}
export function layersToken(s: LayerState): string {
  return OVERLAY_IDS.filter((id) => s.ids.includes(id)).map((id) => (id === 'wrecks' && s.allWrecks ? 'wrecks-all' : id)).join(',');
}
/** Writes or removes the layers= part, keeping the other parts in order. */
export function hashWithLayers(hash: string, s: LayerState | null): string {
  const parts = hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith('layers='));
  const tok = s ? layersToken(s) : '';
  if (tok) parts.push(`layers=${tok}`);
  return parts.length ? `#${parts.join('&')}` : '';
}

// ---------- formatting ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
export function fmtKm(km: number): string {
  return `${km.toLocaleString('en-US', { maximumFractionDigits: km < 100 ? 1 : 0 })} km`;
}
export function fmtMW(mw: number): string {
  return `${mw.toLocaleString('en-US', { maximumFractionDigits: mw < 10 ? 1 : 0 })} MW`;
}
/** '1912-04-15' -> '15 April 1912'; falls back to the year. */
export function fmtDate(date?: string, year?: number): string {
  const m = date ? /^(-?\d{1,4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${Number(m[1])}`;
  return year != null ? String(year) : '';
}
/** OSM-style free-text start dates: '2018-01' -> 'January 2018', '2021-12-20' -> '20 December 2021', else as written. */
export function fmtStart(s?: string): string {
  if (!s) return '';
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (full) return fmtDate(s);
  const ym = /^(\d{4})-(\d{2})$/.exec(s);
  if (ym && Number(ym[2]) >= 1 && Number(ym[2]) <= 12) return `${MONTHS[Number(ym[2]) - 1]} ${ym[1]}`;
  return s;
}
/** Diameter tag: plain numbers are millimetres in OSM. */
export function fmtDiameter(d?: string): string {
  if (!d) return '';
  return /^\d+(\.\d+)?$/.test(d.trim()) ? `${fmtInt(Number(d))} mm` : d;
}
/** 'Hornsea 1 Offshore Wind Farm' -> 'Hornsea 1' for map labels (the card keeps the full name). */
export function shortWindName(name?: string): string {
  if (!name) return '';
  const s = name.replace(/\s+(offshore\s+)?wind\s*(farm|park|power\s+plant|project)?$/i, '').replace(/\s+offshore$/i, '').trim();
  return s || name;
}
/** https:// or http:// only (data comes from third-party registries). */
export function safeUrl(u?: string): string | null {
  if (!u) return null;
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
}
export function commonsThumb(file: string, width = 480): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, '_'))}?width=${width}`;
}
export const wikipediaUrl = (title: string) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
export const wikidataUrl = (q: string) => `https://www.wikidata.org/wiki/${encodeURIComponent(q)}`;
/** OSM element link from our ids: n123 / w123 / r123. */
export function osmUrl(id?: string): string | null {
  const m = id ? /^([nwr])(\d+)$/.exec(id) : null;
  return m ? `https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[m[1] as 'n' | 'w' | 'r']}/${m[2]}` : null;
}
/** "A, B, C and 4 more" */
export function listText(xs: string[], max = 8): string {
  const a = xs.filter(Boolean);
  if (a.length <= max) return a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : (a[0] ?? '');
  return `${a.slice(0, max).join(', ')} and ${a.length - max} more`;
}

// ---------- cards ----------
export interface CardLink { href: string; label: string }
export interface CardModel {
  kind: string; name: string; lead: string;
  facts: [string, string][]; links: CardLink[];
  image?: { src: string; alt: string; credit: string };
  note?: string; source: string;
}
const facts = (xs: [string, string | undefined | null | false][]): [string, string][] => xs.filter((x): x is [string, string] => !!x[1]);

export interface CableProps { id: string; name: string; length_km?: number; rfs?: string; rfs_year?: number; planned?: boolean; owners?: string; suppliers?: string; url?: string; landing_points?: string[] }
export function cableCard(p: CableProps, landingName: (id: string) => string | undefined): CardModel {
  const lps = (p.landing_points ?? []).map((id) => landingName(id) ?? id);
  const len = p.length_km ? fmtKm(p.length_km) : '';
  const lead = p.planned
    ? `Planned${p.rfs ? `, ready for service ${p.rfs}` : ''}${len ? `; ${len} long` : ''} (status as of ${fmtDate(CABLE_SNAPSHOT)})`
    : [len ? `${len} long` : '', p.rfs ? `in service since ${p.rfs}` : ''].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase());
  const url = safeUrl(p.url);
  return {
    kind: p.planned ? 'Submarine cable, planned' : 'Submarine cable', name: p.name, lead,
    facts: facts([['Owners', p.owners], ['Built by', p.suppliers], [`Lands at (${lps.length})`, lps.length ? listText(lps, 10) : '']]),
    links: url ? [{ href: url, label: 'Operator website' }] : [],
    note: 'The route is a schematic drawing, not the surveyed cable position.',
    source: `TeleGeography snapshot ${CABLE_SNAPSHOT}, CC BY-NC-SA 3.0`,
  };
}
export interface LandingProps { id: string; name: string; country?: string; cables?: string[]; tbd?: boolean }
export function landingCard(p: LandingProps, cableName: (id: string) => string | undefined): CardModel {
  const names = (p.cables ?? []).map((id) => cableName(id) ?? id);
  return {
    kind: 'Cable landing point', name: p.name,
    lead: `${names.length} ${names.length === 1 ? 'cable lands' : 'cables land'} here${p.tbd ? ' (exact site to be decided)' : ''}`,
    facts: facts([['Country', p.country], ['Cables', listText(names, 12)]]),
    links: [], source: `TeleGeography snapshot ${CABLE_SNAPSHOT}, CC BY-NC-SA 3.0`,
  };
}
export interface WreckProps { id: string; name?: string; date?: string; year?: number; type?: string; image?: string; wiki?: string; sitelinks?: number; depth_m?: number; src?: string }
export function wreckCard(p: WreckProps): CardModel {
  const when = fmtDate(p.date, p.year);
  const links: CardLink[] = [];
  if (p.wiki) links.push({ href: wikipediaUrl(p.wiki), label: 'Wikipedia' });
  links.push({ href: wikidataUrl(p.id), label: `Wikidata ${p.id}` });
  return {
    kind: p.type ? `Shipwreck, ${p.type}` : 'Shipwreck', name: p.name || 'Unnamed wreck',
    lead: p.depth_m != null ? `Seafloor about ${fmtInt(p.depth_m)} m deep at the recorded position` : '',
    facts: facts([[p.src === 'event' ? 'Sank' : 'Lost', when]]),
    links,
    image: p.image ? { src: commonsThumb(p.image), alt: p.name ? `Photo or drawing of ${p.name}` : 'Wreck image', credit: 'Image: Wikimedia Commons' } : undefined,
    note: 'Depth is the GEBCO 2026 grid depth at the Wikidata coordinate, not a survey of the wreck; many positions are historical estimates.',
    source: 'Wikidata (CC0)',
  };
}
export interface PlatformProps { id: string; name?: string; type?: string; status?: string; operator?: string; start?: string; country?: string; depth_m?: number; wikidata?: string }
export const PLATFORM_KIND: Record<string, string> = {
  oil: 'Oil platform', gas: 'Gas platform', oil_gas: 'Oil and gas platform', wind: 'Offshore wind substation',
  other: 'Offshore platform (research, accommodation or other)', unknown: 'Offshore platform, use not tagged',
};
export function platformCard(p: PlatformProps): CardModel {
  const links: CardLink[] = [];
  const o = osmUrl(p.id); if (o) links.push({ href: o, label: 'OpenStreetMap' });
  if (p.wikidata) links.push({ href: wikidataUrl(p.wikidata), label: 'Wikidata' });
  return {
    kind: `${PLATFORM_KIND[p.type ?? 'unknown'] ?? PLATFORM_KIND.unknown}${p.status === 'abandoned' ? ', abandoned' : ''}`,
    name: p.name || 'Unnamed platform',
    lead: p.depth_m != null ? `Stands in about ${fmtInt(p.depth_m)} m of water` : '',
    facts: facts([['Operator', p.operator], ['Started', fmtStart(p.start)], ['Waters of', p.country]]),
    links, source: ATTRIBUTION.osm,
  };
}
export interface PipelineProps { name?: string; substance?: string; operator?: string; status?: string; diameter?: string; length_km?: number; countries?: string[]; osm?: string[]; wikidata?: string }
export const SUBSTANCE_LABEL: Record<string, string> = { gas: 'Gas', oil: 'Oil', oil_gas: 'Oil and gas', unknown: 'Hydrocarbon' };
export function pipelineCard(p: PipelineProps): CardModel {
  const links: CardLink[] = [];
  const o = osmUrl(p.osm?.[0]); if (o) links.push({ href: o, label: 'OpenStreetMap' });
  if (p.wikidata) links.push({ href: wikidataUrl(p.wikidata), label: 'Wikidata' });
  return {
    kind: `${SUBSTANCE_LABEL[p.substance ?? 'unknown'] ?? 'Hydrocarbon'} pipeline, subsea${p.status === 'disused' ? ', disused' : ''}`,
    name: p.name || 'Unnamed pipeline',
    lead: p.length_km ? `${fmtKm(p.length_km)} under water` : '',
    facts: facts([['Operator', p.operator], ['Diameter', fmtDiameter(p.diameter)], ['Crosses the waters of', p.countries?.length ? listText(p.countries) : '']]),
    links, source: ATTRIBUTION.osm,
  };
}
export interface WindProps { id: string; name?: string; capacity_mw?: number; status?: string; start?: string; operator?: string; turbines?: string; country?: string; depth_m?: number; wikidata?: string }
export function windCard(p: WindProps): CardModel {
  const links: CardLink[] = [];
  const o = osmUrl(p.id); if (o) links.push({ href: o, label: 'OpenStreetMap' });
  if (p.wikidata) links.push({ href: wikidataUrl(p.wikidata), label: 'Wikidata' });
  const t = p.turbines && /^\d+$/.test(p.turbines) ? Number(p.turbines) : null;
  const lead = p.capacity_mw ? `${fmtMW(p.capacity_mw)}${t ? ` from ${fmtInt(t)} turbines` : ''}` : t ? `${fmtInt(t)} turbines` : 'Capacity not recorded';
  return {
    kind: `Offshore wind farm${p.status === 'construction' ? ', under construction' : ''}`, name: p.name || 'Unnamed wind farm', lead,
    facts: facts([['Started', fmtStart(p.start)], ['Operator', p.operator], ['Waters of', p.country], ['Water depth', p.depth_m != null ? `about ${fmtInt(p.depth_m)} m` : '']]),
    links, source: ATTRIBUTION.osm,
  };
}

// ---------- search ----------
export type SearchKind = 'story' | 'feature' | 'cable' | 'wreck';
export interface SearchEntry { name: string; label: string; kind: SearchKind; key: string; n: string }
export const normName = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Prefix matches first, then any substring match; alphabetical within each group. */
export function searchRank(entries: SearchEntry[], query: string, limit = 12): SearchEntry[] {
  const q = normName(query.trim());
  if (!q) return [];
  return entries.filter((e) => e.n.includes(q))
    .sort((a, b) => Number(!a.n.startsWith(q)) - Number(!b.n.startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
