// Screenshots of the Time panel (Years / Months / Since the ice age), the flow layers (globe, mercator, zoomed,
// phone), the new point layers and the loading indicator, plus frame times with flow on.
// Isolated headless Chrome with GPU (playwright-core).
// usage: node scripts/capture_time.mjs [outdir=screenshots] [baseUrl=http://localhost:4173/]
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const [,, outdir = 'screenshots', base = 'http://localhost:4173/'] = process.argv;
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
const out = {};

async function open(viewport, mobile = false, hash = '') {
  const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  // a clean session: no remembered panels, no Time offers already shown
  await page.addInitScript(() => { try { localStorage.clear(); sessionStorage.setItem('sfa-offer-quakes', '1'); for (const k of ['cables', 'wind', 'months', 'mapping']) sessionStorage.setItem(`sfa-offer-${k}`, '1'); } catch { /* ignore */ } });
  await page.goto(base + hash);
  await page.waitForFunction(() => window.__seafloor, null, { timeout: 60000 });
  const S = (f, a) => page.evaluate(f, a);
  const settle = async (ms = 1500) => { await S(() => window.__seafloor.idle()); await page.waitForTimeout(ms); };
  const view = (center, zoom, pitch = 0) => S(([c, z, p]) => window.__seafloor.map.jumpTo({ center: c, zoom: z, pitch: p, bearing: 0 }), [center, zoom, pitch]);
  return { page, S, settle, view };
}
const shot = (page, f) => page.screenshot({ path: `${outdir}/${f}` });

{
  const { page, S, settle, view } = await open({ width: 1440, height: 900 });
  await settle(2000);
  // ---- flow ----
  await view([65, 10], 2.1);
  await S(async () => { const o = window.__seafloor.ocean; await o.set('wind', true); await o.ready('wind'); await o.month(7); });
  await settle(2500);
  await shot(page, 'flow-1-winds-july-globe.png');
  await S(() => window.__seafloor.waitQuiet(6000));
  out.windFrames = await S(() => window.__seafloor.frames(4000));
  out.windCpu = await S(() => window.__seafloor.ocean.flowStats());
  await S(async () => { const o = window.__seafloor.ocean; await o.set('currents', true); await o.ready('currents'); await o.month(0); });
  await view([-60, 32], 3.4);
  await settle(2500);
  await shot(page, 'flow-2-currents-gulf-stream.png');
  await S(() => window.__seafloor.map.setProjection({ type: 'mercator' }));
  await view([-60, 30], 2.6);
  await settle(2500);
  await shot(page, 'flow-3-currents-mercator.png');
  await S(() => window.__seafloor.map.setProjection({ type: 'globe' }));
  await S(async () => { const o = window.__seafloor.ocean; await o.set('chl', true); await o.ready('chl'); await o.set('wind', true); await o.month(7); });
  await view([62, 12], 3);
  await settle(2500);
  await shot(page, 'flow-4-monsoon-bloom-july.png');
  await S(() => window.__seafloor.waitQuiet(6000));
  out.windChlFrames = await S(() => window.__seafloor.frames(4000));
  await S(async () => { const o = window.__seafloor.ocean; await o.set('wind', false); await o.set('chl', false); await o.month(0); });

  // ---- time ----
  await view([150, 10], 1.9);
  await S(() => window.__seafloor.time.open({ mode: 'years', set: 'quakes', year: 2004, only: false }));
  await settle(2000);
  await shot(page, 'time-1-quakes-2004.png');
  await S(async () => { await window.__seafloor.time.seek(2011); await window.__seafloor.time.only(true); });
  await settle(1200);
  await shot(page, 'time-2-quakes-2011-only.png');
  await S(() => window.__seafloor.time.open({ mode: 'years', set: 'cables', year: 2000, only: false }));
  await view([-20, 30], 2.1);
  await settle(2000);
  await shot(page, 'time-3-cables-2000.png');
  await S(() => window.__seafloor.events.set('quakes', false));
  await S(() => window.__seafloor.time.open({ mode: 'years', set: 'mapping', year: 2019, only: false }));
  await view([-40, 20], 2.1);
  await settle(3000);
  await shot(page, 'time-4-mapping-2019.png');
  await S(() => window.__seafloor.time.seek(2026));
  await settle(3000);
  await shot(page, 'time-5-mapping-2026.png');
  await S(() => window.__seafloor.time.open({ mode: 'months', month: 7 }));
  await view([62, 12], 2.4);
  await settle(3000);
  await shot(page, 'time-6-months-july.png');
  await S(() => window.__seafloor.time.open({ mode: 'ago', ago: 20500 }));
  await view([110, 0], 2.6);
  await settle(2500);
  await shot(page, 'time-7-ice-age-sundaland.png');
  await S(() => window.__seafloor.time.close());
  // ---- quakes / seamounts cards ----
  await S(async () => { const e = window.__seafloor.events; await e.set('seamounts', true); await e.ready('seamounts'); });
  await view([-155.3, 19], 5.2);
  await settle(2000);
  await shot(page, 'layer-seamounts-hawaii.png');
  await page.close();
}
// ---- loading indicator: a new place at zoom 7 (PMTiles from Hugging Face) ----
{
  const { page, S, settle, view } = await open({ width: 1440, height: 900 });
  await settle(2000);
  await S(() => window.__seafloor.loading.clear());
  await view([-28.3, 38.6], 7);
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(150);
    const st = await S(() => window.__seafloor.loading.state());
    if (st.el.on && st.pct > 10 && st.pct < 100) { await shot(page, 'loading-1-detail.png'); break; }
  }
  await settle(1500);
  out.loading = await S(() => window.__seafloor.loading.state());
  await page.close();
}
// ---- phone ----
{
  const { page, S, settle, view } = await open({ width: 390, height: 844 }, true);
  await settle(2000);
  await S(async () => { const o = window.__seafloor.ocean; await o.set('wind', true); await o.ready('wind'); });
  await view([-30, 20], 0.9);
  await settle(2500);
  await shot(page, 'flow-5-phone-winds.png');
  await S(() => window.__seafloor.time.open({ mode: 'months', month: 1 }));
  await settle(2500);
  await shot(page, 'time-8-phone-months.png');
  await S(() => window.__seafloor.time.open({ mode: 'years', set: 'quakes', year: 1960, only: false }));
  await settle(2500);
  await shot(page, 'time-9-phone-quakes.png');
  await page.close();
}
await browser.close();
writeFileSync(`${outdir}/time-frames.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
console.log(errors.length ? `errors: ${errors.slice(0, 10).join(' | ')}` : 'no page errors');
