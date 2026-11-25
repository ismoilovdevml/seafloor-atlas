// window.__seafloor: the test / capture hook (split from main.ts, same API). scripts/smoke.mjs, qa.mjs, the capture
// and README screenshot scripts drive the viewer through it. Installed by main.ts at the end of start-up.
import type { GeoJSONSource } from 'maplibre-gl';
import type { Tour } from './tour';
import { FEATURE_LAYERS } from './style';
import type { OverlayUI } from './overlay-ui';
import { CERTAINTY_IDS, CERTAINTY_LAYERS, classFromAlpha, disagreeFromAlpha, type CertaintyId } from './certainty';
import type { MarineUI } from './marine-ui';
import type { WaterUI } from './water-ui';
import type { TimeMode, TimeState, YearSet } from './timeline';
import { $, exagAuto, exagValue, idle, map, meta, rasterTileSize, synthetic, terrainTileSize } from './app-state';
import { currentStory, playStory, stories } from './cards-ui';
import { inspect, readout, renderExtra } from './inspector-ui';
import { certaintyOk, disagreeLg, eventsUI, layerTokens, loadEvents, loadOcean, marine, marineReady, oceanUI, overlays, probes,
  setCertainty, setFeatures, setNew, setPlates, setSatLand, setVeil, uncertaintyLg } from './layers-ui';
import { closeSea, historyUI, loadHistory, openSea, openTime, seaLevel, seaStats, setPlaying, setSeaLevel, showProfile, timeUI,
  toolState, water, waterReady } from './tools-ui';
import { layoutCheck, legendSections, loadTrace, mapShare, meter, setDrawer, setLegend, setMinimised, setPopover, setTab } from './layout-ui';

/** The guided tour lives in main.ts (it is loaded on first use): the hook reaches it through these two. */
export interface TourAccess { start: (n?: number) => Promise<void>; get: () => Tour | null }

export function installQaHook(tourApi: TourAccess) {
  Object.assign(window, {
    __seafloor: {
      map, meta, synthetic, idle, rasterTileSize, terrainTileSize,
      playStory: (id: string, instant = true) => { const s = stories.find((x) => x.id === id); if (s) playStory(s, instant); return !!s; },
      setVeil, setPlates, setNew, setFeatures,
      inspect: (lon: number, lat: number) => inspect(lon, lat),
      inspector: () => ({ open: !$('inspector').hidden, status: $('inspector').dataset.st ?? null, badge: $('insp-badge-t').textContent }),
      setSatLand: (on: boolean) => setSatLand(on),
      profile: async (a: [number, number], b: [number, number]) => showProfile(a, b),
      hoverChart: (frac: number) => { const svg = $('profile-chart').querySelector('svg')!; const r = svg.getBoundingClientRect(); svg.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 60 + frac * (r.width - 72), clientY: r.top + 40 })); },
      readout,
      current: () => currentStory?.id ?? null,
      openSea, closeSea, setSeaLevel: (L: number) => setSeaLevel(L), play: setPlaying,
      seaLevel: () => seaLevel,
      layoutCheck,
      mapShare,
      setMinimised,
      ui: {
        setDrawer: (name: 'explore' | 'layers', open: boolean) => setDrawer(name, open),
        setLegend: (open: boolean) => setLegend(open),
        setTab,
        popover: (id: 'about' | 'settings' | null) => setPopover(id),
        legend: () => ({ shown: !$('legend').hidden, collapsed: $('legend').classList.contains('collapsed'), sections: legendSections().map((x) => x.id) }),
        exaggeration: () => ({ value: exagValue, auto: exagAuto, terrain: map.getTerrain()?.exaggeration ?? null }),
      },
      overlays: {
        set: (id: Parameters<OverlayUI['set']>[0], on: boolean) => overlays.set(id, on),
        /** resolves when a layer's data has loaded and is on the map (true) */
        ready: (id: Parameters<OverlayUI['whenReady']>[0]) => overlays.whenReady(id),
        osm: (on: boolean) => overlays.setOsm(on),
        cableYear: () => ({ ...overlays.year }),
        allWrecks: (on: boolean) => overlays.setAllWrecks(on),
        state: () => ({ ...overlays.state, loadMs: overlays.loadMs,
          visibility: Object.fromEntries(['shipping', 'cables', 'landing-points', 'pipelines', 'platforms', 'wind', 'wrecks'].map((id) => [id, map.getLayoutProperty(id, 'visibility')])) }),
        find: async (key: Parameters<OverlayUI['find']>[0], re: string) => { const f = await overlays.find(key, new RegExp(re)); return f ? { props: f.properties, geometry: f.geometry } : null; },
        /** rendered features of the clickable layers (and labels) in a 6 px box around a screen point */
        hitsAt: (x: number, y: number) => map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: [...FEATURE_LAYERS, ...overlays.clickableLayers()] })
          .map((f) => ({ layer: f.layer.id, name: f.properties?.name ?? null })),
      },
      /** rAF intervals while the camera eases by dLng degrees over ms milliseconds */
      panFrames: (dLng: number, ms: number) => new Promise((res) => {
        const dt: number[] = []; let last = 0, live = true;
        const loop = (t: number) => { if (last) dt.push(t - last); last = t; if (live) requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
        const c = map.getCenter();
        map.once('moveend', () => {
          live = false;
          const a = [...dt].sort((x, y) => x - y), q = (p: number) => +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2);
          res({ frames: a.length, medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: q(1), over20ms: a.filter((x) => x > 20).length });
        });
        map.easeTo({ center: [c.lng + dLng, c.lat], duration: ms, easing: (t) => t });
      }),
      certainty: {
        ok: certaintyOk,
        set: (id: CertaintyId, on: boolean) => setCertainty(id, on),
        state: () => Object.fromEntries(CERTAINTY_IDS.map((id) => [id, certaintyOk[id] ? map.getLayoutProperty(CERTAINTY_LAYERS[id][0], 'visibility') : 'absent'])),
        probe: async (id: 'disagree' | 'uncertainty', lon: number, lat: number) => {
          const px = await probes[id].at(lon, lat);
          if (!px) return null;
          return id === 'disagree' ? { alpha: px[3], m: disagreeLg ? disagreeFromAlpha(px[3], disagreeLg) : null } : { alpha: px[3], cls: uncertaintyLg ? classFromAlpha(px[3], uncertaintyLg)?.label ?? null : null };
        },
        seals: () => { const src = map.getSource('seals') as GeoJSONSource | undefined; return src ? map.querySourceFeatures('seals').length : 0; },
      },
      marine: {
        ready: marineReady,
        set: (s: Parameters<MarineUI['set']>[0]) => marine.set(s),
        value: (lon: number, lat: number) => marine.value(lon, lat),
        card: (lon: number, lat: number) => marine.card(lon, lat),
        /** resolves when the last requested marine view is drawn */
        drawn: () => marine.whenDrawn().then(() => true),
        state: () => ({ on: marine.on, mode: marine.mode, group: marine.group, renders: marine.stats.renders, lastMs: marine.stats.lastMs,
          visibility: map.getLayer('marine') ? map.getLayoutProperty('marine', 'visibility') : null }),
      },
      extra: (lon: number, lat: number) => renderExtra(lon, lat),
      events: {
        set: async (id: 'quakes' | 'seamounts', on: boolean) => { const u = await loadEvents(); await (id === 'quakes' ? u.setQuakes(on) : u.setSeamounts(on)); return true; },
        mode: async (m: 'history' | 'live') => { await (await loadEvents()).setQuakeMode(m); return true; },
        ready: async (id: 'quakes' | 'seamounts') => (await loadEvents()).whenReady(id),
        state: () => eventsUI && ({ quakes: eventsUI.quakesOn, mode: eventsUI.quakeMode, seamounts: eventsUI.seamountsOn, year: eventsUI.year, only: eventsUI.only,
          liveCount: eventsUI.liveCount, liveError: eventsUI.liveError, loadMs: eventsUI.loadMs,
          visibility: { quakes: map.getLayoutProperty('quakes', 'visibility'), seamounts: map.getLayoutProperty('seamounts', 'visibility') }, filter: map.getFilter('quakes') ?? null }),
        findQuake: async (re: string) => (await loadEvents()).findQuake(new RegExp(re)),
        findSeamount: async (re: string) => (await loadEvents()).findSeamount(new RegExp(re)),
      },
      ocean: {
        set: async (id: 'chl' | 'wind' | 'currents', on: boolean) => { const o = await loadOcean(); await (id === 'chl' ? o.setChl(on) : o.setFlow(id, on)); return true; },
        ready: async (id: 'chl' | 'wind' | 'currents') => (await loadOcean()).whenReady(id),
        month: async (mo: number) => { await (await loadOcean()).setMonth(mo); return true; },
        value: (lon: number, lat: number) => oceanUI?.value(lon, lat) ?? null,
        chlPixel: (lon: number, lat: number) => oceanUI?.chlPixel(lon, lat) ?? null,
        flowStats: () => oceanUI?.flowStats() ?? null,
        preloadMonths: () => oceanUI?.preloadMonths() ?? 0,
        state: () => oceanUI && ({ chl: oceanUI.chlOn, flow: oceanUI.flow, month: oceanUI.month, chlMs: oceanUI.stats.chlMs, running: oceanUI.flowLayer?.running ?? null,
          particles: oceanUI.flowLayer?.particles?.n ?? 0,
          // custom layers are not part of getStyle(): ask the map for each
          layers: ['chl', 'flow-wind', 'flow-currents'].filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none') }),
        /** screen positions of a few particles (to check they sit on the visible globe) */
        sample: (n = 200) => {
          const p = oceanUI?.flowLayer?.particles; if (!p) return [];
          const out: [number, number][] = [];
          for (let i = 0; i < Math.min(n, p.n); i++) { const q = map.project([p.lon[i], p.lat[i]]); out.push([Math.round(q.x), Math.round(q.y)]); }
          return out;
        },
      },
      time: {
        open: async (st?: TimeState | { mode: TimeMode; set?: YearSet }) => { await openTime(st); await timeUI!.ready(); return true; },
        close: () => timeUI?.close(),
        seek: async (v: number) => { await timeUI?.seek(v); await timeUI?.ready(); return true; },
        step: async (dir: number) => { timeUI?.step(dir); await timeUI?.ready(); return true; },
        follow: async (set: YearSet) => { await timeUI?.follow(set); await timeUI?.ready(); return true; },
        only: async (on: boolean) => { document.querySelector<HTMLButtonElement>(`#time-only [data-only="${on ? 1 : 0}"]`)?.click(); await timeUI?.ready(); return true; },
        play: (on: boolean) => timeUI?.setPlaying(on),
        speed: (x: number) => { if (timeUI) timeUI.speed = x; },
        ready: async () => { await timeUI?.ready(); return true; },
        stats: () => timeUI?.takeStats() ?? null,
        state: () => timeUI && ({ open: timeUI.open, mode: timeUI.mode, set: timeUI.set, year: timeUI.year, only: timeUI.only, month: timeUI.month, ago: timeUI.ago, playing: timeUI.playing,
          value: $('time-value').textContent, unit: $('time-unit').textContent, headline: $('time-headline').textContent, sub: $('time-sub').textContent, note: $('time-note').textContent,
          modes: [...document.querySelectorAll<HTMLButtonElement>('#time-modes button')].map((b) => `${b.dataset.mode}:${b.disabled ? 0 : 1}`), seaLevel, hash: location.hash }),
      },
      history: {
        ready: () => loadHistory().then((h) => !!h),
        state: () => ({ year: historyUI?.year ?? null, visibility: map.getLayer('history') ? map.getLayoutProperty('history', 'visibility') : null }),
      },
      tour: {
        /** loads the tour chunk and starts at chapter n; resolves when that chapter has settled */
        start: (n = 1) => tourApi.start(n).then(() => true),
        loaded: () => !!tourApi.get(),
        chapters: () => tourApi.get()?.chapters ?? null,
        state: () => tourApi.get()?.state() ?? null,
        next: async () => { await tourApi.get()?.next(); return true; },
        back: async () => { await tourApi.get()?.back(); return true; },
        go: async (i: number) => { await tourApi.get()?.go(i); return true; },
        play: (on: boolean) => tourApi.get()?.setPlaying(on),
        voice: (on: boolean) => tourApi.get()?.setVoice(on),
        exit: async () => { await tourApi.get()?.exit(); return true; },
        layers: layerTokens,
        tool: toolState,
        snapshot: () => ({ layers: layerTokens(), tool: toolState(), exaggeration: exagAuto ? 'auto' : exagValue,
          drawers: { explore: $('ui').classList.contains('explore-open'), layers: $('ui').classList.contains('layers-open') } }),
      },
      loading: {
        state: () => ({ ...meter.view(), started: meter.started, finished: meter.finished, shown: meter.shown, log: meter.log.slice(-12),
          el: { hidden: $('loading').hidden, on: $('loading').classList.contains('on'), text: $('loading').textContent?.replace(/\s+/g, ' ').trim(), bottom: $('loading').getBoundingClientRect().bottom } }),
        trace: () => loadTrace.slice(),
        clear: () => { loadTrace.length = 0; },
      },
      /** waits until the machine is quiet: rAF intervals over a 0.5 s window with p95 under 20 ms (or gives up) */
      waitQuiet: (maxMs = 8000) => new Promise((res) => {
        const t0 = performance.now(); let win: number[] = [], last = 0;
        const loop = (t: number) => {
          if (last) win.push(t - last); last = t;
          if (win.length >= 30) {
            const a = [...win].sort((x, y) => x - y), p95 = a[Math.floor(0.95 * a.length)];
            if (p95 < 20 || t - t0 > maxMs) { res({ p95: +p95.toFixed(1), waitedMs: Math.round(t - t0) }); return; }
            win = [];
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }),
      /** rAF intervals for ms milliseconds (no camera move) */
      frames: (ms: number) => new Promise((res) => {
        const dt: number[] = []; let last = 0; const t0 = performance.now();
        const loop = (t: number) => { if (last) dt.push(t - last); last = t; if (t - t0 < ms) requestAnimationFrame(loop); else {
          const a = [...dt].sort((x, y) => x - y), q = (p: number) => +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2);
          res({ frames: a.length, medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), over20ms: a.filter((x) => x > 20).length }); } };
        requestAnimationFrame(loop);
      }),
      water: {
        ready: waterReady,
        show: (v?: 't' | 's' | 'd', depth?: number) => water.show({ v, depth }),
        close: () => water.close(),
        set: (s: Parameters<WaterUI['set']>[0]) => water.set(s),
        month: (m: number) => water.set({ month: m }),
        play: (on: boolean) => water.setPlaying(on),
        preloadMonths: () => water.preloadMonths(),
        column: (lon: number, lat: number) => water.showColumn(lon, lat),
        value: (lon: number, lat: number) => water.readout(lon, lat),
        state: () => ({ open: water.open, v: water.v, depth: water.open ? water.depth : null, month: water.month, playing: water.playing,
          visibility: map.getLayer('water') ? map.getLayoutProperty('water', 'visibility') : null }),
        stats: () => water.renderStats(),
      },
      /** frame-time summary since the last call (rAF intervals while playing, ramp swap -> next render) */
      seaStats: () => {
        const q = (xs: number[], p: number) => { const a = [...xs].sort((x, y) => x - y); return a.length ? +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2) : null; };
        const out = { frames: seaStats.frames.length, frameMedianMs: q(seaStats.frames, 0.5), frameP95Ms: q(seaStats.frames, 0.95), frameMaxMs: q(seaStats.frames, 1),
          applies: seaStats.applies, applyToRenderMedianMs: q(seaStats.applyToRender, 0.5), applyToRenderP95Ms: q(seaStats.applyToRender, 0.95) };
        seaStats.frames = []; seaStats.applyToRender = []; seaStats.applies = 0;
        return out;
      },
    },
  });
}
