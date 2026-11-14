// Regenerate the README screenshots from a running site (live or `vite preview`).
// usage: node scripts/readme_shots.mjs [baseUrl=https://ismoilovdevml.github.io/seafloor-atlas/] [outdir=../docs/img] [only=name,name]
// Writes PNGs at 2x; pipeline/readme_images.py (or any converter) turns them into small JPEGs for the README.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [,, base = 'https://ismoilovdevml.github.io/seafloor-atlas/', outdir = '../docs/img', only = ''] = process.argv;
mkdirSync(outdir, { recursive: true });
const SHOTS = [
  { name: 'hero', hash: '', cam: { center: [-160, 5], zoom: 1.95, pitch: 0, bearing: 0 } },
  { name: 'measured', hash: '', cam: { center: [-35, 25], zoom: 1.95, pitch: 0, bearing: 0 }, veil: true },
  { name: 'detail-z7', hash: '', cam: { center: [-44.8, 23.4], zoom: 7.3, pitch: 45, bearing: -10 } },
  { name: 'profile', hash: '#story=challenger-deep', profile: [[142.392, 12.373], [142.792, 10.373]] },
  { name: 'sea-ice-age', hash: '#sea=-120', cam: { center: [118, -2], zoom: 2.7, pitch: 0, bearing: 0 } },
  { name: 'ocean-water', hash: '#water=t-0', cam: { center: [170, 5], zoom: 1.9, pitch: 0, bearing: 0 }, column: [-150, 20] },
  { name: 'cables', hash: '#layers=cables', cam: { center: [-35, 25], zoom: 1.95, pitch: 0, bearing: 0 } },
  { name: 'north-sea', hash: '#layers=platforms,pipelines,wind', cam: { center: [3.5, 56.5], zoom: 5.3, pitch: 0, bearing: 0 } },
  { name: 'shipping', hash: '#layers=shipping', cam: { center: [60, 15], zoom: 2.3, pitch: 0, bearing: 0 } },
];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const problems = [];
for (const s of SHOTS.filter((x) => !only || only.split(',').includes(x.name))) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(`${s.name}: ${e.message}`));
  await page.goto(base + s.hash, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.__seafloor, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const settle = async (ms = 2500) => { await page.evaluate(() => window.__seafloor.idle()); await page.waitForTimeout(ms); await page.evaluate(() => window.__seafloor.idle()); };
  if (s.cam) await page.evaluate((cam) => window.__seafloor.map.jumpTo(cam), s.cam);
  if (s.veil) await page.evaluate(() => window.__seafloor.setVeil(true));
  if (s.profile) { await settle(1500); await page.evaluate((p) => window.__seafloor.profile(p[0], p[1]), s.profile); }
  if (s.column) { await settle(1500); await page.evaluate((c) => window.__seafloor.water.column(c[0], c[1]), s.column); }
  await settle();
  await page.screenshot({ path: `${outdir}/${s.name}.png` });
  console.log('wrote', `${outdir}/${s.name}.png`);
  await page.close();
}
await browser.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
