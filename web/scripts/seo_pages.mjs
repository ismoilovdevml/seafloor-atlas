// Generate the static, crawlable pages that sit beside the map app:
//   public/about/index.html          what the atlas shows, key numbers, FAQ, how to cite (+ Dataset and FAQPage JSON-LD)
//   public/views/<id>/index.html     one page per guided view in data/stories.json (+ Place / Breadcrumb JSON-LD)
//   public/sitemap.xml, public/robots.txt
// The map itself is a WebGL app that search engines cannot read; these pages carry the text.
// usage: node scripts/seo_pages.mjs        (run after changing stories.json or the numbers below; commit the output)
// Numbers: KEY must match the README "Key numbers" table (web/test/seo.test.ts checks this).
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(WEB, 'public');
const SITE = 'https://seaflooratlas.org';
const REPO = 'https://github.com/ismoilovdevml/seafloor-atlas';
const ORCID = 'https://orcid.org/0009-0008-2785-3691';
const DOI_CONCEPT = '10.5281/zenodo.24228190';
const VERSION = '1.3.0';
const DOI_VERSION = '10.5281/zenodo.24287662';
const DOI_DATASET = '10.5281/zenodo.24287579'; // cell-level record (netCDF + tables), CC BY 4.0
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
  identifier: [`https://doi.org/${DOI_DATASET}`, `https://doi.org/${DOI_CONCEPT}`, `https://doi.org/${DOI_VERSION}`],
  version: VERSION, creator: person, isAccessibleForFree: true,
  license: `${REPO}/blob/main/LICENSES.md`,
  keywords: ['bathymetry', 'seafloor', 'ocean floor map', 'GEBCO', 'Seabed 2030', 'ocean mapping', 'type identifier grid', 'multibeam', 'ocean depth'],
  spatialCoverage: { '@type': 'Place', geo: { '@type': 'GeoShape', box: '-90 -180 90 180' } },
  temporalCoverage: '2019/2026',
  variableMeasured: ['seafloor depth', 'share of the seafloor directly measured', 'ocean area', 'ocean volume'],
  includedInDataCatalog: { '@type': 'DataCatalog', name: 'Zenodo', url: 'https://zenodo.org' },
  distribution: [
    { '@type': 'DataDownload', name: 'Cell-level record (netCDF-4, CF-1.8) and CSV tables', encodingFormat: 'application/x-netcdf', contentUrl: `https://doi.org/${DOI_DATASET}` },
    { '@type': 'DataDownload', name: 'Code and derived web data', encodingFormat: 'application/zip', contentUrl: `https://doi.org/${DOI_VERSION}` },
  ],
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


// ---------- downloads: the dataset's CSV tables are served from the site; the netCDF stays on Zenodo ----------
const TABLES_SRC = join(WEB, '..', 'dataset', 'tables');
const TABLES = existsSync(TABLES_SRC) ? readdirSync(TABLES_SRC).filter((f) => f.endsWith('.csv')).sort() : [];
mkdirSync(join(PUB, 'data', 'tables'), { recursive: true });
for (const f of TABLES) copyFileSync(join(TABLES_SRC, f), join(PUB, 'data', 'tables', f));
const TABLE_INFO = {
  'global_by_release.csv': 'Global measured share per GEBCO release, with new, re-coded and ever-measured area and the official Seabed 2030 figure',
  'by_latitude_band_by_release.csv': 'Measured share per 5° latitude band and release',
  'by_depth_bin_by_release.csv': 'Measured share per 250 m depth bin and release',
  'by_ocean_by_release.csv': 'Measured share per ocean basin (Marine Regions Global Oceans and Seas) and release',
  'by_zone_by_release.csv': 'National waters (all EEZs) vs high seas per release',
  'by_tid_code_by_release.csv': 'Area per GEBCO Type Identifier code and release (survey types)',
  'recoded_away_by_destination_tid.csv': 'Area leaving the measured codes per transition, by the code it received',
  'cellsize_sensitivity_2026.csv': 'Measured share on blocks of near-constant width (cell-size sensitivity)',
  'inland_components.csv': 'Areas below sea level not connected to the world ocean (e.g. Caspian Sea)',
  'tid_codes.csv': 'GEBCO Type Identifier codes and their meaning',
};
const downloadsHtml = `<h2>Downloads</h2>
<p>Tables (CSV, CC BY 4.0, from the dataset <a href="https://doi.org/${DOI_DATASET}">doi:${DOI_DATASET}</a>; column definitions in its README):</p>
<ul>${TABLES.map((f) => `<li><a href="/data/tables/${f}" download>${f}</a>${TABLE_INFO[f] ? ` – ${esc(TABLE_INFO[f])}` : ''}</li>`).join('')}
<li><a href="/data/eez.json" download>eez.json</a> – measured share per EEZ, GEBCO 2026</li></ul>
<p>The full cell-level record (one netCDF-4 file, 783 MB, every 15″ cell) is on Zenodo: <a href="https://doi.org/${DOI_DATASET}">doi:${DOI_DATASET}</a>.</p>`;
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
<h2>National waters</h2>
<p>How much of each country’s seafloor is measured: <a href="/eez/">ranking of exclusive economic zones</a>.</p>
<h2>Famous places on the seafloor</h2>
<ul class="views">${stories.map((s) => `<li><a href="/views/${s.id}/">${esc(s.title)}<small>${fmtCoord(s.center)}</small></a></li>`).join('')}</ul>
<h2>Frequently asked questions</h2>
${faq.map(([q, a]) => `<h3>${esc(q)}</h3>\n<p>${esc(a)}</p>`).join('\n')}
${downloadsHtml}
<h2>For researchers</h2>
<p>The measured share is computed from the public GEBCO Type Identifier grids of every release from 2019 to 2026 (codes 10–17 = direct measurement), on one fixed ocean mask, with every number traceable to a script. Code, derived data and figures are archived on Zenodo (<a href="https://doi.org/${DOI_VERSION}">doi:${DOI_VERSION}</a>, version ${VERSION}; all versions <a href="https://doi.org/${DOI_CONCEPT}">doi:${DOI_CONCEPT}</a>). The cell-level record behind these numbers (one netCDF file on the native 15″ grid plus tables, CC BY 4.0) is archived at <a href="https://doi.org/${DOI_DATASET}">doi:${DOI_DATASET}</a>.</p>
<pre>Ismoilov, O. (2026). Seafloor Atlas: an interactive globe of the whole ocean floor
and how much of it has been measured (Version ${VERSION}). Zenodo. https://doi.org/${DOI_VERSION}

Dataset: Ismoilov, O. (2026). A cell-level record of directly measured seafloor
in the GEBCO grid releases 2019–2026 (Version 1.0.0). Zenodo. https://doi.org/${DOI_DATASET}</pre>
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

// ---------- one report card per EEZ (data: public/data/eez.json from pipeline/eez_cards.py) ----------
const eezData = JSON.parse(readFileSync(join(PUB, 'data', 'eez.json'), 'utf8'));
const eezRows = eezData.eez.filter((r) => r.share !== null && r.ocean_km2 > 0);
const pct = (x) => `${(x * 100).toFixed(1)} %`;
const km2 = (x) => `${Math.round(x).toLocaleString('en-US')} km²`;
const nRanked = eezData.meta.n_ranked;
const eezRow = (r) => `<tr><td><a href="/eez/${r.slug}/">${esc(r.name)}</a></td><td>${esc(r.sovereign || '')}</td><td>${km2(r.ocean_km2)}</td><td>${pct(r.share)}</td></tr>`;
const sorted = [...eezRows].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.share - a.share);
mkdirSync(join(PUB, 'eez'), { recursive: true });
writeFileSync(join(PUB, 'eez', 'index.html'), page({
  path: '/eez/',
  title: 'How much of each country’s seafloor is mapped? EEZ ranking | Seafloor Atlas',
  description: `Directly measured share of the seafloor in ${eezRows.length} exclusive economic zones, from the GEBCO 2026 grid. All national waters together: ${KEY.eez}; the high seas: ${KEY.highSeas}.`,
  image: null, imageAlt: 'Seafloor Atlas',
  body: `<p class="crumbs"><a href="/">Seafloor Atlas</a> › National waters</p>
<h1>How much of each country’s seafloor has been measured?</h1>
<p class="lede">The share of the seafloor in each exclusive economic zone (EEZ) that is directly measured, mostly by ship sonar, in the GEBCO 2026 grid. All EEZs together are ${KEY.eez} measured, the high seas ${KEY.highSeas}, the whole ocean ${KEY.measured}.</p>
<p>Ranked: ${nRanked} EEZs larger than ${eezData.meta.ranked_min_km2.toLocaleString('en-US')} km² (smaller ones carry boundary errors of a few percent). A low value means the data are not in the public grid, not necessarily that the area was never surveyed.</p>
<table><tr><th>EEZ</th><th>Sovereign</th><th>Ocean area</th><th>Measured</th></tr>
${sorted.map(eezRow).join('\n')}
</table>`,
  jsonld: [{ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Seafloor Atlas', item: `${SITE}/` },
    { '@type': 'ListItem', position: 2, name: 'National waters', item: `${SITE}/eez/` }] }],
}));
for (const r of eezRows) {
  const at = r.lon !== null ? `/#at=${r.lon},${r.lat},${r.zoom}` : '/';
  const rankLine = r.rank ? `It ranks ${r.rank} of ${nRanked} exclusive economic zones larger than ${eezData.meta.ranked_min_km2.toLocaleString('en-US')} km².` : `It is too small (under ${eezData.meta.ranked_min_km2.toLocaleString('en-US')} km²) to be ranked reliably.`;
  const body = `<p class="crumbs"><a href="/">Seafloor Atlas</a> › <a href="/eez/">National waters</a> › ${esc(r.name)}</p>
<h1>How much of the seafloor in ${esc(r.name)} is mapped?</h1>
<p class="lede">${pct(r.share)} of the seafloor in the ${esc(r.geoname || r.name)} is directly measured in the GEBCO 2026 grid, mostly by ship sonar. ${rankLine}</p>
<p><a class="cta" href="${at}">See it on the 3D globe</a></p>
<table>
<tr><td>Seafloor area (ocean part of the zone)</td><td>${km2(r.ocean_km2)}</td></tr>
<tr><td>Directly measured</td><td>${km2(r.measured_km2)} (${pct(r.share)})</td></tr>
<tr><td>All national waters together</td><td>${KEY.eez}</td></tr>
<tr><td>High seas</td><td>${KEY.highSeas}</td></tr>
<tr><td>Whole ocean</td><td>${KEY.measured}</td></tr>
${r.sovereign ? `<tr><td>Sovereign</td><td>${esc(r.sovereign)}</td></tr>` : ''}
</table>
<h2>What these numbers mean</h2>
<p>"Directly measured" means the cell is coded TID 10–17 (multibeam, single beam, lidar, seismic or other direct soundings) in the GEBCO 2026 Type Identifier grid; everything else is estimated, mostly from satellite gravity. The numbers describe what has been shared with GEBCO: national and commercial surveys that were not contributed count as unmeasured. Zone boundaries come from Marine Regions (World EEZ v12, CC BY 4.0), rasterised on a 1′ grid, so very small zones carry errors of a few percent.</p>
<p>In the 3D globe, switch on <em>What’s actually measured</em> to see which parts of this zone were surveyed. <a href="/about/">How the measured share is computed</a> · <a href="https://doi.org/${DOI_DATASET}">Dataset (doi:${DOI_DATASET})</a></p>`;
  mkdirSync(join(PUB, 'eez', r.slug), { recursive: true });
  writeFileSync(join(PUB, 'eez', r.slug, 'index.html'), page({
    path: `/eez/${r.slug}/`,
    title: `${r.name}: how much of the seafloor is mapped? | Seafloor Atlas`,
    description: clip(`${pct(r.share)} of the seafloor in the ${r.geoname || r.name} is directly measured (GEBCO 2026). Area ${km2(r.ocean_km2)}${r.rank ? `, rank ${r.rank} of ${nRanked}` : ''}. See it on an interactive 3D globe.`),
    image: null, imageAlt: `${r.name} seafloor mapping`, body,
    jsonld: [
      { '@context': 'https://schema.org', '@type': 'Place', name: r.geoname || r.name, url: `${SITE}/eez/${r.slug}/`,
        ...(r.lon !== null ? { geo: { '@type': 'GeoCoordinates', latitude: r.lat, longitude: r.lon } } : {}) },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Seafloor Atlas', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'National waters', item: `${SITE}/eez/` },
        { '@type': 'ListItem', position: 3, name: r.name, item: `${SITE}/eez/${r.slug}/` }] },
    ],
  }));
}

// ---------- sitemap + robots ----------
const urls = ['/', '/about/', ...stories.map((s) => `/views/${s.id}/`), '/eez/', ...eezRows.map((r) => `/eez/${r.slug}/`)];
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
// IndexNow key file lives at public/<key>.txt (Bing, Yandex, Seznam, Naver); ping with scripts/indexnow.sh
console.log(`wrote about, ${stories.length} view pages, sitemap (${urls.length} urls), robots.txt`);
