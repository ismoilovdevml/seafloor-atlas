// Guided tour: chapter schema, reading time, deep link, spotlight targets, and every number in the tour's words
// checked against the project's own files (the data the viewer loads, its UI text, docs/trenches.md).
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHAPTERS } from '../src/tour-chapters';
import { TEXT_EN } from '../src/tour-text-en';
import { TEXT_UZ } from '../src/tour-text-uz';
import { hashWithLang, langFromHash, tourLang } from '../src/tour-lang';
import { READ_MIN_MS, TOUR_LAYER_TOKENS, cameraFor, hashWithTour, nearCamera, readingMs, tourFromHash, wordCount } from '../src/tour-model';
import { PRESETS, SEA_MAX, SEA_MIN, landAreaAt, type Hypsometry } from '../src/sealevel';
import { BATHY_STOPS } from '../src/palette';
import { MONTH_LONG, timeToken } from '../src/timeline';
import { amocCard, depthLayers, monthName, type AmocData } from '../src/amoc';
import { NEAR_KM, RATED_TO_LAT, SEARCH_KM } from '../src/inspect';
import { MAX_MERC_LAT } from '../src/geo';

const WEB = join(__dirname, '..'), PUB = join(WEB, 'public');
const read = (p: string) => readFileSync(p, 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (p: string): any => JSON.parse(read(join(PUB, p)));
const html = read(join(WEB, 'index.html'));
const words = (id: string) => TEXT_EN.chapters[id];
const all = (id: string) => `${words(id).title} ${words(id).text} ${words(id).source}`;
const NUM = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const numbersIn = (s: string) => s.match(NUM) ?? [];

describe('tour chapters', () => {
  it('has 10-15 chapters with unique ids, each with words in English', () => {
    expect(CHAPTERS.length).toBeGreaterThanOrEqual(10);
    expect(CHAPTERS.length).toBeLessThanOrEqual(15);
    const ids = CHAPTERS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(TEXT_EN.chapters).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const w = words(id);
      expect(w.title.trim().length, id).toBeGreaterThan(3);
      expect(w.source.trim().length, id).toBeGreaterThan(10);
      expect(wordCount(w.text), id).toBeGreaterThanOrEqual(25);
      expect(wordCount(w.text), id).toBeLessThanOrEqual(90);
    }
  });
  it('scenes are well formed: camera in range, known layer tokens, a valid tool, a spotlight', () => {
    for (const c of CHAPTERS) {
      const { center: [lon, lat], zoom, pitch, bearing, phoneZoom } = c.camera;
      expect(lon, c.id).toBeGreaterThanOrEqual(-180); expect(lon, c.id).toBeLessThanOrEqual(180);
      expect(lat, c.id).toBeGreaterThanOrEqual(-85); expect(lat, c.id).toBeLessThanOrEqual(85);
      expect(zoom, c.id).toBeGreaterThan(0); expect(zoom, c.id).toBeLessThanOrEqual(9.5);
      expect(pitch, c.id).toBeGreaterThanOrEqual(0); expect(pitch, c.id).toBeLessThanOrEqual(78);
      expect(Math.abs(bearing), c.id).toBeLessThanOrEqual(180);
      if (phoneZoom !== undefined) expect(phoneZoom, c.id).toBeGreaterThan(0);
      for (const t of c.layers) expect(TOUR_LAYER_TOKENS, `${c.id}: ${t}`).toContain(t);
      expect(['none', 'profile', 'sea', 'water', 'time'], c.id).toContain(c.tool.kind);
      if (c.tool.kind === 'sea') { expect(c.tool.level).toBeGreaterThanOrEqual(SEA_MIN); expect(c.tool.level).toBeLessThanOrEqual(SEA_MAX); }
      if (c.tool.kind === 'time') expect(timeToken(c.tool.state)).toMatch(/^(month-\d+|ago-\d+|\w+-\d{4}(-only)?)$/);
      if (c.tool.kind === 'water') expect(json('woa/manifest.json').map.depths).toContain(c.tool.depth);
      if (c.open?.kind === 'card') expect(c.layers, `${c.id}: the card's layer is on`).toContain(c.open.id);
      if (c.open?.kind === 'inspect') { expect(Math.abs(c.open.at[1]), c.id).toBeLessThanOrEqual(85); expect(c.tool.kind, c.id).toBe('none'); }
      expect(c.spotlight.length, c.id).toBeGreaterThan(0);
    }
  });
  it('every spotlight target is a real control in index.html', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const c of CHAPTERS) for (const id of c.spotlight) expect(ids.has(id), `${c.id}: #${id}`).toBe(true);
  });
  it('old #tour=N links keep their chapter: new chapters go before "your-turn", which stays last', () => {
    const FIRST = ['globe', 'measured', 'detail', 'profile', 'plates', 'sea-level', 'water', 'monsoon', 'quakes', 'human', 'mapping'];
    expect(CHAPTERS.slice(0, FIRST.length).map((c) => c.id)).toEqual(FIRST);
    expect(CHAPTERS[CHAPTERS.length - 1].id).toBe('your-turn');
    expect(CHAPTERS.slice(FIRST.length, -1).map((c) => c.id)).toEqual(['inspector', 'polar', 'amoc']);
  });
  it('the UI strings are complete', () => {
    for (const [k, v] of Object.entries(TEXT_EN.ui)) expect(typeof v === 'function' ? (v as (a: number, b: unknown) => string)(1, 'x') : v, k).toBeTruthy();
    expect(TEXT_EN.ui.count(3, 12)).toBe('3 of 12');
  });
});

describe('reading time', () => {
  it('is words at 200 per minute, never under 6 s', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('  one two\nthree  ')).toBe(3);
    expect(readingMs('')).toBe(READ_MIN_MS);
    expect(readingMs('word '.repeat(20))).toBe(6000); // 6 s at 200 wpm, exactly the floor
    expect(readingMs('word '.repeat(10))).toBe(6000);
    expect(readingMs('word '.repeat(100))).toBe(30000);
    expect(readingMs('word '.repeat(200))).toBe(60000);
    expect(readingMs('word '.repeat(50), 100, 1000)).toBe(30000);
  });
  it('a full tour takes a few minutes', () => {
    const total = CHAPTERS.reduce((s, c) => s + readingMs(words(c.id).text), 0);
    expect(total).toBeGreaterThan(2 * 60000);
    expect(total).toBeLessThan(6 * 60000);
  });
});

describe('deep link and camera helpers', () => {
  it('reads and writes #tour=N next to the other parts', () => {
    expect(tourFromHash('#tour=5')).toBe(5);
    expect(tourFromHash('#layers=veil&tour=12')).toBe(12);
    expect(tourFromHash('#tour=5&sea=-120')).toBe(5);
    expect(tourFromHash('#tour=0')).toBeNull();
    expect(tourFromHash('#tour=abc')).toBeNull();
    expect(tourFromHash('#detour=3')).toBeNull();
    expect(tourFromHash('')).toBeNull();
    expect(hashWithTour('#layers=veil', 3)).toBe('#layers=veil&tour=3');
    expect(hashWithTour('#tour=3&sea=-120', 4)).toBe('#sea=-120&tour=4');
    expect(hashWithTour('#tour=3&sea=-120', null)).toBe('#sea=-120');
    expect(hashWithTour('#tour=3', null)).toBe('');
    expect(hashWithTour('', 1)).toBe('#tour=1');
  });
  it('phones get the phone zoom, or 0.6 less', () => {
    const c = { center: [10, 20] as [number, number], zoom: 4, pitch: 30, bearing: 5 };
    expect(cameraFor(c, false).zoom).toBe(4);
    expect(cameraFor(c, true).zoom).toBeCloseTo(3.4);
    expect(cameraFor({ ...c, phoneZoom: 1 }, true).zoom).toBe(1);
  });
  it('near the target: centre within a tenth of a tile, zoom close; longitude wraps', () => {
    const t = { center: [179.9, 0] as [number, number], zoom: 3, pitch: 0, bearing: 0 };
    expect(nearCamera({ lng: -179.9, lat: 0, zoom: 3 }, t)).toBe(true);
    expect(nearCamera({ lng: 170, lat: 0, zoom: 3 }, t)).toBe(false);
    expect(nearCamera({ lng: 179.9, lat: 0, zoom: 3.6 }, t)).toBe(false);
  });
});

// ---------- numbers: every one in the tour's words comes from the project's own files ----------
const meta = json('tiles/meta.json');
const man = json('history/manifest.json');
const years = man.stats.years as { year: number; measured_frac: number; official_percent: number }[];
const hypso = json('data/hypsometry.json') as Hypsometry;
const stories = json('data/stories.json') as { id: string; title: string; blurb: string; exaggeration: number }[];
const woa = json('woa/manifest.json');
const seamounts = json('data/seamounts.json');
const quakes = json('data/quakes.json');
const cables = json('data/cables.geojson');
const landing = json('data/landing-points.geojson');
const features = json('data/features.geojson');
const shipping = json('tiles/shipping/legend.json');
const amoc = json('data/amoc.json') as AmocData;
const polar = json('tiles/polar/polar.json');
const amocTop = depthLayers(amoc.stats.layer_means_sv);
/** all viewer source (the inspector's labels live in main.ts or the modules split from it) */
const SRC = readdirSync(join(WEB, 'src')).filter((f) => f.endsWith('.ts')).map((f) => read(join(WEB, 'src', f))).join('\n');
const trenches = read(join(WEB, '..', 'docs', 'trenches.md'));
const pct1 = (f: number) => (100 * f).toFixed(1);
const int = (n: number) => Math.round(n).toLocaleString('en-US');
const mkm = (km2: number) => (km2 / 1e6).toFixed(1); // as the Sea level panel prints it
const story = (id: string) => stories.find((s) => s.id === id)!;
const challenger = /\| Challenger Deep[^|]*\| ([\d,]+) \| ([\d,]+) \| \+?(-?\d+) \|/.exec(trenches)!;
const iceAge = PRESETS.find((p) => p.name === 'Ice age')!;
const land = landAreaAt(hypso, iceAge.level);
const visibleText = (h: string) => h.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');

/** Facts the tour quotes, each derived from its file. */
const FACTS: Record<string, string> = {
  'ocean share of Earth (meta)': pct1(meta.stats.ocean_fraction_of_earth),
  'ocean area, million km² (history manifest)': mkm(man.stats.ocean_km2),
  'deepest colour step, m (palette)': int(-Math.min(...BATHY_STOPS.map(([h]) => h))),
  'measured share 2026 (meta)': pct1(meta.stats.measured_fraction_area),
  'Seabed 2030 figure 2026 (manifest)': String(years.find((y) => y.year === 2026)!.official_percent),
  'measured share 2019 (manifest)': pct1(years.find((y) => y.year === 2019)!.measured_frac),
  'Seabed 2030 figure 2019 (manifest)': String(years.find((y) => y.year === 2019)!.official_percent),
  'first release (manifest)': String(years[0].year),
  'last release (manifest)': String(years[years.length - 1].year),
  'grid version (meta)': meta.version.replace('GEBCO_', ''),
  'base grid, arc-minutes (meta)': String(meta.sourceResolutionArcsec / 60),
  'full grid, arc-seconds (meta.hires)': String(meta.hires.sourceResolutionArcsec),
  'first full-grid zoom (meta)': String(meta.maxzoom + 1),
  'last full-grid zoom (meta.hires)': String(meta.hires.maxzoom),
  'Monterey exaggeration (stories)': String(story('monterey-canyon').exaggeration),
  'Challenger Deep published, m (trenches.md)': challenger[1],
  'Challenger Deep in the 15″ grid, m (trenches.md)': challenger[2],
  'Challenger Deep difference, m (trenches.md)': challenger[3],
  'ice-age sea level, m (Sea level preset)': String(-iceAge.level),
  'land at the ice age, million km² (hypsometry)': mkm(land),
  'more land than today, million km² (hypsometry)': mkm(land - hypso.today_km2),
  'lowest sea level, m (slider)': int(-SEA_MIN),
  'highest sea level, m (slider)': String(SEA_MAX),
  'water depths (WOA manifest)': String(woa.map.depths.length),
  'deepest water layer, m (WOA manifest)': int(Math.max(...woa.map.depths)),
  'WOA period start': woa.period.split('-')[0],
  'WOA period end': woa.period.split('-')[1],
  'WOA edition': (/World Ocean Atlas (\d{4})/.exec(woa.source) ?? [])[1],
  'seamounts (seamounts.json)': int(seamounts.metadata.count),
  'earthquake magnitude floor (quakes.json)': String(quakes.metadata.minmag),
  'earthquake catalogue start (quakes.json)': quakes.metadata.first.slice(0, 4),
  'cables (cables.geojson)': int(cables.features.length),
  'landing points (landing-points.geojson)': int(landing.features.length),
  'cable snapshot year': cables.metadata.snapshot.slice(0, 4),
  'cable snapshot day': String(Number(cables.metadata.snapshot.slice(8, 10))),
  'shipping period start': shipping.period.slice(0, 4),
  'shipping period end': shipping.period.split('/')[1].slice(0, 4),
  'named features (features.geojson)': int(features.features.length),
  'guided views (stories.json)': String(stories.length),
  'tour chapters': String(CHAPTERS.length),
  'AMOC array latitude (amoc.json line)': String(amoc.line.coordinates[0][1]),
  'AMOC first year (amoc.json)': amoc.months.first.slice(0, 4),
  'AMOC last year (amoc.json)': amoc.months.last.slice(0, 4),
  'AMOC mean, Sv (amoc.json)': amoc.stats.mean_sv.toFixed(1),
  'AMOC running-mean window, months (card credit)': (/(\d+)-month running mean/.exec(amocCard(amoc).image!.credit) ?? [])[1],
  'AMOC top layer depth, m (card rows)': (/–([\d,]+) m$/.exec(amocTop[0][0]) ?? [])[1],
  'AMOC top layer, Sv (card rows)': amocTop[0][1].toFixed(1),
  'AMOC layer sum, Sv (card rows)': Math.abs(amocTop.reduce((a, [, x]) => a + x, 0)).toFixed(0),
  'inspector search radius, km (inspect.ts)': String(SEARCH_KM),
  'inspector "near" distance, km (inspect.ts)': String(NEAR_KM),
  'Web Mercator edge, degrees (geo.ts)': MAX_MERC_LAT.toFixed(2),
  'polar disc edge, degrees (polar.json)': String(90 - polar.radius_deg),
  'polar cell, km (polar.json)': String(polar.pixel_km),
  'deepest polar-disc cell, north, m (polar.json)': int(-polar.poles.north.min_m),
  'coverage rated to, degrees (inspect.ts)': String(RATED_TO_LAT),
};
/** Numbers that appear in the project's own UI text and attributions (names like PB2002, MH370 included). */
const UI_NUMBERS = new Set([
  ...numbersIn(visibleText(html)),
  ...stories.flatMap((s) => numbersIn(`${s.title} ${s.blurb}`)),
  ...numbersIn(`${man.attribution} ${seamounts.metadata.attribution} ${quakes.metadata.attribution} ${PRESETS.map((p) => p.note).join(' ')}`),
]);

describe('tour numbers match their sources', () => {
  it('every number in every chapter is a derived fact or appears in the project’s UI text', () => {
    const allowed = new Set([...Object.values(FACTS), ...UI_NUMBERS]);
    for (const c of CHAPTERS) for (const n of numbersIn(all(c.id))) expect(allowed.has(n), `${c.id}: "${n}" has no source`).toBe(true);
  });
  it('the headline numbers are quoted exactly as the files give them', () => {
    const has = (id: string, s: string) => expect(words(id).text, `${id} should say ${s}`).toContain(s);
    has('globe', `${FACTS['ocean area, million km² (history manifest)']} million km²`);
    has('globe', `${FACTS['ocean share of Earth (meta)']}%`);
    has('globe', `${FACTS['deepest colour step, m (palette)']} m`);
    has('measured', `${FACTS['measured share 2026 (meta)']}%`);
    has('measured', `${FACTS['Seabed 2030 figure 2026 (manifest)']}%`);
    expect(story('mh370-search').blurb).toContain('120,000 km²');
    has('measured', '120,000 km²');
    has('detail', `${FACTS['full grid, arc-seconds (meta.hires)']}″ grid at zoom ${FACTS['first full-grid zoom (meta)']}–${FACTS['last full-grid zoom (meta.hires)']}`);
    has('detail', `×${FACTS['Monterey exaggeration (stories)']}`);
    has('profile', `${challenger[2]} m, ${challenger[3]} m from the published ${challenger[1]} m`);
    has('plates', 'about 2 cm a year'); expect(story('mid-atlantic-iceland').blurb).toContain('about 2 cm a year');
    has('sea-level', `−${FACTS['ice-age sea level, m (Sea level preset)']} m`);
    expect(iceAge.note).toContain('20,000 years ago'); has('sea-level', '20,000 years ago');
    has('sea-level', `${FACTS['land at the ice age, million km² (hypsometry)']} million km² stand above the sea, ${FACTS['more land than today, million km² (hypsometry)']} million km² more than today`);
    has('sea-level', `from −${FACTS['lowest sea level, m (slider)']} m to +${FACTS['highest sea level, m (slider)']} m`);
    has('water', `${FACTS['water depths (WOA manifest)']} depths from the surface to ${FACTS['deepest water layer, m (WOA manifest)']} m, averaged over ${woa.period.replace('-', '–')}`);
    // the depth slider ends at a "Seafloor" stop when the manifest has the bottom layers: the tour says so
    if (woa.map.bottom) { has('water', 'on the seafloor itself'); expect(TEXT_UZ.chapters.water.text).toContain('okean tubining oʻzida'); }
    has('monsoon', MONTH_LONG[(CHAPTERS.find((c) => c.id === 'monsoon')!.tool as { state: { month: number } }).state.month - 1]);
    for (const s of ['0.02 mg/m³', 'over 3 in the Peru upwelling', 'about 1.3 m/s']) { has('monsoon', s); expect(visibleText(html)).toContain(s); }
    has('quakes', `magnitude ${FACTS['earthquake magnitude floor (quakes.json)']} or more since ${FACTS['earthquake catalogue start (quakes.json)']}`);
    has('quakes', `${FACTS['seamounts (seamounts.json)']} undersea mountains at least 100 m tall`);
    expect(visibleText(html)).toContain('at least 100 m tall');
    expect(story('tonga-kermadec').blurb).toContain('up to 24 cm a year'); has('quakes', 'up to 24 cm a year');
    has('human', `${FACTS['cables (cables.geojson)']} internet cables and ${FACTS['landing points (landing-points.geojson)']} landing points as of 14 November 2022`);
    has('human', `${FACTS['shipping period start']}–${FACTS['shipping period end']}`);
    has('mapping', `GEBCO_2019, ${FACTS['measured share 2019 (manifest)']}%`);
    has('mapping', `GEBCO_2026, ${FACTS['measured share 2026 (meta)']}%`);
    has('mapping', `announced ${FACTS['Seabed 2030 figure 2019 (manifest)']}% and ${FACTS['Seabed 2030 figure 2026 (manifest)']}%`);
    has('your-turn', `${FACTS['named features (features.geojson)']} named undersea features`);
    has('your-turn', `${FACTS['guided views (stories.json)']} guided views`);
    has('your-turn', `#tour=${CHAPTERS.length}`);
    has('inspector', `searched to ${SEARCH_KM} km`); expect(html).toContain(`searched to ${SEARCH_KM} km`);
    has('inspector', `no sounding within ${NEAR_KM} km`);
    has('polar', `stop at ${FACTS['Web Mercator edge, degrees (geo.ts)']}°`);
    has('polar', `poleward of ${FACTS['polar disc edge, degrees (polar.json)']}°`);
    has('polar', `cells of ${polar.pixel_km} km`);
    has('polar', `down to ${FACTS['deepest polar-disc cell, north, m (polar.json)']} m`);
    has('polar', `not rated poleward of ${RATED_TO_LAT}°`);
  });
  it('the AMOC chapter quotes amoc.json and the card exactly', () => {
    const has = (s: string) => expect(words('amoc').text, `amoc should say ${s}`).toContain(s);
    const lat = FACTS['AMOC array latitude (amoc.json line)'];
    expect(amoc.line.coordinates.every(([, y]) => String(y) === lat)).toBe(true);
    expect(words('amoc').title).toContain(`${lat}° N`); has(`${lat}° N`);
    has(`Since ${monthName(amoc.months.first)}`);
    has(`to ${monthName(amoc.months.last)}`);
    expect(amoc.months.first).toBe('2004-04'); expect(amoc.months.last).toBe('2024-11');
    has(`${amoc.stats.mean_sv.toFixed(1)} million m³ a second on average`);
    expect(amocCard(amoc).lead).toContain(`${amoc.stats.mean_sv.toFixed(1)} million m³ of water per second`);
    has(`${FACTS['AMOC running-mean window, months (card credit)']}-month running mean`);
    // the card's fixed-depth rows balance (RAPID's mass balance): top layer north, the same back south below it
    const [top, ...below] = amocTop;
    expect(top[0]).toBe('0–1,100 m');
    expect(Math.abs(top[1] + below.reduce((a, [, x]) => a + x, 0))).toBeLessThan(0.05);
    has(`balance to ${FACTS['AMOC layer sum, Sv (card rows)']} Sv, ${top[1].toFixed(1)} Sv north in the top 1,100 m and the same back south below`);
    // what the chapter tells the viewer to click is what the line does
    expect(html).toContain('Click the line for the monthly record');
    const uz = TEXT_UZ.chapters.amoc.text;
    for (const s of [`${lat.replace('.', ',')}° shimoliy kenglikda`, '2004-yil apreldan', '2024-yil noyabrgacha', `${amoc.stats.mean_sv.toFixed(1).replace('.', ',')} million m³`, '12 oylik', '0 Sv', `${top[1].toFixed(1).replace('.', ',')} Sv shimolga`]) expect(uz).toContain(s);
  });
  it('the inspector and polar chapters describe what the viewer shows', () => {
    // inspector rows and labels (main.ts or its modules)
    for (const s of ['Nearest measured seafloor', 'SWOT model confidence', 'Second model (AUST_2026) differs by', 'Land below sea level', "'land'"]) expect(SRC, s).toContain(s);
    expect(read(join(WEB, 'src', 'inland-basins.ts'))).toContain('Dead Sea');
    expect(read(join(WEB, 'src', 'point-info.ts'))).toContain('such as a polder');
    // the polar layer's disc starts at 83° and the Mercator tiles stop at 85.05°
    expect(read(join(WEB, 'src', 'polar-layer.ts'))).toMatch(/FADE_FROM = 83\.\d+/);
    expect(polar.poles.north.min_m).toBeLessThan(0);
    expect(read(join(WEB, '..', 'docs', 'data-contract.md'))).toContain('poleward of 84.8 deg');
    // chapter scenes: the inspector opens at its camera centre; the AMOC chapter turns the line on and opens its card
    const ins = CHAPTERS.find((c) => c.id === 'inspector')!, am = CHAPTERS.find((c) => c.id === 'amoc')!, po = CHAPTERS.find((c) => c.id === 'polar')!;
    expect(ins.open).toEqual({ kind: 'inspect', at: ins.camera.center });
    expect(am.layers).toEqual(['amoc']); expect(am.open).toEqual({ kind: 'card', id: 'amoc' });
    expect(po.camera.center[1]).toBeGreaterThanOrEqual(80);
  });
  it('the mapping chapter starts at the first release and the time panel can reach the last', () => {
    const t = CHAPTERS.find((c) => c.id === 'mapping')!.tool;
    expect(t.kind).toBe('time');
    if (t.kind === 'time' && t.state.mode === 'years') { expect(t.state.set).toBe('mapping'); expect(t.state.year).toBe(years[0].year); }
  });
  it('the measured-share figure the tour quotes matches the one the layer note shows', () => {
    // layers-ui.ts (split from main.ts) writes the layer note from meta.stats.measured_fraction_area with one decimal, as FACTS does
    expect(read(join(WEB, 'src', 'layers-ui.ts'))).toContain('Seabed 2030 counts 28.7% for GEBCO 2026');
    expect(FACTS['Seabed 2030 figure 2026 (manifest)']).toBe('28.7');
  });
});

describe('Uzbek tour text', () => {
  // English "10,935" / "361.7" and Uzbek "10 935" / "361,7" are the same number
  const enNums = (s: string) => numbersIn(s.replace(/(\d),(\d{3})\b/g, '$1$2')).sort();
  const uzNums = (s: string) => (s.replace(/(\d)[  ](\d{3})\b/g, '$1$2').replace(/(\d),(\d)/g, '$1.$2').match(/\d+(?:\.\d+)?/g) ?? []).sort();
  it('has every chapter, the new ones included, and every UI string', () => {
    for (const id of ['inspector', 'polar', 'amoc']) { expect(TEXT_UZ.chapters[id]?.title.length, id).toBeGreaterThan(3); expect(TEXT_EN.chapters[id]?.title.length, id).toBeGreaterThan(3); }
    expect(Object.keys(TEXT_UZ.chapters).sort()).toEqual(Object.keys(TEXT_EN.chapters).sort());
    for (const [k, v] of Object.entries(TEXT_UZ.ui)) expect(typeof v === 'function' ? (v as (a: number, b: unknown) => string)(1, 'x') : v, k).toBeTruthy();
    expect(TEXT_UZ.ui.count(3, 12)).toBe('3 / 12');
  });
  it('quotes exactly the English numbers in every chapter', () => {
    for (const c of CHAPTERS) {
      const en = TEXT_EN.chapters[c.id], uz = TEXT_UZ.chapters[c.id];
      expect(uzNums(`${uz.title} ${uz.text}`), c.id).toEqual(enNums(`${en.title} ${en.text}`));
      expect(uz.source).toBe(en.source);
    }
  });
  it('is picked by #lang= first, then by the browser language', () => {
    expect(tourLang(['uz-UZ', 'en'], '')).toBe('uz');
    expect(tourLang(['en-US', 'uz'], '')).toBe('en');
    expect(tourLang(['en-US'], '#tour=3&lang=uz')).toBe('uz');
    expect(tourLang(['uz'], '#lang=en')).toBe('en');
    expect(tourLang([], '')).toBe('en');
  });
  it('the EN / UZ switch writes #lang= and keeps the rest of the address', () => {
    expect(hashWithLang('', 'uz')).toBe('#lang=uz');
    expect(hashWithLang('#tour=3&lang=en', 'uz')).toBe('#tour=3&lang=uz');
    expect(hashWithLang('#story=x&lang=uz&tour=2', 'en')).toBe('#story=x&tour=2&lang=en');
    expect(langFromHash('#tour=3&lang=uz')).toBe('uz');
    expect(langFromHash('#tour=3')).toBeNull();
    expect(langFromHash('#lang=fr')).toBeNull();
  });
});
