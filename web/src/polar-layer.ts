// The two polar caps with their real relief (MapLibre custom WebGL layer).
//
// Web Mercator tiles end at ±85.05°; MapLibre fills the rest of each pole from the tiles' edge row, which
// pipeline/tiles.py flattens into one mean value (a flat disc ~560 km across). pipeline/polar.py writes the GEBCO
// elevation poleward of 83° on an azimuthal-equidistant grid (tiles/polar/north.webp, south.webp, Terrarium RGB).
// This layer drapes each grid on a disc mesh: vertices are placed with MapLibre's own projectTileWithElevation (its
// globe formula is valid beyond 85°, the Mercator y simply goes below 0 or above 1) and lifted by the terrain
// exaggeration; the fragment shader colours the elevation with the map's own ramp (a lookup texture rebuilt when the
// sea level or the ocean-water underlay changes) and adds a hillshade like the map's (light from the north-west).
// The disc fades in between 83.05° and 83.3°, where the tiles still carry the same relief, so there is no seam.
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';

export interface PolarMeta { size: number; radius_deg: number }
export const FADE_FROM = 83.05;
export const FADE_TO = 83.3;
export const LUT_MIN = -11000;
export const LUT_MAX = 7000;
const LUT_N = 1024;
const MESH = 161; // vertices per side (odd: no vertex falls exactly on the pole)

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

/** Disc mesh: per vertex [mercX, mercY, u, v, |lat|], triangles whose three corners lie inside the disc. */
export function discMesh(north: boolean, radius: number, n = MESH): Float32Array {
  const step = (2 * radius) / (n - 1);
  const vert = (i: number, j: number) => {
    const X = -radius + j * step, Y = radius - i * step;
    const [lat, lon] = gridToLatLon(X, Y, north);
    return { inside: Math.hypot(X, Y) <= radius + 1e-9, v: [(lon + 180) / 360, mercYUnclamped(lat), j / (n - 1), i / (n - 1), Math.abs(lat)] };
  };
  const out: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = vert(i, j), b = vert(i, j + 1), c = vert(i + 1, j), d = vert(i + 1, j + 1);
      for (const t of [[a, b, c], [b, d, c]]) if (t.every((p) => p.inside)) for (const p of t) out.push(...p.v);
    }
  }
  return new Float32Array(out);
}

/** RGBA lookup over [LUT_MIN, LUT_MAX] metres from ramp stops (the same interpolation as the map's color-relief). */
export function rampLut(stops: [number, string][], n = LUT_N): Uint8Array {
  const rgb = stops.map(([h, c]) => [h, parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
  const out = new Uint8Array(n * 4);
  for (let k = 0; k < n; k++) {
    const h = LUT_MIN + ((LUT_MAX - LUT_MIN) * k) / (n - 1);
    let i = 1;
    while (i < rgb.length - 1 && rgb[i][0] < h) i++;
    const [h0, ...c0] = rgb[i - 1], [h1, ...c1] = rgb[i];
    const t = h <= h0 ? 0 : h >= h1 ? 1 : (h - h0) / (h1 - h0);
    for (let ch = 0; ch < 3; ch++) out[k * 4 + ch] = Math.round(c0[ch] + (c1[ch] - c0[ch]) * t);
    out[k * 4 + 3] = 255;
  }
  return out;
}

const VERT = (prelude: string, define: string) => `#version 300 es
${prelude}
${define}
in vec2 a_merc;
in vec2 a_uv;
in float a_lat;
uniform highp sampler2D u_dem;
uniform float u_exag;
out vec2 v_uv;
out float v_alpha;
float demAt(vec2 uv) {
  vec3 c = textureLod(u_dem, uv, 0.0).rgb * 255.0;
  return c.r * 256.0 + c.g + c.b / 256.0 - 32768.0;
}
void main() {
  v_uv = a_uv;
  v_alpha = smoothstep(${FADE_FROM.toFixed(2)}, ${FADE_TO.toFixed(2)}, a_lat);
  gl_Position = projectTileWithElevation(a_merc, demAt(a_uv) * u_exag);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform highp sampler2D u_dem;
uniform sampler2D u_lut;
uniform float u_size;
uniform float u_px_m;
uniform float u_shade;
uniform float u_opacity;
in vec2 v_uv;
in float v_alpha;
out vec4 fragColor;
float h(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(int(u_size) - 1));
  vec3 c = texelFetch(u_dem, p, 0).rgb * 255.0;
  return c.r * 256.0 + c.g + c.b / 256.0 - 32768.0;
}
// bilinear elevation at texel coordinate q (the packed bytes must not be filtered by the GPU)
float hb(vec2 q) {
  ivec2 p = ivec2(floor(q));
  vec2 f = fract(q);
  return mix(mix(h(p), h(p + ivec2(1, 0)), f.x), mix(h(p + ivec2(0, 1)), h(p + ivec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 q = v_uv * u_size - 0.5;
  float e = hb(q);
  vec3 col = texture(u_lut, vec2(clamp((e - ${LUT_MIN.toFixed(1)}) / ${(LUT_MAX - LUT_MIN).toFixed(1)}, 0.0, 1.0), 0.5)).rgb;
  // hillshade: light from the north-west of the grid at 40 degrees, flat ground neutral, like the map's layer
  // slopes over 1.5 texels each side from bilinear samples: the grid holds whole metres, and one-texel differences
  // turned the 1 m steps of gentle slopes into visible terraces
  float dx = (hb(q + vec2(1.5, 0.0)) - hb(q - vec2(1.5, 0.0))) / (3.0 * u_px_m);
  float dy = (hb(q + vec2(0.0, 1.5)) - hb(q - vec2(0.0, 1.5))) / (3.0 * u_px_m);
  vec3 n = normalize(vec3(-dx * u_shade, dy * u_shade, 1.0));
  vec3 L = normalize(vec3(-0.5417, 0.5417, 0.6428));
  float s = dot(n, L) - L.z;
  // the map's multidirectional hillshade also lifts flat ground by ~4.5 % towards its highlight colour (measured on
  // screenshots: Antarctic plateau 86,86,78 under the ramp, 92,93,86 on the map)
  col = mix(col, vec3(0.863, 0.922, 1.0), 0.045);
  col = s < 0.0 ? mix(col, vec3(0.012, 0.024, 0.063), min(1.0, -s * 0.55 * 4.0)) : mix(col, vec3(0.863, 0.922, 1.0), min(1.0, s * 0.20 * 4.0));
  float a = v_alpha * u_opacity;
  fragColor = vec4(col * a, a);
}`;

interface Disc { tex: WebGLTexture; buf: WebGLBuffer; n: number; north: boolean }

export class PolarLayer implements CustomLayerInterface {
  readonly id = 'polar-caps';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  opacity = 1;
  private map: MlMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private discs: Disc[] = [];
  private lut: WebGLTexture | null = null;
  private lutData: Uint8Array;
  private lutDirty = true;
  private progs = new Map<string, { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null>; attr: Record<string, number> }>();
  private pxM = 0;
  private size = 0;
  private matMain = new Float32Array(16);
  private matFallback = new Float32Array(16);

  constructor(private base: string, private meta: PolarMeta, stops: [number, string][]) { this.lutData = rampLut(stops); }

  /** New colour ramp (sea level changed, ocean-water underlay on or off). */
  setStops(stops: [number, string][]) { this.lutData = rampLut(stops); this.lutDirty = true; this.map?.triggerRepaint(); }

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl as WebGL2RenderingContext;
    this.size = this.meta.size;
    this.pxM = ((2 * this.meta.radius_deg) / this.meta.size) * 111195;
    for (const north of [true, false]) void this.loadDisc(north);
  }

  private async loadDisc(north: boolean) {
    const r = await fetch(`${this.base}${north ? 'north' : 'south'}.webp`).catch(() => null);
    if (!r?.ok || !this.gl) return;
    const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const g = this.gl;
    if (!g) { bmp.close(); return; }
    const tex = g.createTexture()!;
    g.bindTexture(g.TEXTURE_2D, tex);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    g.pixelStorei(g.UNPACK_COLORSPACE_CONVERSION_WEBGL, g.NONE);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, g.RGBA, g.UNSIGNED_BYTE, bmp);
    bmp.close();
    for (const [k, v] of [[g.TEXTURE_MIN_FILTER, g.NEAREST], [g.TEXTURE_MAG_FILTER, g.NEAREST], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE]]) g.texParameteri(g.TEXTURE_2D, k, v);
    const mesh = discMesh(north, this.meta.radius_deg);
    const buf = g.createBuffer()!;
    g.bindBuffer(g.ARRAY_BUFFER, buf);
    g.bufferData(g.ARRAY_BUFFER, mesh, g.STATIC_DRAW);
    this.discs.push({ tex, buf, n: mesh.length / 5, north });
    this.map?.triggerRepaint();
  }

  onRemove(_map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    const g = gl as WebGL2RenderingContext;
    for (const d of this.discs) { g.deleteTexture(d.tex); g.deleteBuffer(d.buf); }
    if (this.lut) g.deleteTexture(this.lut);
    for (const p of this.progs.values()) g.deleteProgram(p.prog);
    this.discs = []; this.progs.clear(); this.map = null; this.gl = null; this.lut = null;
  }

  private program(g: WebGL2RenderingContext, args: CustomRenderMethodInput) {
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
    g.attachShader(prog, vs); g.attachShader(prog, fs); g.linkProgram(prog);
    g.deleteShader(vs); g.deleteShader(fs);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) { const log = g.getProgramInfoLog(prog); g.deleteProgram(prog); throw new Error(`polar program: ${log}`); }
    const names = ['u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition',
      'u_projection_fallback_matrix', 'u_dem', 'u_lut', 'u_exag', 'u_size', 'u_px_m', 'u_shade', 'u_opacity'];
    p = { prog, loc: Object.fromEntries(names.map((x) => [x, g.getUniformLocation(prog, x)])), attr: Object.fromEntries(['a_merc', 'a_uv', 'a_lat'].map((x) => [x, g.getAttribLocation(prog, x)])) };
    this.progs.set(key, p);
    return p;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const g = gl as WebGL2RenderingContext;
    if (!this.map || !this.discs.length || this.opacity <= 0) return;
    if (this.lutDirty || !this.lut) {
      this.lut ??= g.createTexture()!;
      g.bindTexture(g.TEXTURE_2D, this.lut);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, LUT_N, 1, 0, g.RGBA, g.UNSIGNED_BYTE, this.lutData);
      for (const [k, v] of [[g.TEXTURE_MIN_FILTER, g.LINEAR], [g.TEXTURE_MAG_FILTER, g.LINEAR], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE]]) g.texParameteri(g.TEXTURE_2D, k, v);
      this.lutDirty = false;
    }
    const P = this.program(g, args), L = P.loc, pd = args.defaultProjectionData;
    g.useProgram(P.prog);
    this.matMain.set(pd.mainMatrix);
    g.uniformMatrix4fv(L.u_projection_matrix, false, this.matMain);
    if (L.u_projection_tile_mercator_coords) g.uniform4f(L.u_projection_tile_mercator_coords, ...pd.tileMercatorCoords);
    if (L.u_projection_clipping_plane) g.uniform4f(L.u_projection_clipping_plane, ...pd.clippingPlane);
    if (L.u_projection_transition) g.uniform1f(L.u_projection_transition, pd.projectionTransition);
    if (L.u_projection_fallback_matrix) { this.matFallback.set(pd.fallbackMatrix); g.uniformMatrix4fv(L.u_projection_fallback_matrix, false, this.matFallback); }
    g.uniform1f(L.u_exag, this.map.getTerrain()?.exaggeration ?? 0);
    g.uniform1f(L.u_size, this.size);
    g.uniform1f(L.u_px_m, this.pxM);
    // the map's hillshade strengthens towards low zoom; a fixed vertical gain keeps the sea floor legible at all zooms
    g.uniform1f(L.u_shade, 6.0);
    g.uniform1f(L.u_opacity, this.opacity);
    g.disable(g.DEPTH_TEST);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D, this.lut); g.uniform1i(L.u_lut, 1);
    for (const d of this.discs) {
      g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, d.tex); g.uniform1i(L.u_dem, 0);
      g.bindBuffer(g.ARRAY_BUFFER, d.buf);
      g.enableVertexAttribArray(P.attr.a_merc); g.vertexAttribPointer(P.attr.a_merc, 2, g.FLOAT, false, 20, 0);
      g.enableVertexAttribArray(P.attr.a_uv); g.vertexAttribPointer(P.attr.a_uv, 2, g.FLOAT, false, 20, 8);
      g.enableVertexAttribArray(P.attr.a_lat); g.vertexAttribPointer(P.attr.a_lat, 1, g.FLOAT, false, 20, 16);
      g.drawArrays(g.TRIANGLES, 0, d.n);
    }
    for (const a of Object.values(P.attr)) if (a >= 0) g.disableVertexAttribArray(a);
  }
}
