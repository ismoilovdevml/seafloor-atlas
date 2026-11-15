// The guided tour's chapters: what each one shows (camera, layers, tool, spotlit control). The words are in
// tour-text-en.ts (one file per language, keyed by chapter id); the logic is in tour.ts.
// Cameras reuse the guided views in data/stories.json where a chapter visits the same place.
import type { TourScene } from './tour-model';

export const CHAPTERS: TourScene[] = [
  {
    id: 'globe',
    camera: { center: [-150, 8], zoom: 2.05, pitch: 0, bearing: 0, phoneZoom: 0.75 },
    layers: [], tool: { kind: 'none' },
    spotlight: ['depth-legend', 'legend'],
  },
  {
    id: 'measured', // guided view "mh370-search"
    camera: { center: [93, -36], zoom: 4.8, pitch: 40, bearing: 25 }, exaggeration: 12,
    layers: ['veil'], tool: { kind: 'none' },
    spotlight: ['layers-btn', 'lg-veil', 'legend'],
  },
  {
    id: 'detail', // guided view "monterey-canyon": zoom 7.2 loads the 15" tiles
    camera: { center: [-122.083, 36.667], zoom: 7.2, pitch: 55, bearing: 40 }, exaggeration: 4,
    layers: [], tool: { kind: 'none' },
    spotlight: ['settings-btn'],
  },
  {
    id: 'profile', // guided view "challenger-deep"; the profile line is the one QA checks
    camera: { center: [142.59167, 11.37333], zoom: 5.6, pitch: 62, bearing: -25 }, exaggeration: 9,
    layers: [], tool: { kind: 'profile', a: [142.392, 12.373], b: [142.792, 10.373] },
    spotlight: ['profile-btn', 'profile'],
  },
  {
    id: 'plates', // guided view "mid-atlantic-iceland"
    camera: { center: [-25, 63], zoom: 3.4, pitch: 55, bearing: 20 }, exaggeration: 30,
    layers: ['plates'], tool: { kind: 'none' },
    spotlight: ['lg-plates', 'legend'],
  },
  {
    id: 'sea-level',
    camera: { center: [-170, 63], zoom: 2.6, pitch: 0, bearing: 0, phoneZoom: 1.7 },
    layers: [], tool: { kind: 'sea', level: -120 },
    spotlight: ['sea-presets', 'sea-btn', 'sea'],
  },
  {
    id: 'water',
    camera: { center: [160, 0], zoom: 1.8, pitch: 0, bearing: 0, phoneZoom: 0.9 },
    layers: [], tool: { kind: 'water', v: 't', depth: 0, column: [150, 5] },
    spotlight: ['water-btn', 'water'],
  },
  {
    id: 'monsoon',
    camera: { center: [62, 14], zoom: 3, pitch: 0, bearing: 0, phoneZoom: 2.1 },
    layers: ['chl', 'winds'], tool: { kind: 'time', state: { mode: 'months', month: 7 } },
    spotlight: ['time-sets', 'time-btn', 'time'],
  },
  {
    id: 'quakes', // near the guided view "tonga-kermadec", pulled back to show more of the arc
    camera: { center: [-176, -22], zoom: 3.6, pitch: 45, bearing: 30 }, exaggeration: 20,
    layers: ['quakes', 'seamounts'], tool: { kind: 'none' },
    spotlight: ['lg-quakes', 'legend'],
  },
  {
    id: 'human',
    camera: { center: [-30, 45], zoom: 2.6, pitch: 0, bearing: 0, phoneZoom: 1.6 },
    layers: ['cables', 'shipping', 'wrecks'], tool: { kind: 'none' },
    spotlight: ['ovl-cables', 'legend'],
  },
  {
    id: 'mapping',
    camera: { center: [-40, 25], zoom: 2, pitch: 0, bearing: 0, phoneZoom: 0.9 },
    layers: [], tool: { kind: 'time', state: { mode: 'years', set: 'mapping', year: 2019, only: false }, play: true },
    spotlight: ['time-play', 'time'],
  },
  {
    id: 'your-turn',
    camera: { center: [-150, 8], zoom: 2.05, pitch: 0, bearing: 0, phoneZoom: 0.75 },
    layers: [], tool: { kind: 'none' },
    spotlight: ['search-input'],
  },
];
