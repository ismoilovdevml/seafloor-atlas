// Screen-space helpers for keeping the globe visible next to the panels (no DOM; test/layout.test.ts).
// The globe's visible disk is measured, not modelled: points along great circles from the view centre are
// projected and the largest screen distance is the limb (beyond it the far side projects back inside the disk).
// This holds for MapLibre's globe at any latitude, with perspective and terrain, without reading the depth buffer.

export interface Rect { left: number; top: number; right: number; bottom: number }
export interface Disk { cx: number; cy: number; r: number }
type Project = (lngLat: [number, number]) => { x: number; y: number };

const D2R = Math.PI / 180;
/** Point at angular distance d (radians) from lon/lat along a bearing (radians). */
export function destination(lon: number, lat: number, d: number, brg: number): [number, number] {
  const la = lat * D2R, lo = lon * D2R;
  const s = Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(brg);
  const la2 = Math.asin(Math.max(-1, Math.min(1, s)));
  const lo2 = lo + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [((((lo2 / D2R) + 540) % 360) + 360) % 360 - 180, Math.max(-89.9, Math.min(89.9, la2 / D2R))];
}

/** Visible globe disk: centre = projected view centre, radius = max projected distance along 4 bearings. */
export function globeDisk(project: Project, center: [number, number], stepDeg = 0.5): Disk {
  const c = project(center);
  let r = 0;
  for (const b of [0, 90, 180, 270]) {
    for (let a = 20; a <= 90; a += stepDeg) {
      const p = project(destination(center[0], center[1], a * D2R, b * D2R));
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (Number.isFinite(d)) r = Math.max(r, d);
    }
  }
  return { cx: c.x, cy: c.y, r };
}

export const inside = (x: number, y: number, rc: Rect) => x >= rc.left && x <= rc.right && y >= rc.top && y <= rc.bottom;

/**
 * Share of the globe disk's on-screen part that no panel covers, by sampling an n x n grid over the disk.
 * `visible` = sampled disk points inside the viewport, `free` = those not under any rect.
 */
export function diskCoverage(d: Disk, rects: Rect[], viewport: Rect, n = 60): { visible: number; free: number; freeFrac: number } {
  let visible = 0, free = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = d.cx - d.r + (2 * d.r * (i + 0.5)) / n, y = d.cy - d.r + (2 * d.r * (j + 0.5)) / n;
      if ((x - d.cx) ** 2 + (y - d.cy) ** 2 > d.r * d.r || !inside(x, y, viewport)) continue;
      visible++;
      if (!rects.some((rc) => inside(x, y, rc))) free++;
    }
  }
  return { visible, free, freeFrac: visible ? free / visible : 0 };
}

/** The map area left free by padding. */
export function freeRect(W: number, H: number, pad: { top?: number; bottom?: number; left?: number; right?: number }): Rect {
  return { left: pad.left ?? 0, top: pad.top ?? 0, right: W - (pad.right ?? 0), bottom: H - (pad.bottom ?? 0) };
}

/** Globe-scale view: the whole Earth roughly fits the window (then fitting it to the free area makes sense). */
export const isGlobeScale = (d: Disk, W: number, H: number) => d.r > 0 && d.r <= 0.6 * Math.min(W, H);

/** Largest disk radius that fits the free area with a margin. */
export const fitRadius = (free: Rect) => 0.45 * Math.min(free.right - free.left, free.bottom - free.top);

/** The globe's on-screen radius scales with 2^zoom at globe scale, so the zoom for a target radius is a log step. */
export function zoomForRadius(zoom: number, r: number, target: number): number {
  return zoom + Math.log2(target / r);
}
