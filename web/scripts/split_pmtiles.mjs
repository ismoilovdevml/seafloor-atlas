// Cut PMTiles archives into fixed-size pieces for a static host without range requests (Cloudflare Pages: 25 MiB per
// file, 20,000 files per site). Writes <out>/<name>/00000.bin ... and <out>/manifest.json, read by src/chunked.ts.
//   node scripts/split_pmtiles.mjs <out-dir> <chunk-bytes> dem=<file>[@<source-url>] coverage=<file>[@<source-url>]
// Every piece is re-read and the joined bytes are compared with the archive's SHA-256 before the manifest is written.
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [out, chunkArg, ...specs] = process.argv.slice(2);
const chunk = Number(chunkArg);
if (!out || !(chunk > 0) || !specs.length) { console.error('usage: split_pmtiles.mjs <out> <chunk-bytes> layer=<file>[@url] ...'); process.exit(2); }

const sha = (file) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
const manifest = {};
for (const spec of specs) {
  const [layer, rest] = spec.split('=');
  const [file, source] = rest.split('@');
  const name = basename(file).replace(/\.pmtiles$/, '');
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  const size = statSync(file).size;
  const count = Math.ceil(size / chunk);
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(chunk);
  for (let i = 0; i < count; i++) {
    const n = readSync(fd, buf, 0, chunk, i * chunk);
    writeFileSync(join(dir, `${String(i).padStart(5, '0')}.bin`), buf.subarray(0, n));
  }
  closeSync(fd);
  const whole = await sha(file);
  const h = createHash('sha256');
  for (let i = 0; i < count; i++) h.update(readFileSync(join(dir, `${String(i).padStart(5, '0')}.bin`)));
  if (h.digest('hex') !== whole) { console.error(`${layer}: pieces do not join back to the archive`); process.exit(1); }
  manifest[layer] = { base: `hires/${name}/`, size, chunk, count, sha256: whole, ...(source ? { source } : {}) };
  console.log(`${layer}: ${size} bytes -> ${count} pieces of ${chunk} bytes, sha256 ${whole.slice(0, 12)}…`);
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
