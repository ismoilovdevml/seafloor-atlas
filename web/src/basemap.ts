// Satellite land: Esri World Imagery drawn under the relief, with the relief's land colours made transparent, so
// land shows the photo and the ocean keeps our GEBCO colours. The ramp edits are pure functions over the stop lists
// (palette.ts), so the sea-level and under-layer ramps keep working: whatever is water or tinted stays opaque.
// Attribution: "Powered by Esri" plus the copyrightText the service publishes at World_Imagery/MapServer?f=json
// (checked 2026-11-20). Switched off (#land=grey), nothing is fetched from Esri.
import type { RasterSourceSpecification } from 'maplibre-gl';
import { rampColorAt } from './palette';

export const SAT_COPYRIGHT = 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
export const SAT_ATTRIBUTION = `Powered by Esri · ${SAT_COPYRIGHT}`;
export function satSource(): RasterSourceSpecification {
  return {
    type: 'raster', tileSize: 256, maxzoom: 17, attribution: SAT_ATTRIBUTION,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  };
}

/** Satellite land is on unless the hash says `land=grey`. */
export function satLandFromHash(hash: string): boolean { return !/(?:^#|[#&])land=grey(?:&|$)/.test(hash); }
/** The hash with land=grey when satellite land is off (dropped when on, the default), other parts kept in order. */
export function hashWithLand(hash: string, sat: boolean): string {
  const parts = hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith('land='));
  if (!sat) parts.push('land=grey');
  return parts.length ? `#${parts.join('&')}` : '';
}

export const CLEAR = 'rgba(0,0,0,0)';
/** Every stop at or above landFrom (dry land at the shown sea level) made transparent. */
export function clearLand(stops: [number, string][], landFrom: number): [number, string][] {
  return stops.map(([h, c]) => [h, h >= landFrom ? CLEAR : c]);
}

/** Ice-sheet whites for land on the polar caps, where the photo tiles stop (85.05 degrees). */
export const ICE_STOPS: [number, string][] = [[0.01, '#d9e2e8'], [1000, '#e6edf1'], [2500, '#eff4f7'], [4500, '#f6f9fb']];
/** The same stops with the land part replaced by ICE_STOPS (hex only: the polar layer's lookup table reads hex). */
export function iceLand(stops: [number, string][], landFrom: number): [number, string][] {
  const keep = stops.filter(([h]) => h < landFrom);
  return [...keep, [landFrom, rampColorAt(ICE_STOPS, landFrom)], ...ICE_STOPS.filter(([h]) => h > landFrom)];
}

export function rampExpression(stops: [number, string][]): unknown[] {
  const e: unknown[] = ['interpolate', ['linear'], ['elevation']];
  for (const [h, c] of stops) e.push(h, c);
  return e;
}
