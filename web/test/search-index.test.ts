import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNotableWreck } from '../src/overlays';
import { buildSearchIndex, resolveIndexed, type IndexRow } from '../src/search-index';

const DATA = join(__dirname, '..', 'public', 'data');
const have = existsSync(join(DATA, 'search-index.json')) && existsSync(join(DATA, 'wrecks.geojson'));
const read = (f: string) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

describe('search index resolution', () => {
  const wrecks = [
    { properties: { id: 'Q1', name: 'HMS Hood', year: 1941 } },
    { properties: { id: 'Q2', name: 'Terra Nova', year: null } },
    { properties: { id: 'Q3', name: 'HMS Hood', year: 1914 } },
  ];
  it('finds a row by its stable id, whatever position the feature moved to', () => {
    expect(resolveIndexed(wrecks, 'Q2', 'Terra Nova')).toBe(wrecks[1]);
    expect(resolveIndexed([...wrecks].reverse(), 'Q3', 'HMS Hood', 1914)).toBe(wrecks[2]);
  });
  it('falls back to the name (and year) when the id is gone, never to an array position', () => {
    // a version 1 index cached next to newer data: its "id" is an old array position
    expect(resolveIndexed(wrecks, '0', 'Terra Nova')).toBe(wrecks[1]);
    expect(resolveIndexed(wrecks, '1', 'HMS Hood', 1914)).toBe(wrecks[2]);
    expect(resolveIndexed(wrecks, '1', 'Gone', 1900)).toBeUndefined();
  });
  it('refuses features without a string id', () => {
    expect(() => buildSearchIndex([{ properties: { name: 'X' } }], [], () => true)).toThrow(/properties\.id/);
  });
});

describe.runIf(have)('committed search-index.json', () => {
  const idx = read('search-index.json') as { version: number; cables: IndexRow[]; wrecks: IndexRow[] };
  const files: [keyof typeof idx & ('cables' | 'wrecks'), string][] = [['cables', 'cables.geojson'], ['wrecks', 'wrecks.geojson']];
  it('is exactly what scripts/search_index.mjs builds from the committed GeoJSON (run it after a data change)', () => {
    const built = buildSearchIndex(read('cables.geojson').features, read('wrecks.geojson').features, isNotableWreck);
    expect(idx).toEqual(built);
  });
  for (const [k, file] of files) {
    it(`every ${k} row opens the feature of the same name and id`, () => {
      const features = read(file).features;
      const wrong = idx[k].filter(([name, extra, id]) => {
        const f = resolveIndexed(features, String(id), name, k === 'wrecks' ? extra : undefined);
        return !f || f.properties?.name !== name || f.properties?.id !== id;
      });
      expect(wrong).toEqual([]);
      expect(idx[k].length).toBeGreaterThan(k === 'cables' ? 400 : 1000);
    });
  }
});
