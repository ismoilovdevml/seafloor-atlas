// Write a small synthetic tile set (z0..2) that follows docs/data-contract.md, so the viewer can be
// developed before the real GEBCO tiles exist. Output: public/tiles-synthetic/{dem,coverage}/z/x/y.webp,
// public/tiles-synthetic/meta.json and public/tiles-synthetic/data/{plates,features}.geojson.
// Open the viewer with ?tiles=synthetic to use it.
//
// usage: node scripts/make_synthetic_tiles.mjs        (needs `cwebp` on PATH for lossless WebP)
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tiles-synthetic');
const SIZE = 512;
const MAXZOOM = 2;
const VEIL_MAX = 230;
const VEIL_RGB = [0x0b, 0x14, 0x24];

// ---------- synthetic world (metres) ----------
const rad = Math.PI / 180;
const gauss = (d, w) => Math.exp(-((d / w) ** 2));
const lonDiff = (a, b) => ((a - b + 540) % 360) - 180;
const CONTINENTS = [
  // [lon, lat, half-width lon, half-width lat]
  [-100, 45, 28, 18], [-60, -15, 16, 22], [20, 5, 20, 28], [90, 50, 45, 17], [135, -25, 17, 11], [0, -82, 180, 7],
];
function landness(lon, lat) {
  let m = -1;
  for (const [cx, cy, wx, wy] of CONTINENTS) {
    const dx = lonDiff(lon, cx) / wx, dy = (lat - cy) / wy;
    m = Math.max(m, 1 - Math.hypot(dx, dy));
  }
  return m; // > 0 on land, ~0 at the coast
}
export function elevation(lon, lat) {
  const L = landness(lon, lat);
  if (L > 0) return Math.round(200 + 2600 * L * L + 300 * Math.sin(lon * 0.3) * Math.cos(lat * 0.25));
  let h = -4700 + 350 * Math.sin(lon * rad * 7) * Math.cos(lat * rad * 5);
  // shelf + slope from coast
  const c = -L; // 0 at coast, grows offshore
  h = h + (4600 * Math.exp(-c / 0.05));
  // Mid-Atlantic-style ridge
  const ridgeLon = -30 + 10 * Math.sin(lat * rad * 4);
  h += 2400 * gauss(lonDiff(lon, ridgeLon), 5);
  // East-Pacific-style rise
  h += 1800 * gauss(lonDiff(lon, -110 + 8 * Math.sin(lat * rad * 3)), 8);
  // Mariana-style trench with a Challenger-Deep pit at 142.59E 11.37N
  const trenchLon = 142.59 + 2.5 * Math.sin((lat - 11.37) * rad * 9);
  if (lat > 5 && lat < 30) h = Math.min(h, h - 5600 * gauss(lonDiff(lon, trenchLon), 1.4) * gauss(lat - 17, 12));
  h -= 900 * gauss(Math.hypot(lonDiff(lon, 142.59), lat - 11.37), 2.0);
  return Math.round(Math.max(h, -10950));
}
export function measuredFraction(lon, lat) {
  const L = landness(lon, lat);
  if (L > 0) return null;
  // ship tracks: thin great-circle-ish bands + dense near coasts + a surveyed box around the trench
  const tracks = Math.max(
    gauss(Math.sin((lon + 2 * lat) * rad * 9), 0.06),
    gauss(Math.sin((lon - 3 * lat) * rad * 6), 0.05),
  );
  const coast = Math.exp(-(-L) / 0.08);
  const box = Math.abs(lonDiff(lon, 142.6)) < 4 && Math.abs(lat - 13) < 8 ? 0.85 : 0;
  return Math.min(1, Math.max(0.03, tracks, coast, box));
}

// ---------- tile math ----------
function pixelLonLat(z, tx, ty, px, py) {
  const n = SIZE * 2 ** z;
  const x = (tx * SIZE + px + 0.5) / n, y = (ty * SIZE + py + 0.5) / n;
  const lon = x * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / rad;
  return [lon, lat];
}

// ---------- minimal PNG encoder (RGBA8) ----------
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- write ----------
rmSync(ROOT, { recursive: true, force: true });
const tmp = mkdtempSync(join(tmpdir(), 'seafloor-synth-'));
let measuredArea = 0, oceanArea = 0;
for (let z = 0; z <= MAXZOOM; z++) {
  for (let tx = 0; tx < 2 ** z; tx++) for (let ty = 0; ty < 2 ** z; ty++) {
    const dem = Buffer.alloc(SIZE * SIZE * 4), cov = Buffer.alloc(SIZE * SIZE * 4);
    for (let py = 0; py < SIZE; py++) for (let px = 0; px < SIZE; px++) {
      const [lon, lat] = pixelLonLat(z, tx, ty, px, py);
      const h = elevation(lon, lat);
      const v = h + 32768, i = (py * SIZE + px) * 4;
      dem[i] = v >> 8; dem[i + 1] = v & 255; dem[i + 2] = 0; dem[i + 3] = 255;
      const f = measuredFraction(lon, lat);
      cov[i] = VEIL_RGB[0]; cov[i + 1] = VEIL_RGB[1]; cov[i + 2] = VEIL_RGB[2];
      cov[i + 3] = f === null ? 0 : Math.round(VEIL_MAX * (1 - f));
      if (z === MAXZOOM && f !== null) { const w = Math.cos(lat * rad) ** 2; oceanArea += w; measuredArea += w * f; }
    }
    for (const [kind, buf] of [['dem', dem], ['coverage', cov]]) {
      const dir = join(ROOT, kind, String(z), String(tx));
      mkdirSync(dir, { recursive: true });
      const png = join(tmp, `${kind}-${z}-${tx}-${ty}.png`);
      writeFileSync(png, encodePNG(buf, SIZE, SIZE));
      execFileSync('cwebp', ['-quiet', '-lossless', '-exact', '-z', '6', png, '-o', join(dir, `${ty}.webp`)]);
    }
  }
}
rmSync(tmp, { recursive: true, force: true });

const meta = {
  version: 'SYNTHETIC', tileSize: SIZE, minzoom: 0, maxzoom: MAXZOOM, encoding: 'terrarium',
  veilMax: VEIL_MAX, veilColor: '#0b1424', sourceResolutionArcsec: 60,
  citation: 'Synthetic development tiles (not real data).', doi: '10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa',
  licence: 'Open Government Licence v3 (attribution required)',
  stats: { measured_fraction_area: +(measuredArea / oceanArea).toFixed(4) },
};
writeFileSync(join(ROOT, 'meta.json'), JSON.stringify(meta, null, 1));

mkdirSync(join(ROOT, 'data'), { recursive: true });
const line = (type, coords) => ({ type: 'Feature', properties: { type }, geometry: { type: 'LineString', coordinates: coords } });
const plates = { type: 'FeatureCollection', features: [
  line('ridge', Array.from({ length: 61 }, (_, i) => { const lat = -60 + i * 2; return [-30 + 10 * Math.sin(lat * rad * 4), lat]; })),
  line('ridge', Array.from({ length: 41 }, (_, i) => { const lat = -50 + i * 2; return [-110 + 8 * Math.sin(lat * rad * 3), lat]; })),
  line('subduction', Array.from({ length: 21 }, (_, i) => { const lat = 6 + i; return [142.59 + 2.5 * Math.sin((lat - 11.37) * rad * 9), lat]; })),
  line('transform', [[-40, 0.5], [-20, -0.5]]),
] };
writeFileSync(join(ROOT, 'data', 'plates.geojson'), JSON.stringify(plates));
const pt = (name, kind, lon, lat, blurb) => ({ type: 'Feature', properties: { name, kind, depth_m: elevation(lon, lat), blurb, source: 'synthetic' }, geometry: { type: 'Point', coordinates: [lon, lat] } });
const features = { type: 'FeatureCollection', features: [
  pt('Challenger Deep', 'deep', 142.59, 11.37, 'Synthetic stand-in for the deepest known point of the ocean.'),
  pt('Synthetic Ridge', 'ridge', -30, 0, 'A made-up spreading ridge for development.'),
  pt('Synthetic Rise', 'ridge', -110, -10, 'A made-up fast-spreading rise.'),
] };
writeFileSync(join(ROOT, 'data', 'features.geojson'), JSON.stringify(features));
console.log(`wrote z0..${MAXZOOM} to ${ROOT}; measured fraction ${(meta.stats.measured_fraction_area * 100).toFixed(1)}%`);
