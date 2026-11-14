import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATTRIBUTION, CLICKABLE_LAYERS, DATA_FILES, OVERLAY_ATTRIBUTION, OVERLAY_IDS, OVERLAY_LAYERS,
  cableCard, commonsThumb, fmtDate, fmtDiameter, fmtKm, fmtMW, fmtStart, hashWithLayers, isNotableWreck, landingCard, layersFromHash,
  listText, normName, osmUrl, overlayLayers, overlaySources, pipelineCard, platformCard, safeUrl, searchRank, shortWindName, windCard,
  wreckCard, wreckFilter, type SearchEntry,
} from '../src/overlays';

const DATA = join(__dirname, '..', 'public', 'data');
const have = existsSync(join(DATA, 'cables.geojson'));
const read = (f: string) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

describe('#layers= deep link', () => {
  it('parses alone and next to other parts', () => {
    expect(layersFromHash('#layers=cables,wrecks')).toEqual({ ids: ['cables', 'wrecks'], allWrecks: false });
    expect(layersFromHash('#story=titanic&layers=wind,shipping&sea=-120')).toEqual({ ids: ['shipping', 'wind'], allWrecks: false });
    expect(layersFromHash('#layers=wrecks-all')).toEqual({ ids: ['wrecks'], allWrecks: true });
    expect(layersFromHash('#layers=bogus,platforms')).toEqual({ ids: ['platforms'], allWrecks: false });
    expect(layersFromHash('#story=x')).toBeNull();
    expect(layersFromHash('#layers=')).toEqual({ ids: [], allWrecks: false });
  });
  it('writes in panel order, keeps other parts, removes when empty', () => {
    expect(hashWithLayers('', { ids: ['wrecks', 'cables'], allWrecks: false })).toBe('#layers=cables,wrecks');
    expect(hashWithLayers('#story=x&layers=cables&sea=10', { ids: ['pipelines'], allWrecks: false })).toBe('#story=x&sea=10&layers=pipelines');
    expect(hashWithLayers('#story=x&layers=cables', { ids: [], allWrecks: false })).toBe('#story=x');
    expect(hashWithLayers('#layers=cables', null)).toBe('');
    expect(hashWithLayers('', { ids: ['wrecks'], allWrecks: true })).toBe('#layers=wrecks-all');
    // all-wrecks only counts when wrecks are on
    expect(hashWithLayers('', { ids: ['cables'], allWrecks: true })).toBe('#layers=cables');
  });
  it('round-trips every subset', () => {
    for (let m = 0; m < 1 << OVERLAY_IDS.length; m++) {
      const ids = OVERLAY_IDS.filter((_, i) => m & (1 << i));
      for (const allWrecks of [false, true]) {
        const back = layersFromHash(hashWithLayers('#water=t-0', { ids, allWrecks })) ?? { ids: [], allWrecks: false };
        expect(back!.ids).toEqual(ids);
        expect(back!.allWrecks).toBe(allWrecks && ids.includes('wrecks'));
      }
    }
  });
});

describe('formatting', () => {
  it('numbers, dates and units', () => {
    expect(fmtKm(6605)).toBe('6,605 km');
    expect(fmtKm(12.34)).toBe('12.3 km');
    expect(fmtMW(1218)).toBe('1,218 MW');
    expect(fmtMW(2.3)).toBe('2.3 MW');
    expect(fmtDate('1912-04-15')).toBe('15 April 1912');
    expect(fmtDate(undefined, 1588)).toBe('1588');
    expect(fmtDate()).toBe('');
    expect(fmtStart('2018-01')).toBe('January 2018');
    expect(fmtStart('2021-12-20')).toBe('20 December 2021');
    expect(fmtStart('Q4 2027')).toBe('Q4 2027');
    expect(fmtDiameter('915')).toBe('915 mm');
    expect(fmtDiameter('36"')).toBe('36"');
    expect(listText(['a'])).toBe('a');
    expect(listText(['a', 'b', 'c'])).toBe('a, b and c');
    expect(listText(['a', 'b', 'c', 'd'], 2)).toBe('a, b and 2 more');
  });
  it('wind-farm label shortening keeps a name', () => {
    expect(shortWindName('Hornsea 1 Offshore Wind Farm')).toBe('Hornsea 1');
    expect(shortWindName('London Array')).toBe('London Array');
    expect(shortWindName('Borkum Riffgrund 2 Offshore Wind Park')).toBe('Borkum Riffgrund 2');
    expect(shortWindName('Wind Farm')).toBe('Wind Farm');
  });
  it('links are built safely', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('http://www.telxius.com')).toBe('http://www.telxius.com/');
    expect(safeUrl('not a url')).toBeNull();
    expect(osmUrl('n1042145924')).toBe('https://www.openstreetmap.org/node/1042145924');
    expect(osmUrl('r11894296')).toBe('https://www.openstreetmap.org/relation/11894296');
    expect(osmUrl('x1')).toBeNull();
    expect(commonsThumb('RMS Titanic 3.jpg')).toBe('https://commons.wikimedia.org/wiki/Special:FilePath/RMS_Titanic_3.jpg?width=480');
  });
});

describe('search ranking', () => {
  const e = (name: string, kind: SearchEntry['kind'] = 'feature'): SearchEntry => ({ name, label: kind, kind, key: name, n: normName(name) });
  const idx = [e('Titanic', 'wreck'), e('Tiamat Seamount'), e('Atlantis Fracture Zone'), e('MAREA', 'cable'), e('Mariana Trench'), e('Malé', 'feature')];
  it('prefix first, then substring, case- and accent-insensitive', () => {
    expect(searchRank(idx, 'ti').map((x) => x.name)).toEqual(['Tiamat Seamount', 'Titanic', 'Atlantis Fracture Zone']);
    expect(searchRank(idx, 'MAR').map((x) => x.name)).toEqual(['MAREA', 'Mariana Trench']);
    expect(searchRank(idx, 'male').map((x) => x.name)).toEqual(['Malé']);
    expect(searchRank(idx, '  ')).toEqual([]);
    expect(searchRank(idx, 'a', 2)).toHaveLength(2);
  });
});

describe('layer specs', () => {
  const layers = overlayLayers('Font');
  const ids = layers.map((l) => l.id);
  it('every toggle layer and clickable layer exists, with a source', () => {
    const srcs = overlaySources('tiles/shipping/');
    for (const id of [...Object.values(OVERLAY_LAYERS).flat(), ...CLICKABLE_LAYERS]) {
      expect(id === 'shipping' || ids.includes(id), id).toBe(true);
    }
    for (const l of layers) expect(srcs[(l as { source: string }).source], l.id).toBeDefined();
    // overlays start hidden; casings draw under their lines
    for (const l of layers.filter((x) => !x.id.startsWith('ov-hl'))) expect((l.layout as { visibility?: string }).visibility).toBe('none');
    expect(ids.indexOf('pipelines-casing')).toBeLessThan(ids.indexOf('pipelines'));
    expect(ids.indexOf('cables-casing')).toBeLessThan(ids.indexOf('cables'));
  });
  it('the wreck filter matches isNotableWreck', () => {
    expect(wreckFilter(true)).toEqual(['boolean', true]);
    expect(wreckFilter(false)).toEqual(['>=', ['coalesce', ['get', 'sitelinks'], 0], 1]);
    expect(isNotableWreck({ sitelinks: 0 })).toBe(false);
    expect(isNotableWreck({})).toBe(false);
    expect(isNotableWreck({ sitelinks: 3 })).toBe(true);
  });
});

describe('attribution', () => {
  it('matches the data contract table verbatim', () => {
    const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'data-contract.md'), 'utf8');
    for (const a of Object.values(ATTRIBUTION)) expect(doc.includes(`| ${a} |`), a).toBe(true);
    for (const id of OVERLAY_IDS) expect(OVERLAY_ATTRIBUTION[id]).toBeTruthy();
  });
  it.skipIf(!have)('matches each file\'s own metadata', () => {
    expect(read(DATA_FILES.cables).metadata.attribution).toBe(ATTRIBUTION.cables);
    expect(read(DATA_FILES.landing).metadata.attribution).toBe(ATTRIBUTION.cables);
    expect(read(DATA_FILES.wrecks).metadata.attribution).toBe(ATTRIBUTION.wrecks);
    for (const k of ['platforms', 'pipelines', 'wind'] as const) expect(read(DATA_FILES[k]).metadata.attribution).toBe(ATTRIBUTION.osm);
    const legend = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'tiles', 'shipping', 'legend.json'), 'utf8'));
    expect(legend.attribution).toBe(ATTRIBUTION.shipping);
  });
});

describe.skipIf(!have)('cards from the real files', () => {
  const find = (f: string, re: RegExp) => read(f).features.find((x: { properties: { name?: string } }) => re.test(x.properties.name ?? ''))?.properties;
  it('MAREA cable', () => {
    const lps = new Map<string, string>(read(DATA_FILES.landing).features.map((f: { properties: { id: string; name: string } }) => [f.properties.id, f.properties.name]));
    const c = cableCard(find(DATA_FILES.cables, /^MAREA$/), (id) => lps.get(id));
    expect(c.name).toBe('MAREA');
    expect(c.lead).toBe('6,605 km long, in service since 2018 May');
    expect(c.facts.find((f) => f[0] === 'Owners')?.[1]).toBe('Meta, Microsoft, Telxius');
    expect(c.facts.find((f) => f[0].startsWith('Lands at'))?.[1]).toMatch(/Bilbao.*Virginia Beach/);
    expect(c.links[0].href).toBe('http://www.telxius.com/');
  });
  it('a planned cable says so with the snapshot date', () => {
    const c = cableCard(find(DATA_FILES.cables, /^2Africa$/), () => undefined);
    expect(c.kind).toBe('Submarine cable, planned');
    expect(c.lead).toMatch(/^Planned, ready for service 2023; 45,000 km long \(status as of 14 November 2022\)$/);
  });
  it('landing point lists cable names', () => {
    const names = new Map<string, string>(read(DATA_FILES.cables).features.map((f: { properties: { id: string; name: string } }) => [f.properties.id, f.properties.name]));
    const c = landingCard(find(DATA_FILES.landing, /^Marseille, France$/), (id) => names.get(id));
    expect(c.lead).toBe('14 cables land here');
    expect(c.facts.find((f) => f[0] === 'Cables')?.[1]).toMatch(/2Africa/);
  });
  it('Titanic wreck: ~3,800 m, date, links, Commons thumbnail', () => {
    const c = wreckCard(find(DATA_FILES.wrecks, /^Titanic$/));
    expect(c.lead).toBe('Seafloor about 3,802 m deep at the recorded position');
    expect(c.facts).toContainEqual(['Lost', '15 April 1912']);
    expect(c.links.map((l) => l.href)).toEqual(['https://en.wikipedia.org/wiki/Titanic', 'https://www.wikidata.org/wiki/Q25173']);
    expect(c.image?.src).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/RMS_Titanic_3\.jpg\?width=\d+$/);
  });
  it('wreck notability split: 1,204 of 20,124 shown by default', () => {
    const w = read(DATA_FILES.wrecks).features;
    expect(w.length).toBe(20124);
    expect(w.filter((f: { properties: { sitelinks?: number } }) => isNotableWreck(f.properties)).length).toBe(1204);
  });
  it('Troll A platform, Nord Stream 1 pipeline, Hornsea 1 wind farm', () => {
    const t = platformCard(find(DATA_FILES.platforms, /^Troll A$/));
    expect(t.kind).toBe('Oil and gas platform');
    expect(t.lead).toBe('Stands in about 302 m of water');
    expect(t.facts).toContainEqual(['Waters of', 'Norway']);
    const n = pipelineCard(find(DATA_FILES.pipelines, /^Nord Stream 1$/));
    expect(n.kind).toBe('Gas pipeline, subsea');
    expect(n.lead).toBe('1,220 km under water');
    expect(n.facts.find((f) => f[0] === 'Crosses the waters of')?.[1]).toMatch(/Russia.*Germany/);
    const h = windCard(find(DATA_FILES.wind, /^Hornsea 1 /));
    expect(h.name).toBe('Hornsea 1 Offshore Wind Farm');
    expect(h.lead).toMatch(/^1,218 MW/);
    expect(h.facts).toContainEqual(['Started', 'January 2018']);
  });
  it('every feature of every file yields a card without throwing', () => {
    const lps = () => undefined;
    for (const f of read(DATA_FILES.cables).features) expect(cableCard(f.properties, lps).name).toBeTruthy();
    for (const f of read(DATA_FILES.landing).features) expect(landingCard(f.properties, lps).name).toBeTruthy();
    for (const f of read(DATA_FILES.wrecks).features) expect(wreckCard(f.properties).name).toBeTruthy();
    for (const f of read(DATA_FILES.platforms).features) expect(platformCard(f.properties).kind).toBeTruthy();
    for (const f of read(DATA_FILES.pipelines).features) expect(pipelineCard(f.properties).kind).toBeTruthy();
    for (const f of read(DATA_FILES.wind).features) expect(windCard(f.properties).lead).toBeTruthy();
  });
});
