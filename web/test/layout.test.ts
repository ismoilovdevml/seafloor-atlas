import { describe, expect, it } from 'vitest';
import { destination, diskCoverage, fitRadius, freeRect, globeDisk, isGlobeScale, zoomForRadius } from '../src/layout';

describe('globe layout helpers', () => {
  it('destination: quarter turn east from the equator, poles clamp', () => {
    const [lon, lat] = destination(0, 0, Math.PI / 2, Math.PI / 2);
    expect(lon).toBeCloseTo(90, 6); expect(lat).toBeCloseTo(0, 6);
    expect(destination(170, 0, (20 * Math.PI) / 180, Math.PI / 2)[0]).toBeCloseTo(-170, 6); // wraps the antimeridian
    expect(destination(0, 80, Math.PI / 4, 0)[1]).toBeLessThanOrEqual(89.9);
  });
  it('globeDisk finds the limb of an orthographic sphere', () => {
    // orthographic globe of radius 300 px centred at (500, 400), view centre lon/lat 0/0: x = R cos(lat) sin(lon)
    const R = 300, D2R = Math.PI / 180;
    const project = ([lon, lat]: [number, number]) => ({ x: 500 + R * Math.cos(lat * D2R) * Math.sin(lon * D2R), y: 400 - R * Math.sin(lat * D2R) });
    const d = globeDisk(project, [0, 0], 0.25);
    expect(d.cx).toBe(500); expect(d.cy).toBe(400);
    expect(d.r).toBeGreaterThan(299.9); expect(d.r).toBeLessThanOrEqual(300.0001);
  });
  it('coverage: no panels = all free; a half-plane panel = about half', () => {
    const disk = { cx: 100, cy: 100, r: 50 }, vp = { left: 0, top: 0, right: 200, bottom: 200 };
    expect(diskCoverage(disk, [], vp).freeFrac).toBe(1);
    const half = diskCoverage(disk, [{ left: 0, top: 100, right: 200, bottom: 200 }], vp, 100).freeFrac;
    expect(half).toBeGreaterThan(0.47); expect(half).toBeLessThan(0.53);
    // off-screen parts of the disk do not count
    const clipped = diskCoverage({ cx: 0, cy: 100, r: 50 }, [], vp);
    expect(clipped.freeFrac).toBe(1);
    expect(clipped.visible).toBeLessThan(diskCoverage(disk, [], vp).visible * 0.6);
  });
  it('fit: free rect, globe scale and zoom step', () => {
    const free = freeRect(1440, 900, { left: 320, right: 300, top: 0, bottom: 263 });
    expect(free).toEqual({ left: 320, top: 0, right: 1140, bottom: 637 });
    expect(fitRadius(free)).toBeCloseTo(0.45 * 637, 6);
    expect(isGlobeScale({ cx: 0, cy: 0, r: 280 }, 1440, 900)).toBe(true);
    expect(isGlobeScale({ cx: 0, cy: 0, r: 970 }, 1440, 900)).toBe(false); // zoomed in on a place
    expect(zoomForRadius(2, 300, 150)).toBeCloseTo(1, 9);
    expect(zoomForRadius(2, 300, 300)).toBe(2);
  });
});
