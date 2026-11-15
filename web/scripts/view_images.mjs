// Render one 1200x630 picture per guided view for the static /views/<id>/ pages (and their social previews).
// usage: node scripts/view_images.mjs [baseUrl=https://seaflooratlas.org/] [only=id,id]
// Writes public/views/<id>/view.png; convert to JPEG with `sips -s format jpeg -s formatOptions 82` (macOS) or any tool.
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const [,, base = 'https://seaflooratlas.org/', only = ''] = process.argv;
const stories = JSON.parse(readFileSync('public/data/stories.json', 'utf8')).filter((s) => !only || only.split(',').includes(s.id));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const s of stories) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(`${base}#story=${s.id}`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.__seafloor, null, { timeout: 60000 });
  // visibility (not display): the app derives the map padding from the UI boxes
  await page.addStyleTag({ content: 'body > *:not(#map){visibility:hidden!important}.maplibregl-control-container{visibility:hidden!important}' });
  await page.evaluate(() => window.__seafloor.idle());
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__seafloor.idle());
  mkdirSync(`public/views/${s.id}`, { recursive: true });
  await page.screenshot({ path: `public/views/${s.id}/view.png` });
  console.log('wrote', s.id);
  await page.close();
}
await browser.close();
