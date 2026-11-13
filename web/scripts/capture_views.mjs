// Capture the viewer with an isolated headless Chrome (playwright-core, not the user's browser) and print
// any console errors / failed requests. Needs the dev or preview server running.
// usage: node scripts/capture_views.mjs [outdir=screenshots] [query=''] [baseUrl=http://localhost:5173/]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [,, outdir = 'screenshots', query = '', base = 'http://localhost:5173/'] = process.argv;
mkdirSync(outdir, { recursive: true });
// a N-S line through Challenger Deep (142.592 E, 11.373 N), ~250 km long
const MARIANA_A = [142.392, 12.373], MARIANA_B = [142.792, 10.373];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const problems = [];
async function session(name, viewport, scale = 1) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${name}] [${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${name}] [pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[${name}] [http ${r.status()}] ${r.url()}`); });
  await page.goto(`${base}${query}`);
  await page.waitForFunction(() => window.__seafloor, null, { timeout: 30000 });
  const settle = async (ms = 1500) => { await page.evaluate(() => window.__seafloor.idle()); await page.waitForTimeout(ms); await page.evaluate(() => window.__seafloor.idle()); };
  return { page, settle };
}
async function shot(page, file) { await page.screenshot({ path: `${outdir}/${file}` }); console.log('wrote', `${outdir}/${file}`); }

// ---------- desktop ----------
{
  const { page, settle } = await session('desktop', { width: 1440, height: 900 });
  const info = await page.evaluate(() => ({ synthetic: window.__seafloor.synthetic, version: window.__seafloor.meta.version, gl: (() => { const gl = window.__seafloor.map.painter.context.gl; const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; })() }));
  console.log('tiles:', info);
  await settle(2500);
  await shot(page, 'desktop-1-globe.png');

  await page.evaluate(() => window.__seafloor.setVeil(true));
  await settle();
  await shot(page, 'desktop-2-coverage.png');
  await page.evaluate(() => { window.__seafloor.setVeil(false); window.__seafloor.setPlates(true); });
  await settle();
  await shot(page, 'desktop-3-plates.png');
  await page.evaluate(() => window.__seafloor.setPlates(false));

  await page.evaluate(() => window.__seafloor.playStory('challenger-deep', true));
  await settle(2500);
  console.log('readout at Challenger Deep centre:', await page.evaluate(async () => { await window.__seafloor.readout(142.59, 11.37); return [...document.querySelectorAll('#readout-grid dd')].map((d) => d.textContent).join(' | '); }));
  await shot(page, 'desktop-4-story-mariana.png');

  const prof = await page.evaluate(([a, b]) => window.__seafloor.profile(a, b), [MARIANA_A, MARIANA_B]);
  console.log('profile:', JSON.stringify(prof));
  await page.evaluate(() => window.__seafloor.hoverChart(0.52));
  await settle(800);
  await shot(page, 'desktop-5-profile-mariana.png');

  await page.evaluate(() => window.__seafloor.playStory('mh370-search', true));
  await page.evaluate(() => window.__seafloor.setVeil(true));
  await page.click('#profile-close');
  await settle(2500);
  await shot(page, 'desktop-6-mh370-coverage.png');
  await page.close();
}

// ---------- phone ----------
{
  const { page, settle } = await session('phone', { width: 390, height: 844 }, 2);
  await settle(2500);
  await shot(page, 'phone-1-globe.png');
  await page.evaluate(() => window.__seafloor.playStory('challenger-deep', true));
  await settle(2500);
  await shot(page, 'phone-2-story.png');
  await page.evaluate(([a, b]) => window.__seafloor.profile(a, b), [MARIANA_A, MARIANA_B]);
  await page.evaluate(() => window.__seafloor.hoverChart(0.52));
  await settle(800);
  await shot(page, 'phone-3-profile.png');
  await page.click('#profile-close');
  await page.click('#tab-layers');
  await page.evaluate(() => window.__seafloor.setVeil(true));
  await settle(1000);
  await shot(page, 'phone-4-layers.png');
  await page.close();
}

console.log('console/http problems:', problems.length ? problems : 'none');
await browser.close();
