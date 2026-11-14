// End-to-end browser QA: every story, every layer, profile, readout, search, deep links, both poles, phone.
// Isolated headless Chrome with GPU (playwright-core), never the user's browser.
// usage: node scripts/qa.mjs [baseUrl=http://localhost:4173/] [outdir=qa-out]
// Writes <outdir>/*.png and <outdir>/summary.json; exits 1 if any check fails.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const [,, base = 'http://localhost:4173/', outdir = 'qa-out'] = process.argv;
mkdirSync(outdir, { recursive: true });
const checks = [], problems = [], poles = {};
const ok = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const KNOWN_WARNING = /calculateFogMatrix is not supported on globe projection/;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
async function session(name, viewport) {
  const mobile = viewport.width < 600;
  const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !KNOWN_WARNING.test(m.text())) problems.push(`[${name}] [${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${name}] [pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[${name}] [http ${r.status()}] ${r.url()}`); });
  await page.goto(base);
  await page.waitForFunction(() => window.__seafloor, null, { timeout: 60000 });
  const settle = async (ms = 1200) => { await page.evaluate(() => window.__seafloor.idle()); await page.waitForTimeout(ms); await page.evaluate(() => window.__seafloor.idle()); };
  return { page, settle };
}
const shot = (page, f) => page.screenshot({ path: `${outdir}/${f}` });

// ---------------- desktop ----------------
{
  const { page, settle } = await session('desktop', { width: 1440, height: 900 });
  const meta = await page.evaluate(() => ({ synthetic: window.__seafloor.synthetic, meta: window.__seafloor.meta }));
  ok('real tiles loaded (not synthetic)', !meta.synthetic && meta.meta.version === 'GEBCO_2026', meta.meta.version);
  ok('meta has polar caps', !!meta.meta.polarCaps, JSON.stringify(meta.meta.polarCaps));
  await settle(2500);
  await shot(page, 'globe.png');

  // poles: look straight down; record where the pole lands on screen for the pixel check
  for (const [name, lat] of [['north', 90], ['south', -90]]) {
    await page.evaluate((lat) => window.__seafloor.map.jumpTo({ center: [0, lat > 0 ? 87 : -87], zoom: 2.6, pitch: 0, bearing: 0 }), lat);
    await settle(2000);
    poles[name] = await page.evaluate((lat) => { const p = window.__seafloor.map.project([0, lat]); return { x: p.x, y: p.y }; }, lat);
    await shot(page, `pole-${name}.png`);
  }

  // stories
  const ids = await page.evaluate(async () => (await (await fetch('data/stories.json')).json()).map((s) => s.id));
  for (const id of ids) {
    const r = await page.evaluate((id) => window.__seafloor.playStory(id, true), id);
    await settle(900);
    const cur = await page.evaluate(() => window.__seafloor.current());
    ok(`story ${id}`, r && cur === id);
    await shot(page, `story-${id}.png`);
  }

  // layers
  await page.evaluate(() => window.__seafloor.map.jumpTo({ center: [150, 0], zoom: 1.6, pitch: 0, bearing: 0 }));
  for (const [name, on, off] of [
    ['veil', (s) => s.setVeil(true), (s) => s.setVeil(false)],
    ['new2026', (s) => s.setNew?.(true), (s) => s.setNew?.(false)],
    ['plates', (s) => s.setPlates(true), (s) => s.setPlates(false)],
  ]) {
    await page.evaluate(`(${on.toString()})(window.__seafloor)`);
    await settle();
    const vis = await page.evaluate((id) => window.__seafloor.map.getLayoutProperty(id, 'visibility'), name);
    ok(`layer ${name} visible when on`, vis === 'visible', vis);
    await shot(page, `layer-${name}.png`);
    await page.evaluate(`(${off.toString()})(window.__seafloor)`);
  }

  // readout at Challenger Deep
  await page.evaluate(() => window.__seafloor.readout(142.5917, 11.3733));
  const depth = await page.textContent('#r-depth');
  const meas = await page.textContent('#r-meas');
  ok('readout depth at Challenger Deep', /10[,.\s]?\d{3}/.test(depth || ''), `${depth} / measured ${meas}`);

  // profile across the Mariana Trench
  const prof = await page.evaluate(() => window.__seafloor.profile([142.392, 12.373], [142.792, 10.373]));
  await settle(800);
  ok('profile across Mariana reaches below -10,000 m', prof && prof.min < -10000, JSON.stringify(prof)?.slice(0, 160));
  await shot(page, 'profile-mariana.png');
  await page.keyboard.press('Escape');

  // search
  await page.fill('#search-input', 'Challenger Deep');
  await page.waitForTimeout(400);
  const n = await page.locator('#search-results li').count();
  ok('search "Challenger Deep" lists results', n > 0, `${n} results`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6500);
  const c = await page.evaluate(() => window.__seafloor.map.getCenter());
  ok('search Enter flies to Challenger Deep', Math.abs(c.lat - 11.37) < 2 && Math.abs(c.lng - 142.59) < 3, `${c.lng.toFixed(2)}, ${c.lat.toFixed(2)}`);
  await shot(page, 'search-challenger.png');

  // sea level: presets change the land statistic, animation stays smooth, stories reset to 0
  if (await page.evaluate(() => typeof window.__seafloor.setSeaLevel === 'function')) {
    await page.evaluate(() => { const s = window.__seafloor; s.openSea(); s.map.jumpTo({ center: [-170, 63], zoom: 2.6, pitch: 0, bearing: 0 }); });
    const stat = {};
    for (const L of [0, -120, 70]) {
      await page.evaluate((L) => window.__seafloor.setSeaLevel(L), L);
      await settle(600);
      stat[L] = await page.textContent('#sea-stat');
      await shot(page, `sea-${L}.png`);
    }
    const km = (t) => Number((/([\d.]+)\s*million/.exec(t || '') || [])[1]);
    ok('sea level -120 m exposes more land than today, +70 m less', km(stat[-120]) > km(stat[0]) && km(stat[70]) < km(stat[0]),
      `today ${km(stat[0])}, -120 ${km(stat[-120])}, +70 ${km(stat[70])} M km2`);
    await page.evaluate(() => { window.__seafloor.seaStats(); window.__seafloor.play(true); });
    await page.waitForTimeout(4000);
    const fs = await page.evaluate(() => { const s = window.__seafloor; s.play(false); return s.seaStats(); });
    ok('sea-level animation frame time p95 < 50 ms', fs.frameP95Ms !== null && fs.frameP95Ms < 50, JSON.stringify(fs));
    await page.evaluate(() => window.__seafloor.playStory('challenger-deep', true));
    await settle(500);
    ok('a story resets sea level to 0', (await page.evaluate(() => window.__seafloor.seaLevel())) === 0);
    await page.evaluate(() => { location.hash = '#sea=-120'; });
    await page.waitForTimeout(800);
    ok('#sea=-120 link sets the level', (await page.evaluate(() => window.__seafloor.seaLevel())) === -120);
    await page.evaluate(() => window.__seafloor.closeSea());
  }

  // deep link changed in an open tab
  await page.evaluate(() => { location.hash = '#story=drake-passage'; });
  await page.waitForTimeout(800);
  ok('hashchange plays the linked story', (await page.evaluate(() => window.__seafloor.current())) === 'drake-passage');
  await page.close();
}

// ---------------- phone ----------------
{
  const { page, settle } = await session('phone', { width: 390, height: 844 });
  await settle(2500);
  await shot(page, 'phone-globe.png');
  await page.click('#tab-layers');
  await page.waitForTimeout(500);
  ok('phone: layers tab opens', (await page.getAttribute('#tab-layers', 'aria-selected')) === 'true');
  await shot(page, 'phone-layers.png');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  ok('phone: no horizontal scroll', !overflow);
  await page.close();
}

await browser.close();
ok('no console errors / failed requests', problems.length === 0, problems.slice(0, 8).join(' | '));
writeFileSync(`${outdir}/summary.json`, JSON.stringify({ base, checks, problems, poles }, null, 1));
const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
