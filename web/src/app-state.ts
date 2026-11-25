// Shared viewer state and helpers (split from main.ts). Every UI module imports from here; this module holds:
// * the start-up objects main.ts creates (map, meta, sampler, tile settings, the ruler), as live bindings set once by
//   setCore() before any module's init runs;
// * small DOM and fetch helpers, the phone / reduced-motion tests;
// * flags several modules read (appReady, touring) and the terrain exaggeration;
// * one tool at a time: closeTools().
// Module rule (all split modules): top-level code only declares. Anything that touches the DOM, the map or another
// module runs inside an init function that main.ts calls in the original start-up order, so circular imports between
// the UI modules are safe (no imported binding is read while the modules are being evaluated).
import type * as maplibregl from 'maplibre-gl';
import type { MeasureTool } from './measure';
import type { TileSampler } from './sampler';
import type { Meta } from './style';
import { closeInspector } from './inspector-ui';
import { closeSea, profiling, seaOpen, setProfiling, timeUI, water } from './tools-ui';

export function $<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
// prefers-reduced-motion: camera moves made for the visitor (search, cards, layout fits) jump instead of flying;
// the tour and the guided views read it themselves
export const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
export function anim<T extends object>(o: T): T { return reduceMotion.matches ? { ...o, duration: 0 } : o; }

export async function getJSON<T>(url: string): Promise<T | null> {
  try { const r = await fetch(url); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}
/** window.localStorage, or null where even reading the accessor throws (blocked site data). */
export function localStore(): Storage | null { try { return window.localStorage; } catch { return null; } }
export function phone(): boolean { return window.innerWidth <= 760; }
export function visible(id: string): boolean { return !$(id).hidden && getComputedStyle($(id)).display !== 'none'; }

// ---------- start-up objects (main.ts) ----------
export let map: maplibregl.Map;
export let meta: Meta;
export let synthetic: boolean;
export let tilesBase: string;
export let dataBase: string;
export let sampler: TileSampler;
export let demMaxZoom: number;
/** highest zoom of the static tiles next to the page (fast); above it tiles come from the PMTiles archive */
export let staticMaxZoom: number;
export let rasterTileSize: number;
export let terrainTileSize: number;
export let measureTool: MeasureTool;
export interface Core {
  map: maplibregl.Map; meta: Meta; synthetic: boolean; tilesBase: string; dataBase: string; sampler: TileSampler;
  demMaxZoom: number; staticMaxZoom: number; rasterTileSize: number; terrainTileSize: number;
}
export function setCore(c: Core) {
  ({ map, meta, synthetic, tilesBase, dataBase, sampler, demMaxZoom, staticMaxZoom, rasterTileSize, terrainTileSize } = c);
}
export function setMeasureTool(m: MeasureTool) { measureTool = m; }
/** Resolves on the map's next 'idle' (the tour host and the QA hook wait on it). */
export function idle(): Promise<void> { return new Promise((res) => { if (map.loaded() && map.areTilesLoaded()) map.once('idle', () => res()); else map.once('idle', () => res()); map.triggerRepaint(); }); }

// ---------- flags ----------
/** Every control is wired (main.ts sets it at the very end of start-up). */
export let appReady = false;
export function markReady() { appReady = true; }
/** the guided tour is running (tour.ts sets it through its host) */
export let touring = false;
export function setTouringFlag(on: boolean) { touring = on; }

// ---------- terrain exaggeration ----------
// whole-globe zooms stay at about x20: at x50 steep walls on the rim (Aleutian, Kuril trenches, Andes) stood out as a
// sawtooth silhouette, while the relief inside the disc comes mostly from the hillshade and barely changes
const AUTO_EXAG: [number, number][] = [[0, 22], [2, 20], [3.5, 20], [5, 14], [6.5, 6], [8, 3]];
export function autoExaggeration(z: number): number {
  if (z <= AUTO_EXAG[0][0]) return AUTO_EXAG[0][1];
  for (let i = 1; i < AUTO_EXAG.length; i++) {
    const [z0, e0] = AUTO_EXAG[i - 1], [z1, e1] = AUTO_EXAG[i];
    if (z <= z1) return e0 + ((z - z0) / (z1 - z0)) * (e1 - e0);
  }
  return AUTO_EXAG[AUTO_EXAG.length - 1][1];
}

export let exagAuto = true;
export let exagValue = 0;
export function setExagAuto(on: boolean) { exagAuto = on; $<HTMLInputElement>('exag-auto').checked = on; }
export function applyExaggeration(v: number) {
  exagValue = Math.round(v);
  map.setTerrain({ source: 'dem-terrain', exaggeration: exagValue });
  $<HTMLInputElement>('exag').value = String(exagValue);
  $<HTMLOutputElement>('exag-out').textContent = `×${exagValue}`;
}
export function initExaggeration() {
  exagValue = autoExaggeration(map.getZoom());
  map.on('zoomend', () => { if (exagAuto) applyExaggeration(autoExaggeration(map.getZoom())); });
  $<HTMLInputElement>('exag').addEventListener('input', (e) => {
    exagAuto = false; $<HTMLInputElement>('exag-auto').checked = false;
    applyExaggeration(Number((e.target as HTMLInputElement).value));
  });
  $<HTMLInputElement>('exag-auto').addEventListener('change', (e) => {
    exagAuto = (e.target as HTMLInputElement).checked;
    if (exagAuto) applyExaggeration(autoExaggeration(map.getZoom()));
  });
}

// ---------- one tool at a time ----------
type Tool = 'sea' | 'water' | 'profile' | 'time' | 'measure';
/**
 * One tool at a time: closes every bottom tool except `keep`, and the point inspector, which would otherwise stay
 * open beside (or, on short windows, on top of) the tool. seaHash: false leaves the sea level out of the address
 * (the Time panel writes its own).
 */
export function closeTools(keep: Tool, opts: { seaHash?: boolean } = {}) {
  if (keep !== 'profile' && profiling) setProfiling(false);
  if (keep !== 'sea' && seaOpen) closeSea(opts.seaHash ?? true);
  if (keep !== 'water') water.close();
  if (keep !== 'time') timeUI?.close();
  if (keep !== 'measure') measureTool.stop();
  closeInspector();
}
