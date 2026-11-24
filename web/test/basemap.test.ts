import { describe, expect, it } from 'vitest';
import { SAT_KEY, initialSatLand, storeSatLand, storedSatLand } from '../src/basemap';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

describe('satellite land choice in localStorage', () => {
  it('round-trips the choice', () => {
    const s = mem();
    expect(storedSatLand(s)).toBeNull();
    storeSatLand(s, false);
    expect(s.m.get(SAT_KEY)).toBe('grey');
    expect(storedSatLand(s)).toBe(false);
    storeSatLand(s, true);
    expect(storedSatLand(s)).toBe(true);
  });
  it('survives blocked or missing storage', () => {
    expect(storedSatLand(blocked)).toBeNull();
    expect(() => storeSatLand(blocked, false)).not.toThrow();
    expect(storedSatLand(null)).toBeNull();
  });
  it('the hash wins, then the stored choice, then the default (on)', () => {
    expect(initialSatLand('', null)).toBe(true);
    expect(initialSatLand('', false)).toBe(false);
    expect(initialSatLand('#story=x', false)).toBe(false);
    expect(initialSatLand('#land=grey', true)).toBe(false);
    expect(initialSatLand('#story=x&land=grey', null)).toBe(false);
    expect(initialSatLand('#land=sat', false)).toBe(true);
  });
});
