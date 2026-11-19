// "Measure distance", as on Google Maps: click the globe to add points, drag a point to move it, click a point to
// remove it, click the first point to close the shape (its area appears too). The path follows great circles, so
// it is the real shortest distance over the Earth; distances on a sphere of mean radius 6,371.0088 km (within about
// 0.5 % of the WGS84 ellipsoid). Pure geometry is exported for tests; the tool itself needs a map.
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { EARTH_RADIUS_KM, greatCircle, haversineKm, unwrapPath } from './geo';

export type LonLat = [number, number];

export function pathKm(pts: LonLat[], closed = false): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineKm(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) d += haversineKm(pts[pts.length - 1], pts[0]);
  return d;
}

/** Area of a closed ring on the sphere (km²), by the spherical-excess sum of Chamberlain & Duquette (2007). */
export function ringAreaKm2(pts: LonLat[]): number {
  if (pts.length < 3) return 0;
  const R = (Math.PI / 180);
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [l1, p1] = pts[i], [l2, p2] = pts[(i + 1) % pts.length];
    let dl = l2 - l1;
    if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
    s += dl * R * (2 + Math.sin(p1 * R) + Math.sin(p2 * R));
  }
  return Math.abs((s * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

const nf = (x: number, d: number) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** '850 m (2,789 ft)' under 1 km, else '1,234.56 km (767.07 mi)', as Google Maps shows both. */
export function formatDistance(km: number): string {
  if (km < 1) return `${nf(km * 1000, 0)} m (${nf(km * 3280.84, 0)} ft)`;
  const d = km < 100 ? 2 : 1;
  return `${nf(km, d)} km (${nf(km / 1.609344, d)} mi)`;
}

export function formatArea(km2: number): string {
  if (km2 < 1) return `${nf(km2 * 1e6, 0)} m²`;
  const d = km2 < 100 ? 2 : 0;
  return `${nf(km2, d)} km² (${nf(km2 / 2.589988, d)} mi²)`;
}

/** The drawn path: each leg as a densified great circle (one point per ~25 km), unwrapped across the antimeridian. */
export function pathLine(pts: LonLat[], closed: boolean): LonLat[] {
  const ring = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  const out: LonLat[] = [];
  for (let i = 1; i < ring.length; i++) {
    const n = Math.max(2, Math.min(256, Math.ceil(haversineKm(ring[i - 1], ring[i]) / 25)));
    const leg = greatCircle(ring[i - 1], ring[i], n);
    out.push(...(i === 1 ? leg : leg.slice(1)));
  }
  return out.length ? unwrapPath(out) : ring;
}

const SRC = 'measure';

export interface MeasureHost {
  /** close the other bottom tools before measuring */
  beforeStart: () => void;
  /** a panel appeared or changed size */
  layout: () => void;
}

export class MeasureTool {
  active = false;
  closed = false;
  pts: LonLat[] = [];
  private markers: maplibregl.Marker[] = [];
  private label: maplibregl.Marker;
  private panel: HTMLElement;
  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.stop(); };

  constructor(private map: MlMap, private host: MeasureHost, parent: HTMLElement, private button: HTMLButtonElement) {
    this.panel = document.createElement('section');
    this.panel.className = 'measure tool-panel';
    this.panel.id = 'measure';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-labelledby', 'measure-title');
    this.panel.innerHTML = `
      <header><h2 id="measure-title">Measure distance</h2></header>
      <p class="measure-hint" id="measure-hint">Click on the map to add to your path</p>
      <dl class="measure-stats">
        <div><dt id="measure-dist-dt">Total distance</dt><dd id="measure-dist" aria-live="polite">–</dd></div>
        <div id="measure-area-row" hidden><dt>Area</dt><dd id="measure-area"></dd></div>
      </dl>
      <div class="measure-actions"><button type="button" class="text-btn" id="measure-clear">Clear</button></div>
      <button class="close" type="button" aria-label="Close measure distance"><svg width="18" height="18" aria-hidden="true"><use href="#i-close"/></svg></button>`;
    parent.appendChild(this.panel);
    this.panel.querySelector('.close')!.addEventListener('click', () => this.stop());
    this.panel.querySelector('#measure-clear')!.addEventListener('click', () => this.clear());
    const lab = document.createElement('div');
    lab.className = 'measure-label';
    this.label = new maplibregl.Marker({ element: lab, anchor: 'left', offset: [12, 0] });
    button.addEventListener('click', () => (this.active ? this.stop() : this.start()));
    map.on('click', (e) => {
      if (!this.active || this.closed) return;
      if ((e.originalEvent.target as HTMLElement | null)?.closest?.('.measure-pt')) return;
      this.add([e.lngLat.lng, e.lngLat.lat]);
    });
  }

  start(first?: LonLat) {
    if (!this.active) {
      this.host.beforeStart();
      this.active = true;
      this.button.setAttribute('aria-pressed', 'true');
      this.panel.hidden = false;
      this.map.getCanvas().style.cursor = 'crosshair';
      document.addEventListener('keydown', this.onKey);
      this.ensureLayers();
    }
    if (first) this.add(first);
    this.render();
    this.host.layout();
  }

  stop() {
    if (!this.active) return;
    this.clear();
    this.active = false;
    this.button.setAttribute('aria-pressed', 'false');
    this.panel.hidden = true;
    this.map.getCanvas().style.cursor = '';
    document.removeEventListener('keydown', this.onKey);
    this.host.layout();
  }

  clear() {
    this.pts = [];
    this.closed = false;
    for (const m of this.markers) m.remove();
    this.markers = [];
    this.render();
  }

  add(p: LonLat) {
    this.pts.push(p);
    this.markers.push(this.makeMarker(p));
    this.render();
  }

  private makeMarker(p: LonLat): maplibregl.Marker {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'measure-pt';
    el.setAttribute('aria-label', 'Measured point: drag to move, click to remove');
    const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(p).addTo(this.map);
    let dragged = false;
    m.on('dragstart', () => { dragged = true; });
    m.on('drag', () => { const ll = m.getLngLat(); this.pts[this.markers.indexOf(m)] = [ll.lng, ll.lat]; this.render(); });
    m.on('dragend', () => { setTimeout(() => { dragged = false; }, 0); });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dragged) return;
      const i = this.markers.indexOf(m);
      if (i === 0 && !this.closed && this.pts.length > 2) { this.closed = true; this.render(); return; }
      this.markers.splice(i, 1)[0].remove();
      this.pts.splice(i, 1);
      if (this.pts.length < 3) this.closed = false;
      this.render();
    });
    return m;
  }

  private ensureLayers() {
    if (this.map.getSource(SRC)) return;
    this.map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({ id: 'measure-fill', type: 'fill', source: SRC, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.12 } });
    this.map.addLayer({ id: 'measure-casing', type: 'line', source: SRC, filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000000', 'line-opacity': 0.55, 'line-width': 5 } });
    this.map.addLayer({ id: 'measure-line', type: 'line', source: SRC, filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 2.5 } });
  }

  private render() {
    const src = this.map.getSource(SRC) as GeoJSONSource | undefined;
    const line = this.pts.length > 1 ? pathLine(this.pts, this.closed) : [];
    const feats: GeoJSON.Feature[] = [];
    if (line.length > 1) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
    if (this.closed) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [line] } });
    src?.setData({ type: 'FeatureCollection', features: feats });
    this.markers.forEach((m, i) => m.getElement().classList.toggle('first', i === 0 && this.pts.length > 2 && !this.closed));
    const km = pathKm(this.pts, this.closed);
    const $ = (id: string) => this.panel.querySelector<HTMLElement>(`#${id}`)!;
    $('measure-dist').textContent = this.pts.length > 1 ? formatDistance(km) : '–';
    $('measure-dist-dt').textContent = this.closed ? 'Total distance (perimeter)' : 'Total distance';
    $('measure-area-row').hidden = !this.closed;
    if (this.closed) $('measure-area').textContent = formatArea(ringAreaKm2(this.pts));
    $('measure-hint').textContent = this.closed ? 'Drag the points to change the shape; click a point to remove it'
      : this.pts.length > 2 ? 'Click the first point to close the shape and see its area'
      : 'Click on the map to add to your path';
    if (this.pts.length > 1) {
      this.label.getElement().textContent = formatDistance(km).replace(/ \(.*\)$/, '');
      this.label.setLngLat(this.closed ? this.pts[0] : this.pts[this.pts.length - 1]).addTo(this.map);
    } else this.label.remove();
  }
}
