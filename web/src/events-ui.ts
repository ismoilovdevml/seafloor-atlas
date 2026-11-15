// DOM + map side of the Earthquakes and Seamounts layers (logic in quakes.ts / seamounts.ts). Loaded on first use
// (main.ts imports this module dynamically), data fetched on first switch-on: quakes.json 3.2 MB (0.9 MB gzipped),
// seamounts.json 3.7 MB (1.0 MB), the live USGS feed ~1.4 MB (180 kB gzipped).
import type { GeoJSONSource, Map as MlMap, MapGeoJSONFeature } from 'maplibre-gl';
import type { CardModel } from './overlays';
import {
  CASING, DEPTH_STOPS, DEPTH_UNKNOWN, LIVE_FEED, MAG_RADIUS, QUAKE_ATTRIBUTION, liveToGeoJSON, opacityExpression, pulseEvents, quakeCard, quakeLayers,
  quakesToGeoJSON, yearFilter, yearStats, type QuakeColumns, type QuakeFC, type QuakeProps, type YearStats,
} from './quakes';
import { SEAMOUNT_ATTRIBUTION, SEAMOUNT_COLOR, seamountCard, seamountLayers, seamountShares, seamountsToGeoJSON, type SeamountColumns, type SeamountProps } from './seamounts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export interface EventsHost {
  map: MlMap;
  dataBase: string;
  /** a layer went on or off (badge, hash, readout) */
  onChange: () => void;
  /** a time-aware layer was switched on (the Time panel may offer itself) */
  offerTime: (set: 'quakes') => void;
}

export class EventsUI {
  quakesOn = false;
  quakeMode: 'history' | 'live' = 'history';
  seamountsOn = false;
  year: number | null = null;
  only = false;
  liveError: string | null = null;
  private hist: QuakeFC | null = null;
  private live: QuakeFC | null = null;
  private liveAt = 0;
  private stats: YearStats | null = null;
  private seamountData: GeoJSON.FeatureCollection<GeoJSON.Point, SeamountProps> | null = null;
  private loads = new Map<string, Promise<unknown>>();
  private pulseRaf = 0;
  readonly loadMs: Record<string, number> = {};

  constructor(private host: EventsHost) {
    const map = host.map;
    map.addSource('seamounts', { type: 'geojson', data: EMPTY });
    map.addSource('quakes', { type: 'geojson', data: EMPTY });
    map.addSource('quakes-pulse', { type: 'geojson', data: EMPTY });
    // above the overlays, below the highlight ring and the labels
    for (const l of [...seamountLayers(), ...quakeLayers()]) map.addLayer(l, 'ov-hl-casing');
    for (const id of ['quakes', 'seamounts']) {
      map.on('mouseenter', id, () => { if (!map.getCanvas().style.cursor) map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { if (map.getCanvas().style.cursor === 'pointer') map.getCanvas().style.cursor = ''; });
    }
    $<HTMLInputElement>('t-quakes').addEventListener('change', (e) => this.setQuakes((e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('t-seamounts').addEventListener('change', (e) => this.setSeamounts((e.target as HTMLInputElement).checked));
    $('quake-mode').addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'quake-mode') this.setQuakeMode(t.value as 'history' | 'live');
    });
    this.renderLegends();
  }

  get clickable(): string[] { return [...(this.quakesOn ? ['quakes'] : []), ...(this.seamountsOn ? ['seamounts'] : [])]; }

  private timed<T>(key: string, p: Promise<T>): Promise<T> {
    const t0 = performance.now();
    return p.finally(() => { this.loadMs[key] = Math.round(performance.now() - t0); });
  }
  private loadHistory(): Promise<QuakeFC | null> {
    let p = this.loads.get('quakes') as Promise<QuakeFC | null> | undefined;
    if (!p) {
      p = this.timed('quakes', fetch(`${this.host.dataBase}/quakes.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d: QuakeColumns | null) => {
        if (!d) return null;
        this.hist = quakesToGeoJSON(d);
        this.stats = yearStats(this.hist, 1900, Math.max(new Date().getUTCFullYear(), new Date(d.metadata.newest).getUTCFullYear()));
        const big = this.hist.features.filter((f) => f.properties.mag >= 7).length;
        $('quakes-stat').innerHTML = `<strong>${fmt(d.n)}</strong> earthquakes of magnitude 5.5 or more since 1900, ${fmt(big)} of them 7 or more. Almost all sit on plate boundaries.`;
        return this.hist;
      }));
      this.loads.set('quakes', p);
    }
    return p;
  }
  /** The live feed, refetched when older than five minutes. */
  private loadLive(): Promise<QuakeFC | null> {
    if (this.live && Date.now() - this.liveAt < 300e3) return Promise.resolve(this.live);
    const p = this.timed('live', fetch(LIVE_FEED, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`USGS answered ${r.status}`)))).then((fc) => {
      this.live = liveToGeoJSON(fc);
      this.liveAt = Date.now();
      this.liveError = null;
      return this.live;
    }).catch((e: Error) => { this.liveError = e.message || 'network error'; return null; }));
    this.loads.set('live', p);
    return p;
  }
  private loadSeamounts() {
    let p = this.loads.get('seamounts') as Promise<unknown> | undefined;
    if (!p) {
      p = this.timed('seamounts', fetch(`${this.host.dataBase}/seamounts.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d: SeamountColumns | null) => {
        if (!d) return null;
        this.seamountData = seamountsToGeoJSON(d);
        (this.host.map.getSource('seamounts') as GeoJSONSource).setData(this.seamountData);
        const s = seamountShares(d);
        $('seamounts-stat').innerHTML = `Only <strong>${pct(s.measured, s.n)}</strong> of ${fmt(s.n)} seamount summits hold a sonar sounding; ${pct(s.named, s.n)} have a name.`;
        return this.seamountData;
      }));
      this.loads.set('seamounts', p);
    }
    return p;
  }
  /** Resolves once the active data of a layer is on the map (test hook). */
  async whenReady(id: 'quakes' | 'seamounts'): Promise<boolean> {
    if (id === 'seamounts') { await this.loads.get('seamounts'); return !!this.seamountData; }
    await (this.quakeMode === 'live' ? this.loads.get('live') : this.loads.get('quakes'));
    return this.quakeMode === 'live' ? !!this.live : !!this.hist;
  }

  async setQuakes(on: boolean) {
    this.quakesOn = on;
    $<HTMLInputElement>('t-quakes').checked = on;
    $('row-quakes').classList.toggle('on', on);
    $('lg-quakes').hidden = !on;
    if (on) {
      $('row-quakes').setAttribute('aria-busy', 'true');
      await this.applyQuakeData();
      $('row-quakes').removeAttribute('aria-busy');
      if (this.quakeMode === 'history') this.host.offerTime('quakes');
    }
    this.host.map.setLayoutProperty('quakes', 'visibility', on ? 'visible' : 'none');
    this.host.map.setLayoutProperty('quakes-pulse', 'visibility', on && this.year !== null ? 'visible' : 'none');
    this.host.onChange();
  }
  async setQuakeMode(m: 'history' | 'live') {
    this.quakeMode = m;
    document.querySelectorAll<HTMLInputElement>('#quake-mode input').forEach((i) => { i.checked = i.value === m; });
    if (this.quakesOn) {
      $('row-quakes').setAttribute('aria-busy', 'true');
      await this.applyQuakeData();
      $('row-quakes').removeAttribute('aria-busy');
    }
    this.renderQuakeLegend();
    this.host.onChange();
  }
  private async applyQuakeData() {
    const live = this.quakeMode === 'live';
    const fc = live ? await this.loadLive() : await this.loadHistory();
    if (live !== (this.quakeMode === 'live')) return; // switched meanwhile
    (this.host.map.getSource('quakes') as GeoJSONSource).setData(fc ?? EMPTY);
    this.applyQuakeStyle();
    const note = $('quake-live-note');
    if (live) {
      note.hidden = false;
      note.textContent = fc ? `${fmt(fc.features.length)} earthquakes of magnitude 2.5 or more in the last 30 days, fetched ${new Date(this.liveAt).toISOString().slice(11, 16)} UTC from USGS.`
        : `Could not reach the USGS feed (${this.liveError}). Check the connection and switch the option again.`;
    } else note.hidden = true;
  }
  private applyQuakeStyle() {
    const map = this.host.map, live = this.quakeMode === 'live';
    const y = live ? null : this.year;
    map.setFilter('quakes', yearFilter(y, !this.only) as never);
    map.setPaintProperty('quakes', 'circle-opacity', opacityExpression(y, !this.only, live) as never);
  }

  async setSeamounts(on: boolean) {
    this.seamountsOn = on;
    $<HTMLInputElement>('t-seamounts').checked = on;
    $('row-seamounts').classList.toggle('on', on);
    $('lg-seamounts').hidden = !on;
    if (on) {
      $('row-seamounts').setAttribute('aria-busy', 'true');
      await this.loadSeamounts();
      $('row-seamounts').removeAttribute('aria-busy');
    }
    this.host.map.setLayoutProperty('seamounts', 'visibility', on ? 'visible' : 'none');
    this.host.onChange();
  }

  // ---------- the Time panel ----------
  /** Range, per-year counts and the headline numbers (loads the catalogue). */
  async timeline() {
    await this.loadHistory();
    const s = this.stats!;
    return { first: s.first, last: s.last, count: s.count, stats: s };
  }
  /** Shows the catalogue up to (or only) `year`; null = everything. Switches to the catalogue if live was on. */
  async setYear(year: number | null, only = false) {
    this.year = year; this.only = only;
    if (year !== null && this.quakeMode === 'live') await this.setQuakeMode('history');
    this.applyQuakeStyle();
    this.host.map.setLayoutProperty('quakes-pulse', 'visibility', this.quakesOn && year !== null ? 'visible' : 'none');
    if (year === null) this.stopPulse();
  }
  headline(year: number, only: boolean): { main: string; sub: string } {
    const s = this.stats;
    if (!s) return { main: '', sub: '' };
    const k = Math.max(0, Math.min(s.count.length - 1, year - s.first));
    const b = s.biggest[k];
    const big = b ? `largest M ${b.mag.toFixed(1)}, ${b.place}` : 'no event of M 5.5 or more';
    return only
      ? { main: `<strong>${fmt(s.count[k])}</strong> earthquakes of magnitude 5.5 or more in ${year}`, sub: big[0].toUpperCase() + big.slice(1) + '.' }
      : { main: `<strong>${fmt(s.cum[k])}</strong> earthquakes of magnitude 5.5 or more since 1900`, sub: `${fmt(s.count[k])} in ${year}; ${big}.` };
  }
  /** One expanding ring on each M >= 7 event of the year (a still ring when motion is reduced). */
  pulse(year: number) {
    if (!this.hist) return;
    const map = this.host.map;
    (map.getSource('quakes-pulse') as GeoJSONSource).setData(pulseEvents(this.hist, year));
    cancelAnimationFrame(this.pulseRaf);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      map.setPaintProperty('quakes-pulse', 'circle-radius', 14);
      map.setPaintProperty('quakes-pulse', 'circle-stroke-opacity', 0.85);
      return;
    }
    const t0 = performance.now(), D = 1100;
    const frame = (t: number) => {
      const f = Math.min(1, (t - t0) / D), e = 1 - (1 - f) ** 3;
      map.setPaintProperty('quakes-pulse', 'circle-radius', 5 + 26 * e);
      map.setPaintProperty('quakes-pulse', 'circle-stroke-opacity', 0.95 * (1 - f));
      if (f < 1) this.pulseRaf = requestAnimationFrame(frame);
    };
    this.pulseRaf = requestAnimationFrame(frame);
  }
  private stopPulse() {
    cancelAnimationFrame(this.pulseRaf);
    (this.host.map.getSource('quakes-pulse') as GeoJSONSource | undefined)?.setData(EMPTY);
  }

  // ---------- cards ----------
  card(hit: MapGeoJSONFeature): { card: CardModel; geometry: GeoJSON.Geometry } | null {
    const [lon, lat] = (hit.geometry as GeoJSON.Point).coordinates;
    if (hit.layer.id === 'quakes') return { card: quakeCard(hit.properties as QuakeProps, lon, lat), geometry: hit.geometry };
    if (hit.layer.id === 'seamounts') return { card: seamountCard(hit.properties as SeamountProps), geometry: hit.geometry };
    return null;
  }
  /** Test hook: the catalogue entry whose place matches. */
  async findQuake(re: RegExp): Promise<{ props: QuakeProps; coordinates: number[] } | null> {
    const fc = await this.loadHistory();
    const f = fc?.features.find((x) => re.test(x.properties.place));
    return f ? { props: f.properties, coordinates: f.geometry.coordinates } : null;
  }
  async findSeamount(re: RegExp): Promise<{ props: SeamountProps; coordinates: number[] } | null> {
    await this.loadSeamounts();
    const f = this.seamountData?.features.find((x) => re.test(x.properties.name));
    return f ? { props: f.properties, coordinates: f.geometry.coordinates } : null;
  }
  get liveCount(): number { return this.live?.features.length ?? 0; }

  // ---------- legends ----------
  private renderLegends() {
    const L = DEPTH_STOPS[DEPTH_STOPS.length - 1][0];
    const grad = DEPTH_STOPS.map(([d, c]) => `${c} ${((100 * d) / L).toFixed(1)}%`).join(', ');
    $('quake-bar').style.background = `linear-gradient(90deg, ${grad})`;
    $('quake-ticks').innerHTML = DEPTH_STOPS.map(([d], i) => `<span class="${i === 0 ? 'first' : i === DEPTH_STOPS.length - 1 ? 'last' : ''}" style="left:${((100 * d) / L).toFixed(1)}%">${d}${i === DEPTH_STOPS.length - 1 ? ' km' : ''}</span>`).join('');
    this.renderQuakeLegend();
    const ring = (m: boolean, r: number) => `<svg width="28" height="16" aria-hidden="true"><circle cx="14" cy="8" r="${r}" fill="${m ? SEAMOUNT_COLOR.measured : 'none'}" stroke="${m ? SEAMOUNT_COLOR.casing : SEAMOUNT_COLOR.unmeasured}" stroke-width="${m ? 1 : 1.5}"/></svg>`;
    $('seamount-key').innerHTML = `<li>${ring(true, 4.5)}<span>Summit measured by sonar</span></li><li>${ring(false, 4.5)}<span>Summit predicted from gravity</span></li>`;
    $('seamounts-src').textContent = SEAMOUNT_ATTRIBUTION;
    $('quakes-src').textContent = QUAKE_ATTRIBUTION;
  }
  private renderQuakeLegend() {
    const live = this.quakeMode === 'live';
    const mags = live ? [3, 5, 7] : [6, 7, 8, 9];
    const r = (m: number) => { let k = 0; while (k < MAG_RADIUS.length - 2 && MAG_RADIUS[k + 1][0] < m) k++; const [m0, r0] = MAG_RADIUS[k], [m1, r1] = MAG_RADIUS[k + 1]; return r0 + ((m - m0) / (m1 - m0)) * (r1 - r0); };
    const w = mags.reduce((s, m) => s + 2 * r(m) + 22, 0);
    let x = 0;
    const items = mags.map((m) => { const rr = r(m); const cx = x + rr + 1; x += 2 * rr + 22; return `<circle cx="${cx.toFixed(1)}" cy="16" r="${rr.toFixed(1)}" fill="${DEPTH_STOPS[1][1]}" stroke="${CASING}" stroke-width="0.8"/><text x="${(cx + rr + 3).toFixed(1)}" y="20">${m}</text>`; }).join('');
    $('quake-sizes').innerHTML = `<svg viewBox="0 0 ${Math.ceil(w)} 32" width="${Math.ceil(w)}" height="32" aria-hidden="true">${items}</svg><span class="ov-unit">magnitude</span>`;
    $('quake-unknown').style.background = DEPTH_UNKNOWN;
    $('lg-quakes-t').textContent = live ? 'Earthquakes, last 30 days' : this.year !== null ? `Earthquakes, ${this.only ? this.year : `1900–${this.year}`}` : 'Earthquakes since 1900';
    $('quake-cap').textContent = live ? 'Hypocentre depth; magnitude 2.5 and up, brighter in the past day' : 'Hypocentre depth; magnitude 5.5 and up';
  }
  /** Legend title follows the Time panel. */
  refreshLegend() { this.renderQuakeLegend(); }
}
