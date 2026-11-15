// Generate the static, crawlable pages that sit beside the map app:
//   public/about/index.html          what the atlas shows, key numbers, FAQ, how to cite (+ Dataset and FAQPage JSON-LD)
//   public/views/<id>/index.html     one page per guided view in data/stories.json (+ Place / Breadcrumb JSON-LD)
//   public/sitemap.xml, public/robots.txt
// The map itself is a WebGL app that search engines cannot read; these pages carry the text.
// usage: node scripts/seo_pages.mjs        (run after changing stories.json or the numbers below; commit the output)
// Numbers: KEY must match the README "Key numbers" table (web/test/seo.test.ts checks this).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(WEB, 'public');
const SITE = 'https://seaflooratlas.org';
const REPO = 'https://github.com/ismoilovdevml/seafloor-atlas';
const ORCID = 'https://orcid.org/0009-0008-2785-3691';
const DOI_CONCEPT = '10.5281/zenodo.24228190';
const VERSION = '1.1.1';
const DOI_VERSION = '10.5281/zenodo.24254651';
const UPDATED = '2026-11-16';

export const KEY = {
  oceanArea: '361.7 million km²',
  oceanShare: '70.9 %',
  measured: '30.8 %',
  official: '28.7 %',
  change: '29.7 % → 30.8 %',
  gained: '+4.1 million km²',
  eez: '38.0 %',
  highSeas: '26.4 %',
  abyssal: '26.7 %',
  south: '19–20 %',
  trenchErr: '10 m',
  volume: '1.338 billion km³',
  meanDepth: '3,702 m',
  noRecords: '45 %',
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const fmtCoord = ([lon, lat]) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
const clip = (s, n = 158) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(' ', n - 1))}…`);

const CSS = `:root{color-scheme:dark;--bg:#07101d;--panel:#0d1a2c;--line:rgba(160,200,230,.16);--ink:#e8f0f7;--muted:#a9bccd;--accent:#9fe3c8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:var(--accent)}main{max-width:820px;margin:0 auto;padding:24px 16px 64px}header.top{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:820px;margin:0 auto;padding:16px}
header.top a.brand{color:var(--ink);text-decoration:none;font:500 20px Georgia,serif}.cta{display:inline-block;background:var(--accent);color:#06261c;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:999px}
h1{font:500 clamp(30px,5vw,44px)/1.1 Georgia,"Times New Roman",serif;margin:8px 0 14px}h2{font:500 26px/1.2 Georgia,serif;margin:40px 0 10px}h3{font-size:18px;margin:22px 0 4px}
.lede{font-size:19px;color:var(--muted)}figure{margin:22px 0}figure img{width:100%;height:auto;border-radius:12px;border:1px solid var(--line);display:block}figcaption{color:var(--muted);font-size:14px;margin-top:6px}
table{border-collapse:collapse;width:100%;font-size:15px}td,th{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}td:last-child{white-space:nowrap;font-weight:600}
ul.views{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}ul.views a{display:block;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel);text-decoration:none;color:var(--ink)}
ul.views small{display:block;color:var(--muted)}.crumbs{font-size:14px;color:var(--muted)}.crumbs a{color:var(--muted)}pre{white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:14px}
footer{max-width:820px;margin:0 auto;padding:24px 16px 40px;color:var(--muted);font-size:14px;border-top:1px solid var(--line)}`;

function page({ path, title, description, image, imageAlt, body, jsonld = [] }) {
  const url = `${SITE}${path}`;
  const img = image ? `${SITE}${image}` : `${SITE}/og-image.png`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Seafloor Atlas">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}"><meta property="og:image" content="${img}">
<meta property="og:image:alt" content="${esc(imageAlt || title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${img}">
<meta name="theme-color" content="#07101d">
<style>${CSS}</style>
${jsonld.map(ld).join('\n')}
</head>
<body>
<header class="top"><a class="brand" href="/">Seafloor Atlas</a><a class="cta" href="/">Open the 3D globe</a></header>
<main>
${body}
</main>
<footer>
<p>Seafloor Atlas is an independent, open-source project by <a href="${ORCID}">Otabek Ismoilov</a>. It is not an official GEBCO or Seabed 2030 product. Depths are not for navigation.</p>
<p><a href="/">3D globe</a> · <a href="/about/">About &amp; FAQ</a> · <a href="${REPO}">Source code</a> · <a href="https://doi.org/${DOI_CONCEPT}">Zenodo archive</a> · Updated ${UPDATED}</p>
</footer>
</body>
</html>
`;
}

const stories = JSON.parse(readFileSync(join(PUB, 'data', 'stories.json'), 'utf8'));
const viewImg = (id) => (existsSync(join(PUB, 'views', id, 'view.jpg')) ? `/views/${id}/view.jpg` : null);

const person = { '@type': 'Person', name: 'Otabek Ismoilov', url: ORCID, identifier: ORCID, affiliation: { '@type': 'Organization', name: 'Independent researcher' } };
const dataset = {
  '@context': 'https://schema.org', '@type': 'Dataset',
  name: 'Seafloor Atlas: an interactive globe of the whole ocean floor and how much of it has been measured',
  description: `Web tiles, derived grids and statistics built from the GEBCO 2019–2026 grids and their Type Identifier grids: seafloor depth, the share of the seafloor directly measured by ships (${KEY.measured} in GEBCO 2026, area-weighted), release-by-release changes, and regional statistics, with the code that computes them.`,
  url: `${SITE}/`, sameAs: [REPO, `https://doi.org/${DOI_CONCEPT}`],
  identifier: [`https://doi.org/${DOI_CONCEPT}`, `https://doi.org/${DOI_VERSION}`],
  version: VERSION, creator: person, isAccessibleForFree: true,
  license: `${REPO}/blob/main/LICENSES.md`,
  keywords: ['bathymetry', 'seafloor', 'ocean floor map', 'GEBCO', 'Seabed 2030', 'ocean mapping', 'type identifier grid', 'multibeam', 'ocean depth'],
  spatialCoverage: { '@type': 'Place', geo: { '@type': 'GeoShape', box: '-90 -180 90 180' } },
  temporalCoverage: '2019/2026',
  variableMeasured: ['seafloor depth', 'share of the seafloor directly measured', 'ocean area', 'ocean volume'],
  includedInDataCatalog: { '@type': 'DataCatalog', name: 'Zenodo', url: 'https://zenodo.org' },
  distribution: [{ '@type': 'DataDownload', encodingFormat: 'application/zip', contentUrl: `https://doi.org/${DOI_VERSION}` }],
  isBasedOn: 'https://doi.org/10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa',
  dateModified: UPDATED,
};

const faq = [
  ['How much of the ocean floor has been mapped?',
    `In the GEBCO 2026 grid, ${KEY.measured} of the seafloor area is coded as directly measured by ships and other surveys (multibeam and single-beam sonar, lidar, seismic). The official Seabed 2030 figure for the same grid is ${KEY.official}; it uses a stricter, depth-dependent resolution rule. The rest of the seafloor is estimated from satellite gravity or interpolated between measurements.`],
  ['Why is so little of the seafloor measured?',
    `The ocean covers ${KEY.oceanArea} (${KEY.oceanShare} of Earth). A survey ship measures only a strip a few kilometres wide under its track, and most of the deep ocean is far from shipping lanes and coasts. The least-measured places are the abyssal plains (${KEY.abyssal} at 4–5 km depth), the southern mid-latitudes (${KEY.south} at 40–50° S) and the high seas (${KEY.highSeas}, against ${KEY.eez} inside national waters).`],
  ['How fast is the measured share growing?',
    `Between GEBCO 2025 and GEBCO 2026 it went from ${KEY.change}, ${KEY.gained} in one year on the same ocean mask. Part of every release is also re-coded between "measured" and "estimated", which this atlas tracks release by release.`],
  ['What is the deepest point of the ocean?',
    `Challenger Deep, at the southern end of the Mariana Trench in the western Pacific, almost 11 km below sea level. At the 14 deepest places the GEBCO 2026 grid lies within a median of ${KEY.trenchErr} of published surveys.`],
  ['How much water is in the ocean?',
    `On the GEBCO 2026 grid the ocean holds ${KEY.volume} with a mean depth of ${KEY.meanDepth}, within 0.5 % of an earlier published estimate (Charette and Smith 2010).`],
  ['Where does the data come from?',
    'Depth and the measured/estimated coding come from the GEBCO Compilation Group grids (2019–2026) and their Type Identifier grids. Other layers use World Ocean Atlas 2023 (temperature, salinity), NASA MODIS-Aqua (phytoplankton), NCEP/NCAR and OSCAR (winds, currents), USGS ComCat (earthquakes), OBIS and AquaMaps (marine life), Marine Regions (national waters), seamount catalogues, OpenStreetMap, Wikidata, the World Bank and TeleGeography. Each layer keeps its source licence.'],
  ['Can I use the data and the code?',
    `Yes. The code is MIT-licensed. Each data file keeps the licence of its source, listed per file in LICENSES.md; some layers are non-commercial or ShareAlike. The depths are not for navigation.`],
  ['How do I cite Seafloor Atlas?',
    `Ismoilov, O. (2026). Seafloor Atlas: an interactive globe of the whole ocean floor and how much of it has been measured (Version ${VERSION}). Zenodo. https://doi.org/${DOI_VERSION}. The concept DOI for all versions is ${DOI_CONCEPT}. Please also cite GEBCO and the other data sources you use.`],
  ['Is this an official GEBCO or Seabed 2030 product?',
    'No. It is an independent open-source project built on their public data and is not endorsed by them.'],
];

// ---------- about ----------
const aboutBody = `<p class="crumbs"><a href="/">Seafloor Atlas</a> › About</p>
<h1>How much of the ocean floor has actually been measured?</h1>
<p class="lede">Seafloor Atlas is a free interactive 3D globe of the whole ocean floor, built from the GEBCO 2026 grid. It shows the shape of the seafloor and, for every place, whether its depth was measured by a ship or only estimated from space.</p>
<p><a class="cta" href="/">Open the 3D globe</a> &nbsp; <a href="/#tour=1">or take the 2-minute guided tour</a></p>
<figure><img src="/img/measured.jpg" width="1600" height="1000" loading="eager" alt="Globe of the Atlantic: seafloor surveyed by ships is bright, areas estimated from satellite gravity are dark."><figcaption>"What's actually measured": ship-surveyed seafloor stays bright, estimated seafloor goes dark.</figcaption></figure>
<h2>Key numbers</h2>
<table>
<tr><td>Ocean area</td><td>${KEY.oceanArea} (${KEY.oceanShare} of Earth)</td></tr>
<tr><td>Seafloor directly measured, GEBCO 2026</td><td>${KEY.measured}</td></tr>
<tr><td>Official Seabed 2030 figure (stricter rule)</td><td>${KEY.official}</td></tr>
<tr><td>GEBCO 2025 → GEBCO 2026</td><td>${KEY.change} (${KEY.gained})</td></tr>
<tr><td>National waters (EEZs) vs high seas, measured</td><td>${KEY.eez} vs ${KEY.highSeas}</td></tr>
<tr><td>Deepest places: median error of the grid vs surveys</td><td>${KEY.trenchErr}</td></tr>
<tr><td>Ocean volume, mean depth</td><td>${KEY.volume}, ${KEY.meanDepth}</td></tr>
<tr><td>Ocean area with no species record at all</td><td>${KEY.noRecords}</td></tr>
</table>
<p>All numbers are computed in the open <a href="${REPO}">source code</a> from public data, area-weighted on the sphere.</p>
<h2>What you can do on the globe</h2>
<ul>
<li><strong>See what is measured</strong> and what is only estimated, anywhere on Earth, down to 460 m detail.</li>
<li><strong>Draw a depth profile</strong> across a trench or ridge, for example across Challenger Deep (almost 11 km).</li>
<li><strong>Lower or raise the sea</strong>: at −120 m, the level of the last ice age, Sundaland, Sahul and Beringia become land.</li>
<li><strong>Look at the water</strong>: temperature, salinity and density from the surface to 5 km, month by month.</li>
<li><strong>Play time</strong>: earthquakes since 1900, internet cables, offshore wind farms and seafloor mapping 2019 → 2026.</li>
<li><strong>Follow winds, currents and phytoplankton</strong> through the seasons, and see marine life records and their gaps.</li>
<li><strong>Human activity at sea</strong>: submarine cables, shipping lanes, shipwrecks, oil and gas platforms, pipelines, wind farms.</li>
</ul>
<h2>Famous places on the seafloor</h2>
<ul class="views">${stories.map((s) => `<li><a href="/views/${s.id}/">${esc(s.title)}<small>${fmtCoord(s.center)}</small></a></li>`).join('')}</ul>
<h2>Frequently asked questions</h2>
${faq.map(([q, a]) => `<h3>${esc(q)}</h3>\n<p>${esc(a)}</p>`).join('\n')}
<h2>For researchers</h2>
<p>The measured share is computed from the public GEBCO Type Identifier grids of every release from 2019 to 2026 (codes 10–17 = direct measurement), on one fixed ocean mask, with every number traceable to a script. Code, derived data and figures are archived on Zenodo (<a href="https://doi.org/${DOI_VERSION}">doi:${DOI_VERSION}</a>, version ${VERSION}; all versions <a href="https://doi.org/${DOI_CONCEPT}">doi:${DOI_CONCEPT}</a>). A preprint describing the method has been submitted to EarthArXiv.</p>
<pre>Ismoilov, O. (2026). Seafloor Atlas: an interactive globe of the whole ocean floor
and how much of it has been measured (Version ${VERSION}). Zenodo. https://doi.org/${DOI_VERSION}</pre>
`;
const aboutLd = [
  dataset,
  { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Seafloor Atlas', item: `${SITE}/` },
    { '@type': 'ListItem', position: 2, name: 'About', item: `${SITE}/about/` }] },
];
mkdirSync(join(PUB, 'about'), { recursive: true });
writeFileSync(join(PUB, 'about', 'index.html'), page({
  path: '/about/',
  title: 'How much of the ocean floor is mapped? Key numbers and FAQ | Seafloor Atlas',
  description: `Only ${KEY.measured} of the seafloor has been directly measured by ships (GEBCO 2026). An interactive 3D map of the whole ocean floor, with key numbers, FAQ and data sources.`,
  image: '/img/measured.jpg', imageAlt: 'Globe showing which parts of the Atlantic seafloor were measured by ships',
  body: aboutBody, jsonld: aboutLd,
}));

// ---------- one page per guided view ----------
for (const [i, s] of stories.entries()) {
  const others = stories.filter((o) => o.id !== s.id);
  const img = viewImg(s.id);
  const body = `<p class="crumbs"><a href="/">Seafloor Atlas</a> › <a href="/about/">Places</a> › ${esc(s.title)}</p>
<h1>${esc(s.title)}</h1>
<p class="lede">${esc(s.blurb)}</p>
<p><a class="cta" href="/#story=${s.id}">Explore ${esc(s.title)} in 3D</a></p>
${img ? `<figure><img src="${img}" width="1200" height="630" loading="eager" alt="3D view of the seafloor at ${esc(s.title)} from the GEBCO 2026 grid"><figcaption>${esc(s.title)} on the Seafloor Atlas globe (GEBCO 2026, relief exaggerated).</figcaption></figure>` : ''}
<h2>Where it is</h2>
<p>${esc(s.title)} is centred near ${fmtCoord(s.center)}. In the 3D globe you can turn on <em>What's actually measured</em> to see which parts of this seafloor were surveyed by ships and which are only estimated from satellite gravity, draw a depth profile across it, or change the sea level.</p>
<h2>About the data</h2>
<p>Depths come from the GEBCO 2026 global grid (15 arc-seconds, about 460 m at the equator). Across the whole ocean, ${KEY.measured} of the seafloor is directly measured; the rest is estimated. <a href="/about/">Read how this is computed</a>.</p>
<h2>More places on the seafloor</h2>
<ul class="views">${others.map((o) => `<li><a href="/views/${o.id}/">${esc(o.title)}<small>${fmtCoord(o.center)}</small></a></li>`).join('')}</ul>`;
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'Place', name: s.title, description: s.blurb, url: `${SITE}/views/${s.id}/`,
      geo: { '@type': 'GeoCoordinates', latitude: s.center[1], longitude: s.center[0] }, ...(img ? { image: `${SITE}${img}` } : {}) },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Seafloor Atlas', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Places', item: `${SITE}/about/` },
      { '@type': 'ListItem', position: 3, name: s.title, item: `${SITE}/views/${s.id}/` }] },
  ];
  mkdirSync(join(PUB, 'views', s.id), { recursive: true });
  writeFileSync(join(PUB, 'views', s.id, 'index.html'), page({
    path: `/views/${s.id}/`,
    title: `${s.title}: 3D seafloor map | Seafloor Atlas`,
    description: clip(`${s.blurb} Explore it on an interactive 3D globe of the ocean floor.`),
    image: img, imageAlt: `3D view of ${s.title}`, body, jsonld,
  }));
  void i;
}

// ---------- sitemap + robots ----------
const urls = ['/', '/about/', ...stories.map((s) => `/views/${s.id}/`)];
writeFileSync(join(PUB, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${UPDATED}</lastmod></url>`).join('\n')}
</urlset>
`);
writeFileSync(join(PUB, 'robots.txt'), `User-agent: *
Allow: /
Disallow: /tiles/
Disallow: /history/

Sitemap: ${SITE}/sitemap.xml
`);
console.log(`wrote about, ${stories.length} view pages, sitemap (${urls.length} urls), robots.txt`);
