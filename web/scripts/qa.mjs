// End-to-end browser QA: every story, every layer, profile, readout, search, deep links, both poles, phone,
// and the panel shell (layer groups and (i) notes, legend dock, tool bar, settings popover, keyboard search, phone tabs).
// Isolated headless Chrome with GPU (playwright-core), never the user's browser.
// usage: node scripts/qa.mjs [baseUrl=http://localhost:4173/] [outdir=qa-out]
// Writes <outdir>/*.png and <outdir>/summary.json; exits 1 if any check fails.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const [,, base = 'http://localhost:4173/', outdir = 'qa-out'] = process.argv;
mkdirSync(outdir, { recursive: true });
const checks = [], poles = {};
let problems = [];
const recovered = new Set();
const ok = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const KNOWN_WARNING = /calculateFogMatrix is not supported on globe projection/;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
async function session(name, viewport, opts = {}) {
  const mobile = viewport.width < 600;
  const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: opts.dpr ?? 1 });
  // A 5xx that the viewer retried successfully (tilesource.ts backoff) is not a failure: such entries carry
  // their URL and are dropped at the end if a later 2xx for the same URL arrived.
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !KNOWN_WARNING.test(m.text())) problems.push({ text: `[${name}] [${m.type()}] ${m.text()}`, url: /status of 5\d\d/.test(m.text()) ? m.location()?.url : undefined }); });
  page.on('pageerror', (e) => problems.push({ text: `[${name}] [pageerror] ${e.message}` }));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push({ text: `[${name}] [http ${r.status()}] ${r.url()}`, url: r.status() >= 500 ? r.url() : undefined });
    else if (r.status() < 300) recovered.add(r.url());
  });
  opts.onPage?.(page);
  await page.goto(base + (opts.query ?? ''));
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

  // ---------- panel shell ----------
  const share = await page.evaluate(() => window.__seafloor.mapShare());
  ok('default view: map-first (>= 85% of the 1440x900 window shows the map)', share >= 0.85, `${(100 * share).toFixed(1)}% of the window is map`);
  // layers drawer: three groups, compact rows, (i) expands a short note
  await page.click('#layers-btn');
  await page.waitForTimeout(300);
  const groups = await page.evaluate(() => ({
    open: document.getElementById('layers-btn').getAttribute('aria-expanded'),
    titles: [...document.querySelectorAll('#layers .group-title')].map((h) => h.textContent),
    rows: [...document.querySelectorAll('#layers .row')].filter((r) => r.offsetParent).map((r) => r.querySelector('.row-name').textContent),
    notesOpen: [...document.querySelectorAll('#layers .info')].filter((x) => !x.hidden).length,
  }));
  ok('layers drawer: Seafloor / Ocean / Human activity groups with compact rows, notes folded', groups.open === 'true' && groups.titles.join() === 'Seafloor,Ocean,Human activity' && groups.rows.length >= 11 && groups.notesOpen === 0,
    `${groups.titles.join(' | ')}; ${groups.rows.length} rows: ${groups.rows.join(', ')}`);
  await page.click('[aria-controls="info-veil"]');
  const note = await page.evaluate(() => ({ vis: !document.getElementById('info-veil').hidden, exp: document.querySelector('[aria-controls="info-veil"]').getAttribute('aria-expanded'), text: document.getElementById('info-veil').textContent.trim() }));
  await page.click('[aria-controls="info-veil"]');
  const noteClosed = await page.evaluate(() => document.getElementById('info-veil').hidden);
  ok('(i) expands a short note with the key stat and source, and folds again', note.vis && note.exp === 'true' && /\d+\.\d%/.test(note.text) && /GEBCO/.test(note.text) && noteClosed, note.text.slice(0, 120));
  // legend dock lists only what is on the map
  const lg0 = await page.evaluate(() => window.__seafloor.ui.legend());
  await page.click('label:has(#t-veil)'); await page.click('label:has(#t-plates)');
  await page.waitForTimeout(300);
  const lg1 = await page.evaluate(() => window.__seafloor.ui.legend());
  const badge = await page.textContent('#layers-count');
  await page.click('label:has(#t-veil)'); await page.click('label:has(#t-plates)');
  await page.waitForTimeout(300);
  const lg2 = await page.evaluate(() => window.__seafloor.ui.legend());
  ok('legend dock shows only the active layers', lg0.sections.join() === 'depth-legend' && lg1.sections.join() === 'depth-legend,lg-veil,lg-plates' && lg2.sections.join() === 'depth-legend' && badge === '2',
    `off: ${lg0.sections}; veil+plates on: ${lg1.sections} (badge ${badge}); off again: ${lg2.sections}`);
  await page.click('#layers-btn');
  // tool bar: one tool panel at a time
  const toolState = () => page.evaluate(() => ['profile', 'sea', 'water'].map((id) => `${id}:${document.getElementById(id).hidden ? 0 : 1}/${document.getElementById(id + '-btn').getAttribute('aria-pressed') === 'true' ? 1 : 0}`).join(' '));
  const steps = [];
  for (const b of ['sea', 'water', 'profile', 'profile']) { await page.click(`#${b}-btn`); await page.waitForTimeout(500); steps.push(await toolState()); }
  ok('tool bar opens one tool at a time (sea level -> ocean water -> profile -> closed)',
    steps[0] === 'profile:0/0 sea:1/1 water:0/0' && steps[1] === 'profile:0/0 sea:0/0 water:1/1' && steps[2] === 'profile:1/1 sea:0/0 water:0/0' && steps[3] === 'profile:0/0 sea:0/0 water:0/0', steps.join(' | '));
  // settings popover: vertical exaggeration
  await page.click('#settings-btn');
  await page.fill('#exag', '12');
  const ex = await page.evaluate(() => ({ pop: !document.getElementById('settings').hidden, ...window.__seafloor.ui.exaggeration() }));
  await page.click('label:has(#exag-auto)');
  const exAuto = await page.evaluate(() => window.__seafloor.ui.exaggeration());
  await page.keyboard.press('Escape');
  const popClosed = await page.evaluate(() => ({ hidden: document.getElementById('settings').hidden, focus: document.activeElement.id }));
  ok('settings popover sets the vertical exaggeration (and back to auto); Esc closes it and returns focus', ex.pop && ex.value === 12 && ex.terrain === 12 && !ex.auto && exAuto.auto && popClosed.hidden && popClosed.focus === 'settings-btn',
    `set ${ex.value} (terrain ${ex.terrain}, auto ${ex.auto}); auto again ${exAuto.auto} -> ${exAuto.value}; closed ${popClosed.hidden}, focus ${popClosed.focus}`);
  // keyboard: Cmd+K and / focus the search box
  await page.keyboard.press('Meta+k');
  const f1 = await page.evaluate(() => document.activeElement.id);
  await page.keyboard.press('Escape');
  const f2 = await page.evaluate(() => document.activeElement.id);
  await page.keyboard.press('/');
  const f3 = await page.evaluate(() => document.activeElement.id);
  await page.keyboard.press('Escape');
  ok('Cmd+K and / focus the search box, Esc leaves it', f1 === 'search-input' && f2 !== 'search-input' && f3 === 'search-input', `Cmd+K -> ${f1}, Esc -> ${f2 || 'body'}, / -> ${f3}`);
  // search covers guided views too
  await page.fill('#search-input', 'drake');
  await page.waitForTimeout(300);
  const storyHit = await page.$$eval('#search-results li[data-kind="story"]', (els) => els.map((e) => e.textContent));
  await page.fill('#search-input', '');
  await page.keyboard.press('Escape');
  ok('search lists guided views', storyHit.some((t) => /Drake Passage/.test(t)), storyHit.join(' | '));

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

  // ocean water (WOA23): layer, readout, monthly animation, water-column chart, coexistence with other tools
  if (await page.evaluate(() => window.__seafloor.water?.ready)) {
    const W = (fn, arg) => page.evaluate(fn, arg);
    await W(() => { const s = window.__seafloor; s.map.jumpTo({ center: [160, 0], zoom: 1.8, pitch: 0, bearing: 0 }); return s.water.show('t', 0); });
    await settle(1500);
    const st = await W(() => window.__seafloor.water.state());
    // the map canvas behind the layer: warm-pool pixel must be in the warm (orange/yellow) end of cmocean thermal
    const px = await W(() => { const c = window.__seafloor.map.getSource('water').getCanvas(); const x = Math.floor(((150 + 180) / 360) * c.width), y = c.height / 2; return [...c.getContext('2d').getImageData(x, y, 1, 1).data]; });
    ok('water layer visible with warm colours in the West Pacific', st.open && st.visibility === 'visible' && px[3] === 255 && px[0] > 200 && px[2] < 140, `${JSON.stringify(st)} rgba ${px}`);
    await page.evaluate(() => window.__seafloor.readout(150, 0));
    const tv = await page.textContent('#r-meas');
    const tnum = Number((tv || '').replace('−', '-').replace(/[^\d.-]/g, ''));
    ok('readout: surface temperature in the warm pool 28-31 °C', tnum > 28 && tnum < 31 && (await page.textContent('#r-meas-dt')).startsWith('Temperature'), tv);
    await shot(page, 'water-t0.png');
    await W(() => window.__seafloor.water.set({ v: 's', depthIdx: 5 }));
    await page.evaluate(() => window.__seafloor.readout(-12, 37));
    const med = Number((await page.textContent('#r-meas')).replace(/[^\d.]/g, ''));
    await page.evaluate(() => window.__seafloor.readout(-60, 37));
    const west = Number((await page.textContent('#r-meas')).replace(/[^\d.]/g, ''));
    ok('readout: Mediterranean outflow at 1,000 m saltier than the western Atlantic', med > 35.6 && med - west > 0.5, `off Iberia ${med}, 60° W ${west}`);
    const col = await W(() => window.__seafloor.water.column(-20.5, 30.5));
    await settle(500);
    const paths = await page.locator('#wc-chart svg path.series').count();
    ok('water-column chart renders T, S and density down to the abyss', col && col.series === 3 && paths === 3 && col.bottom >= 4000 && col.surface.d > 20 && col.surface.d < 28,
      JSON.stringify(col));
    await shot(page, 'water-column.png');
    // the 12 monthly layers (~6.6 MB) are fetched first; measuring before they arrive only times the network
    const pre = await W(async () => { const t0 = performance.now(); const n = await window.__seafloor.water.preloadMonths(); return { n, ms: Math.round(performance.now() - t0) }; });
    await W(() => { const w = window.__seafloor.water; w.set({ v: 't', depthIdx: 0 }); w.stats(); w.play(true); });
    await page.waitForTimeout(3000);
    const anim = await W(() => { const w = window.__seafloor.water; const st = w.state(); w.play(false); return { st, stats: w.stats() }; });
    ok('monthly animation runs (12 months loaded, > 10 redraws in 3 s, redraw p95 < 60 ms)', pre.n === 12 && anim.st.playing && anim.stats.renders > 10 && anim.stats.p95Ms < 60,
      `months loaded ${pre.n}/12 in ${pre.ms} ms; ${anim.stats.renders} redraws in 3 s, median ${anim.stats.medianMs} ms, p95 ${anim.stats.p95Ms} ms`);
    await W(() => window.__seafloor.openSea());
    ok('opening sea level closes the water panel', !(await W(() => window.__seafloor.water.state())).open);
    await W(() => { window.__seafloor.closeSea(); return window.__seafloor.water.show('d', 1000); });
    await W(() => window.__seafloor.playStory('challenger-deep', true));
    await settle(400);
    const after = await W(() => window.__seafloor.water.state());
    ok('a story turns the water layer off', !after.open && after.visibility === 'none', JSON.stringify(after));
    await page.evaluate(() => { location.hash = '#water=s-1000'; });
    await page.waitForTimeout(1200);
    const linked = await W(() => window.__seafloor.water.state());
    ok('#water=s-1000 link opens salinity at 1,000 m', linked.open && linked.v === 's' && linked.depth === 1000, JSON.stringify(linked));
    await W(() => window.__seafloor.water.close());
  }

  // ---------- human-activity overlays ----------
  // finds a screen point where the wanted feature is the top clickable hit, then clicks it like a user
  const closeCard = () => page.evaluate(() => { const c = document.getElementById('feature-card'); if (!c.hidden) c.querySelector('.close').click(); });
  async function clickFeature(key, re, layer, zoom, maxTries = 14) {
    await closeCard(); // an open card would sit over the point being clicked
    const f = await page.evaluate(([k, r]) => window.__seafloor.overlays.find(k, r), [key, re]);
    if (!f) return { ok: false, why: 'not in data' };
    const g = f.geometry;
    const pts = g.type === 'Point' ? [g.coordinates] : (g.type === 'LineString' ? [g.coordinates] : g.coordinates).flat();
    const step = Math.max(1, Math.floor(pts.length / maxTries));
    for (let i = Math.floor(step / 2); i < pts.length; i += step) {
      await page.evaluate(([c, z]) => window.__seafloor.map.jumpTo({ center: c, zoom: z, pitch: 0, bearing: 0 }), [pts[i], zoom]);
      await settle(500);
      const xy = await page.evaluate((c) => { const p = window.__seafloor.map.project(c); return [p.x, p.y]; }, pts[i]);
      const hits = await page.evaluate(([x, y]) => window.__seafloor.overlays.hitsAt(x, y), xy);
      if (hits[0] && hits[0].layer === layer && new RegExp(re).test(hits[0].name ?? '')) {
        await page.mouse.click(xy[0], xy[1]);
        await page.waitForTimeout(700);
        return { ok: true, name: await page.textContent('#f-name'), kind: await page.textContent('#f-kind'), lead: await page.textContent('#f-depth'), facts: await page.textContent('#f-facts'), cursor: null };
      }
    }
    return { ok: false, why: 'no unambiguous point' };
  }
  const OV = ['cables', 'shipping', 'wrecks', 'platforms', 'pipelines', 'wind'];
  const LAYER_OF = { cables: 'cables', shipping: 'shipping', wrecks: 'wrecks', platforms: 'platforms', pipelines: 'pipelines', wind: 'wind' };
  await page.evaluate(() => { const s = window.__seafloor; s.water.close(); s.closeSea(); document.querySelector('[data-close="feature-card"]').click(); s.map.jumpTo({ center: [-30, 30], zoom: 2.2, pitch: 0, bearing: 0 }); });
  await page.evaluate(() => window.__seafloor.ui.setDrawer('layers', true));
  for (const id of OV) {
    await page.click(`label:has(#t-${id})`);
    await settle(900);
    const on = await page.evaluate(() => window.__seafloor.overlays.state());
    const legend = await page.isVisible(`#ovl-${id}`);
    await page.click(`label:has(#t-${id})`);
    await page.waitForTimeout(300);
    const off = await page.evaluate(() => window.__seafloor.overlays.state());
    ok(`overlay toggle ${id} shows and hides its layer`, on.visibility[LAYER_OF[id]] === 'visible' && on.ids.includes(id) && legend && off.visibility[LAYER_OF[id]] === 'none' && !off.ids.includes(id),
      `on ${on.visibility[LAYER_OF[id]]}, legend ${legend}, off ${off.visibility[LAYER_OF[id]]}, load ${JSON.stringify(on.loadMs)}`);
  }
  await page.evaluate(() => window.__seafloor.ui.setDrawer('layers', false));
  // all layers on: screenshot + frame time while panning
  await page.evaluate(async () => { const s = window.__seafloor; for (const id of ['cables', 'shipping', 'wrecks', 'platforms', 'pipelines', 'wind']) await s.overlays.set(id, true); s.map.jumpTo({ center: [-20, 45], zoom: 2.6, pitch: 0, bearing: 0 }); });
  await settle(2000);
  await shot(page, 'overlays-all.png');
  const panAll = await page.evaluate(() => window.__seafloor.panFrames(60, 4000));
  ok('pan with all six overlays on: frame p95 < 20 ms', panAll.p95Ms < 20, JSON.stringify(panAll));
  await page.evaluate(async () => { const s = window.__seafloor; for (const id of ['shipping', 'wrecks', 'platforms', 'pipelines', 'wind']) await s.overlays.set(id, false); });
  ok('#layers= hash follows the toggles', (await page.evaluate(() => location.hash)).includes('layers=cables'), await page.evaluate(() => location.hash));
  const marea = await clickFeature('cables', '^MAREA$', 'cables', 4.2);
  ok('click on MAREA opens its cable card', marea.ok && marea.name === 'MAREA' && /6,605 km/.test(marea.lead), JSON.stringify(marea).slice(0, 220));
  await shot(page, 'card-marea.png');
  // search a wreck by name -> card with depth, link and a lazily loaded Commons thumbnail
  await page.evaluate(async () => { await window.__seafloor.overlays.set('cables', false); });
  await page.fill('#search-input', '');
  await page.focus('#search-input');
  await page.waitForTimeout(800);
  await page.fill('#search-input', 'Titanic');
  await page.waitForTimeout(500);
  const opts = await page.$$eval('#search-results li[data-i]', (els) => els.map((e) => ({ i: e.dataset.i, kind: e.dataset.kind, t: e.textContent })));
  const t = opts.find((o) => o.kind === 'wreck' && /^Titanic/.test(o.t));
  if (t) await page.dispatchEvent(`#search-results li[data-i="${t.i}"]`, 'pointerdown');
  await page.waitForTimeout(4500);
  const tc = await page.evaluate(() => ({ name: document.getElementById('f-name').textContent, lead: document.getElementById('f-depth').textContent, img: document.getElementById('f-img').getAttribute('src'),
    imgLoaded: document.getElementById('f-img').complete && document.getElementById('f-img').naturalWidth > 0, links: [...document.querySelectorAll('#f-links a')].map((a) => a.href), wrecks: window.__seafloor.overlays.state().ids }));
  ok('search "Titanic" lists the wreck; its card says ~3,800 m with Wikipedia link and photo', !!t && tc.name === 'Titanic' && /3,8\d\d m/.test(tc.lead) && tc.links.some((h) => h.includes('en.wikipedia.org/wiki/Titanic'))
    && /Special:FilePath\/.+\?width=\d+/.test(tc.img || '') && tc.wrecks.includes('wrecks'), JSON.stringify({ kinds: opts.map((o) => o.kind), ...tc }).slice(0, 300));
  await page.evaluate(() => window.__seafloor.map.jumpTo({ center: [-49.95, 41.73], zoom: 4.2, pitch: 0, bearing: 0 }));
  await settle(1500);
  await shot(page, 'card-titanic.png');
  await page.evaluate(async () => { const s = window.__seafloor; await s.overlays.set('wrecks', false); await s.overlays.set('platforms', true); });
  // a platform cluster zooms in on click
  await closeCard();
  await page.evaluate(() => window.__seafloor.map.jumpTo({ center: [2.5, 56.5], zoom: 3.6, pitch: 0, bearing: 0 }));
  await settle(1200);
  const cl = await page.evaluate(() => { const m = window.__seafloor.map; const f = m.queryRenderedFeatures({ layers: ['platforms-cluster'] })[0]; if (!f) return null; const p = m.project(f.geometry.coordinates); return { x: p.x, y: p.y, z: m.getZoom() }; });
  if (cl) { await page.mouse.click(cl.x, cl.y); await page.waitForTimeout(1200); }
  const zAfter = await page.evaluate(() => window.__seafloor.map.getZoom());
  ok('clicking a platform cluster zooms in', cl && zAfter > cl.z + 0.5, cl ? `z ${cl.z.toFixed(2)} -> ${zAfter.toFixed(2)}` : 'no cluster rendered');
  const troll = await clickFeature('platforms', '^Troll A$', 'platforms', 9.2, 1);
  ok('click on Troll A opens its platform card', troll.ok && troll.name === 'Troll A' && /302 m/.test(troll.lead) && /Norway/.test(troll.facts), JSON.stringify(troll).slice(0, 220));
  await shot(page, 'card-troll-a.png');
  await page.evaluate(async () => { const s = window.__seafloor; await s.overlays.set('platforms', false); await s.overlays.set('wind', true); });
  // Hornsea 1's centre is a few km from Hornsea 2: below z8.5 the bigger farm wins the symbol collision
  const horn = await clickFeature('wind', '^Hornsea 1 ', 'wind', 8.5, 1);
  ok('click on Hornsea 1 opens its wind-farm card', horn.ok && /^Hornsea 1/.test(horn.name) && /1,218 MW/.test(horn.lead), JSON.stringify(horn).slice(0, 220));
  await page.evaluate(async () => { const s = window.__seafloor; await s.overlays.set('wind', false); await s.overlays.set('pipelines', true); });
  const ns = await clickFeature('pipelines', '^Nord Stream 1$', 'pipelines', 6.5, 30);
  ok('click on Nord Stream 1 opens its pipeline card', ns.ok && ns.name === 'Nord Stream 1' && /Gas pipeline/.test(ns.kind) && /Germany/.test(ns.facts), JSON.stringify(ns).slice(0, 220));
  await shot(page, 'card-nord-stream.png');
  await page.evaluate(async () => { await window.__seafloor.overlays.set('pipelines', false); document.querySelector('[data-close="feature-card"]').click(); });
  await page.evaluate(() => { location.hash = '#layers=cables,wrecks-all'; });
  await page.waitForTimeout(2500);
  const linkedOv = await page.evaluate(() => window.__seafloor.overlays.state());
  ok('#layers=cables,wrecks-all link turns those layers on', linkedOv.ids.join() === 'cables,wrecks' && linkedOv.allWrecks && linkedOv.visibility.wrecks === 'visible', JSON.stringify(linkedOv));
  await page.evaluate(async () => { const s = window.__seafloor; await s.overlays.set('cables', false); await s.overlays.set('wrecks', false); s.overlays.allWrecks(false); });

  // ---------- how sure is the depth? + marine life ----------
  const E = (fn, arg) => page.evaluate(fn, arg);
  if (await E(() => window.__seafloor.certainty.ok.disagree)) {
    await E(() => { document.querySelector('[data-close="feature-card"]').click(); window.__seafloor.ui.setDrawer('layers', true); window.__seafloor.map.jumpTo({ center: [-130, -30], zoom: 1.9, pitch: 0, bearing: 0 }); });
    await page.click('label:has(#t-disagree)');
    await settle(1500);
    const vis = await E(() => ({ st: window.__seafloor.certainty.state(), lg: window.__seafloor.ui.legend().sections }));
    const pr = await E(() => window.__seafloor.certainty.probe('disagree', -140, -20));
    await E(() => window.__seafloor.readout(-140, -20));
    await page.waitForTimeout(600);
    const ex = await E(() => [document.getElementById('r-extra-dt').textContent, document.getElementById('r-extra-dd').textContent, document.getElementById('r-extra').hidden]);
    ok('model disagreement: layer + legend on toggle; 140° W 20° S reads 300-1,000 m in the tile and the readout', vis.st.disagree === 'visible' && vis.lg.includes('lg-disagree') && pr && pr.m > 300 && pr.m < 1000 && ex[0] === 'Models differ by' && /m/.test(ex[1]) && !ex[2],
      `${JSON.stringify(vis)}; probe ${JSON.stringify(pr)}; readout "${ex[0]}: ${ex[1]}"`);
    await shot(page, 'certainty-disagree.png');
    await page.click('label:has(#t-disagree)');
  }
  if (await E(() => window.__seafloor.certainty.ok.uncertainty)) {
    await page.click('label:has(#t-uncertainty)');
    await settle(1200);
    const pr = await E(() => window.__seafloor.certainty.probe('uncertainty', -120, -30));
    await E(() => window.__seafloor.readout(-120, -30));
    await page.waitForTimeout(600);
    const ex = await E(() => [document.getElementById('r-extra-dt').textContent, document.getElementById('r-extra-dd').textContent]);
    const st = await E(() => window.__seafloor.certainty.state());
    ok('prediction confidence: layer on toggle; 120° W 30° S is a confidence class (not metres) in the readout', st.uncertainty === 'visible' && /confidence/.test(pr?.cls ?? '') && ex[0] === 'Prediction confidence' && /^(High|Medium|Low)$/.test(ex[1]),
      `probe ${JSON.stringify(pr)}; readout "${ex[0]}: ${ex[1]}"`);
    await shot(page, 'certainty-uncertainty.png');
    await page.click('label:has(#t-uncertainty)');
  }
  if (await E(() => window.__seafloor.certainty.ok.seals)) {
    await page.click('label:has(#t-seals)');
    // queryRenderedFeatures does not report circles on the globe below ~z2.5 although they are drawn (screenshot-checked), so count at z3.5
    await E(() => window.__seafloor.map.jumpTo({ center: [75, -64], zoom: 3.5, pitch: 0, bearing: 0 }));
    await settle(2500);
    const sd = await E(() => {
      const m = window.__seafloor.map, f = m.querySourceFeatures('seals');
      return { vis: m.getLayoutProperty('seals', 'visibility'), bins: f.length, antarctic: f.filter((x) => x.geometry.coordinates[1] < -60).length, stat: document.getElementById('seals-stat').textContent,
        rendered: m.queryRenderedFeatures({ layers: ['seals'] }).length };
    });
    ok('seal soundings: bins on the Antarctic shelf drawn; headline share from the file', sd.vis === 'visible' && sd.antarctic > 100 && sd.rendered > 50 && /^2\.2% of 4\.5 million seal dives/.test(sd.stat), JSON.stringify(sd));
    // click the South Georgia bin with the largest excess: a card with its numbers
    await E(() => { window.__seafloor.setFeatures(false); window.__seafloor.ui.setDrawer('layers', false); window.__seafloor.map.jumpTo({ center: [-37.15, -54.25], zoom: 7, pitch: 0, bearing: 0 }); });
    await settle(1500);
    const xy = await E(() => { const p = window.__seafloor.map.project([-37.15, -54.25]); return [p.x, p.y]; });
    const top = await E(([x, y]) => window.__seafloor.map.queryRenderedFeatures([[x - 4, y - 4], [x + 4, y + 4]]).map((f) => f.layer.id), xy);
    await page.mouse.click(xy[0], xy[1]);
    await page.waitForTimeout(700);
    const sc = await E(() => ({ kind: document.getElementById('f-kind').textContent, lead: document.getElementById('f-depth').textContent, shown: !document.getElementById('feature-card').hidden }));
    ok('seal soundings: clicking a bin opens its card (dives deeper than the chart)', sc.shown && sc.kind === 'Seal dives deeper than the chart' && /of \d[\d,]* dives/.test(sc.lead), `${JSON.stringify(sc)}; hits ${top.slice(0, 4)}`);
    await shot(page, 'certainty-seals.png');
    await E(() => { document.querySelector('[data-close="feature-card"]').click(); window.__seafloor.setFeatures(true); window.__seafloor.ui.setDrawer('layers', true); });
    await page.click('label:has(#t-seals)');
  }
  if (await E(() => window.__seafloor.marine.ready)) {
    await page.click('label:has(#t-marine)');
    await E(() => window.__seafloor.map.jumpTo({ center: [125, -2], zoom: 2.2, pitch: 0, bearing: 0 }));
    await settle(2000);
    const am = await E(() => ({ ct: window.__seafloor.marine.value(122.5, -2), gyre: window.__seafloor.marine.value(-145, 20), st: window.__seafloor.marine.state(), lg: window.__seafloor.ui.legend().sections }));
    ok('marine life (AquaMaps): Coral Triangle cell > 2,000 predicted species, 5x the North Pacific gyre', am.st.visibility === 'visible' && am.lg.includes('lg-marine') && am.ct.raw > 2000 && am.ct.raw > 5 * am.gyre.raw,
      `Coral Triangle ${am.ct.text}, gyre ${am.gyre.text}; render ${am.st.lastMs} ms`);
    await shot(page, 'marine-aquamaps.png');
    await page.click('label:has(input[value="es50"])');
    await settle(800);
    const regionMedian = (lon0, lon1, lat0, lat1) => {
      const v = [];
      for (let lo = lon0; lo <= lon1; lo += 1.40625) for (let la = lat0; la <= lat1; la += 1.40625) { const r = window.__seafloor.marine.value(lo, la).raw; if (Number.isFinite(r) && r > 0) v.push(r); }
      v.sort((a, b) => a - b); const m = v.length ? v[Math.floor(v.length / 2)] : NaN;
      return { raw: m, text: `ES50 ${Number.isFinite(m) ? ((m - 1) / 100).toFixed(1) : 'n/a'} (median of ${v.length} cells)` };
    };
    const es = await E(`(() => { const rm = ${regionMedian.toString()}; return { ct: rm(115, 130, -10, 10), ns: rm(-2, 8, 52, 60) }; })()`);
    await page.click('label:has(input[value="records"])');
    await settle(800);
    const rc = await E(() => ({ ns: window.__seafloor.marine.value(3, 56), gyre: window.__seafloor.marine.value(-150, 15) }));
    ok('marine life: ES50 higher in the Coral Triangle than the North Sea, records the other way round (sampling bias)', es.ct.raw > es.ns.raw && rc.ns.raw > 1000 && rc.ns.raw > rc.gyre.raw,
      `ES50 Coral Triangle ${es.ct.text} vs North Sea ${es.ns.text}; records North Sea ${rc.ns.text}, gyre 150° W 15° N ${rc.gyre.text}`);
    await shot(page, 'marine-records.png');
    await page.selectOption('#marine-group', 'whales');
    await settle(1200);
    const wh = await E(() => ({ st: window.__seafloor.marine.state(), disabled: document.querySelector('#marine-mode input').disabled }));
    // a click on open ocean with nothing else under it opens the cell card
    await E(() => { window.__seafloor.ui.setDrawer('layers', false); window.__seafloor.setFeatures(false); window.__seafloor.map.jumpTo({ center: [151, -5], zoom: 3, pitch: 0, bearing: 0 }); });
    await settle(1200);
    const c = await E(() => { const p = window.__seafloor.map.project([151, -5]); return [p.x, p.y]; });
    await page.mouse.click(c[0], c[1]);
    await page.waitForFunction(() => document.getElementById('f-kind').textContent.startsWith('Marine life'), null, { timeout: 10000 }).catch(() => {});
    const card = await E(() => ({ kind: document.getElementById('f-kind').textContent, lead: document.getElementById('f-depth').textContent, facts: document.getElementById('f-facts').children.length,
      group: document.getElementById('f-facts').textContent.slice(0, 80), links: [...document.querySelectorAll('#f-links a')].map((a) => a.href) }));
    ok('marine life: group filter (whales) redraws; clicking a cell opens its species card with the AquaMaps link', wh.st.group === 'whales' && wh.disabled && card.kind.startsWith('Marine life') && card.facts >= 6 && /Whales/.test(card.group) && card.links.some((h) => h.includes('aquamaps.org')),
      `${JSON.stringify(wh.st)}; card ${JSON.stringify(card).slice(0, 260)}`);
    await shot(page, 'marine-card.png');
    await E(async () => { const s = window.__seafloor; document.querySelector('[data-close="feature-card"]').click(); s.setFeatures(true); await s.water.show('t', 0); });
    await page.waitForTimeout(800);
    const ex = await E(() => ({ marine: window.__seafloor.marine.state().on, water: window.__seafloor.water.state().open }));
    ok('marine life and ocean water take turns (opening water switches marine life off)', !ex.marine && ex.water, JSON.stringify(ex));
    await E(async () => { const s = window.__seafloor; s.water.close(); await s.marine.set({ group: '', mode: 'aquamaps' }); });
  }

  // deep link changed in an open tab
  await page.evaluate(() => { location.hash = '#story=drake-passage'; });
  await page.waitForTimeout(800);
  ok('hashchange plays the linked story', (await page.evaluate(() => window.__seafloor.current())) === 'drake-passage');
  // panel open/closed state survives a reload (localStorage)
  await page.evaluate(() => { const u = window.__seafloor.ui; u.setDrawer('layers', true); u.setDrawer('explore', false); u.setLegend(false); });
  await page.reload();
  await page.waitForFunction(() => window.__seafloor, null, { timeout: 60000 });
  const kept = await page.evaluate(() => ({ layers: document.getElementById('layers-btn').getAttribute('aria-expanded'), explore: document.getElementById('explore-btn').getAttribute('aria-expanded'), legend: window.__seafloor.ui.legend() }));
  ok('panel state is remembered across a reload', kept.layers === 'true' && kept.explore === 'false' && kept.legend.collapsed, JSON.stringify(kept));
  await page.evaluate(() => { localStorage.clear(); });
  await page.close();
}

// ---------------- bottom panels never hide most of the globe ----------------
for (const [w, h] of [[1440, 900], [1280, 720], [1920, 1080]]) {
  const { page, settle } = await session(`layout-${w}x${h}`, { width: w, height: h });
  await settle(1500);
  for (const [name, open, close] of [
    ['water', 'window.__seafloor.water.show("t", 0)', 'window.__seafloor.water.close()'],
    ['water-column', '(async () => { await window.__seafloor.water.show("t", 0); await window.__seafloor.water.column(-150, 10); })()', 'window.__seafloor.water.close()'],
    ['sea', 'window.__seafloor.openSea(-120)', 'window.__seafloor.closeSea()'],
    ['profile', 'window.__seafloor.profile([-160, 20], [-140, 0])', 'document.getElementById("profile-close").click()'],
  ]) {
    await page.evaluate(open);
    await page.waitForTimeout(800); await settle(800);
    const c = await page.evaluate(() => window.__seafloor.layoutCheck());
    const p = c.panels.find((x) => ['water', 'sea', 'profile'].includes(x.id));
    ok(`${w}x${h} ${name}: globe centre uncovered and >= 60% of the globe disk free`, c.centreFree && c.freeFrac >= 0.6,
      `free ${(100 * c.freeFrac).toFixed(1)}%, zoom ${c.zoom}, disk r ${c.disk.r} at ${c.disk.cx},${c.disk.cy}, panel ${p ? `${p.w}x${p.h} @${p.left},${p.top}` : 'none'}`);
    await shot(page, `ui-${name}-${w}x${h}.png`);
    if (name === 'water' || name === 'sea') {
      const id = name;
      await page.click(`#${id}-min`);
      await page.waitForTimeout(500);
      const m = await page.evaluate((id) => ({ h: document.getElementById(id).getBoundingClientRect().height, exp: document.getElementById(`${id}-min`).getAttribute('aria-expanded') }), id);
      if (name === 'water') await shot(page, `ui-water-minimised-${w}x${h}.png`);
      await page.focus(`#${id}-min`); await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      const e = await page.evaluate((id) => ({ h: document.getElementById(id).getBoundingClientRect().height, exp: document.getElementById(`${id}-min`).getAttribute('aria-expanded') }), id);
      ok(`${w}x${h} ${name}: minimise to a header bar and expand again (keyboard)`, m.h < 70 && m.exp === 'false' && e.h > m.h + 60 && e.exp === 'true', `minimised ${Math.round(m.h)} px, expanded ${Math.round(e.h)} px`);
    }
    await page.evaluate(close);
    await page.waitForTimeout(700);
  }
  await page.close();
}

// ---------------- high-density screens: raster tiles drawn 1:1 ----------------
{
  const sharp = {};
  for (const [name, query] of [['before', '?tilesize=512'], ['after', '']]) {
    // tile requests and bytes for the first view (counted from navigation on), before the veil is switched on
    const bytes = { n: 0, b: 0, on: true };
    const onPage = (p) => p.on('requestfinished', async (r) => { if (bytes.on && /\/tiles\/|huggingface/.test(r.url())) { bytes.n++; bytes.b += (await r.sizes()).responseBodySize; } });
    const { page, settle } = await session(`dpr2-${name}`, { width: 1440, height: 900 }, { dpr: 2, query, onPage });
    await settle(2500);
    bytes.on = false;
    await page.evaluate(() => window.__seafloor.setVeil(true));
    await settle(2500);
    const d = await page.evaluate(() => ({ ...window.__seafloor.layoutCheck().disk, ts: window.__seafloor.rasterTileSize }));
    const png = await page.screenshot({ path: `${outdir}/sharp-${name}.png` });
    // mean luminance-gradient magnitude over the inner 85 % of the globe disk, in device pixels
    sharp[name] = await page.evaluate(async ([src, d]) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const { data, width } = g.getImageData(0, 0, img.width, img.height);
      const L = (x, y) => { const i = (y * width + x) * 4; return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; };
      const cx = d.cx * 2, cy = d.cy * 2, R = d.r * 2 * 0.85;
      let s = 0, n = 0;
      for (let y = Math.floor(cy - R); y < cy + R; y += 2) for (let x = Math.floor(cx - R); x < cx + R; x += 2) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > R * R || x < 1 || y < 1 || x >= width - 1 || y >= img.height - 1) continue;
        s += Math.hypot(L(x + 1, y) - L(x - 1, y), L(x, y + 1) - L(x, y - 1)); n++;
      }
      return { gradient: +(s / n).toFixed(2), tileSize: d.ts };
    }, ['data:image/png;base64,' + png.toString('base64'), d]);
    sharp[name].requests = bytes.n; sharp[name].MB = +(bytes.b / 1e6).toFixed(2);
    sharp[name].pan = await page.evaluate(() => window.__seafloor.panFrames(60, 3000));
    await page.close();
  }
  ok('2x screen: rasters sharper with 256 px declared tiles (mean gradient +10% or more), panning p95 < 20 ms',
    sharp.after.tileSize === 256 && sharp.before.tileSize === 512 && sharp.after.gradient > 1.1 * sharp.before.gradient && sharp.after.pan.p95Ms < 20,
    `before ${sharp.before.gradient} (${sharp.before.requests} tiles, ${sharp.before.MB} MB), after ${sharp.after.gradient} (${sharp.after.requests} tiles, ${sharp.after.MB} MB, pan p95 ${sharp.after.pan.p95Ms} ms)`);
  writeFileSync(`${outdir}/sharpness.json`, JSON.stringify(sharp, null, 1));
}

// ---------------- phone ----------------
{
  const { page, settle } = await session('phone', { width: 390, height: 844 });
  await settle(2500);
  await shot(page, 'phone-globe.png');
  // tabs: Explore / Layers / Tools share one bottom sheet; tapping the open tab folds it away
  const sheet = () => page.evaluate(() => ({ tab: document.getElementById('ui').dataset.tab, stories: getComputedStyle(document.getElementById('stories')).display !== 'none',
    layers: getComputedStyle(document.getElementById('layers')).display !== 'none', tools: getComputedStyle(document.getElementById('toolbar')).display !== 'none',
    selected: [...document.querySelectorAll('.tabs [aria-selected="true"]')].map((b) => b.id).join() }));
  await page.click('#tab-stories'); await page.waitForTimeout(300);
  const ps = await sheet();
  await page.click('#tab-tools'); await page.waitForTimeout(300);
  const pt = await sheet();
  await shot(page, 'phone-tools.png');
  await page.click('#tab-tools'); await page.waitForTimeout(300);
  const pn = await sheet();
  ok('phone: Explore / Tools tabs switch the sheet and fold it again', ps.stories && !ps.layers && !ps.tools && ps.selected === 'tab-stories' && pt.tools && !pt.stories && pt.selected === 'tab-tools' && !pn.tools && !pn.stories && !pn.layers && pn.selected === '',
    `explore ${JSON.stringify(ps)} | tools ${JSON.stringify(pt)} | folded ${JSON.stringify(pn)}`);
  await page.click('#tab-layers');
  await page.waitForTimeout(500);
  ok('phone: layers tab opens', (await page.getAttribute('#tab-layers', 'aria-selected')) === 'true' && (await sheet()).layers);
  await shot(page, 'phone-layers.png');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  ok('phone: no horizontal scroll', !overflow);
  // overlays from the bottom sheet: the group scrolls into reach, a toggle works, the legend shows
  await page.locator('#t-cables').scrollIntoViewIfNeeded();
  await page.click('label:has(#t-cables)');
  await settle(1200);
  const pc = await page.evaluate(() => ({ st: window.__seafloor.overlays.state(), legend: window.__seafloor.ui.legend(), sheet: (() => { const b = document.getElementById('layers').getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; })(), h: innerHeight }));
  ok('phone: cables toggle in the layers sheet works, its legend section is listed and the sheet stays on screen', pc.st.visibility.cables === 'visible' && pc.legend.sections.includes('ovl-cables') && pc.sheet.bottom <= pc.h + 1 && pc.sheet.top > 100, JSON.stringify({ sheet: pc.sheet, h: pc.h, legend: pc.legend }));
  await shot(page, 'phone-overlays.png');
  await page.click('label:has(#t-cables)');
  if (await page.evaluate(() => window.__seafloor.water?.ready)) {
    await page.evaluate(() => window.__seafloor.water.show('t', 0));
    await page.evaluate(() => window.__seafloor.water.column(-160, 20));
    await settle(800);
    const r = await page.evaluate(() => { const w = document.getElementById('water').getBoundingClientRect(); return { top: w.top, bottom: w.bottom, h: innerHeight, over: document.documentElement.scrollWidth > innerWidth, series: document.querySelectorAll('#wc-chart svg path.series').length }; });
    ok('phone: water sheet fits, chart drawn, no horizontal scroll', r.bottom <= r.h + 1 && r.top > 100 && !r.over && r.series === 3, JSON.stringify(r));
    await shot(page, 'phone-water.png');
  }
  await page.close();
}

await browser.close();
const retried = problems.filter((p) => p.url && recovered.has(p.url)).length;
problems = problems.filter((p) => !(p.url && recovered.has(p.url))).map((p) => p.text);
ok('no console errors / failed requests', problems.length === 0, problems.length ? problems.slice(0, 8).join(' | ') : (retried ? `${retried} transient 5xx recovered by retry` : ''));
writeFileSync(`${outdir}/summary.json`, JSON.stringify({ base, checks, problems, poles }, null, 1));
const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
