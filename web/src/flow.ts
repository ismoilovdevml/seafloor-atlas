// Winds (NCEP/NCAR R1) and surface currents (OSCAR v2.0) as moving particles: decoding, bilinear sampling,
// particle advection in lon/lat, colour ramp and readout text. No DOM or WebGL here (test/flow.test.ts); the
// drawing is flow-layer.ts (a MapLibre custom layer, so the streaks follow the globe and mercator alike).
// Format: docs/data-contract.md, "Phytoplankton, winds and currents"; written by pipeline/flow.py.
import { MAX_MERC_LAT } from './geo';

export type FlowKind = 'wind' | 'currents';
export const FLOW_KINDS: FlowKind[] = ['wind', 'currents'];

export interface FlowGridDef { res_deg: number; width: number; height: number; lat0: number; lon0: number; scale: number; fill: number }
export interface FlowLayerInfo { bytes: number; cells: number; speed_max: number; speed_p99: number; speed_mean_area: number }
export interface FlowManifest {
  source: string; period: string; citation: string; licence: string; attribution: string;
  speed_range: [number, number];
  grid: FlowGridDef;
  months: string[];
  annual: string;
  layers: Record<string, FlowLayerInfo>;
  caveats?: string[];
}
export interface FlowField { g: FlowGridDef; u: Float32Array; v: Float32Array }

/** File key for a month: 1..12 -> '01'..'12', 0 -> 'annual'. */
export const flowKey = (month: number) => (month >= 1 && month <= 12 ? String(month).padStart(2, '0') : 'annual');

/**
 * u then v, each int16 stored as two byte planes (all low bytes, then all high bytes); q = -32768 is no data
 * (NaN), otherwise value = q * scale (m/s).
 */
export function decodeUV(bytes: Uint8Array, w: number, h: number, scale: number): [Float32Array, Float32Array] {
  const n = w * h;
  if (bytes.length !== 4 * n) throw new Error(`flow layer is ${bytes.length} bytes, expected ${4 * n}`);
  const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  for (let k = 0; k < 2; k++) {
    const lo = 2 * k * n, hi = lo + n, a = out[k];
    for (let i = 0; i < n; i++) {
      let q = bytes[lo + i] | (bytes[hi + i] << 8);
      if (q >= 32768) q -= 65536;
      a[i] = q === -32768 ? NaN : q * scale;
    }
  }
  return out;
}

/**
 * Bilinear u/v at lon/lat into `out`; grid points at lat0 - r*res, lon0 + c*res, longitudes wrap, rows clamp.
 * Returns false (out = NaN) when any of the four points has no data, so particles stop at coasts and ice edges.
 */
export function sampleUV(f: FlowField, lon: number, lat: number, out: Float32Array | number[]): boolean {
  const g = f.g, w = g.width, h = g.height;
  const x = (lon - g.lon0) / g.res_deg;
  let y = (g.lat0 - lat) / g.res_deg;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const xa = ((x0 % w) + w) % w, xb = (xa + 1) % w, yb = Math.min(y0 + 1, h - 1);
  const i00 = y0 * w + xa, i10 = y0 * w + xb, i01 = yb * w + xa, i11 = yb * w + xb;
  const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
  const u = f.u[i00] * a + f.u[i10] * b + f.u[i01] * c + f.u[i11] * d;
  const v = f.v[i00] * a + f.v[i10] * b + f.v[i01] * c + f.v[i11] * d;
  out[0] = u; out[1] = v;
  return u === u && v === v; // NaN check
}

// ---------- readout ----------
const POINTS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** Compass point (16) for a bearing in degrees clockwise from north. */
export function compass16(deg: number): string {
  return POINTS16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}
/** Bearing (deg clockwise from north) the vector points to. */
export function bearingTo(u: number, v: number): number {
  return ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
}
/** Readout text. Winds are named by where they come from (meteorology), currents by where they flow to (oceanography). */
export function formatFlow(kind: FlowKind, u: number, v: number): string {
  if (!(u === u && v === v)) return kind === 'currents' ? 'no data (land, ice or coast)' : 'no data';
  const s = Math.hypot(u, v);
  const dec = kind === 'currents' ? 2 : 1;
  if (s < (kind === 'currents' ? 0.005 : 0.05)) return `calm, ${s.toFixed(dec)} m/s`;
  const to = bearingTo(u, v);
  return kind === 'wind' ? `${s.toFixed(dec)} m/s from the ${compass16(to + 180)}` : `${s.toFixed(dec)} m/s towards the ${compass16(to)}`;
}

// ---------- colour ----------
/**
 * Speed ramp for the streaks, one family from dim steel blue (slow) to warm white (fast): lightness rises
 * monotonically with speed (OKLCH L 0.55 -> 0.97), so on the dark globe faster reads as brighter; the
 * slowest stop still has >= 3:1 on the violet abyss. Alpha rises with speed too (set in the shader).
 */
export const FLOW_RAMP = ['#4f7187', '#8fb3c6', '#dbe9ef', '#fff4d1'];
export function hexRgb(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Colour at t in 0..1 along FLOW_RAMP (linear in sRGB between the stops). */
export function rampAt(t: number, stops = FLOW_RAMP): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = hexRgb(stops[i]), b = hexRgb(stops[i + 1]);
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number];
}

// ---------- motion ----------
/**
 * Degrees moved per frame per (m/s) so that `smax` m/s moves `pxPerFrame` screen pixels at this zoom (MapLibre's
 * world is 512 * 2^zoom px wide): streaks keep their on-screen speed and length as you zoom.
 */
export function stepScale(zoom: number, smax: number, pxPerFrame = 1.5): number {
  const degPerPx = 360 / (512 * 2 ** zoom);
  return (pxPerFrame * degPerPx) / smax;
}
/** Particle count for a viewport (CSS px): constant density on screen, bounded for phones and big monitors. */
export function particleCount(cssW: number, cssH: number, perPx = 1 / 150): number {
  return Math.round(Math.max(1500, Math.min(9000, cssW * cssH * perPx)));
}

/** Web Mercator (0..1, y down) of lon/lat, latitude clamped to the mercator limit. */
export function mercX(lon: number): number { return (lon + 180) / 360; }
export function mercY(lat: number): number {
  const la = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat)) * (Math.PI / 180);
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + la / 2)) / (2 * Math.PI);
}

/** Where new particles may start: a lon/lat box list (each [w, s, e, n]) and an optional extra test. */
export interface SpawnArea { boxes: [number, number, number, number][]; weights: number[]; grid?: { deg: number; lat0: number; lon0: number; mask: Uint8Array } }
/**
 * Boxes weighted by their true area (cos lat), times an optional factor per box: on the globe the host passes
 * the foreshortening (cosine of the angle from the view centre), so particles are spread evenly on the screen
 * instead of piling up in a bright ring at the limb.
 */
export function spawnArea(boxes: [number, number, number, number][], factor?: number[], gridDeg?: number): SpawnArea {
  const weights: number[] = [];
  // boxes on a regular grid of `gridDeg` cells: a mask makes "is this point in the area?" O(1)
  let grid: SpawnArea['grid'];
  if (gridDeg) {
    // the grid's origin is the first box's corner, moved to just below -90 / -180
    const lat0 = boxes.length ? boxes[0][1] - Math.ceil((boxes[0][1] + 90) / gridDeg) * gridDeg : -90;
    const lon0 = boxes.length ? boxes[0][0] - Math.ceil((boxes[0][0] + 180) / gridDeg) * gridDeg : -180;
    const cols = Math.round(360 / gridDeg), mask = new Uint8Array(cols * (Math.ceil(180 / gridDeg) + 1));
    const cell = (lon: number, lat: number) => Math.floor((lat - lat0) / gridDeg + 1e-9) * cols + ((Math.floor((lon - lon0) / gridDeg + 1e-9) % cols) + cols) % cols;
    for (const [w, s] of boxes) mask[cell(w, s)] = 1;
    grid = { deg: gridDeg, lat0, lon0, mask };
  }
  let acc = 0;
  for (const [k, [w, s, e, n]] of boxes.entries()) {
    const area = (factor?.[k] ?? 1) * Math.max(0, e - w) * Math.max(0, Math.sin((n * Math.PI) / 180) - Math.sin((s * Math.PI) / 180));
    acc += area; weights.push(acc);
  }
  return grid ? { boxes, weights, grid } : { boxes, weights };
}
/** Whether lon/lat lies in the area (by the cell mask when there is one). */
export function inArea(a: SpawnArea, lon: number, lat: number): boolean {
  if (a.grid) {
    const { deg, lat0, lon0, mask } = a.grid, cols = Math.round(360 / deg);
    const r = Math.floor((lat - lat0) / deg + 1e-9), c = ((Math.floor((lon - lon0) / deg + 1e-9) % cols) + cols) % cols;
    return mask[r * cols + c] === 1;
  }
  return a.boxes.some(([w, s, e, n]) => lat >= s && lat <= n && ((lon >= w && lon <= e) || (lon + 360 >= w && lon + 360 <= e)));
}
/** A random point, uniform by area inside the spawn area (rand: () => [0, 1)). */
export function randomIn(a: SpawnArea, rand: () => number, out: [number, number]): [number, number] {
  const total = a.weights[a.weights.length - 1] ?? 0;
  if (!total) { out[0] = rand() * 360 - 180; out[1] = Math.asin(rand() * 2 - 1) * (180 / Math.PI); return out; }
  const r = rand() * total;
  let lo = 0, hi = a.weights.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a.weights[m] > r) hi = m; else lo = m + 1; }
  const [w, s, e, n] = a.boxes[lo];
  const s0 = Math.sin((s * Math.PI) / 180), s1 = Math.sin((n * Math.PI) / 180);
  out[0] = w + rand() * (e - w);
  out[1] = Math.asin(s0 + rand() * (s1 - s0)) * (180 / Math.PI);
  if (out[0] >= 180) out[0] -= 360; else if (out[0] < -180) out[0] += 360;
  return out;
}

export const POLAR_LIMIT = 84; // beyond this the mercator streaks would stretch; particles respawn

/**
 * The particle system, advected in lon/lat. `age` counts frames since birth (the drawing hides trail segments
 * older than the particle); `life` is each particle's lifetime in frames, staggered so respawns spread out.
 */
export class Particles {
  readonly lon: Float32Array;
  readonly lat: Float32Array;
  readonly speed: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  respawns = 0;
  private uv = new Float32Array(2);
  private pt: [number, number] = [0, 0];

  constructor(readonly n: number, private rand: () => number = Math.random, readonly maxLife = 90) {
    this.lon = new Float32Array(n); this.lat = new Float32Array(n); this.speed = new Float32Array(n);
    this.age = new Float32Array(n); this.life = new Float32Array(n);
  }

  /** Puts particle i somewhere in the area where the field has data (a few tries, else it dies next frame). */
  spawn(i: number, f: FlowField, area: SpawnArea, staggered = false) {
    this.respawns++;
    for (let t = 0; t < 12; t++) {
      randomIn(area, this.rand, this.pt);
      if (Math.abs(this.pt[1]) > POLAR_LIMIT) continue;
      if (sampleUV(f, this.pt[0], this.pt[1], this.uv)) {
        this.lon[i] = this.pt[0]; this.lat[i] = this.pt[1];
        this.speed[i] = Math.hypot(this.uv[0], this.uv[1]);
        this.age[i] = 0;
        this.life[i] = Math.round(this.maxLife * (0.55 + 0.45 * this.rand()));
        // at the first seeding, ages are spread over the lifetime so respawns do not come in waves
        if (staggered) this.age[i] = Math.floor(this.rand() * this.life[i]);
        return;
      }
    }
    this.lon[i] = this.pt[0]; this.lat[i] = this.pt[1]; this.speed[i] = 0; this.age[i] = 0; this.life[i] = 0;
  }

  /** After the camera moved: particles outside the new area start again inside it. Returns how many moved. */
  respawnOutside(f: FlowField, area: SpawnArea): number {
    let n = 0;
    for (let i = 0; i < this.n; i++) {
      if (!inArea(area, this.lon[i], this.lat[i])) { this.spawn(i, f, area); n++; }
    }
    return n;
  }

  seed(f: FlowField, area: SpawnArea) {
    for (let i = 0; i < this.n; i++) this.spawn(i, f, area, true);
    this.respawns = 0;
  }

  /**
   * One step: k = degrees per (m/s) per frame (stepScale), frames = elapsed frames at 60 Hz (fractional ok).
   * A particle that leaves the data, the polar band or its lifetime is respawned inside `area`; its age
   * restarts, so its old trail is not joined to the new position.
   */
  step(f: FlowField, area: SpawnArea, k: number, frames = 1) {
    const uv = this.uv, D2R = Math.PI / 180;
    for (let i = 0; i < this.n; i++) {
      const la = this.lat[i];
      if (++this.age[i] > this.life[i] || !sampleUV(f, this.lon[i], la, uv)) { this.spawn(i, f, area); continue; }
      const cl = Math.max(Math.cos(la * D2R), 0.08);
      let lo = this.lon[i] + (uv[0] * k * frames) / cl;
      const nla = la + uv[1] * k * frames;
      if (nla > POLAR_LIMIT || nla < -POLAR_LIMIT) { this.spawn(i, f, area); continue; }
      if (lo >= 180) lo -= 360; else if (lo < -180) lo += 360;
      this.lon[i] = lo; this.lat[i] = nla;
      this.speed[i] = Math.hypot(uv[0], uv[1]);
    }
  }
}
