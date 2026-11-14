import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureTiles, fetchTile, maxZoomFor, parseTileUrl, tileTemplate } from '../src/tilesource';

afterEach(() => vi.unstubAllGlobals());

describe('tilesource', () => {
  it('parses protocol urls', () => {
    expect(parseTileUrl('sfa://dem/6/12/20')).toEqual(['dem', 6, 12, 20]);
    expect(parseTileUrl('sfa://coverage/0/0/0')).toEqual(['coverage', 0, 0, 0]);
    expect(parseTileUrl('https://x/dem/1/2/3.webp')).toBeNull();
    expect(tileTemplate('dem')).toBe('sfa://dem/{z}/{x}/{y}');
  });

  it('serves low zooms from static files', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);
    configureTiles('tiles', 5, null);
    const buf = await fetchTile('dem', 5, 10, 7);
    expect(fetchMock).toHaveBeenCalledWith('tiles/dem/5/10/7.webp', expect.anything());
    expect(new Uint8Array(buf!)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('without a hires archive, zooms above lowMax have no tile and maxzoom stays low', async () => {
    configureTiles('tiles/', 5, null);
    expect(maxZoomFor('dem')).toBe(5);
    expect(await fetchTile('dem', 6, 0, 0)).toBeNull();
  });

  it('with a hires archive, dem and coverage reach its maxzoom but new2026 does not', () => {
    configureTiles('tiles/', 5, { maxzoom: 7, dem: 'https://example.org/dem.pmtiles', coverage: 'https://example.org/cov.pmtiles' });
    expect(maxZoomFor('dem')).toBe(7);
    expect(maxZoomFor('coverage')).toBe(7);
    expect(maxZoomFor('new2026')).toBe(5);
  });

  it('retries a transient 503 and then succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7])));
    vi.stubGlobal('fetch', fetchMock);
    configureTiles('tiles/', 5, null);
    const p = fetchTile('dem', 3, 5, 2);
    await vi.runAllTimersAsync();
    expect(new Uint8Array((await p)!)).toEqual(new Uint8Array([7]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not retry a 404', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    configureTiles('tiles/', 5, null);
    expect(await fetchTile('dem', 3, 5, 2)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a missing static tile resolves to null instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    configureTiles('tiles/', 5, null);
    expect(await fetchTile('coverage', 3, 1, 1)).toBeNull();
  });
});
