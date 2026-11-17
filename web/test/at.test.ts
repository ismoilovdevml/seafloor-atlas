import { describe, expect, it } from 'vitest';
import { atFromHash } from '../src/at';

describe('#at= deep link', () => {
  it('parses lon,lat,zoom alone and combined with other parts', () => {
    expect(atFromHash('#at=21.46,58.79,5.2')).toEqual({ lon: 21.46, lat: 58.79, zoom: 5.2 });
    expect(atFromHash('#layers=cables&at=-37.1,-14.4,2.8')).toEqual({ lon: -37.1, lat: -14.4, zoom: 2.8 });
    expect(atFromHash('#at=154.7,73.1&sea=-120')).toEqual({ lon: 154.7, lat: 73.1, zoom: 4 });
  });
  it('rejects malformed or out-of-range values', () => {
    expect(atFromHash('')).toBeNull();
    expect(atFromHash('#at=200,10,3')).toBeNull();
    expect(atFromHash('#at=10,89,3')).toBeNull();
    expect(atFromHash('#at=10,10,30')).toBeNull();
    expect(atFromHash('#story=romanche')).toBeNull();
  });
});
