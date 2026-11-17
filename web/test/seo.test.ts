// Guards for the static SEO pages written by scripts/seo_pages.mjs (committed under public/).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '..');
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');
const stories: { id: string; title: string }[] = JSON.parse(read('public/data/stories.json'));
const about = read('public/about/index.html');
const sources = read('../README.md') + read('../docs/paper/manuscript.md');

function jsonLd(html: string): unknown[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

describe('static SEO pages', () => {
  it('every number on the about page appears in the README or the paper', () => {
    const nums = [...about.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/\b\d[\d,]*(?:\.\d+)? ?(?:%|m\b|million km²|billion km³)/g)].map((m) => m[0]);
    expect(nums.length).toBeGreaterThan(10);
    const missing = [...new Set(nums)].filter((n) => !sources.includes(n) && !sources.includes(n.replace(' ', ' ')));
    expect(missing).toEqual([]);
  });

  it('has one page per guided view, each linking back to the globe', () => {
    for (const s of stories) {
      const p = `public/views/${s.id}/index.html`;
      expect(existsSync(join(WEB, p)), p).toBe(true);
      const html = read(p);
      expect(html).toContain(`href="/#story=${s.id}"`);
      expect(html).toContain(`<link rel="canonical" href="https://seaflooratlas.org/views/${s.id}/">`);
    }
  });

  it('sitemap lists the home page, about and every view', () => {
    const sm = read('public/sitemap.xml');
    for (const u of ['/', '/about/', ...stories.map((s) => `/views/${s.id}/`)]) expect(sm).toContain(`<loc>https://seaflooratlas.org${u}</loc>`);
    expect(read('public/robots.txt')).toContain('Sitemap: https://seaflooratlas.org/sitemap.xml');
  });

  it('JSON-LD parses on the home page, about page and view pages', () => {
    expect(jsonLd(read('index.html')).length).toBe(1);
    const types = jsonLd(about).map((o) => (o as { '@type': string })['@type']);
    expect(types).toEqual(expect.arrayContaining(['Dataset', 'FAQPage', 'BreadcrumbList']));
    expect(jsonLd(read(`public/views/${stories[0].id}/index.html`)).length).toBe(2);
  });
});

describe('EEZ report cards and downloads', () => {
  const eez: { eez: { slug: string; share: number | null; ocean_km2: number; name: string }[] } = JSON.parse(read('public/data/eez.json'));
  const rows = eez.eez.filter((r) => r.share !== null && r.ocean_km2 > 0);
  it('has a page per EEZ with its share, listed in the sitemap and the index', () => {
    const sm = read('public/sitemap.xml'); const idx = read('public/eez/index.html');
    for (const r of rows) {
      const html = read(`public/eez/${r.slug}/index.html`);
      expect(html).toContain(`${(r.share! * 100).toFixed(1)} %`);
      expect(sm).toContain(`<loc>https://seaflooratlas.org/eez/${r.slug}/</loc>`);
      expect(idx).toContain(`href="/eez/${r.slug}/"`);
    }
  });
  it('serves every dataset CSV table linked from the about page', () => {
    const files = readdirSync(join(WEB, '../dataset/tables')).filter((f) => f.endsWith('.csv'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      expect(read(`public/data/tables/${f}`)).toBe(read(`../dataset/tables/${f}`));
      expect(about).toContain(`href="/data/tables/${f}"`);
    }
  });
});
