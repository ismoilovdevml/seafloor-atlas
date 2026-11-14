// DOM + map side of the "Human activity at sea" overlays (pure logic in overlays.ts). GeoJSON is fetched once,
// the first time a layer is switched on (or when search needs cable / wreck names), and handed to MapLibre as
// an object so the same copy serves the map, the cards and the search.
import type { GeoJSONSource, Map as MlMap, MapGeoJSONFeature } from 'maplibre-gl';
import {
  CLICKABLE_LAYERS, DATA_FILES, ICONS, OV_COLOR, OVERLAY_ATTRIBUTION, OVERLAY_DATA, OVERLAY_IDS, OVERLAY_LAYERS,
  cableCard, fmtInt, isNotableWreck, landingCard, normName, pipelineCard, platformCard, shortWindName, windCard, wreckCard, wreckFilter,
  type CardModel, type DataKey, type LayerState, type OverlayId, type SearchEntry,
} from './overlays';

type FC = GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, any>>;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- icons (drawn locally at 2x; the legend uses the same drawings) ----------
function canvas(w: number, h: number) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return [c, c.getContext('2d')!] as const;
}
function platformIcon(fill: string | [string, string]) {
  const [c, g] = canvas(22, 22);
  g.lineJoin = 'round';
  const x = 4, s = 14;
  if (Array.isArray(fill)) {
    g.fillStyle = fill[0]; g.beginPath(); g.moveTo(x, x); g.lineTo(x + s, x); g.lineTo(x, x + s); g.closePath(); g.fill();
    g.fillStyle = fill[1]; g.beginPath(); g.moveTo(x + s, x); g.lineTo(x + s, x + s); g.lineTo(x, x + s); g.closePath(); g.fill();
  } else { g.fillStyle = fill; g.fillRect(x, x, s, s); }
  g.lineWidth = 2.6; g.strokeStyle = OV_COLOR.casing; g.strokeRect(x, x, s, s);
  return c;
}
function windIcon() {
  const [c, g] = canvas(40, 40);
  const cx = 20, cy = 20, L = 15;
  g.lineCap = 'round';
  for (const pass of [0, 1]) {
    g.strokeStyle = pass ? OV_COLOR.wind : OV_COLOR.casing; g.lineWidth = pass ? 3.6 : 7.4;
    for (const a of [-90, 30, 150]) {
      const r = (a * Math.PI) / 180;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + L * Math.cos(r), cy + L * Math.sin(r)); g.stroke();
    }
  }
  g.beginPath(); g.arc(cx, cy, 4.2, 0, Math.PI * 2); g.fillStyle = OV_COLOR.windInk; g.fill();
  g.lineWidth = 1.6; g.strokeStyle = OV_COLOR.wind; g.stroke();
  return c;
}
/** Nautical-chart wreck sign: a hull line crossed by three masts. */
function wreckIcon() {
  const [c, g] = canvas(34, 22);
  g.lineCap = 'round';
  const draw = () => {
    g.beginPath(); g.moveTo(4, 11); g.lineTo(30, 11);
    for (const x of [10, 17, 24]) { g.moveTo(x, 4.5); g.lineTo(x, 17.5); }
    g.stroke();
  };
  g.strokeStyle = OV_COLOR.casing; g.lineWidth = 6.4; draw();
  g.strokeStyle = OV_COLOR.wreck; g.lineWidth = 2.6; draw();
  return c;
}
const ICON_DRAW: Record<string, () => HTMLCanvasElement> = {
  [ICONS.oil]: () => platformIcon(OV_COLOR.oil),
  [ICONS.gas]: () => platformIcon(OV_COLOR.gas),
  [ICONS.oilGas]: () => platformIcon([OV_COLOR.oil, OV_COLOR.gas]),
  [ICONS.windSub]: () => platformIcon(OV_COLOR.wind),
  [ICONS.other]: () => platformIcon(OV_COLOR.other),
  [ICONS.windFarm]: windIcon,
  [ICONS.wreck]: wreckIcon,
};
const iconUrl = new Map<string, string>();
function iconImg(id: string, cssW: number): string {
  if (!iconUrl.has(id)) iconUrl.set(id, ICON_DRAW[id]().toDataURL());
  return `<img src="${iconUrl.get(id)}" width="${cssW}" alt="" aria-hidden="true" class="ov-ico">`;
}
const lineKey = (color: string, dash = '', w = 2.4) =>
  `<svg width="28" height="10" aria-hidden="true"><line x1="1" y1="5" x2="27" y2="5" stroke="${OV_COLOR.casing}" stroke-width="${w + 2.4}" stroke-opacity="0.7"/><line x1="1" y1="5" x2="27" y2="5" stroke="${color}" stroke-width="${w}" stroke-dasharray="${dash}"/></svg>`;
const keyRow = (sym: string, label: string) => `<li>${sym}<span>${label}</span></li>`;

export interface OverlayHost {
  map: MlMap;
  dataBase: string;
  shippingLegend: string;
  /** called whenever the set of active layers changes (hash, padding) */
  onChange: (s: LayerState) => void;
}

export class OverlayUI {
  readonly on = new Set<OverlayId>();
  allWrecks = false;
  landing = true;
  private files = new Map<DataKey, Promise<FC | null>>();
  private data = new Map<DataKey, FC>();
  private applied = new Set<DataKey>();
  private cableNames = new Map<string, string>();
  private landingNames = new Map<string, string>();
  private hlKey: string | null = null;
  readonly loadMs: Record<string, number> = {};

  constructor(private host: OverlayHost) {
    const map = host.map;
    for (const [id, draw] of Object.entries(ICON_DRAW)) {
      const c = draw();
      if (!map.hasImage(id)) map.addImage(id, c.getContext('2d')!.getImageData(0, 0, c.width, c.height), { pixelRatio: 2 });
    }
    for (const id of OVERLAY_IDS) {
      const input = $<HTMLInputElement>(`t-${id}`);
      input.addEventListener('change', () => this.set(id, input.checked));
    }
    $<HTMLInputElement>('t-wrecks-all').addEventListener('change', (e) => this.setAllWrecks((e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('t-landing').addEventListener('change', (e) => this.setLanding((e.target as HTMLInputElement).checked));
    for (const id of CLICKABLE_LAYERS) {
      map.on('mouseenter', id, () => { if (!map.getCanvas().style.cursor) map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { if (map.getCanvas().style.cursor === 'pointer') map.getCanvas().style.cursor = ''; });
    }
    this.renderStaticLegends();
  }

  get state(): LayerState { return { ids: OVERLAY_IDS.filter((id) => this.on.has(id)), allWrecks: this.allWrecks }; }

  /** Fetch one data file once; features get an index `_i` for card lookups (rendered features lose arrays). */
  load(key: DataKey): Promise<FC | null> {
    let p = this.files.get(key);
    if (!p) {
      const t0 = performance.now();
      p = fetch(`${this.host.dataBase}/${DATA_FILES[key]}`).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((fc: FC | null) => {
        if (!fc) return null;
        fc.features.forEach((f, i) => {
          f.properties = f.properties ?? {};
          f.properties._i = i;
          if (key === 'wind') f.properties.label = shortWindName(f.properties.name);
        });
        if (key === 'cables') for (const f of fc.features) this.cableNames.set(f.properties.id, f.properties.name);
        if (key === 'landing') for (const f of fc.features) this.landingNames.set(f.properties.id, f.properties.name);
        this.data.set(key, fc);
        this.loadMs[key] = Math.round(performance.now() - t0);
        return fc;
      });
      this.files.set(key, p);
    }
    return p;
  }

  private async ensureOnMap(key: DataKey) {
    const fc = await this.load(key);
    if (!fc || this.applied.has(key)) return;
    this.applied.add(key);
    (this.host.map.getSource(key) as GeoJSONSource).setData(fc);
  }

  private visibility() {
    const map = this.host.map;
    for (const id of OVERLAY_IDS) {
      for (const layer of OVERLAY_LAYERS[id]) {
        const vis = this.on.has(id) && !(layer === 'landing-points' && !this.landing);
        map.setLayoutProperty(layer, 'visibility', vis ? 'visible' : 'none');
      }
    }
  }

  async set(id: OverlayId, on: boolean, opts: { notify?: boolean } = {}) {
    const input = $<HTMLInputElement>(`t-${id}`);
    input.checked = on;
    $(`ov-${id}`).classList.toggle('on', on);
    $(`ovl-${id}`).hidden = !on;
    if (on) this.on.add(id); else this.on.delete(id);
    if (!on && this.hlKey && this.hlKey.startsWith(`${id}:`)) this.clearHighlight();
    if (on && OVERLAY_DATA[id].length) {
      $(`ov-${id}`).setAttribute('aria-busy', 'true');
      await Promise.all(OVERLAY_DATA[id].map((k) => this.ensureOnMap(k)));
      $(`ov-${id}`).removeAttribute('aria-busy');
      this.renderCounts(id);
    }
    this.visibility();
    if (opts.notify !== false) this.host.onChange(this.state);
  }

  setAllWrecks(all: boolean, notify = true) {
    this.allWrecks = all;
    $<HTMLInputElement>('t-wrecks-all').checked = all;
    this.host.map.setFilter('wrecks', wreckFilter(all) as never);
    this.renderCounts('wrecks');
    if (notify) this.host.onChange(this.state);
  }
  setLanding(on: boolean) {
    this.landing = on;
    $<HTMLInputElement>('t-landing').checked = on;
    this.visibility();
  }

  /** Apply a deep-link state (from #layers=). */
  async apply(s: LayerState) {
    this.setAllWrecks(s.allWrecks, false);
    await Promise.all(OVERLAY_IDS.map((id) => (s.ids.includes(id) !== this.on.has(id) ? this.set(id, s.ids.includes(id), { notify: false }) : null)));
    this.host.onChange(this.state);
  }

  // ---------- legends ----------
  private renderStaticLegends() {
    const att = (id: OverlayId) => `<p class="ov-att">${OVERLAY_ATTRIBUTION[id]}</p>`;
    $('ovk-cables').innerHTML = keyRow(lineKey(OV_COLOR.cable, '', 1.8), 'In service')
      + keyRow(lineKey(OV_COLOR.cable, '5 3.5', 1.8), 'Planned at the snapshot')
      + keyRow(`<svg width="28" height="10" aria-hidden="true"><circle cx="14" cy="5" r="3.6" fill="${OV_COLOR.cable}" stroke="${OV_COLOR.casing}" stroke-width="1"/></svg>`, 'Landing point');
    $('ovn-cables').insertAdjacentHTML('afterend', att('cables'));
    $('ovk-pipelines').innerHTML = keyRow(lineKey(OV_COLOR.gas), 'Gas')
      + keyRow(lineKey(OV_COLOR.oil, '6 3.2'), 'Oil')
      + keyRow(lineKey(OV_COLOR.unknown, '1.6 3.6'), 'Substance not tagged');
    $('ovn-pipelines').insertAdjacentHTML('afterend', att('pipelines'));
    $('ovk-platforms').innerHTML = keyRow(iconImg(ICONS.oil, 11), 'Oil') + keyRow(iconImg(ICONS.oilGas, 11), 'Oil and gas')
      + keyRow(iconImg(ICONS.gas, 11), 'Gas') + keyRow(iconImg(ICONS.windSub, 11), 'Wind-farm substation')
      + keyRow(iconImg(ICONS.other, 11), 'Other or not tagged')
      + keyRow('<span class="ov-cluster" aria-hidden="true">24</span>', 'Group of platforms; click to zoom in');
    $('ovn-platforms').insertAdjacentHTML('afterend', att('platforms'));
    $('ovk-wind').innerHTML = keyRow(`<span class="ov-wind-sizes">${iconImg(ICONS.windFarm, 11)}${iconImg(ICONS.windFarm, 16)}${iconImg(ICONS.windFarm, 22)}</span>`, 'Larger symbol = more capacity (MW)');
    $('ovn-wind').insertAdjacentHTML('afterend', att('wind'));
    $('ovk-wrecks').innerHTML = keyRow(iconImg(ICONS.wreck, 17), 'Wreck (names appear as you zoom in)');
    $('ovn-wrecks').insertAdjacentHTML('afterend', att('wrecks'));
    $('ovn-shipping').insertAdjacentHTML('afterend', att('shipping'));
    this.renderShippingLegend();
  }

  private async renderShippingLegend() {
    const lg = await fetch(this.host.shippingLegend).then((r) => (r.ok ? r.json() : null)).catch(() => null) as
      { stops: { log10: number; color: string }[]; log10Min: number; log10Max: number; units: string; period: string } | null;
    if (!lg) { $('ov-shipping').hidden = true; return; }
    const span = lg.log10Max - lg.log10Min;
    const pos = (l: number) => ((100 * (l - lg.log10Min)) / span).toFixed(1);
    const grad = lg.stops.map((s) => `${s.color} ${pos(s.log10)}%`).join(', ');
    const sup = (n: number) => String(n).split('').map((d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]).join('');
    const ticks = lg.stops.filter((s) => Number.isInteger(s.log10) && s.log10 % 1 === 0 && s.log10 >= Math.ceil(lg.log10Min))
      .map((s) => `<span style="left:${pos(s.log10)}%">10${sup(s.log10)}</span>`).join('');
    const [y0, y1] = lg.period.split('/').map((x) => x.slice(0, 4));
    $('ovk-shipping').innerHTML = `<div class="ov-bar" style="background:linear-gradient(90deg, ${grad})"></div><div class="ov-ticks" aria-hidden="true">${ticks}</div>`;
    $('ovn-shipping').textContent = `AIS position reports per km² per year, ${y0}–${y1}. Read it as relative traffic: busy lanes, ports and fishing grounds glow.`;
  }

  private renderCounts(id: OverlayId) {
    const n = (k: DataKey) => this.data.get(k)?.features.length ?? 0;
    if (id === 'cables' && n('cables')) {
      $('ovn-cables').textContent = `${fmtInt(n('cables'))} cables and ${fmtInt(n('landing'))} landing points, as of 14 November 2022. Routes are schematic; cables laid since then are missing.`;
    } else if (id === 'pipelines' && n('pipelines')) {
      $('ovn-pipelines').textContent = `${fmtInt(n('pipelines'))} subsea oil and gas lines mapped in OpenStreetMap. Faded = disused.`;
    } else if (id === 'platforms' && n('platforms')) {
      $('ovn-platforms').textContent = `${fmtInt(n('platforms'))} platforms mapped in OpenStreetMap, best in the Gulf of Mexico, North Sea, Persian Gulf and Caspian.`;
    } else if (id === 'wind' && n('wind')) {
      $('ovn-wind').textContent = `${fmtInt(n('wind'))} offshore wind farms in OpenStreetMap. Chinese offshore wind is under-mapped there.`;
    } else if (id === 'wrecks' && n('wrecks')) {
      const all = this.data.get('wrecks')!.features;
      const notable = all.filter((f) => isNotableWreck(f.properties)).length;
      $('ovn-wrecks').textContent = this.allWrecks
        ? `All ${fmtInt(all.length)} wreck records in Wikidata at sea. Most are UK and Irish heritage-register entries, so the density shows where records exist, not where ships sank.`
        : `${fmtInt(notable)} wrecks with an article in at least one Wikipedia or other Wikimedia project.`;
      $('t-wrecks-all-label').textContent = `Show all ${fmtInt(all.length)} records`;
    }
  }

  // ---------- clicks ----------
  clickableLayers(): string[] {
    return CLICKABLE_LAYERS.filter((id) => this.host.map.getLayer(id) && this.host.map.getLayoutProperty(id, 'visibility') === 'visible');
  }
  private original(key: DataKey, hit: MapGeoJSONFeature) {
    const i = hit.properties?._i;
    return typeof i === 'number' ? this.data.get(key)?.features[i] : undefined;
  }
  /** A card for a rendered overlay feature, or 'cluster' after zooming into a platform cluster. */
  async cardFor(hit: MapGeoJSONFeature): Promise<CardModel | 'cluster' | null> {
    const id = hit.layer.id;
    if (id === 'platforms-cluster') {
      const src = this.host.map.getSource('platforms') as GeoJSONSource;
      const z = await src.getClusterExpansionZoom(hit.properties.cluster_id as number);
      this.host.map.easeTo({ center: (hit.geometry as GeoJSON.Point).coordinates as [number, number], zoom: Math.min(z + 0.3, 9), duration: 700 });
      return 'cluster';
    }
    const key: DataKey | null = id === 'cables' ? 'cables' : id === 'landing-points' ? 'landing' : id === 'wrecks' ? 'wrecks'
      : id === 'platforms' ? 'platforms' : id === 'pipelines' ? 'pipelines' : id === 'wind' ? 'wind' : null;
    if (!key) return null;
    const f = this.original(key, hit);
    if (!f) return null;
    this.highlight(key, f);
    return this.cardFrom(key, f);
  }
  cardFrom(key: DataKey, f: GeoJSON.Feature<GeoJSON.Geometry, Record<string, any>>): CardModel {
    const p = f.properties as any;
    switch (key) {
      case 'cables': return cableCard(p, (x) => this.landingNames.get(x));
      case 'landing': return landingCard(p, (x) => this.cableNames.get(x));
      case 'wrecks': return wreckCard(p);
      case 'platforms': return platformCard(p);
      case 'pipelines': return pipelineCard(p);
      default: return windCard(p);
    }
  }
  highlight(key: DataKey, f: GeoJSON.Feature) {
    this.hlKey = `${key === 'landing' ? 'cables' : key === 'wind' ? 'wind' : key}:${(f.properties as any)?._i}`;
    (this.host.map.getSource('ov-hl') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: f.geometry }] });
  }
  clearHighlight() {
    this.hlKey = null;
    (this.host.map.getSource('ov-hl') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
  }

  // ---------- search ----------
  /** Cable names and notable wreck names (loads the two files once). */
  async searchEntries(): Promise<SearchEntry[]> {
    const [c, w] = await Promise.all([this.load('cables'), this.load('wrecks')]);
    const out: SearchEntry[] = [];
    for (const f of c?.features ?? []) out.push({ name: f.properties.name, label: f.properties.planned ? 'Cable, planned' : 'Undersea cable', kind: 'cable', key: String(f.properties._i), n: normName(f.properties.name) });
    for (const f of w?.features ?? []) {
      if (!f.properties.name || !isNotableWreck(f.properties)) continue;
      out.push({ name: f.properties.name, label: f.properties.year ? `Shipwreck, ${f.properties.year}` : 'Shipwreck', kind: 'wreck', key: String(f.properties._i), n: normName(f.properties.name) });
    }
    return out;
  }
  /** Switch the layer on, highlight the item and return its card and where to look. */
  async focus(e: SearchEntry): Promise<{ card: CardModel; feature: GeoJSON.Feature } | null> {
    const key: DataKey = e.kind === 'cable' ? 'cables' : 'wrecks';
    const fc = await this.load(key);
    const f = fc?.features[Number(e.key)];
    if (!f) return null;
    await this.set(key === 'cables' ? 'cables' : 'wrecks', true);
    this.highlight(key, f);
    return { card: this.cardFrom(key, f), feature: f };
  }
  /** Test hook: card for the first feature in a data file whose name matches. */
  async find(key: DataKey, re: RegExp) {
    const fc = await this.load(key);
    return fc?.features.find((f) => re.test(f.properties.name ?? '')) ?? null;
  }
}
