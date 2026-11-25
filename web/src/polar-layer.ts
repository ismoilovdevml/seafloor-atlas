// The two polar caps with their real relief (MapLibre custom WebGL layer), and the polar grid the depth sampler reads.
//
// Web Mercator tiles end at ±85.05°; MapLibre fills the rest of each pole from the tiles' edge row, which
// pipeline/tiles.py fades (from 84.8°) into one mean value (a flat disc ~560 km across). pipeline/polar.py writes the
// GEBCO elevation poleward of 83° on an azimuthal-equidistant grid (tiles/polar/north.webp, south.webp, Terrarium RGB,
// whole metres). loadPolarGrid() decodes one pole into an Int16Array once; this layer and sampler.ts share it.
//
// The layer drapes each grid on a radial disc mesh (rings around the pole, clean circular edge at exactly 83°):
// vertices are placed with MapLibre's own projectTileWithElevation (its globe formula is valid beyond 85°, the
// Mercator y simply goes below 0 or above 1) and lifted by the terrain exaggeration; the fragment shader colours the
// elevation with the map's own ramp, evaluated exactly from the ramp stops (no lookup-table quantisation, so a +1 m ice
// shelf or a +10 m sea-level step stays sharp), and adds a hillshade lit like MapLibre's (azimuth in each point's own
// north-up frame, plus the map bearing for the default viewport anchor). Where the disc starts depends on the layers
// under it (the layer sits right above the hillshade):
// * plain relief: it fades in between 83.05° and 83.3°, so it also hides the band (~83-85°) where Mercator tiles
//   stretch 15" rows into visible terraces in the hillshade; the tiles carry the same relief there, so no seam;
// * while a layer between 'relief' and 'hillshade' is visible (ocean water, phytoplankton, marine life) it fades in
//   only between 84.7° and 84.85°, so those layers stay visible up to ~84.7°. The tiles are real data up to 84.8°
//   (pipeline/tiles.py BLEND_FROM; their fade into the cap mean runs 84.8-84.92°, and at most 0.8 % of that mean shows
//   through this fade). The terraces equatorward of 84.7° show then (zoom >= ~4), under the overlay.
//
// GPU hygiene: nothing touches GL outside onAdd/render/onRemove. MapLibre resets its tracked state before render and
// marks it dirty afterwards; the one setting it does not track that we change (UNPACK_ALIGNMENT, tracked, but we restore
// it anyway) is put back. Each disc has its own vertex array object, so MapLibre's buffers are never touched.
// Lazy: the ~3 MB of WebP is fetched and the textures (2 x 8 MB, R16I) created only once the view reaches |lat| >= 60°;
// a disc is drawn only while the view reaches |lat| >= 75° on its side. After a WebGL context loss MapLibre drops custom
// layers; this layer re-adds itself (same position) once the restored style has loaded, and rebuilds its GPU state.
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';

export interface PolarMeta { size: number; radius_deg: number }
/** Ground width of one polar-grid pixel (km): 2 * radius_deg degrees of latitude over `size` pixels (0.76 km for 2048 px, 7 deg). */
export function polarPixelKm(m: PolarMeta): number {
  return (2 * m.radius_deg * Math.PI * 6371.0088) / 180 / m.size;
}
/** Plain relief: the disc starts (alpha 0, mesh edge) at FADE_FROM and is opaque from FADE_TO; see the header. */
export const FADE_FROM = 83.05;
export const FADE_TO = 83.3;
/** The fade while a layer under the hillshade (ocean water, phytoplankton, marine life) is visible. */
export const OVERLAY_FADE_FROM = 84.7;
export const OVERLAY_FADE_TO = 84.85;
/** Most ramp stops the shader evaluates (seaLevelStops / iceLand produce ~21). */
export const MAX_STOPS = 64;
/** Radial spacing of the mesh rings and target arc spacing along them (degrees; the old square grid had 14/160). */
export const RING_STEP = 0.0875;
/** Fetch + upload a pole once the view reaches this |latitude|; draw it while the view reaches DRAW_FROM_LAT. */
export const LOAD_FROM_LAT = 60;
export const DRAW_FROM_LAT = 75;
const LIGHT_ALTITUDE_DEG = 40;

/** Unclamped Web Mercator y (0 at 85.05° N, 1 at 85.05° S; beyond them below 0 / above 1). */
export function mercYUnclamped(lat: number): number {
  const la = Math.max(-89.9999, Math.min(89.9999, lat)) * (Math.PI / 180);
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + la / 2)) / (2 * Math.PI);
}

/** Grid-plane (X, Y in degrees from the pole) -> lat, lon; the inverse of pipeline/polar.py polar_xy. */
export function gridToLatLon(X: number, Y: number, north: boolean): [number, number] {
  const d = Math.hypot(X, Y);
  const lon = (Math.atan2(X, north ? -Y : Y) * 180) / Math.PI;
  return [north ? 90 - d : -90 + d, lon];
}

/** lat, lon -> grid-plane (X, Y) in degrees from the pole (pipeline/polar.py polar_xy). */
export function latLonToGrid(lat: number, lon: number, north: boolean): [number, number] {
  const d = north ? 90 - lat : lat + 90;
  const a = (lon * Math.PI) / 180;
  return [d * Math.sin(a), north ? -d * Math.cos(a) : d * Math.cos(a)];
}

export interface DiscMesh { vertices: Float32Array; indices: Uint16Array; rings: number[] }

/**
 * Radial disc mesh over a grid of half-width `gridRadius` (u, v address that grid), out to `radius` degrees from the
 * pole. Vertex = [mercX, mercY, u, v, |lat|] (20 bytes); ring k lies at about k * step degrees from the pole, the
 * last ring exactly at `radius` (so the edge is a circle at 90 - radius degrees, alpha 0 all round). Each ring has a
 * power-of-two number of sectors keeping the arc spacing <= step (at most a doubling from one ring to the next), plus
 * one duplicated vertex at lon +180 so no triangle spans the antimeridian in Mercator space. The pole itself is one
 * vertex (a fan).
 */
export function discMesh(north: boolean, gridRadius: number, radius = 90 - FADE_FROM, step = RING_STEP): DiscMesh {
  if (radius > gridRadius) throw new Error('polar mesh: radius beyond the grid');
  const K = Math.max(1, Math.round(radius / step));
  const v: number[] = [];
  const ringStart: number[] = [], ringSectors: number[] = [];
  const push = (X: number, Y: number, lon: number, lat: number) => {
    v.push((lon + 180) / 360, mercYUnclamped(lat), (X + gridRadius) / (2 * gridRadius), (gridRadius - Y) / (2 * gridRadius), Math.abs(lat));
  };
  // ring 0: the pole
  ringStart.push(0); ringSectors.push(0);
  push(0, 0, 0, north ? 90 : -90);
  for (let k = 1; k <= K; k++) {
    const d = (radius * k) / K;
    let M = 8;
    while ((2 * Math.PI * d) / M > step && M < 4096) M *= 2;
    ringStart.push(v.length / 5); ringSectors.push(M);
    for (let s = 0; s <= M; s++) {
      const lon = -180 + (360 * s) / M;
      const [X, Y] = latLonToGrid(north ? 90 - d : -90 + d, lon, north);
      push(X, Y, lon, north ? 90 - d : -90 + d);
    }
  }
  const idx: number[] = [];
  // pole fan
  for (let s = 0; s < ringSectors[1]; s++) idx.push(0, ringStart[1] + s, ringStart[1] + s + 1);
  for (let k = 1; k < K; k++) {
    const a = ringStart[k], b = ringStart[k + 1], Ma = ringSectors[k], Mb = ringSectors[k + 1];
    if (Mb === Ma) {
      for (let s = 0; s < Ma; s++) idx.push(a + s, b + s, b + s + 1, a + s, b + s + 1, a + s + 1);
    } else {
      // Mb = 2 Ma: each inner sector meets two outer ones
      for (let s = 0; s < Ma; s++) {
        idx.push(a + s, b + 2 * s, b + 2 * s + 1, a + s, b + 2 * s + 1, a + s + 1, a + s + 1, b + 2 * s + 1, b + 2 * s + 2);
      }
    }
  }
  if (v.length / 5 > 65536) throw new Error('polar mesh: too many vertices for 16-bit indices');
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx), rings: ringSectors };
}

// ---------- colour ramp ----------

/** Ramp stops packed for the shader: (elevation, r, g, b) per stop, colours 0..1, at most MAX_STOPS. */
export function packStops(stops: [number, string][]): { data: Float32Array; n: number } {
  if (stops.length > MAX_STOPS) throw new Error(`polar layer: ${stops.length} ramp stops, at most ${MAX_STOPS}`);
  const data = new Float32Array(MAX_STOPS * 4);
  stops.forEach(([h, c], i) => {
    data.set([h, parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255], i * 4);
  });
  return { data, n: stops.length };
}

/**
 * The fragment shader's ramp() in JavaScript (same branches, same order), for tests: linear RGB between the stops
 * around h, clamped at both ends; identical to palette.rampColorAt.
 */
export function rampRgb(p: { data: Float32Array; n: number }, h: number): [number, number, number] {
  const at = (i: number): [number, number, number] => [p.data[i * 4 + 1], p.data[i * 4 + 2], p.data[i * 4 + 3]];
  if (h <= p.data[0]) return at(0);
  for (let i = 1; i < p.n; i++) {
    const h1 = p.data[i * 4];
    if (h <= h1) {
      const h0 = p.data[(i - 1) * 4], t = (h - h0) / (h1 - h0), a = at(i - 1), b = at(i);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return at(p.n - 1);
}

// ---------- the polar grid (shared with sampler.ts) ----------

export interface PolarGrid { north: boolean; size: number; radius: number; h: Int16Array }

const metaCache = new Map<string, Promise<PolarMeta | null>>();
const gridCache = new Map<string, Promise<PolarGrid | null>>();

/** polar.json of a polar folder (`base` ends with a slash), fetched once; PolarLayer seeds it with the copy it has. */
export function polarMeta(base: string): Promise<PolarMeta | null> {
  let p = metaCache.get(base);
  if (!p) {
    p = fetch(`${base}polar.json`).then((r) => (r.ok ? r.json() as Promise<PolarMeta> : null)).catch(() => null);
    metaCache.set(base, p);
    p.then((m) => { if (!m) metaCache.delete(base); });
  }
  return p;
}

/** Terrarium RGBA (alpha ignored) -> whole metres. polar.py writes whole metres, so the B channel is 0 and this is exact. */
export function decodePolarRgba(px: ArrayLike<number>, count: number): Int16Array {
  const h = new Int16Array(count);
  for (let i = 0; i < count; i++) h[i] = Math.round(px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768);
  return h;
}

/** One pole's grid (`base` = polar folder URL ending with a slash), fetched and decoded once; null if unavailable. */
export function loadPolarGrid(base: string, north: boolean): Promise<PolarGrid | null> {
  const key = `${base}${north ? 'north' : 'south'}`;
  let p = gridCache.get(key);
  if (p) return p;
  p = (async () => {
    const meta = await polarMeta(base);
    if (!meta) return null;
    const r = await fetch(`${base}${north ? 'north' : 'south'}.webp`);
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    try {
      const n = bmp.width;
      if (bmp.height !== n || n !== meta.size) return null;
      const ctx = new OffscreenCanvas(n, n).getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      // alpha is 255 everywhere, so the canvas' premultiplied storage leaves RGB exact (see sampler.ts)
      const px = ctx.getImageData(0, 0, n, n, { colorSpace: 'srgb' }).data;
      return { north, size: n, radius: meta.radius_deg, h: decodePolarRgba(px, n * n) };
    } finally {
      bmp.close();
    }
  })().catch(() => null);
  gridCache.set(key, p);
  p.then((g) => { if (!g && gridCache.get(key) === p) gridCache.delete(key); });
  return p;
}

/** Elevation (m) at lat/lon from a polar grid, bilinear between pixel centres (as the shader); NaN outside the disc. */
export function polarDepth(g: PolarGrid, lat: number, lon: number): number {
  if ((lat > 0) !== g.north) return NaN;
  const [X, Y] = latLonToGrid(lat, lon, g.north);
  if (Math.hypot(X, Y) > g.radius) return NaN;
  const n = g.size;
  const fx = ((X + g.radius) / (2 * g.radius)) * n - 0.5, fy = ((g.radius - Y) / (2 * g.radius)) * n - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const at = (x: number, y: number) => g.h[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))];
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/**
 * Fade band for a layer order and visibility: the narrow one while any layer between 'relief' and 'hillshade' (where
 * the ocean-water, phytoplankton and marine-life rasters are inserted) is visible, else the wide one.
 */
export function fadeBand(order: string[], visible: (id: string) => boolean): [number, number] {
  const a = order.indexOf('relief'), b = order.indexOf('hillshade');
  if (a >= 0 && b > a) for (let i = a + 1; i < b; i++) if (visible(order[i])) return [OVERLAY_FADE_FROM, OVERLAY_FADE_TO];
  return [FADE_FROM, FADE_TO];
}

/** Which caps to load / draw for a view whose bounds reach latitudes north and south (map.getBounds()). */
export function capsInView(north: number, south: number): { load: [boolean, boolean]; draw: [boolean, boolean] } {
  return { load: [north >= LOAD_FROM_LAT, south <= -LOAD_FROM_LAT], draw: [north >= DRAW_FROM_LAT, south <= -DRAW_FROM_LAT] };
}

/** Light direction (sin, cos of the azimuth clockwise from north) like MapLibre's hillshade: + bearing if anchored to the viewport. */
export function lightAzimuth(directionDeg: number, bearingDeg: number, anchor: 'map' | 'viewport'): [number, number] {
  const a = ((directionDeg + (anchor === 'viewport' ? bearingDeg : 0)) * Math.PI) / 180;
  return [Math.sin(a), Math.cos(a)];
}

/**
 * Horizontal light vector in the grid plane at grid point (X, Y): the fragment shader's formula in JavaScript.
 * North = towards the north pole (towards the centre of the north disc, away from it on the south disc); east = north
 * turned clockwise.
 */
export function gridLight(X: number, Y: number, north: boolean, sc: [number, number]): [number, number] {
  const d = Math.hypot(X, Y);
  const N: [number, number] = d > 1e-9 ? (north ? [-X / d, -Y / d] : [X / d, Y / d]) : [0, 1];
  const E: [number, number] = [N[1], -N[0]];
  return [sc[0] * E[0] + sc[1] * N[0], sc[0] * E[1] + sc[1] * N[1]];
}

// ---------- shaders ----------

const ATTR = { a_merc: 0, a_uv: 1, a_lat: 2 } as const;

const VERT = (prelude: string, define: string) => `#version 300 es
${prelude}
${define}
in vec2 a_merc;
in vec2 a_uv;
in float a_lat;
uniform highp isampler2D u_dem;
uniform float u_size;
uniform float u_exag;
out vec2 v_uv;
out float v_lat;
float demAt(vec2 uv) {
  // nearest texel (the old RGBA path sampled with NEAREST filtering, clamped to the edge)
  ivec2 p = clamp(ivec2(floor(uv * u_size)), ivec2(0), ivec2(int(u_size) - 1));
  return float(texelFetch(u_dem, p, 0).r);
}
void main() {
  v_uv = a_uv;
  v_lat = a_lat;
  gl_Position = projectTileWithElevation(a_merc, demAt(a_uv) * u_exag);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
#define MAX_STOPS ${MAX_STOPS}
uniform highp isampler2D u_dem;
uniform vec4 u_stops[MAX_STOPS];
uniform int u_nstops;
uniform float u_size;
uniform float u_radius;
uniform float u_north;
uniform vec2 u_light;
uniform float u_px_m;
uniform float u_shade;
uniform float u_opacity;
uniform vec2 u_fade;
in vec2 v_uv;
in float v_lat;
out vec4 fragColor;
float h(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(int(u_size) - 1));
  return float(texelFetch(u_dem, p, 0).r);
}
// bilinear elevation at texel coordinate q (integer textures cannot be filtered by the GPU)
float hb(vec2 q) {
  ivec2 p = ivec2(floor(q));
  vec2 f = fract(q);
  return mix(mix(h(p), h(p + ivec2(1, 0)), f.x), mix(h(p + ivec2(0, 1)), h(p + ivec2(1, 1)), f.x), f.y);
}
// the map's colour ramp: linear RGB between the stops around e, clamped at both ends (as MapLibre's color-relief)
vec3 ramp(float e) {
  if (e <= u_stops[0].x) return u_stops[0].yzw;
  for (int i = 1; i < MAX_STOPS; i++) {
    if (i >= u_nstops) break;
    vec4 s1 = u_stops[i];
    if (e <= s1.x) {
      vec4 s0 = u_stops[i - 1];
      return mix(s0.yzw, s1.yzw, (e - s0.x) / (s1.x - s0.x));
    }
  }
  return u_stops[u_nstops - 1].yzw;
}
void main() {
  vec2 q = v_uv * u_size - 0.5;
  float e = hb(q);
  vec3 col = ramp(e);
  // hillshade: light at ${LIGHT_ALTITUDE_DEG} degrees from the hillshade layer's azimuth, taken in this point's own
  // north-up frame like MapLibre's tiles (a fixed grid direction lit the far side of the pole from the wrong side)
  vec2 P = vec2(v_uv.x * 2.0 - 1.0, 1.0 - v_uv.y * 2.0) * u_radius;
  float d = length(P);
  vec2 N = d > 1e-6 ? (u_north > 0.5 ? -P / d : P / d) : vec2(0.0, 1.0);
  vec2 E = vec2(N.y, -N.x);
  vec3 L = vec3((u_light.x * E + u_light.y * N) * ${Math.cos((LIGHT_ALTITUDE_DEG * Math.PI) / 180).toFixed(4)}, ${Math.sin((LIGHT_ALTITUDE_DEG * Math.PI) / 180).toFixed(4)});
  // slopes over 1.5 texels each side from bilinear samples: the grid holds whole metres, and one-texel differences
  // turned the 1 m steps of gentle slopes into visible terraces
  float dx = (hb(q + vec2(1.5, 0.0)) - hb(q - vec2(1.5, 0.0))) / (3.0 * u_px_m);
  float dy = (hb(q + vec2(0.0, 1.5)) - hb(q - vec2(0.0, 1.5))) / (3.0 * u_px_m);
  vec3 n = normalize(vec3(-dx * u_shade, dy * u_shade, 1.0));
  float s = dot(n, L) - L.z;
  // the map's multidirectional hillshade also lifts flat ground by ~4.5 % towards its highlight colour (measured on
  // screenshots: Antarctic plateau 86,86,78 under the ramp, 92,93,86 on the map)
  col = mix(col, vec3(0.863, 0.922, 1.0), 0.045);
  col = s < 0.0 ? mix(col, vec3(0.012, 0.024, 0.063), min(1.0, -s * 0.55 * 4.0)) : mix(col, vec3(0.863, 0.922, 1.0), min(1.0, s * 0.20 * 4.0));
  float a = smoothstep(u_fade.x, u_fade.y, v_lat) * u_opacity;
  fragColor = vec4(col * a, a);
}`;

interface DiscGpu { tex: WebGLTexture; vao: WebGLVertexArrayObject; vbo: WebGLBuffer; ibo: WebGLBuffer; count: number; north: boolean }
type Prog = { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> };

export class PolarLayer implements CustomLayerInterface {
  readonly id = 'polar-caps';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  opacity = 1;
  private map: MlMap | null = null;
  /** index 0 = north, 1 = south */
  private grids: (PolarGrid | null | undefined)[] = [undefined, undefined];
  private requested = [false, false];
  private gpu: (DiscGpu | null)[] = [null, null];
  private stops: { data: Float32Array; n: number };
  private progs = new Map<string, Prog>();
  private pxM: number;
  private matMain = new Float32Array(16);
  private matFallback = new Float32Array(16);
  // WebGL context loss: MapLibre removes custom layers; we re-add ourselves at the same place once it is restored
  private host: MlMap | null = null;
  private after: string[] = [];
  private lostWhileAdded = false;

  constructor(private base: string, private meta: PolarMeta, stops: [number, string][]) {
    this.stops = packStops(stops);
    this.pxM = ((2 * meta.radius_deg) / meta.size) * 111195;
    if (!metaCache.has(base)) metaCache.set(base, Promise.resolve(meta));
  }

  /** New colour ramp (sea level changed, ocean-water underlay on or off). */
  setStops(stops: [number, string][]) { this.stops = packStops(stops); this.map?.triggerRepaint(); }

  onAdd(map: MlMap) {
    this.map = map;
    // a (re-)add may come with a new context: every GPU handle from before is void
    this.gpu = [null, null];
    this.progs.clear();
    this.lostWhileAdded = false;
    if (this.host !== map) {
      this.host?.off('webglcontextrestored', this.onRestored);
      this.host = map;
      map.on('webglcontextrestored', this.onRestored);
    }
  }

  onRemove(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    const g = gl as WebGL2RenderingContext;
    if (g.isContextLost()) {
      // MapLibre is tearing the style down after a context loss (style.destroy, the order still readable): remember
      // where we were; the handles died with the context
      const order = map.getLayersOrder();
      this.after = order.slice(order.indexOf(this.id) + 1);
      this.lostWhileAdded = true;
    } else {
      for (const d of this.gpu) if (d) { g.deleteTexture(d.tex); g.deleteBuffer(d.vbo); g.deleteBuffer(d.ibo); g.deleteVertexArray(d.vao); }
      for (const p of this.progs.values()) g.deleteProgram(p.prog);
      this.host?.off('webglcontextrestored', this.onRestored);
      this.host = null;
    }
    this.gpu = [null, null]; this.progs.clear(); this.map = null;
  }

  private onRestored = () => {
    const map = this.host;
    if (!map || !this.lostWhileAdded) return;
    const add = () => {
      if (!this.lostWhileAdded || map.getLayer(this.id)) return;
      map.addLayer(this, this.after.find((id) => map.getLayer(id)));
    };
    if (map.isStyleLoaded()) add(); else map.once('style.load', add);
  };

  private program(g: WebGL2RenderingContext, args: CustomRenderMethodInput): Prog {
    const key = args.shaderData.variantName;
    let p = this.progs.get(key);
    if (p) return p;
    const sh = (type: number, src: string) => {
      const s = g.createShader(type)!;
      g.shaderSource(s, src); g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(`polar shader: ${g.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = g.createProgram()!;
    const vs = sh(g.VERTEX_SHADER, VERT(args.shaderData.vertexShaderPrelude, args.shaderData.define));
    const fs = sh(g.FRAGMENT_SHADER, FRAG);
    g.attachShader(prog, vs); g.attachShader(prog, fs);
    // fixed attribute slots: one vertex array object per disc serves every projection variant of the program
    for (const [name, loc] of Object.entries(ATTR)) g.bindAttribLocation(prog, loc, name);
    g.linkProgram(prog);
    g.deleteShader(vs); g.deleteShader(fs);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) { const log = g.getProgramInfoLog(prog); g.deleteProgram(prog); throw new Error(`polar program: ${log}`); }
    const names = ['u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition',
      'u_projection_fallback_matrix', 'u_dem', 'u_stops', 'u_nstops', 'u_exag', 'u_size', 'u_radius', 'u_north', 'u_light', 'u_px_m', 'u_shade', 'u_opacity', 'u_fade'];
    p = { prog, loc: Object.fromEntries(names.map((x) => [x, g.getUniformLocation(prog, x)])) };
    this.progs.set(key, p);
    return p;
  }

  /** Texture + mesh of one pole (inside render: MapLibre restores its own state afterwards). */
  private upload(g: WebGL2RenderingContext, grid: PolarGrid): DiscGpu {
    const tex = g.createTexture()!;
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, tex);
    const align = g.getParameter(g.UNPACK_ALIGNMENT) as number;
    g.pixelStorei(g.UNPACK_ALIGNMENT, 2);
    // an ArrayBufferView source: UNPACK_COLORSPACE_CONVERSION does not apply, and MapLibre has just reset
    // UNPACK_PREMULTIPLY_ALPHA / UNPACK_FLIP_Y to false for us
    g.texImage2D(g.TEXTURE_2D, 0, g.R16I, grid.size, grid.size, 0, g.RED_INTEGER, g.SHORT, grid.h);
    g.pixelStorei(g.UNPACK_ALIGNMENT, align);
    for (const [k, v] of [[g.TEXTURE_MIN_FILTER, g.NEAREST], [g.TEXTURE_MAG_FILTER, g.NEAREST], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE]]) g.texParameteri(g.TEXTURE_2D, k, v);
    const mesh = discMesh(grid.north, grid.radius);
    const vao = g.createVertexArray()!;
    g.bindVertexArray(vao);
    const vbo = g.createBuffer()!, ibo = g.createBuffer()!;
    g.bindBuffer(g.ARRAY_BUFFER, vbo);
    g.bufferData(g.ARRAY_BUFFER, mesh.vertices, g.STATIC_DRAW);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ibo);
    g.bufferData(g.ELEMENT_ARRAY_BUFFER, mesh.indices, g.STATIC_DRAW);
    g.enableVertexAttribArray(ATTR.a_merc); g.vertexAttribPointer(ATTR.a_merc, 2, g.FLOAT, false, 20, 0);
    g.enableVertexAttribArray(ATTR.a_uv); g.vertexAttribPointer(ATTR.a_uv, 2, g.FLOAT, false, 20, 8);
    g.enableVertexAttribArray(ATTR.a_lat); g.vertexAttribPointer(ATTR.a_lat, 1, g.FLOAT, false, 20, 16);
    g.bindVertexArray(null);
    return { tex, vao, vbo, ibo, count: mesh.indices.length, north: grid.north };
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const g = gl as WebGL2RenderingContext;
    const map = this.map;
    if (!map || this.opacity <= 0 || g.isContextLost()) return;
    const b = map.getBounds();
    const view = capsInView(b.getNorth(), b.getSouth());
    const draw: DiscGpu[] = [];
    for (const i of [0, 1]) {
      if (!view.load[i]) continue;
      if (!this.requested[i]) {
        this.requested[i] = true;
        void loadPolarGrid(this.base, i === 0).then((grid) => { this.grids[i] = grid; if (grid) this.map?.triggerRepaint(); });
      }
      const grid = this.grids[i];
      if (!grid) continue;
      this.gpu[i] ??= this.upload(g, grid);
      if (view.draw[i]) draw.push(this.gpu[i]!);
    }
    if (!draw.length) return;
    const P = this.program(g, args), L = P.loc, pd = args.defaultProjectionData;
    g.useProgram(P.prog);
    this.matMain.set(pd.mainMatrix);
    g.uniformMatrix4fv(L.u_projection_matrix, false, this.matMain);
    if (L.u_projection_tile_mercator_coords) g.uniform4f(L.u_projection_tile_mercator_coords, ...pd.tileMercatorCoords);
    if (L.u_projection_clipping_plane) g.uniform4f(L.u_projection_clipping_plane, ...pd.clippingPlane);
    if (L.u_projection_transition) g.uniform1f(L.u_projection_transition, pd.projectionTransition);
    if (L.u_projection_fallback_matrix) { this.matFallback.set(pd.fallbackMatrix); g.uniformMatrix4fv(L.u_projection_fallback_matrix, false, this.matFallback); }
    g.uniform1f(L.u_exag, map.getTerrain()?.exaggeration ?? 0);
    g.uniform1f(L.u_size, this.meta.size);
    g.uniform1f(L.u_radius, this.meta.radius_deg);
    g.uniform1f(L.u_px_m, this.pxM);
    g.uniform4fv(L.u_stops, this.stops.data);
    g.uniform1i(L.u_nstops, this.stops.n);
    g.uniform2fv(L.u_light, this.light(map));
    // the map's hillshade strengthens towards low zoom; a fixed vertical gain keeps the sea floor legible at all zooms
    g.uniform1f(L.u_shade, 6.0);
    g.uniform1f(L.u_opacity, this.opacity);
    g.uniform2fv(L.u_fade, fadeBand(map.getLayersOrder(), (id) => map.getLayoutProperty(id, 'visibility') !== 'none'));
    g.disable(g.DEPTH_TEST);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.activeTexture(g.TEXTURE0);
    g.uniform1i(L.u_dem, 0);
    for (const d of draw) {
      g.bindTexture(g.TEXTURE_2D, d.tex);
      g.uniform1f(L.u_north, d.north ? 1 : 0);
      g.bindVertexArray(d.vao);
      g.drawElements(g.TRIANGLES, d.count, g.UNSIGNED_SHORT, 0);
    }
    // leave no vertex array of ours bound: MapLibre's next buffer bindings must not land in it; and no integer texture
    // on unit 0 for a float sampler of MapLibre's to meet if one of its own binds fails (seen after a context restore)
    g.bindVertexArray(null);
    g.bindTexture(g.TEXTURE_2D, null);
  }

  /** The hillshade layer's light (direction, anchor) as (sin, cos) of the azimuth from north. */
  private light(map: MlMap): [number, number] {
    let dir = 315;
    let anchor: 'map' | 'viewport' = 'viewport';
    if (map.getLayer('hillshade')) {
      const d = map.getPaintProperty('hillshade', 'hillshade-illumination-direction') as number | number[] | undefined;
      const v = Array.isArray(d) ? d[0] : d;
      if (typeof v === 'number') dir = v;
      if (map.getPaintProperty('hillshade', 'hillshade-illumination-anchor') === 'map') anchor = 'map';
    }
    return lightAzimuth(dir, map.getBearing(), anchor);
  }
}
