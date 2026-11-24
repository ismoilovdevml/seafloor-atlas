// Start-up smoke test of the built site: open it in Chrome and fail on any uncaught page error, then check that the
// controls wired near the end of main.ts respond (an exception earlier in the module silently leaves them dead).
// Then a layout check at 1440x900, 1024x720 and 375x812: no two visible UI panels overlap and nothing makes the
// page scroll sideways, with the panels closed, with a drawer open and with a card open.
//   npm run build && node scripts/smoke.mjs        (serves dist/ with vite preview on a free port)
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const port = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
const fail = (msg) => { console.error(`smoke: ${msg}`); server.kill(); process.exit(1); };
// UI boxes that must never overlap one another (the top bar, the control rail, readout, legend, tool bar or phone
// tabs, and whichever drawers, cards, popovers and tool panels are open)
const PANELS = ['#topbar', '#nav3d', '#readout', '#legend', '#toolbar', '.tabs', '#stories', '#layers', '#inspector',
  '#story-card', '#feature-card', '#settings', '#about', '.tool-panel'];
const visibleBoxes = (sels) => {
  const out = [];
  for (const s of sels) for (const el of document.querySelectorAll(s)) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (el.hidden || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || r.width < 1 || r.height < 1) continue;
    out.push({ name: el.id ? `#${el.id}` : s, l: r.left, t: r.top, r: r.right, b: r.bottom });
  }
  return { boxes: out, scrollW: document.documentElement.scrollWidth, bodyW: document.body.scrollWidth, vw: innerWidth };
};
/** Problems in the current layout: overlapping panel pairs (> 1 px both ways) and horizontal overflow. */
async function layoutProblems(page, label) {
  const { boxes, scrollW, bodyW, vw } = await page.evaluate(visibleBoxes, PANELS);
  const bad = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ow = Math.min(a.r, b.r) - Math.max(a.l, b.l), oh = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (ow > 1 && oh > 1) bad.push(`${label}: ${a.name} overlaps ${b.name} by ${Math.round(ow)} x ${Math.round(oh)} px`);
    }
    if (boxes[i].l < -1 || boxes[i].r > vw + 1) bad.push(`${label}: ${boxes[i].name} runs off screen (${Math.round(boxes[i].l)}..${Math.round(boxes[i].r)} of ${vw})`);
  }
  if (scrollW > vw || bodyW > vw) bad.push(`${label}: page is ${Math.max(scrollW, bodyW)} px wide in a ${vw} px window`);
  return { bad, names: boxes.map((b) => b.name) };
}
/** Layout at three window sizes: panels closed, a drawer open (Layers), then a card on top (the AMOC card). */
async function layoutCheck(browser, base) {
  const problems = [], seen = [];
  for (const [w, h] of [[1440, 900], [1024, 720], [375, 812]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(base, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('#nav3d[data-placed]', { state: 'attached', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const phone = w < 761;
    const steps = [
      ['closed', null],
      ['Layers open', () => document.getElementById(innerWidth < 761 ? 'tab-layers' : 'layers-btn')?.click()],
      ['Layers + AMOC card', () => { const t = document.getElementById('t-amoc'); if (t && !t.checked) t.click(); }],
    ];
    for (const [name, act] of steps) {
      if (act) await page.evaluate(act);
      if (name.includes('AMOC')) await page.waitForSelector('#feature-card:not([hidden])', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(800);
      const { bad, names } = await layoutProblems(page, `${w}x${h} ${name}`);
      problems.push(...bad);
      seen.push(`${w}x${h} ${name}: ${names.join(' ')}`);
    }
    // on a desktop the Explore drawer shares the left column with the legend
    if (!phone) {
      await page.evaluate(() => document.getElementById('explore-btn')?.click());
      await page.waitForTimeout(800);
      const { bad, names } = await layoutProblems(page, `${w}x${h} Explore + Layers + card`);
      problems.push(...bad);
      seen.push(`${w}x${h} Explore + Layers + card: ${names.join(' ')}`);
    }
    await page.close();
  }
  return { problems, seen };
}
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
  const layout = await layoutCheck(browser, `http://localhost:${port}/`);
  await browser.close();
  if (errors.length) fail(`page errors:\n  ${errors.join('\n  ')}`);
  if (!measuring) fail('the measure button did not open its panel');
  if (touring !== 'true') fail('the Tour button did not start the tour');
  if (!satOn[0] || !satOn[1]) fail(`satellite land is not on by default with its attribution (${satOn})`);
  if (!satOff[0] || !satOff[1]) fail(`the Satellite land switch did not turn it off (${satOff})`);
  if (!insp?.status) fail(`the point inspector did not classify a point (${JSON.stringify(insp)})`);
  if (!inspClosed) fail('Esc did not close the point inspector');
  if (layout.problems.length) fail(`layout:\n  ${layout.problems.join('\n  ')}\nvisible panels:\n  ${layout.seen.join('\n  ')}`);
  console.log(`smoke: no page errors; measure, tour, satellite land and point inspector (${insp.status}) respond`);
  console.log(`smoke: layout OK, no overlapping panels or sideways scroll in ${layout.seen.length} states:\n  ${layout.seen.join('\n  ')}`);
} catch (e) { fail(String(e)); }
server.kill();
