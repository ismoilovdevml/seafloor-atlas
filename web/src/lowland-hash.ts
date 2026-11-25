// Node only (never imported by the page): the content hash of the tiles src/lowland-index.ts is built from, shared by
// scripts/lowland_index.mjs (writes it) and test/lowland.test.ts (checks it).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** sha256 over every static coverage tile z0..maxzoom and the z(maxzoom) DEM tiles, in a fixed order. */
export function lowlandTileHash(tiles: string, maxzoom: number): string {
  const h = createHash('sha256');
  const add = (layer: string, z: number) => {
    const n = 2 ** z;
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
      const rel = `${layer}/${z}/${x}/${y}.webp`;
      h.update(rel);
      h.update(readFileSync(join(tiles, rel)));
    }
  };
  for (let z = 0; z <= maxzoom; z++) add('coverage', z);
  add('dem', maxzoom);
  return h.digest('hex');
}
