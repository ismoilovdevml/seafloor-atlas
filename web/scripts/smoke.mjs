// Start-up smoke test of the built site: open it in Chrome and fail on any uncaught page error, then check that the
// controls wired near the end of main.ts respond (an exception earlier in the module silently leaves them dead).
//   npm run build && node scripts/smoke.mjs        (serves dist/ with vite preview on a free port)
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const port = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
const fail = (msg) => { console.error(`smoke: ${msg}`); server.kill(); process.exit(1); };
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${port}/`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e)));
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'commit', timeout: 60000 });
  // a visitor may press the ruler while start-up is still running: click it as soon as it exists, twice (on, off)
  for (let i = 0, n = 0; i < 400 && n < 2; i++) {
    await page.waitForTimeout(25);
    if (await page.evaluate(() => { const b = document.getElementById('nav-measure'); b?.click(); return !!b; }).catch(() => false)) n++;
  }
  await page.waitForLoadState('load');
  await page.waitForTimeout(4000);
  // the measure tool and the tour are wired late in main.ts: both must react
  let measuring = false;
  for (let t0 = Date.now(); Date.now() - t0 < 60000 && !measuring;) {
    // a DOM click: this checks the wiring, not the layout (the compass stays invisible until it is placed)
    await page.evaluate(() => document.getElementById('nav-measure')?.click());
    await page.waitForTimeout(500);
    measuring = await page.evaluate(() => !document.getElementById('measure')?.hidden);
  }
  await page.keyboard.press('Escape');
  // satellite land is on by default with its attribution; the Layers switch turns it off (#land=grey)
  const satOn = await page.evaluate(() => [document.getElementById('t-satland')?.checked, document.getElementById('map-att')?.hidden === false]);
  await page.evaluate(() => document.getElementById('t-satland')?.click());
  await page.waitForTimeout(300);
  const satOff = await page.evaluate(() => [location.hash.includes('land=grey'), document.getElementById('map-att')?.hidden === true]);
  await page.evaluate(() => document.getElementById('t-satland')?.click());
  let insp = null;
  for (let t0 = Date.now(); Date.now() - t0 < 30000 && !insp?.status;) {
    insp = await page.evaluate(async () => { await window.__seafloor?.inspect(-30, -20); return window.__seafloor?.inspector(); });
    if (!insp?.status) await page.waitForTimeout(1000);
  }
  await page.keyboard.press('Escape');
  const inspClosed = await page.evaluate(() => document.getElementById('inspector')?.hidden);
  // on a CI runner without a GPU start-up is slower: retry until the late-wired Tour button answers (60 s at most)
  let touring = null;
  for (let t0 = Date.now(); Date.now() - t0 < 60000 && touring !== 'true';) {
    await page.evaluate(() => document.getElementById('tour-btn')?.click());
    await page.waitForTimeout(1500);
    touring = await page.getAttribute('#tour-btn', 'aria-pressed');
  }
  await browser.close();
  if (errors.length) fail(`page errors:\n  ${errors.join('\n  ')}`);
  if (!measuring) fail('the measure button did not open its panel');
  if (touring !== 'true') fail('the Tour button did not start the tour');
  if (!satOn[0] || !satOn[1]) fail(`satellite land is not on by default with its attribution (${satOn})`);
  if (!satOff[0] || !satOff[1]) fail(`the Satellite land switch did not turn it off (${satOff})`);
  if (!insp?.status) fail(`the point inspector did not classify a point (${JSON.stringify(insp)})`);
  if (!inspClosed) fail('Esc did not close the point inspector');
  console.log(`smoke: no page errors; measure, tour, satellite land and point inspector (${insp.status}) respond`);
} catch (e) { fail(String(e)); }
server.kill();
