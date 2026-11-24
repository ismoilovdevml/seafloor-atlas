// Guards for files served as they are: the social preview image and the Cloudflare Pages cache rules.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const PUB = join(__dirname, '..', 'public');

describe('og-image.png', () => {
  const buf = readFileSync(join(PUB, 'og-image.png'));
  it('is a 1200x630 PNG under 300 KB (larger previews are dropped by Telegram and WhatsApp)', () => {
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(buf.length).toBeLessThan(300 * 1024);
  });
});

/** Cloudflare Pages _headers rules: path pattern ("*" matches anything, slashes included) -> Cache-Control. */
function cacheRules(text: string): { re: RegExp; detach: boolean; cc: string | null }[] {
  const rules: { re: RegExp; detach: boolean; cc: string | null }[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('/')) {
      const re = new RegExp(`^${line.trim().split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      rules.push({ re, detach: false, cc: null });
    } else if (rules.length && /^\s+! Cache-Control/.test(line)) rules.at(-1)!.detach = true;
    else if (rules.length && /^\s+Cache-Control:/.test(line)) rules.at(-1)!.cc = line.split(':')[1].trim();
  }
  return rules;
}
/** The Cache-Control a path ends up with: values of every matching rule joined, "! Cache-Control" drops earlier ones. */
function cacheControl(rules: ReturnType<typeof cacheRules>, path: string): string[] {
  let out: string[] = [];
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    if (r.detach) out = [];
    if (r.cc) out.push(r.cc);
  }
  return out;
}
function walk(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!/^(cells|[0-9]+)$/.test(name)) walk(p, keep, out); }
    else if (keep(p)) out.push(`/${relative(PUB, p).split(sep).join('/')}`);
  }
  return out;
}

describe('_headers', () => {
  const rules = cacheRules(readFileSync(join(PUB, '_headers'), 'utf8'));
  // JSON that describes data at fixed paths and changes in place when that data is rebuilt
  const describing = walk(PUB, (p) => /(?:manifest|meta|polar|legend)\.json$|obis\/groups\/index\.json$/.test(p.split(sep).join('/')));
  it('every manifest, meta, polar and legend file gets one short Cache-Control', () => {
    expect(describing).toEqual(expect.arrayContaining(['/tiles/meta.json', '/tiles/polar/polar.json', '/data/obis/manifest.json',
      '/tiles/disagree/legend.json', '/tiles/uncertainty/legend.json', '/tiles/shipping/legend.json']));
    const wrong = describing.map((p) => [p, cacheControl(rules, p)] as const)
      .filter(([, cc]) => cc.length !== 1 || cc[0] !== 'public, max-age=300, must-revalidate');
    expect(wrong).toEqual([]);
  });
  it('hashed assets stay immutable and tiles keep their day', () => {
    expect(cacheControl(rules, '/assets/index-abc123.js')).toEqual(['public, max-age=31536000, immutable']);
    expect(cacheControl(rules, '/tiles/dem/3/1/2.webp')).toEqual(['public, max-age=86400, stale-while-revalidate=604800']);
  });
});
