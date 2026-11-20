// Optional Esri basemaps (picture only). The default background is our own GEBCO relief; an Esri basemap replaces
// its colour and shading while every data layer, the readout and the inspector keep reading our tiles.
// Each source carries its own attribution: "Powered by Esri" plus the copyrightText the service publishes at
// <service>/MapServer?f=json (checked 2026-11-20). The tiles are fetched only after a viewer picks one.
import type { RasterSourceSpecification } from 'maplibre-gl';

export type BaseId = 'atlas' | 'sat' | 'ocean' | 'topo';
export interface EsriBase { id: Exclude<BaseId, 'atlas'>; label: string; title: string; service: string; maxzoom: number; copyright: string }

export const ESRI: EsriBase[] = [
  { id: 'sat', label: 'Satellite', title: 'Esri World Imagery: satellite and aerial photos', service: 'World_Imagery', maxzoom: 17,
    copyright: 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community' },
  { id: 'ocean', label: 'Ocean', title: 'Esri World Ocean Base: shaded ocean relief (itself modelled from GEBCO and other grids)', service: 'Ocean/World_Ocean_Base', maxzoom: 13,
    copyright: 'Esri, Garmin, GEBCO, NOAA NGDC, and other contributors' },
  { id: 'topo', label: 'Topo', title: 'Esri World Topographic Map', service: 'World_Topo_Map', maxzoom: 17,
    copyright: 'Sources: Esri, HERE, Garmin, Intermap, increment P Corp., GEBCO, USGS, FAO, NPS, NRCAN, GeoBase, IGN, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), (c) OpenStreetMap contributors, and the GIS User Community' },
];

export function esriAttribution(b: EsriBase): string { return `Powered by Esri · ${b.copyright}`; }

export function esriSource(b: EsriBase): RasterSourceSpecification {
  return {
    type: 'raster', tileSize: 256, maxzoom: b.maxzoom, attribution: esriAttribution(b),
    tiles: [`https://server.arcgisonline.com/ArcGIS/rest/services/${b.service}/MapServer/tile/{z}/{y}/{x}`],
  };
}

const IDS = new Set<string>(['atlas', ...ESRI.map((b) => b.id)]);
/** `#...&base=sat` -> 'sat'; anything else -> 'atlas'. */
export function baseFromHash(hash: string): BaseId {
  const m = /(?:^#|[#&])base=([a-z]+)(?:&|$)/.exec(hash);
  return m && IDS.has(m[1]) ? (m[1] as BaseId) : 'atlas';
}
/** The hash with base= set (dropped for the default 'atlas'), other parts kept in order. */
export function hashWithBase(hash: string, id: BaseId): string {
  const parts = hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith('base='));
  if (id !== 'atlas') parts.push(`base=${id}`);
  return parts.length ? `#${parts.join('&')}` : '';
}
