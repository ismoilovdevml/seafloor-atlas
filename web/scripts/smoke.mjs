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
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(4000);
  // the measure tool and the tour are wired late in main.ts: both must react
  let measuring = false;
  for (let t0 = Date.now(); Date.now() - t0 < 30000 && !measuring;) {
    await page.click('#nav-measure', { timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(500);
    measuring = await page.evaluate(() => !document.getElementById('measure')?.hidden);
  }
  await page.keyboard.press('Escape');
  // on a CI runner without a GPU start-up is slower: retry until the late-wired Tour button answers (30 s at most)
  let touring = null;
  for (let t0 = Date.now(); Date.now() - t0 < 30000 && touring !== 'true';) {
    await page.click('#tour-btn', { timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(1500);
    touring = await page.getAttribute('#tour-btn', 'aria-pressed');
  }
  await browser.close();
  if (errors.length) fail(`page errors:\n  ${errors.join('\n  ')}`);
  if (!measuring) fail('the measure button did not open its panel');
  if (touring !== 'true') fail('the Tour button did not start the tour');
  console.log('smoke: no page errors; measure and tour respond');
} catch (e) { fail(String(e)); }
server.kill();
