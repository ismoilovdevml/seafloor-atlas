// Verifies every story centre against the real DEM tiles: decodes the max-zoom Terrarium tile(s) under the
// point (with the host `dwebp`, lossless -> PAM, no canvas involved) and checks the depth against an
// expected range for what the story claims is there. Skipped when real tiles are not built yet.
// Run alone with: npm run verify:stories
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { bilinear, decodeTerrarium, lonLatToWorldPx } from '../src/geo';

const PUB = join(__dirname, '..', 'public');
const TILES = join(PUB, 'tiles');
// VERIFY_DEM_ONLY=1 lets the check run while the pipeline is still writing coverage (meta.json comes last)
const demOnly = !existsSync(join(TILES, 'meta.json')) && process.env.VERIFY_DEM_ONLY === '1' && existsSync(join(TILES, 'dem'));
const haveTiles = existsSync(join(TILES, 'meta.json')) || demOnly;
let haveDwebp = true;
try { execFileSync('dwebp', ['-version'], { stdio: 'ignore' }); } catch { haveDwebp = false; }

/** Expected elevation range (m) at each story centre, from the literature value of the named feature. */
const EXPECT: Record<string, [number, number]> = {
  // Gazetteer point; the 1' GEBCO source cell there is -10,900 m (checked with rasterio). The z5 tiles are
  // 'average'-resampled to ~2.4 km Mercator pixels, which fills the narrow pit to about -10,700 m.
  'challenger-deep': [-10950, -10600],
  'mid-atlantic-iceland': [-1500, -100], // Reykjanes Ridge (gazetteer point, -532 m) near Iceland
  'hawaii-emperor-bend': [-3500, -100], // Kammu Guyot at the bend (gazetteer, -1,297 m)
  'east-pacific-rise': [-3300, -2300], // crest at 20 S (shallowest point across the rise in the 1' grid: -2,947 m)
  'tonga-kermadec': [-11000, -10200], // Horizon Deep ~ -10,800 m
  bahamas: [-5000, -3500], // Great Bahama Canyon (gazetteer, -4,631 m)
  'monterey-canyon': [-2500, -500], // Monterey Canyon (gazetteer, -1,331 m)
  'drake-passage': [-5000, -2000], // mid-passage, 1' grid -3,865 m
  'gakkel-ridge': [-5700, -4000], // western Gakkel rift valley (PB2002 axis), 1' grid min -5,314 m
  romanche: [-8100, -7000], // Vema Deep in the Romanche valley, 1' grid min -7,852 m
  'mh370-search': [-6000, -2000], // search-area flank, 1' grid -4,003 m
};

const tileCache = new Map<string, Float32Array>();
function demTile(z: number, x: number, y: number, S: number): Float32Array {
  const k = `${z}/${x}/${y}`;
  const hit = tileCache.get(k);
  if (hit) return hit;
  const pam = execFileSync('dwebp', ['-quiet', join(TILES, 'dem', String(z), String(x), `${y}.webp`), '-pam', '-o', '-'], { maxBuffer: 64 << 20 });
  const hdrEnd = pam.indexOf('ENDHDR\n') + 7;
  const hdr = pam.subarray(0, hdrEnd).toString();
  const w = Number(/WIDTH (\d+)/.exec(hdr)![1]), d = Number(/DEPTH (\d+)/.exec(hdr)![1]);
  if (w !== S) throw new Error(`tile ${k} width ${w} != ${S}`);
  const g = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) { const o = hdrEnd + i * d; g[i] = decodeTerrarium(pam[o], pam[o + 1], pam[o + 2]); }
  tileCache.set(k, g);
  return g;
}
function depthAt(lon: number, lat: number, z: number, S: number): number {
  const n = S * 2 ** z;
  const [x, y] = lonLatToWorldPx(lon, lat, z, S);
  return bilinear((ix, iy) => demTile(z, Math.floor(ix / S), Math.floor(iy / S), S)[(iy % S) * S + (ix % S)], x, y, n);
}

describe.skipIf(!haveTiles || !haveDwebp)('story centres on real GEBCO tiles', () => {
  const meta = demOnly
    ? { tileSize: 512, maxzoom: Math.max(...readdirSync(join(TILES, 'dem')).map(Number)), version: 'dem-only (meta.json not written yet)' }
    : haveTiles ? JSON.parse(readFileSync(join(TILES, 'meta.json'), 'utf8')) : {};
  const stories: { id: string; title: string; center: [number, number] }[] = JSON.parse(readFileSync(join(PUB, 'data', 'stories.json'), 'utf8'));
  const S = meta.tileSize, Z = meta.maxzoom;

  it('every story has an expectation', () => {
    expect(stories.map((s) => s.id).sort()).toEqual(Object.keys(EXPECT).sort());
  });

  const rows: string[] = [];
  for (const s of stories) {
    it(`${s.id} centre depth is in range`, () => {
      const h = depthAt(s.center[0], s.center[1], Z, S);
      // deepest point within +-0.25 deg, to show how far the centre is from the local minimum
      let best = { h: Infinity, lon: 0, lat: 0 };
      for (let dy = -0.25; dy <= 0.25001; dy += 0.025) for (let dx = -0.25; dx <= 0.25001; dx += 0.025) {
        const v = depthAt(s.center[0] + dx, s.center[1] + dy, Z, S);
        if (v < best.h) best = { h: v, lon: s.center[0] + dx, lat: s.center[1] + dy };
      }
      const [lo, hi] = EXPECT[s.id];
      rows.push(`${s.id.padEnd(22)} centre ${s.center.map((c) => c.toFixed(3)).join(', ').padEnd(18)} h=${h.toFixed(0).padStart(7)} m  expect [${lo}, ${hi}]  local-min ${best.h.toFixed(0)} m @ ${best.lon.toFixed(3)}, ${best.lat.toFixed(3)}`);
      expect(h).toBeGreaterThanOrEqual(lo);
      expect(h).toBeLessThanOrEqual(hi);
    });
  }
  it('prints the table', () => { console.log(`z${Z} ${S}px tiles (${meta.version})\n` + rows.join('\n')); });
});
