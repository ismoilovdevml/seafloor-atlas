// Screenshots of the ocean-water layer (WOA23) for the README. Isolated headless Chrome (playwright-core).
// usage: node scripts/capture_water.mjs [outdir=screenshots] [baseUrl=http://localhost:4173/]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [,, outdir = 'screenshots', base = 'http://localhost:4173/'] = process.argv;
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const problems = [];
async function open(viewport) {
  const mobile = viewport.width < 600;
  const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__seafloor?.water?.ready, null, { timeout: 60000 });
  return page;
}
const settle = async (page, ms = 1500) => { await page.evaluate(() => window.__seafloor.idle()); await page.waitForTimeout(ms); await page.evaluate(() => window.__seafloor.idle()); };
async function view(page, file, { v, depthIdx, stretch = false, center, zoom, column, hover }) {
  await page.evaluate(async (a) => {
    const s = window.__seafloor;
    if (!s.water.state().open) await s.water.show(a.v, 0);
    await s.water.set({ v: a.v, depthIdx: a.depthIdx, stretch: a.stretch, month: 0 });
    s.map.jumpTo({ center: a.center, zoom: a.zoom, pitch: 0, bearing: 0 });
    if (a.column) await s.water.column(...a.column);
    if (a.hover) await s.readout(...a.hover);
  }, { v, depthIdx, stretch, center, zoom, column, hover });
  await settle(page, 2000);
  await page.screenshot({ path: `${outdir}/${file}` });
  console.log('wrote', `${outdir}/${file}`);
}

const desk = await open({ width: 1440, height: 900 });
// surface temperature, Pacific; column across the equatorial thermocline
await view(desk, 'water-1-surface-temperature.png', { v: 't', depthIdx: 0, center: [-165, 4], zoom: 2.05, column: [-140, 0.5], hover: [150, 0] });
// salinity at 1,000 m, colours stretched: the Mediterranean outflow tongue spreading west from Gibraltar
await view(desk, 'water-2-salinity-1000m-mediterranean.png', { v: 's', depthIdx: 5, stretch: true, center: [-32, 32], zoom: 2.45, column: [-14, 36.5], hover: [-12, 37] });
// potential density at 200 m; water column in the tropical Atlantic (sharp pycnocline under warm, light surface water)
await view(desk, 'water-3-density-profile.png', { v: 'd', depthIdx: 3, stretch: true, center: [-10, -5], zoom: 2.0, column: [-25.5, 5.5], hover: [-25.5, 5.5] });
await desk.close();

const phone = await open({ width: 390, height: 844 });
await view(phone, 'water-4-phone.png', { v: 't', depthIdx: 0, center: [-160, 5], zoom: 0.75, column: [-160, 20] });
await phone.close();
await browser.close();
if (problems.length) { console.error('console errors:', problems); process.exit(1); }
