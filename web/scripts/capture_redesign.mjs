// Screenshots of the redesigned UI at several window sizes (for review and the README).
// usage: node scripts/capture_redesign.mjs [baseUrl=http://localhost:4173/] [outdir=screenshots]
import { chromium } from 'playwright-core';
const [,, base = 'http://localhost:4173/', outdir = 'screenshots'] = process.argv;
const sizes = [[1440, 900], [1280, 720], [1920, 1080], [390, 844]];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
for (const [w, h] of sizes) {
  const phone = w < 600;
  const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone });
  page.on('pageerror', (e) => errors.push(`${w}x${h}: ${e.message}`));
  const go = async (hash, prep) => {
    await page.goto(base + hash, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__seafloor, null, { timeout: 60000 });
    if (prep) await page.evaluate(prep);
    await page.evaluate(() => window.__seafloor.idle()); await page.waitForTimeout(2500);
  };
  const tag = `${w}x${h}`;
  await go('', null);
  await page.screenshot({ path: `${outdir}/redesign-default-${tag}.png` });
  await go('#layers=cables', () => { const s = window.__seafloor; s.setVeil(true); s.ui.setDrawer('layers', true); });
  await page.screenshot({ path: `${outdir}/redesign-layers-${tag}.png` });
  await go('#water=t-0', () => { const s = window.__seafloor; s.map.jumpTo({ center: [-160, 15], zoom: 1.9 }); s.water.column(-150, 20); });
  await page.screenshot({ path: `${outdir}/redesign-water-${tag}.png` });
  if (!phone) { await go('', null); await page.keyboard.press('Meta+k'); await page.keyboard.type('Titanic'); await page.waitForTimeout(600); await page.screenshot({ path: `${outdir}/redesign-search-${tag}.png` }); }
  await page.close();
}
await browser.close();
console.log(errors.length ? errors.join('\n') : 'no page errors');
