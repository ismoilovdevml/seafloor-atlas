// Screenshots of the guided tour: four desktop chapters and one on a phone.
// Isolated headless Chrome with GPU (playwright-core).
// usage: node scripts/capture_tour.mjs [outdir=screenshots] [baseUrl=http://localhost:4173/]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [,, outdir = 'screenshots', base = 'http://localhost:4173/'] = process.argv;
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];

async function open(viewport, mobile = false) {
  const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch { /* ignore */ } });
  await page.goto(base);
  await page.waitForFunction(() => window.__seafloor, null, { timeout: 60000 });
  await page.evaluate(() => window.__seafloor.idle());
  return page;
}
/** Tour paused at chapter n (1-based), tiles drawn, then a screenshot. */
async function chapter(page, n, file) {
  await page.evaluate((n) => window.__seafloor.tour.start(n), n);
  await page.evaluate(() => window.__seafloor.tour.play(false));
  await page.evaluate(() => window.__seafloor.idle());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outdir}/${file}` });
  console.log(file);
}

{
  const page = await open({ width: 1440, height: 900 });
  await chapter(page, 1, 'tour-1-globe.png');
  await chapter(page, 4, 'tour-4-profile.png');
  await chapter(page, 8, 'tour-8-monsoon.png');
  await chapter(page, 11, 'tour-11-mapping.png');
  await page.close();
}
{
  const page = await open({ width: 390, height: 844 }, true);
  await chapter(page, 6, 'tour-phone-6-sea-level.png');
  await page.close();
}
await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
