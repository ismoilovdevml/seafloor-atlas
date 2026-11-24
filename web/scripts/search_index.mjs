// Search index for cables and notable wrecks: public/data/search-index.json (a few tens of kB), so focusing the search
// box no longer downloads the 3.7 MB wrecks.geojson and the cable file just to read names. Rows carry each feature's
// stable properties.id (never its array position, which shifts whenever the weekly refresh adds a wreck); the viewer
// resolves a chosen row with resolveIndexed() in src/search-index.ts.
// Runs before every build (package.json) and in refresh-data.yml after the GeoJSON files are rewritten.
// test/search-index.test.ts fails when the committed index no longer matches the committed GeoJSON.
//   node scripts/search_index.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNotableWreck } from '../src/overlays.ts';
import { buildSearchIndex } from '../src/search-index.ts';

const data = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const read = (f) => JSON.parse(readFileSync(join(data, f), 'utf8'));
const out = buildSearchIndex(read('cables.geojson').features, read('wrecks.geojson').features, isNotableWreck);
writeFileSync(join(data, 'search-index.json'), JSON.stringify(out));
console.log(`search-index.json: ${out.cables.length} cables, ${out.wrecks.length} notable wrecks`);
