// MapLibre custom WebGL layer that draws the flow particles (flow.ts) as fading streaks.
//
// Why a custom layer: the particles live in lon/lat and every frame each trail segment is projected with
// MapLibre's own `projectTile` (from shaderData.vertexShaderPrelude), so the same shader is right on the globe,
// in mercator and during the transition, and the far side of the globe is clipped by MapLibre's horizon plane.
// A canvas source would need a 2048² texture upload and a terrain-texture redraw every frame.
//
// Trails: a ring buffer of the last K positions of every particle ([slot][particle] x, y, speed). Each frame
// only the newest slot (N x 12 bytes) and the particle ages (N x 4 bytes) are uploaded. Segment d (d = 0 is the
// newest) is drawn as an instanced screen-space quad between slots head-d-1 and head-d, hidden when the
// particle is younger than d + 1 frames (it was respawned) or the segment crosses the antimeridian; alpha falls
// with d, so trails fade. K - 1 instanced draws of 4 vertices per frame.
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
import { FLOW_RAMP, hexRgb, mercX, mercY, Particles, stepScale, type FlowField, type SpawnArea } from './flow';

const K = 16; // trail slots (15 segments: about 20 px of trail at the top speed)

const VERT = (prelude: string, define: string) => `#version 300 es
${prelude}
${define}
in vec3 a_new;
in vec3 a_old;
in float a_age;
in vec2 a_corner;
uniform float u_d;
uniform float u_k;
uniform vec2 u_half_viewport;
uniform float u_width;
uniform float u_smax;
uniform vec3 u_ramp[4];
uniform float u_opacity;
out vec4 v_color;
out float v_side;
void main() {
  bool live = a_age >= u_d + 1.0 && abs(a_new.x - a_old.x) < 0.5;
  vec4 p0 = projectTile(a_old.xy);
  vec4 p1 = projectTile(a_new.xy);
  vec2 s0 = p0.xy / p0.w * u_half_viewport;
  vec2 s1 = p1.xy / p1.w * u_half_viewport;
  vec2 dir = s1 - s0;
  float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  bool head = a_corner.x > 0.5;
  vec4 p = head ? p1 : p0;
  // half a width of overhang at both ends so consecutive segments join without gaps
  vec2 off = nrm * a_corner.y * (u_width * 0.5 + 0.75) + dir * (head ? 0.5 : -0.5) * u_width;
  p.xy += off / u_half_viewport * p.w;
  gl_Position = (live && len > 1e-4) ? p : vec4(2.0, 2.0, 2.0, 1.0);
  // square root: most of the ocean moves at a small fraction of the jets' speed and would all look alike
  float t = sqrt(clamp((head ? a_new.z : a_old.z) / u_smax, 0.0, 1.0));
  float x = t * 3.0;
  vec3 c = x < 1.0 ? mix(u_ramp[0], u_ramp[1], x) : x < 2.0 ? mix(u_ramp[1], u_ramp[2], x - 1.0) : mix(u_ramp[2], u_ramp[3], x - 2.0);
  float fade = 1.0 - (u_d + (head ? 0.0 : 1.0)) / u_k;
  float a = (0.45 + 0.55 * t) * fade * u_opacity;
#ifdef GLOBE
  // the streaks fly at sea level while the exaggerated seafloor is pushed inwards: near the horizon they would
  // float off the globe's edge, so they fade out there. MapLibre's horizon plane (unit normal n, offset w) gives
  // h = dot(p, n) + w: 0 on the horizon, 1 + w under the camera, at every zoom and pitch.
  vec3 sp = projectToSphere(head ? a_new.xy : a_old.xy);
  float h = (dot(sp, u_projection_clipping_plane.xyz) + u_projection_clipping_plane.w) / max(1e-3, 1.0 + u_projection_clipping_plane.w);
  a *= smoothstep(0.08, 0.4, h);
#endif
  v_color = vec4(c * a, a);
  v_side = a_corner.y * (u_width * 0.5 + 0.75);
}`;

const FRAG = `#version 300 es
precision mediump float;
uniform highp float u_width;
in vec4 v_color;
in float v_side;
out vec4 fragColor;
void main() {
  // 0.75 px soft edge on each side of the line core
  float d = abs(v_side) - u_width * 0.5;
  fragColor = v_color * clamp(1.0 - d / 0.75, 0.0, 1.0);
}`;

interface Prog { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null>; attr: Record<string, number> }

export interface FlowLayerOpts {
  id: string;
  /** particles for the current viewport size */
  count: () => number;
  /** where particles may (re)start, recomputed by the host when the camera stops */
  area: () => SpawnArea;
  /** speed at the top of the colour ramp (m/s) */
  smax: number;
  /** screen px a particle at smax moves per 60 Hz frame */
  pxPerFrame: number;
}

export class FlowLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  field: FlowField | null = null;
  /** false: draw the current trails without moving (paused, reduced motion, hidden tab) */
  running = true;
  opacity = 1;
  smax: number;
  readonly stats = { frames: 0, cpuMs: [] as number[] };
  private map: MlMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private progs = new Map<string, Prog>();
  private ring = new Float32Array(0);
  private ages = new Float32Array(0);
  private ringBuf: WebGLBuffer | null = null;
  private ageBuf: WebGLBuffer | null = null;
  private cornerBuf: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private p: Particles | null = null;
  private head = 0;
  private lastT = 0;
  private fullUpload = true;

  constructor(private opts: FlowLayerOpts) { this.id = opts.id; this.smax = opts.smax; }

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl as WebGL2RenderingContext;
    const g = this.gl;
    this.ringBuf = g.createBuffer(); this.ageBuf = g.createBuffer(); this.cornerBuf = g.createBuffer();
    this.vao = g.createVertexArray();
    g.bindBuffer(g.ARRAY_BUFFER, this.cornerBuf);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), g.STATIC_DRAW);
  }

  onRemove(_map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    const g = gl as WebGL2RenderingContext;
    for (const b of [this.ringBuf, this.ageBuf, this.cornerBuf]) if (b) g.deleteBuffer(b);
    if (this.vao) g.deleteVertexArray(this.vao);
    for (const p of this.progs.values()) g.deleteProgram(p.prog);
    this.progs.clear();
    this.map = null; this.gl = null; this.p = null;
  }

  /** New particle set (field change of size, viewport change, new area): seeds and fills the trail history. */
  reseed(prerun = 0) {
    if (!this.field) return;
    const n = this.opts.count();
    if (!this.p || this.p.n !== n) {
      this.p = new Particles(n);
      this.ring = new Float32Array(K * n * 3);
      this.ages = new Float32Array(n);
    }
    this.p.seed(this.field, this.opts.area());
    for (let s = 0; s < K; s++) this.writeSlot(s);
    this.head = 0;
    this.fullUpload = true;
    // reduced motion: run the system for a while once so the frozen frame shows real streaks
    for (let i = 0; i < prerun; i++) this.advance(1);
  }

  /** The camera stopped somewhere else: particles outside the new view start again inside it. */
  refreshArea(prerun = 0) {
    if (!this.p || !this.field) { this.reseed(prerun); return; }
    // respawned particles restart at age 0, so the shader hides the trail slots of their old life
    this.p.respawnOutside(this.field, this.opts.area());
    for (let i = 0; i < prerun; i++) this.advance(1);
    this.map?.triggerRepaint();
  }

  private writeSlot(s: number) {
    const p = this.p!, n = p.n, r = this.ring, o = s * n * 3;
    for (let i = 0; i < n; i++) {
      r[o + 3 * i] = mercX(p.lon[i]);
      r[o + 3 * i + 1] = mercY(p.lat[i]);
      r[o + 3 * i + 2] = p.speed[i];
      this.ages[i] = p.age[i];
    }
  }

  private advance(frames: number) {
    const p = this.p, f = this.field, map = this.map;
    if (!p || !f || !map) return;
    p.step(f, this.opts.area(), stepScale(map.getZoom(), this.smax, this.opts.pxPerFrame), frames);
    this.head = (this.head + 1) % K;
    this.writeSlot(this.head);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const g = gl as WebGL2RenderingContext;
    if (!this.field || !this.map) return;
    if (!this.p) this.reseed();
    const p = this.p!;
    const now = performance.now();
    if (this.running && !document.hidden) {
      const t0 = now;
      const frames = this.lastT ? Math.min(3, Math.max(0.25, (now - this.lastT) / (1000 / 60))) : 1;
      this.advance(frames);
      this.stats.frames++;
      if (this.stats.cpuMs.length < 4000) this.stats.cpuMs.push(performance.now() - t0);
    }
    this.lastT = this.running ? now : 0;

    const prog = this.program(g, args);
    g.useProgram(prog.prog);
    const L = prog.loc;
    const pd = args.defaultProjectionData;
    g.uniformMatrix4fv(L.u_projection_matrix, false, new Float32Array(pd.mainMatrix));
    if (L.u_projection_tile_mercator_coords) g.uniform4f(L.u_projection_tile_mercator_coords, ...pd.tileMercatorCoords);
    if (L.u_projection_clipping_plane) g.uniform4f(L.u_projection_clipping_plane, ...pd.clippingPlane);
    if (L.u_projection_transition) g.uniform1f(L.u_projection_transition, pd.projectionTransition);
    if (L.u_projection_fallback_matrix) g.uniformMatrix4fv(L.u_projection_fallback_matrix, false, new Float32Array(pd.fallbackMatrix));
    const dpr = window.devicePixelRatio || 1;
    g.uniform2f(L.u_half_viewport, g.drawingBufferWidth / 2, g.drawingBufferHeight / 2);
    g.uniform1f(L.u_width, 1.25 * dpr);
    g.uniform1f(L.u_smax, this.smax);
    g.uniform1f(L.u_k, K - 1);
    g.uniform1f(L.u_opacity, this.opacity);
    g.uniform3fv(L.u_ramp, new Float32Array(FLOW_RAMP.flatMap((c) => hexRgb(c).map((x) => x / 255))));

    const n = p.n, stride = 12;
    g.bindVertexArray(this.vao);
    g.bindBuffer(g.ARRAY_BUFFER, this.ringBuf);
    if (this.fullUpload) { g.bufferData(g.ARRAY_BUFFER, this.ring, g.DYNAMIC_DRAW); this.fullUpload = false; }
    else g.bufferSubData(g.ARRAY_BUFFER, this.head * n * stride, this.ring, this.head * n * 3, n * 3);
    g.bindBuffer(g.ARRAY_BUFFER, this.ageBuf);
    g.bufferData(g.ARRAY_BUFFER, this.ages, g.DYNAMIC_DRAW);
    g.vertexAttribPointer(prog.attr.a_age, 1, g.FLOAT, false, 4, 0);
    g.vertexAttribDivisor(prog.attr.a_age, 1);
    g.enableVertexAttribArray(prog.attr.a_age);
    g.bindBuffer(g.ARRAY_BUFFER, this.cornerBuf);
    g.vertexAttribPointer(prog.attr.a_corner, 2, g.FLOAT, false, 8, 0);
    g.vertexAttribDivisor(prog.attr.a_corner, 0);
    g.enableVertexAttribArray(prog.attr.a_corner);
    g.bindBuffer(g.ARRAY_BUFFER, this.ringBuf);
    g.enableVertexAttribArray(prog.attr.a_new); g.vertexAttribDivisor(prog.attr.a_new, 1);
    g.enableVertexAttribArray(prog.attr.a_old); g.vertexAttribDivisor(prog.attr.a_old, 1);
    g.disable(g.DEPTH_TEST);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    for (let d = 0; d < K - 1; d++) {
      const sn = (this.head - d + K) % K, so = (this.head - d - 1 + K) % K;
      g.vertexAttribPointer(prog.attr.a_new, 3, g.FLOAT, false, stride, sn * n * stride);
      g.vertexAttribPointer(prog.attr.a_old, 3, g.FLOAT, false, stride, so * n * stride);
      g.uniform1f(L.u_d, d);
      g.drawArraysInstanced(g.TRIANGLE_STRIP, 0, 4, n);
    }
    for (const a of ['a_new', 'a_old', 'a_age', 'a_corner']) { g.vertexAttribDivisor(prog.attr[a], 0); g.disableVertexAttribArray(prog.attr[a]); }
    g.bindVertexArray(null);
    if (this.running) this.map.triggerRepaint();
  }

  private program(g: WebGL2RenderingContext, args: CustomRenderMethodInput): Prog {
    const key = args.shaderData.variantName;
    let p = this.progs.get(key);
    if (p) return p;
    const sh = (type: number, src: string) => {
      const s = g.createShader(type)!;
      g.shaderSource(s, src); g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(`flow shader: ${g.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = g.createProgram()!;
    g.attachShader(prog, sh(g.VERTEX_SHADER, VERT(args.shaderData.vertexShaderPrelude, args.shaderData.define)));
    g.attachShader(prog, sh(g.FRAGMENT_SHADER, FRAG));
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(`flow program: ${g.getProgramInfoLog(prog)}`);
    const names = ['u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition', 'u_projection_fallback_matrix',
      'u_d', 'u_k', 'u_half_viewport', 'u_width', 'u_smax', 'u_ramp', 'u_opacity'];
    p = {
      prog,
      loc: Object.fromEntries(names.map((x) => [x, g.getUniformLocation(prog, x)])),
      attr: Object.fromEntries(['a_new', 'a_old', 'a_age', 'a_corner'].map((x) => [x, g.getAttribLocation(prog, x)])),
    };
    this.progs.set(key, p);
    return p;
  }

  /** CPU time per frame (advection + trail write) since the last call. */
  takeStats() {
    const a = [...this.stats.cpuMs].sort((x, y) => x - y), q = (f: number) => (a.length ? +a[Math.min(a.length - 1, Math.floor(f * a.length))].toFixed(2) : null);
    const out = { frames: this.stats.frames, particles: this.p?.n ?? 0, cpuMedianMs: q(0.5), cpuP95Ms: q(0.95) };
    this.stats.frames = 0; this.stats.cpuMs = [];
    return out;
  }
  get particles(): Particles | null { return this.p; }
}
