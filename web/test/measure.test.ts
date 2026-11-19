import { describe, expect, it } from 'vitest';
import { formatArea, formatDistance, pathKm, pathLine, ringAreaKm2 } from '../src/measure';

describe('measure distance', () => {
  it('sums great-circle legs and closes the ring when asked', () => {
    // one degree of latitude on the 6,371.0088 km sphere = 111.195 km
    expect(pathKm([[0, 0], [0, 1]])).toBeCloseTo(111.195, 2);
    expect(pathKm([[0, 0], [0, 1], [0, 2]])).toBeCloseTo(222.39, 1);
    expect(pathKm([[0, 0], [1, 0], [1, 1]], true)).toBeCloseTo(pathKm([[0, 0], [1, 0], [1, 1], [0, 0]]), 6);
    // London - New York, about 5,570 km on the sphere
    expect(pathKm([[-0.1276, 51.5072], [-74.006, 40.7128]])).toBeGreaterThan(5550);
    expect(pathKm([[-0.1276, 51.5072], [-74.006, 40.7128]])).toBeLessThan(5590);
  });
  it('gives the area of a ring on the sphere', () => {
    // a 1 x 1 degree box at the equator is about 12,364 km² on this sphere
    expect(ringAreaKm2([[0, 0], [1, 0], [1, 1], [0, 1]])).toBeGreaterThan(12300);
    expect(ringAreaKm2([[0, 0], [1, 0], [1, 1], [0, 1]])).toBeLessThan(12400);
    // order does not matter, a degenerate ring has none
    expect(ringAreaKm2([[0, 1], [1, 1], [1, 0], [0, 0]])).toBeCloseTo(ringAreaKm2([[0, 0], [1, 0], [1, 1], [0, 1]]), 3);
    expect(ringAreaKm2([[0, 0], [1, 1]])).toBe(0);
    // across the antimeridian
    expect(ringAreaKm2([[179.5, 0], [-179.5, 0], [-179.5, 1], [179.5, 1]])).toBeCloseTo(ringAreaKm2([[0, 0], [1, 0], [1, 1], [0, 1]]), 0);
  });
  it('formats like Google Maps (metric with imperial in brackets)', () => {
    expect(formatDistance(0.85)).toBe('850 m (2,789 ft)');
    expect(formatDistance(12.3456)).toBe('12.35 km (7.67 mi)');
    expect(formatDistance(5570.4)).toBe('5,570.4 km (3,461.3 mi)');
    expect(formatArea(12364.2)).toBe('12,364 km² (4,774 mi²)');
    expect(formatArea(0.5)).toBe('500,000 m²');
  });
  it('draws legs as densified great circles that do not jump at the antimeridian', () => {
    const line = pathLine([[170, 10], [-170, 10]], false);
    expect(line.length).toBeGreaterThan(50);
    for (let i = 1; i < line.length; i++) expect(Math.abs(line[i][0] - line[i - 1][0])).toBeLessThan(1);
    const ring = pathLine([[0, 0], [1, 0], [1, 1]], true);
    expect(ring[ring.length - 1]).toEqual([0, 0]);
  });
});
