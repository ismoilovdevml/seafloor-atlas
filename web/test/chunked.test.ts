import { describe, expect, it } from 'vitest';
import { ChunkedSource, pieceName, piecesFor } from '../src/chunked';

const archive = Uint8Array.from({ length: 2500 }, (_, i) => i % 251);
const chunk = 1000;
const pieces = (i: number) => archive.slice(i * chunk, (i + 1) * chunk).buffer;
const meta = { base: 'hires/x/', size: archive.length, chunk, count: 3 };

describe('chunked PMTiles source', () => {
  it('names pieces and finds the pieces for a byte range', () => {
    expect(pieceName(7)).toBe('00007.bin');
    expect(piecesFor(0, 16384, meta)).toEqual([0, 2]); // header read longer than the file is clipped
    expect(piecesFor(999, 2, meta)).toEqual([0, 1]);
    expect(piecesFor(2000, 500, meta)).toEqual([2, 2]);
    expect(piecesFor(2500, 10, meta)).toBeNull();
  });
  it('joins bytes across piece boundaries exactly and reuses fetched pieces', async () => {
    const got: string[] = [];
    const src = new ChunkedSource(meta, 8, async (url) => { got.push(url); return pieces(Number(url.slice(-9, -4))); });
    for (const [off, len] of [[0, 10], [995, 10], [1500, 1000], [2490, 100], [0, 2500]] as const) {
      const r = new Uint8Array((await src.getBytes(off, len)).data);
      expect([...r]).toEqual([...archive.slice(off, Math.min(off + len, archive.length))]);
    }
    expect(got).toEqual(['hires/x/00000.bin', 'hires/x/00001.bin', 'hires/x/00002.bin']);
    expect(src.getKey()).toBe('hires/x/');
  });
  it('evicts the least recently used piece and refetches after a failure', async () => {
    let calls = 0, fail = true;
    const src = new ChunkedSource(meta, 1, async (url) => { calls++; if (fail && url.endsWith('00001.bin')) { fail = false; throw new Error('503'); } return pieces(Number(url.slice(-9, -4))); });
    await src.getBytes(0, 10);
    await expect(src.getBytes(1000, 10)).rejects.toThrow('503');
    expect([...new Uint8Array((await src.getBytes(1000, 3)).data)]).toEqual([...archive.slice(1000, 1003)]);
    await src.getBytes(0, 10); // evicted by capacity 1 -> fetched again
    expect(calls).toBe(4);
  });
});
