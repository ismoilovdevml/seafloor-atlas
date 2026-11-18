import { describe, expect, it } from 'vitest';
import { FrameGovernor, MIN_RATIO, startQuality, WINDOW } from '../src/quality';

const none = new URLSearchParams();

describe('start quality', () => {
  it('caps the pixel ratio (1.5 on touch screens, 2 elsewhere) and antialiases only 1x screens', () => {
    expect(startQuality(3, true, none)).toEqual({ pixelRatio: 1.5, antialias: false });
    expect(startQuality(2, false, none)).toEqual({ pixelRatio: 2, antialias: false });
    expect(startQuality(3, false, none)).toEqual({ pixelRatio: 2, antialias: false });
    expect(startQuality(1, false, none)).toEqual({ pixelRatio: 1, antialias: true });
    expect(startQuality(1.25, true, none)).toEqual({ pixelRatio: 1.25, antialias: true });
  });
  it('lets ?pr= and ?aa= override', () => {
    expect(startQuality(3, true, new URLSearchParams('pr=3&aa=1'))).toEqual({ pixelRatio: 3, antialias: true });
    expect(startQuality(1, false, new URLSearchParams('aa=0'))).toEqual({ pixelRatio: 1, antialias: false });
  });
});

describe('frame governor', () => {
  const feed = (g: FrameGovernor, ms: number, n = WINDOW) => { let r: number | null = null; for (let i = 0; i < n; i++) r = g.push(ms) ?? r; return r; };
  it('keeps the ratio while frames are fast', () => {
    const g = new FrameGovernor(2);
    expect(feed(g, 16, WINDOW * 3)).toBeNull();
    expect(g.ratio).toBe(2);
  });
  it('steps down by 0.5 per slow window and stops at 1', () => {
    const g = new FrameGovernor(2);
    expect(feed(g, 120)).toBe(1.5);
    expect(feed(g, 120)).toBe(1);
    expect(feed(g, 120)).toBeNull();
    expect(g.ratio).toBe(MIN_RATIO);
    expect(g.steps).toBe(2);
  });
  it('uses the median, ignores hidden-tab gaps and never moves when the ratio is forced', () => {
    const g = new FrameGovernor(1.5);
    for (let i = 0; i < WINDOW - 1; i++) g.push(i < 5 ? 400 : 16); // a few hitches do not count
    expect(g.push(16)).toBeNull();
    expect(g.push(5000)).toBeNull(); // tab in the background
    expect(feed(new FrameGovernor(2, true), 200)).toBeNull();
  });
});
