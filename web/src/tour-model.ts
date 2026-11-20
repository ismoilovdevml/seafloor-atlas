// Guided tour: shared types and pure helpers (no DOM; test/tour.test.ts). main.ts imports only this small
// module at load; the tour itself (tour.ts, its chapters, text and styles) is a separate chunk loaded when
// Tour is pressed or the page opens with #tour=N.
import type { TimeState } from './timeline';

/** What a chapter does with the bottom tools (one tool at a time, as in the tool bar). */
export type TourTool =
  | { kind: 'none' }
  | { kind: 'profile'; a?: [number, number]; b?: [number, number] }
  | { kind: 'sea'; level: number }
  | { kind: 'water'; v: 't' | 's' | 'd'; depth: number; column?: [number, number] }
  | { kind: 'time'; state: TimeState; play?: boolean };

export interface TourCamera { center: [number, number]; zoom: number; pitch: number; bearing: number }

/** A chapter's scene: language-independent (the words live in tour-text-*.ts, keyed by id). */
export interface TourScene {
  id: string;
  camera: TourCamera & { phoneZoom?: number };
  /** fixed vertical exaggeration (as the guided views use); omitted = automatic with zoom */
  exaggeration?: number;
  /** exactly these layer tokens are on (others off): veil, plates, new2026, disagree, uncertainty, seals,
   *  marine, and the #layers= tokens (quakes, seamounts, chl, winds, currents, cables, shipping, wrecks, ...) */
  layers: string[];
  tool: TourTool;
  /** element ids of the control the chapter talks about; the first one visible on screen is spotlit */
  spotlight: string[];
}

export interface TourChapterText { title: string; text: string; source: string }
export interface TourText {
  lang: string;
  ui: {
    region: string; start: string; exit: string; back: string; next: string; finish: string; pause: string; play: string;
    voiceOn: string; voiceOff: string; chapters: string; count: (n: number, total: number) => string;
    chapter: (n: number, title: string) => string; paused: string; sourcePrefix: string; keys: string;
  };
  chapters: Record<string, TourChapterText>;
}

/** Every layer token a chapter may name. */
export const TOUR_LAYER_TOKENS = [
  'veil', 'plates', 'new2026', 'disagree', 'uncertainty', 'seals', 'marine',
  'quakes', 'quakes-live', 'seamounts', 'chl', 'winds', 'currents', 'amoc',
  'cables', 'cables-osm', 'shipping', 'wrecks', 'wrecks-all', 'platforms', 'pipelines', 'wind',
];

export const READ_WPM = 200;
export const READ_MIN_MS = 6000;
/** Words in a text (whitespace-separated runs). */
export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
/** Time to read a text at `wpm` words per minute, never less than `minMs`. */
export function readingMs(text: string, wpm = READ_WPM, minMs = READ_MIN_MS): number {
  return Math.max(minMs, Math.round((wordCount(text) / wpm) * 60000));
}

/** Reads `tour=<n>` (1-based) from a hash; null when absent or not a positive integer. */
export function tourFromHash(hash: string): number | null {
  const m = /(?:^#|[#&])tour=(\d{1,3})(?:&|$)/.exec(hash);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}
/** Writes or removes the tour= part of a hash, keeping the other parts in order. */
export function hashWithTour(hash: string, n: number | null): string {
  const parts = hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith('tour='));
  if (n !== null) parts.push(`tour=${n}`);
  return parts.length ? `#${parts.join('&')}` : '';
}

/** Camera for the window: phones get the chapter's phone zoom, or 0.6 less (as the guided views do). */
export function cameraFor(c: TourScene['camera'], phone: boolean): TourCamera {
  return { center: c.center, zoom: phone ? c.phoneZoom ?? c.zoom - 0.6 : c.zoom, pitch: c.pitch, bearing: c.bearing };
}

/** Did the camera reach the target? Centre within a tenth of the view width at that zoom, zoom within `dz`. */
export function nearCamera(at: { lng: number; lat: number; zoom: number }, target: TourCamera, dz = 0.35): boolean {
  const span = 360 / 2 ** Math.max(0, target.zoom); // degrees across ~one 512 px tile at that zoom
  let dLng = Math.abs(at.lng - target.center[0]) % 360;
  if (dLng > 180) dLng = 360 - dLng;
  const dLat = Math.abs(at.lat - target.center[1]);
  return dLng * Math.cos((target.center[1] * Math.PI) / 180) <= 0.1 * span + 1e-6 && dLat <= 0.1 * span + 1e-6 && Math.abs(at.zoom - target.zoom) <= dz;
}
