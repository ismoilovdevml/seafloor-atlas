// English words for the guided tour (chapter ids from tour-chapters.ts). Another language is another file of
// this shape. Every number here comes from the project's own data or UI; test/tour.test.ts checks them
// against the files named in each chapter's source line.
import type { TourText } from './tour-model';

export const TEXT_EN: TourText = {
  lang: 'en',
  ui: {
    region: 'Guided tour',
    start: 'Tour',
    exit: 'Exit tour',
    back: 'Back',
    next: 'Next',
    finish: 'Finish',
    pause: 'Pause',
    play: 'Play',
    voiceOn: 'Stop reading aloud',
    voiceOff: 'Read aloud',
    chapters: 'Chapters',
    count: (n, total) => `${n} of ${total}`,
    chapter: (n, title) => `Chapter ${n}: ${title}`,
    paused: 'Paused',
    sourcePrefix: 'Source: ',
    keys: 'Left and Right arrows: back and next. Space: pause or play. Esc: exit.',
    language: 'Tour language',
  },
  chapters: {
    globe: {
      title: 'The whole ocean floor',
      text: 'Hi, I’m Ping, your sonar buoy. This globe is the GEBCO 2026 grid: 361.7 million km² of ocean, 70.9% of Earth’s surface. Colour is depth, from pale green at the coast through teal and blue to violet-black at 11,000 m, with the steps closer near the surface. The relief is stretched vertically so ridges and trenches read on a whole-Earth view.',
      source: 'GEBCO 2026 Grid (tiles/meta.json); ocean area from history/manifest.json; colour scale from the depth legend.',
    },
    measured: {
      title: 'What is actually measured',
      text: 'Only 30.8% of the seafloor has been measured directly, mostly by ship sonar; Seabed 2030 counts 28.7% for GEBCO 2026 with a stricter rule. “What’s actually measured” dims everything else, where the depth is estimated from satellite gravity. Here the search for flight MH370 mapped a 120,000 km² swath between 2014 and 2017, bright against its estimated surroundings.',
      source: 'GEBCO 2026 type identifier grid, codes 10–17 = direct survey (tiles/meta.json); the MH370 guided view.',
    },
    detail: {
      title: 'Zoom in for the full grid',
      text: 'Zoomed out, the map shows the grid at 1′. Close up it switches to the full 15″ grid at zoom 6–7, loaded as you go; the loading bar shows its progress. Monterey Canyon is as deep as the Grand Canyon and starts a few hundred metres off the California coast. The relief here is stretched ×4; Map settings changes the stretch.',
      source: 'GEBCO 2026 15″ tiles at zoom 6–7 (tiles/meta.json); the Monterey Canyon guided view.',
    },
    profile: {
      title: 'A slice through Challenger Deep',
      text: 'The Depth profile tool reads the seafloor along a line you draw. This one crosses the Mariana Trench at Challenger Deep, the deepest known point of the ocean. At full resolution the grid’s deepest cell there is 10,927 m, 8 m from the published 10,935 m. The panel also shows how much of the line ships have measured.',
      source: 'GEBCO 2026 15″ grid against the published depth (Hotham 2026), docs/trenches.md.',
    },
    plates: {
      title: 'Plates and ridges',
      text: 'Plate boundaries show where tectonic plates meet, coloured by how they move: spreading, subduction, transform and collision. Down the Atlantic, North America and Eurasia pull apart by about 2 cm a year; at Iceland a mantle hotspot under the ridge pushes it above sea level. Click a boundary for its two plates and their speed.',
      source: 'Bird (2003) PB2002 plate boundaries; spreading rate from the Mid-Atlantic Ridge guided view.',
    },
    'sea-level': {
      title: 'The sea at the ice age',
      text: 'The Sea level tool floods or drains today’s terrain. At −120 m, the Last Glacial Maximum about 20,000 years ago, Beringia joins Asia to America: 170.0 million km² stand above the sea, 21.8 million km² more than today. Press play to sweep the whole range, from −6,000 m to +100 m.',
      source: 'Land areas from the GEBCO 2026 1′ grid (data/hypsometry.json); preset note from the Sea level tool.',
    },
    water: {
      title: 'Inside the water',
      text: 'Ocean water shows temperature, salinity and density at 11 depths from the surface to 5,000 m, averaged over 1991–2020, and on the seafloor itself, the slider’s last stop. Click the ocean for its water column: this one is in the western Pacific, warm at the top and cold below the thermocline.',
      source: 'World Ocean Atlas 2023 (NOAA NCEI), 1991–2020 climate normal (woa/manifest.json).',
    },
    monsoon: {
      title: 'Winds, currents and the July bloom',
      text: 'The Time panel’s Months mode moves several layers together. In July the monsoon over the Arabian Sea blows from the southwest (from the northeast in January), and phytoplankton blooms off Somalia and Oman where it brings up nutrients. Chlorophyll runs from 0.02 mg/m³ in the South Pacific gyre to over 3 in the Peru upwelling. Ocean currents, the other flow layer, reach about 1.3 m/s in the Gulf Stream, Kuroshio and Agulhas.',
      source: 'Winds: NCEP/NCAR reanalysis, 1991–2020; chlorophyll-a: NASA MODIS-Aqua climatology; currents: OSCAR, 2015–2024.',
    },
    quakes: {
      title: 'Earthquakes and seamounts',
      text: 'Every earthquake of magnitude 5.5 or more since 1900, sized by magnitude and coloured by depth: almost all sit on plate boundaries. The rings are seamounts, 69,770 undersea mountains at least 100 m tall; a filled ring has a sonar sounding on its summit. At the Tonga Trench the plates converge at up to 24 cm a year, the fastest anywhere on Earth.',
      source: 'USGS ANSS ComCat (data/quakes.json); SDUST2026SM and SIO 2023 seamount catalogues (data/seamounts.json); rate from the Tonga–Kermadec guided view.',
    },
    human: {
      title: 'People at sea',
      text: 'Human activity has its own layer group. Shown here: 527 internet cables and 1,436 landing points as of 14 November 2022, shipping traffic from ship position reports for 2015–2021, and shipwrecks recorded in Wikidata. Oil and gas platforms, subsea pipelines and offshore wind farms come from OpenStreetMap.',
      source: 'TeleGeography cable snapshot of 14 November 2022 (data/cables.geojson); World Bank / IMF shipping density; Wikidata; OpenStreetMap.',
    },
    mapping: {
      title: 'Mapping the seafloor, 2019 to 2026',
      text: 'The Time panel’s Years mode steps through the GEBCO releases. In GEBCO_2019, 12.4% of the ocean floor was measured directly by this atlas’s count; in GEBCO_2026, 30.8%. Amber marks what each release added. Seabed 2030 announced 15% and 28.7%: it counts cells of a depth-dependent grid, so the two figures differ.',
      source: 'GEBCO_2019 to GEBCO_2026 type identifier grids (history/manifest.json); official figures from Seabed 2030 / GEBCO announcements.',
    },
    'your-turn': {
      title: 'Your turn',
      text: 'Search finds 5,412 named undersea features, cables and wrecks, and Explore holds 11 guided views. The address always describes what you see (story, layers, sea level, time, even this tour as #tour=12), so a link shares the exact view. About this map lists every source and licence, with DOIs for citing. Happy exploring!',
      source: 'IHO-IOC GEBCO Gazetteer (data/features.geojson); guided views (data/stories.json).',
    },
  },
};
