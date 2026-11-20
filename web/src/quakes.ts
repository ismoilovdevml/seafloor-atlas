// Earthquakes: USGS ComCat M >= 5.5 since 1900 (columnar data/quakes.json, pipeline/quakes.py) and the live USGS
// "past 30 days, M >= 2.5" feed. Decoding, MapLibre layer specs, the year filter for the Time panel, per-year
// statistics and the card text. No DOM (test/quakes.test.ts). Contract: docs/data-contract.md, "Earthquakes".
import type { LayerSpecification } from 'maplibre-gl';
import type { CardModel } from './overlays';

export const QUAKE_ATTRIBUTION = 'Earthquakes: USGS ANSS ComCat (public domain)';
export const LIVE_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson';
export const eventPage = (id: string) => `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(id)}`;

export interface QuakeColumns {
  metadata: { attribution: string; minmag: number; count: number; first: string; newest: string };
  n: number; lon: number[]; lat: number[]; time: number[]; mag: number[]; depth_km: (number | null)[]; id: string[]; place: string[];
}
export interface QuakeProps { mag: number; depth: number; time: number; year: number; id: string; place: string; live?: boolean }
export type QuakeFC = GeoJSON.FeatureCollection<GeoJSON.Point, QuakeProps>;

/** Columns -> GeoJSON (depth -1 = unknown; MapLibre expressions cannot test null cheaply). */
export function quakesToGeoJSON(d: QuakeColumns): QuakeFC {
  const features: QuakeFC['features'] = new Array(d.n);
  for (let i = 0; i < d.n; i++) {
    const t = d.time[i];
    const dep = d.depth_km[i];
    features[i] = {
      type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [d.lon[i], d.lat[i]] },
      // Clamp shallow above-sea-level hypocentres (e.g. -1..-3 km in volcanic edifices) to 0 km so -1 stays the unknown sentinel.
      properties: { mag: d.mag[i], depth: dep == null ? -1 : Math.max(0, dep), time: t, year: new Date(t).getUTCFullYear(), id: d.id[i], place: d.place[i] },
    };
  }
  return { type: 'FeatureCollection', features };
}

/** The USGS summary feed -> the same properties (depth is the third coordinate, km). */
export function liveToGeoJSON(fc: GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>>): QuakeFC {
  const features: QuakeFC['features'] = [];
  for (const [i, f] of fc.features.entries()) {
    const p = f.properties ?? {}, c = f.geometry?.coordinates;
    // typeof, not Number(): Number(null) is 0, and the feed has null magnitudes/depths for some events
    const mag = typeof p.mag === 'number' ? p.mag : NaN, t = typeof p.time === 'number' ? p.time : NaN;
    if (!c || !Number.isFinite(mag) || !Number.isFinite(t)) continue;
    const dep = typeof c[2] === 'number' ? c[2] : NaN;
    features.push({
      type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [c[0], c[1]] },
      properties: { mag, depth: Number.isFinite(dep) ? Math.max(0, Math.round(dep)) : -1, time: t, year: new Date(t).getUTCFullYear(), id: String(f.id ?? p.code ?? ''), place: String(p.place ?? ''), live: true },
    });
  }
  // largest drawn last (on top) is done by circle-sort-key; keep the feed order otherwise
  return { type: 'FeatureCollection', features };
}

// ---------- colour and size ----------
/**
 * Depth, shallow -> deep: one warm family with lightness falling monotonically (OKLCH L 0.95 -> 0.68), every
 * stop >= 3:1 on the violet abyss (#21163b and #33386f, checked with the dataviz validator); a dark casing ring
 * separates the circles on the pale shelf. Stops at the conventional class limits 70 km and 300 km.
 */
export const DEPTH_STOPS: [number, string][] = [[0, '#fff0b3'], [70, '#ffc15e'], [300, '#ff8a50'], [700, '#f2607e']];
export const DEPTH_UNKNOWN = '#c4ccd3';
export const CASING = '#050a14';
export function depthColorExpression(): unknown[] {
  return ['case', ['<', ['get', 'depth'], 0], DEPTH_UNKNOWN, ['interpolate', ['linear'], ['get', 'depth'], ...DEPTH_STOPS.flat()]];
}
/** Circle radius (px) by magnitude at zoom 2; area roughly doubles per magnitude step, M 9.5 about 15 px. */
export const MAG_RADIUS: [number, number][] = [[2.5, 1.3], [4.5, 1.7], [5.5, 2.1], [6.5, 3.4], [7.5, 5.6], [8.5, 9.5], [9.5, 15]];
export function radiusExpression(scale = 1): unknown[] {
  const at = (k: number) => ['interpolate', ['linear'], ['get', 'mag'], ...MAG_RADIUS.flatMap(([m, r]) => [m, +(r * k * scale).toFixed(2)])];
  return ['interpolate', ['linear'], ['zoom'], 1, at(0.8), 2, at(1), 5, at(1.5), 8, at(2.1)];
}
export const depthClass = (d: number) => (d < 0 ? 'depth unknown' : d < 70 ? 'shallow' : d < 300 ? 'intermediate depth' : 'deep');

/** Year filter for the Time panel: null = all; cumulative = up to and including `year`; else that year only. */
export function yearFilter(year: number | null, cumulative: boolean): unknown[] | null {
  if (year === null) return null;
  return cumulative ? ['<=', ['get', 'year'], year] : ['==', ['get', 'year'], year];
}
/** Opacity: the current year full, earlier years faint (cumulative view); live: the last day full, older events lighter. */
export function opacityExpression(year: number | null, cumulative: boolean, live: boolean, now = Date.now()): unknown {
  if (live) return ['case', ['>=', ['get', 'time'], now - 864e5], 0.95, 0.7];
  if (year !== null && cumulative) return ['case', ['==', ['get', 'year'], year], 0.95, 0.3];
  return 0.85;
}

export function quakeLayers(): LayerSpecification[] {
  const NONE = { visibility: 'none' as const };
  return [
    {
      id: 'quakes', type: 'circle', source: 'quakes', layout: { ...NONE, 'circle-sort-key': ['get', 'mag'] } as never,
      paint: {
        'circle-radius': radiusExpression() as never,
        'circle-color': depthColorExpression() as never,
        'circle-opacity': 0.85,
        'circle-stroke-color': CASING, 'circle-stroke-width': 0.6, 'circle-stroke-opacity': 0.75,
        'circle-pitch-alignment': 'map',
      },
    },
    // big events of the year the Time panel is on: one expanding ring (size and fade animated by the host)
    {
      id: 'quakes-pulse', type: 'circle', source: 'quakes-pulse', layout: NONE,
      paint: { 'circle-radius': 6, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#fff6dc', 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0, 'circle-pitch-alignment': 'map' },
    },
  ] as LayerSpecification[];
}

// ---------- per-year statistics (Time panel headline) ----------
export interface YearStats { first: number; last: number; count: number[]; cum: number[]; biggest: ({ mag: number; place: string; i: number } | null)[] }
export function yearStats(fc: QuakeFC, first = 1900, last = new Date().getUTCFullYear()): YearStats {
  const n = last - first + 1;
  const count = new Array(n).fill(0), biggest: YearStats['biggest'] = new Array(n).fill(null);
  fc.features.forEach((f, i) => {
    const k = f.properties.year - first;
    if (k < 0 || k >= n) return;
    count[k]++;
    if (!biggest[k] || f.properties.mag > biggest[k]!.mag) biggest[k] = { mag: f.properties.mag, place: f.properties.place, i };
  });
  const cum: number[] = [];
  count.reduce((s, c, i) => (cum[i] = s + c), 0);
  return { first, last, count, cum, biggest };
}

/** Big events of one year for the pulse layer (M >= minMag). */
export function pulseEvents(fc: QuakeFC, year: number, minMag = 7): QuakeFC {
  return { type: 'FeatureCollection', features: fc.features.filter((f) => f.properties.year === year && f.properties.mag >= minMag) };
}

// ---------- card ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function fmtUtc(t: number): string {
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}
export function fmtAgo(t: number, now = Date.now()): string {
  const h = (now - t) / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes ago`;
  if (h < 48) return `${Math.round(h)} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}
const ns = (v: number, a: string, b: string) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? a : b}`;
export function quakeCard(p: QuakeProps, lon: number, lat: number, now = Date.now()): CardModel {
  const depth = p.depth >= 0 ? `${p.depth.toLocaleString('en-US')} km deep (${depthClass(p.depth)})` : 'depth not known';
  return {
    kind: p.live ? 'Earthquake, last 30 days' : 'Earthquake',
    name: p.place || 'Unnamed region',
    lead: `Magnitude ${p.mag.toFixed(1)}, ${depth}`,
    facts: [
      ['Time', p.live ? `${fmtUtc(p.time)} (${fmtAgo(p.time, now)})` : fmtUtc(p.time)],
      ['Epicentre', `${ns(lat, 'N', 'S')}, ${ns(lon, 'E', 'W')}`],
    ],
    links: p.id ? [{ href: eventPage(p.id), label: 'USGS event page' }] : [],
    note: p.live ? 'Live USGS feed, updated every minute; early magnitudes and depths are often revised.'
      : 'Magnitudes are of mixed types (Mw, Ms, mb); depths before the 1960s are often fixed defaults.',
    source: p.live ? 'USGS Earthquake Hazards Program, real-time feed (public domain)' : 'USGS ANSS ComCat (public domain)',
  };
}
