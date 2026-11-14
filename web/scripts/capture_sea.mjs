// Sea-level feature check with an isolated headless Chrome (playwright-core): screenshots at fixed levels and
// places, the animation mid-play with frame timing, deep link, story reset and hover readout. Prints any
// console errors / warnings and failed requests. Needs `vite preview` (or the dev server) running.
// usage: node scripts/capture_sea.mjs [outdir=screenshots] [baseUrl=http://localhost:4173/]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [,, outdir = 'screenshots', base = 'http://localhost:4173/'] = process.argv;
mkdirSync(outdir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const problems = [];
const checks = [];
const check = (name, ok, detail = '') => { checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

async function session(name, viewport, hash = '', scale = 1) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${name}] [${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${name}] [pageerror] ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[${name}] [failed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[${name}] [http ${r.status()}] ${r.url()}`); });
  await page.goto(`${base}${hash}`);
  await page.waitForFunction(() => window.__seafloor, null, { timeout: 30000 });
  const settle = async (ms = 1500) => { await page.evaluate(() => window.__seafloor.idle()); await page.waitForTimeout(ms); await page.evaluate(() => window.__seafloor.idle()); };
  return { page, settle };
}
async function shot(page, file) { await page.screenshot({ path: `${outdir}/${file}` }); console.log('wrote', `${outdir}/${file}`); }
const view = (page, cam) => page.evaluate((c) => window.__seafloor.map.jumpTo(c), cam);
const level = (page, L) => page.evaluate((x) => window.__seafloor.setSeaLevel(x), L);
const stat = (page) => page.evaluate(() => `${document.getElementById('sea-out').textContent} | ${document.getElementById('sea-stat').textContent}`);

// ---------- desktop ----------
{
  const { page, settle } = await session('desktop', { width: 1440, height: 900 });
  const gl = await page.evaluate(() => { const g = window.__seafloor.map.painter.context.gl; const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
  console.log('renderer:', gl);
  await page.click('#tab-layers').catch(() => {}); // desktop has no tabs; harmless
  await page.click('#sea-btn');
  await settle(2500);
  console.log('today:', await stat(page));
  await shot(page, 'sea-1-today.png');

  await level(page, -120);
  await view(page, { center: [-172, 62], zoom: 3.1, pitch: 0, bearing: 0 });
  await settle(2500);
  console.log('-120:', await stat(page));
  console.log('readout -120 at Bering Strait shelf (-168.5, 65.5):', await page.evaluate(async () => { await window.__seafloor.readout(-168.5, 65.5); return document.getElementById('readout-grid').innerText.replace(/\n+/g, ' | '); }));
  await shot(page, 'sea-2-lgm-beringia.png');

  await view(page, { center: [112, -2], zoom: 3.0, pitch: 0, bearing: 0 });
  await settle(2500);
  await shot(page, 'sea-3-lgm-sundaland.png');

  await view(page, { center: [3, 54.5], zoom: 4.3, pitch: 0, bearing: 0 });
  await settle(2500);
  await shot(page, 'sea-4-lgm-doggerland.png');

  await level(page, -2500);
  await view(page, { center: [-31, 33], zoom: 3.4, pitch: 0, bearing: 0 });
  await settle(2500);
  console.log('-2500:', await stat(page));
  await shot(page, 'sea-5-ridges-midatlantic.png');

  await level(page, -6000);
  await view(page, { center: [160, 10], zoom: 2.05, pitch: 0, bearing: 0 });
  await settle(2500);
  console.log('-6000:', await stat(page));
  await shot(page, 'sea-6-trenches-only.png');

  await level(page, 70);
  await view(page, { center: [8, 50], zoom: 3.7, pitch: 0, bearing: 0 });
  await settle(2500);
  console.log('+70:', await stat(page));
  await shot(page, 'sea-7-plus70-europe.png');

  await view(page, { center: [90, 23.5], zoom: 5.0, pitch: 0, bearing: 0 });
  await settle(2500);
  console.log('readout +70 at Dhaka (90.41, 23.81):', await page.evaluate(async () => { await window.__seafloor.readout(90.41, 23.81); return document.getElementById('readout-grid').innerText.replace(/\n+/g, ' | '); }));
  await shot(page, 'sea-8-plus70-bangladesh.png');

  await level(page, 10);
  await settle(2000);
  await shot(page, 'sea-9-plus10-bangladesh.png');

  // animation: globe view, play from today, measure 10 s, screenshot mid-play
  await level(page, 0);
  await view(page, { center: [130, 10], zoom: 2.05, pitch: 0, bearing: 0 });
  await settle(2500);
  await page.evaluate(() => window.__seafloor.seaStats()); // reset counters
  await page.click('#sea-play');
  await page.waitForTimeout(5000);
  console.log('mid-play level:', await page.evaluate(() => window.__seafloor.seaLevel()));
  await shot(page, 'sea-10-playing.png');
  await page.waitForTimeout(5000);
  const st = await page.evaluate(() => window.__seafloor.seaStats());
  console.log('frame timing (10 s of play, 1440x900 @1x):', JSON.stringify(st));
  // zoomed-in + pitched (3D terrain, heavier) timing
  await page.evaluate(() => window.__seafloor.play(false));
  await view(page, { center: [142.5, 12], zoom: 5, pitch: 60, bearing: 20 });
  await settle(2000);
  await page.evaluate(() => window.__seafloor.seaStats());
  await page.evaluate(() => window.__seafloor.play(true));
  await page.waitForTimeout(6000);
  console.log('frame timing (6 s, z5 pitch 60, 3D terrain):', JSON.stringify(await page.evaluate(() => window.__seafloor.seaStats())));
  await page.evaluate(() => window.__seafloor.play(false));
  check('pause button state', (await page.getAttribute('#sea-play', 'aria-pressed')) === 'false');

  // slider by keyboard: one step in the fine range = 1 m
  await level(page, -120);
  await page.focus('#sea-range');
  await page.keyboard.press('ArrowRight');
  check('arrow key is 1 m in the fine range', (await page.evaluate(() => window.__seafloor.seaLevel())) === -119, String(await page.evaluate(() => window.__seafloor.seaLevel())));
  await page.waitForTimeout(400);
  check('hash follows level', (await page.evaluate(() => location.hash)) === '#sea=-119', await page.evaluate(() => location.hash));

  // preset button
  await page.click('#sea-presets button[data-level="70"]');
  check('preset +70 applies', (await page.evaluate(() => window.__seafloor.seaLevel())) === 70);

  // story resets sea level to 0 and closes the panel
  await page.evaluate(() => window.__seafloor.playStory('challenger-deep', true));
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ L: window.__seafloor.seaLevel(), hidden: document.getElementById('sea').hidden, hash: location.hash }));
  check('story resets sea level', after.L === 0 && after.hidden && after.hash === '#story=challenger-deep', JSON.stringify(after));

  // profile and sea panel are exclusive
  await page.click('#sea-btn');
  await level(page, -50);
  await page.click('#profile-btn');
  const ex = await page.evaluate(() => ({ L: window.__seafloor.seaLevel(), seaHidden: document.getElementById('sea').hidden, profileHidden: document.getElementById('profile').hidden }));
  check('profile closes sea panel', ex.L === 0 && ex.seaHidden && !ex.profileHidden, JSON.stringify(ex));
  await page.click('#profile-close');
  await page.close();
}

// ---------- deep link ----------
{
  const { page, settle } = await session('deeplink', { width: 1280, height: 800 }, '#sea=-120');
  await settle(1500);
  const d = await page.evaluate(() => ({ L: window.__seafloor.seaLevel(), open: !document.getElementById('sea').hidden, out: document.getElementById('sea-out').textContent, slider: document.getElementById('sea-range').value }));
  check('#sea=-120 restores the level', d.L === -120 && d.open, JSON.stringify(d));
  await page.evaluate(() => { location.hash = '#sea=10'; });
  await page.waitForTimeout(300);
  check('hashchange to #sea=10', (await page.evaluate(() => window.__seafloor.seaLevel())) === 10);
  await page.close();
  const s2 = await session('deeplink2', { width: 1280, height: 800 }, '#story=bahamas&sea=-120');
  await s2.settle(1000);
  const d2 = await s2.page.evaluate(() => ({ story: window.__seafloor.current(), L: window.__seafloor.seaLevel() }));
  await s2.page.waitForTimeout(400);
  const h2 = await s2.page.evaluate(() => location.hash);
  check('#story=bahamas&sea=-120 keeps both', d2.story === 'bahamas' && d2.L === -120 && h2 === '#story=bahamas&sea=-120', `${JSON.stringify(d2)} ${h2}`);
  await s2.page.close();
}

// ---------- phone ----------
{
  const { page, settle } = await session('phone', { width: 390, height: 844 }, '#sea=-120', 2);
  await page.evaluate(() => window.__seafloor.map.jumpTo({ center: [-170, 62], zoom: 2.4 }));
  await settle(2500);
  await page.evaluate(async () => { await window.__seafloor.readout(-168.5, 65.5); });
  await shot(page, 'sea-phone-1-lgm.png');
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check('phone: no horizontal scroll', noHScroll);
  await page.click('#sea-presets button[data-level="70"]');
  await page.evaluate(() => window.__seafloor.map.jumpTo({ center: [90, 23.5], zoom: 4.2 }));
  await settle(2500);
  await shot(page, 'sea-phone-2-plus70.png');
  await page.click('#sea-close');
  await settle(800);
  const ph = await page.evaluate(() => ({ L: window.__seafloor.seaLevel(), tabsShown: getComputedStyle(document.querySelector('.tabs')).display !== 'none' }));
  check('phone: close returns to today and the tabs', ph.L === 0 && ph.tabsShown, JSON.stringify(ph));
  await shot(page, 'sea-phone-3-closed.png');
  await page.close();
}

console.log(checks.join('\n'));
console.log('console/http problems:', problems.length ? problems : 'none');
await browser.close();
