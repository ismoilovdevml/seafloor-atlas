import { describe, expect, it } from 'vitest';
import { nextTilt, tiltButton, TILT_DEG, turned } from '../src/nav3d';

describe('compass and 3D switch', () => {
  it('turns the bearing by 45 degrees and keeps it in (-180, 180]', () => {
    expect(turned(0, 45)).toBe(45);
    expect(turned(170, 45)).toBe(-145);
    expect(turned(-170, -45)).toBe(145);
    expect(turned(135, 45)).toBe(180);
    expect(turned(-135, -45)).toBe(180);
  });
  it('tilts a flat view and flattens a tilted one', () => {
    expect(nextTilt(0)).toEqual({ pitch: TILT_DEG, label: '3D' });
    expect(nextTilt(5)).toEqual({ pitch: TILT_DEG, label: '3D' });
    expect(nextTilt(40)).toEqual({ pitch: 0, label: '2D' });
  });
  it('names the 3D button by the action its visible text shows (label in name)', () => {
    for (const p of [0, 5, 40, 60]) {
      const b = tiltButton(p);
      expect(b.name, `pitch ${p}`).toContain(b.text);
      expect(b.text).toBe(nextTilt(p).label);
    }
    expect(tiltButton(0).tilted).toBe(false);
    expect(tiltButton(60)).toEqual({ text: '2D', name: 'Look straight down (2D)', tilted: true });
  });
});
