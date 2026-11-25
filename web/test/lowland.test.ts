import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeTerrarium, LOW_LAND_ALPHA, lonLatToWorldPx } from '../src/geo';
import { LOWLAND_INDEX } from '../src/lowland-index';
import { lowlandTileHash } from '../src/lowland-hash';
import { mayHoldLowLand, raiseLowLand, TERRARIUM_ZERO } from '../src/lowland';

const TILES = join(__dirname, '..', 'public', 'tiles');
const tileOf = (lon: number, lat: number, z: number): [number, number] => {
  const [x, y] = lonLatToWorldPx(lon, lat, z, 512);
  return [Math.floor(x / 512), Math.floor(y / 512)];
};

describe('raiseLowLand', () => {
  it('writes 0 m where the coverage alpha is the reserved low-land value, nowhere else', () => {
    const terr = (h: number) => { const v = h + 32768; return [Math.floor(v / 256), Math.floor(v) % 256, Math.round((v % 1) * 256)]; };
    const dem = new Uint8ClampedArray([...terr(-3), 255, ...terr(-82), 255, ...terr(-4000), 255, ...terr(120), 255]);
    const cov = new Uint8ClampedArray([0, 0, 0, LOW_LAND_ALPHA, 0, 0, 0, LOW_LAND_ALPHA, 9, 9, 9, 2, 0, 0, 0, 0]);
    expect(raiseLowLand(dem, cov)).toBe(2);
    const h = (i: number) => decodeTerrarium(dem[i * 4], dem[i * 4 + 1], dem[i * 4 + 2]);
    expect([h(0), h(1), h(2), h(3)]).toEqual([0, 0, -4000, 120]);
    expect(decodeTerrarium(...TERRARIUM_ZERO)).toBe(0);
    expect([dem[3], dem[7]]).toEqual([255, 255]); // alpha untouched
  });
});

describe('mayHoldLowLand', () => {
  it('flags the tiles over Flevoland and Death Valley from z5, the Caspian at every zoom, not the open Pacific', () => {
    for (let z = 5; z <= 7; z++) {
      expect(mayHoldLowLand(z, ...tileOf(5.6, 52.5, z), LOWLAND_INDEX)).toBe(true);
      expect(mayHoldLowLand(z, ...tileOf(-116.85, 36.3, z), LOWLAND_INDEX)).toBe(true);
    }
    for (let z = 0; z <= 7; z++) expect(mayHoldLowLand(z, ...tileOf(50.5, 42, z), LOWLAND_INDEX)).toBe(true);
    // open North Pacific between Hawaii and the Aleutians (the z5 tile at -150, 0 holds the Line Islands: land)
    for (let z = 3; z <= 7; z++) expect(mayHoldLowLand(z, ...tileOf(-170, 20, z), LOWLAND_INDEX)).toBe(false);
  });
  it('checks every tile without a usable index', () => {
    expect(mayHoldLowLand(5, ...tileOf(-150, 0, 5), null)).toBe(true);
  });
  it('skips most static tiles (the coverage fetch is the cost)', () => {
    let on = 0, all = 0;
    for (let z = 0; z <= LOWLAND_INDEX.maxzoom; z++) for (let i = 0; i < 4 ** z; i++) { all++; if (mayHoldLowLand(z, i % 2 ** z, Math.floor(i / 2 ** z), LOWLAND_INDEX)) on++; }
    expect(on / all).toBeLessThan(0.4);
  });
});

describe('lowland-index.ts', () => {
  const real = existsSync(join(TILES, 'meta.json')) && existsSync(join(TILES, 'coverage', String(LOWLAND_INDEX.maxzoom)));
  it.skipIf(!real)('matches the committed tiles (rerun `node scripts/lowland_index.mjs` after a tile rebuild)', () => {
    const meta = JSON.parse(readFileSync(join(TILES, 'meta.json'), 'utf8'));
    expect(LOWLAND_INDEX.revision).toBe(meta.hires?.revision ?? null);
    expect(LOWLAND_INDEX.maxzoom).toBe(meta.maxzoom);
    expect(lowlandTileHash(TILES, meta.maxzoom)).toBe(LOWLAND_INDEX.sha256);
  });
});
