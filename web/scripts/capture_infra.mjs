// Screenshots of the "Human activity at sea" overlays + pan frame times with the layers off and on.
// Isolated headless Chrome with GPU (playwright-core). usage: node scripts/capture_infra.mjs [outdir=screenshots] [baseUrl=http://localhost:4173/]
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const [,, outdir = 'screenshots', base = 'http://localhost:4173/'] = process.argv;
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];

async function open(viewport, mobile = false) {
  const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__seafloor, null, { timeout: 60000 });
  const settle = async (ms = 1500) => { await page.evaluate(() => window.__seafloor.idle()); await page.waitForTimeout(ms); await page.evaluate(() => window.__seafloor.idle()); };
  const layers = (ids) => page.evaluate(async (ids) => { const o = window.__seafloor.overlays; for (const id of ['cables', 'shipping', 'wrecks', 'platforms', 'pipelines', 'wind']) await o.set(id, ids.includes(id)); }, ids);
  const view = (center, zoom, pitch = 0) => page.evaluate(([c, z, p]) => window.__seafloor.map.jumpTo({ center: c, zoom: z, pitch: p, bearing: 0 }), [center, zoom, pitch]);
  // scroll the layers panel to the overlay group so the legends are in the picture
  const showGroup = (id) => page.evaluate((id) => document.getElementById(`ov-${id}`).scrollIntoView({ block: 'start' }), id);
  return { page, settle, layers, view, showGroup };
}

const frames = {};
{
  const { page, settle, layers, view, showGroup } = await open({ width: 1440, height: 900 });
  await settle(2000);
  // frame times: same pan with nothing on, then with all six layers
  for (const [where, c, z] of [['globe', [-30, 30], 2.2], ['north-sea', [3, 56], 5]]) {
    for (const on of [false, true]) {
      await layers(on ? ['cables', 'shipping', 'wrecks', 'platforms', 'pipelines', 'wind'] : []);
      await view(c, z); await settle(1500);
      const runs = [];
      for (let i = 0; i < 2; i++) runs.push(await page.evaluate((d) => window.__seafloor.panFrames(d, 4000), where === 'globe' ? 60 : 6));
      frames[`${where}-${on ? 'all-layers' : 'no-layers'}`] = runs;
    }
  }
  await layers(['cables']); await showGroup('cables');
  await view([-30, 28], 2.05); await settle(2500);
  await page.screenshot({ path: `${outdir}/infra-1-cables-global.png` });
  await layers(['platforms', 'pipelines', 'wind']); await showGroup('platforms');
  await view([3.2, 56.2], 5.1); await settle(3000);
  await page.screenshot({ path: `${outdir}/infra-2-north-sea.png` });
  await layers(['shipping']); await showGroup('shipping');
  await view([75, 12], 2.4); await settle(3000);
  await page.screenshot({ path: `${outdir}/infra-3-shipping.png` });
  await layers(['wrecks']); await showGroup('wrecks');
  await view([-38, 47], 3.6); await settle(2500);
  await page.screenshot({ path: `${outdir}/infra-4-wrecks-north-atlantic.png` });
  // a card: Titanic from the search box
  await page.focus('#search-input'); await page.waitForTimeout(800);
  await page.fill('#search-input', 'Titanic'); await page.waitForTimeout(500);
  const i = await page.$$eval('#search-results li[data-kind="wreck"]', (els) => els.find((e) => /^Titanic/.test(e.textContent))?.dataset.i);
  await page.dispatchEvent(`#search-results li[data-i="${i}"]`, 'pointerdown');
  await page.waitForTimeout(4000); await settle(2500);
  await page.waitForFunction(() => { const im = document.getElementById('f-img'); return im.complete; }, null, { timeout: 15000 }).catch(() => {});
  await page.screenshot({ path: `${outdir}/infra-5-card-titanic.png` });
  await page.close();
}
{
  const { page, settle, layers, view } = await open({ width: 390, height: 844 }, true);
  await settle(2000);
  await page.click('#tab-layers');
  await layers(['cables', 'wind', 'platforms', 'pipelines']);
  await view([2, 55], 3.4); await settle(2500);
  await page.evaluate(() => document.getElementById('ov-cables').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outdir}/infra-6-phone.png` });
  await page.close();
}
await browser.close();
writeFileSync(`${outdir}/infra-frames.json`, JSON.stringify(frames, null, 1));
console.log(JSON.stringify(frames));
if (errors.length) { console.log('errors:', errors); process.exit(1); }
