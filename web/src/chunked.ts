// A PMTiles archive cut into fixed-size pieces served as plain static files (Cloudflare Pages: no HTTP range
// requests, 25 MiB per file, 20,000 files). getBytes(offset, length) fetches the pieces that cover the range and
// joins them. PMTiles keeps tiles in Hilbert order, so neighbouring tiles share pieces and a small piece cache
// serves most reads. Written by scripts/split_pmtiles.mjs; the manifest format is in docs/data-contract.md.
import type { RangeResponse, Source } from 'pmtiles';

export interface ChunkedArchive {
  /** directory of the pieces, relative to the page or absolute; ends with '/' */
  base: string;
  /** total archive size in bytes */
  size: number;
  /** piece size in bytes (the last piece is shorter) */
  chunk: number;
  /** number of pieces */
  count: number;
  /** SHA-256 of the whole archive and the URL it was cut from (provenance only) */
  sha256?: string;
  source?: string;
}

export function pieceName(i: number): string {
  return `${String(i).padStart(5, '0')}.bin`;
}

/** Pieces [first, last] that hold bytes [offset, offset + length) of the archive (clipped to its size). */
export function piecesFor(offset: number, length: number, a: Pick<ChunkedArchive, 'size' | 'chunk'>): [number, number] | null {
  const end = Math.min(offset + length, a.size);
  if (offset < 0 || length <= 0 || offset >= end) return null;
  return [Math.floor(offset / a.chunk), Math.floor((end - 1) / a.chunk)];
}

type Fetcher = (url: string) => Promise<ArrayBuffer>;

async function fetchPiece(url: string): Promise<ArrayBuffer> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url).catch((e) => { if (attempt >= 3) throw e; return null; });
    if (res?.ok) return res.arrayBuffer();
    if (res && res.status < 500) throw new Error(`piece ${url}: HTTP ${res.status}`);
    if (attempt >= 3) throw new Error(`piece ${url}: failed`);
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }
}

export class ChunkedSource implements Source {
  private cache = new Map<number, Promise<ArrayBuffer>>();
  constructor(private a: ChunkedArchive, private capacity = 48, private get: Fetcher = fetchPiece) {}

  getKey(): string { return this.a.base; }

  private piece(i: number): Promise<ArrayBuffer> {
    let p = this.cache.get(i);
    if (p) { this.cache.delete(i); this.cache.set(i, p); return p; } // most recently used last
    // shared between readers, so it is not tied to one request's abort signal
    p = this.get(`${this.a.base}${pieceName(i)}`);
    p.catch(() => { if (this.cache.get(i) === p) this.cache.delete(i); });
    this.cache.set(i, p);
    while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value as number);
    return p;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const span = piecesFor(offset, length, this.a);
    if (!span) return { data: new ArrayBuffer(0) };
    const [first, last] = span;
    const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, k) => this.piece(first + k)));
    const end = Math.min(offset + length, this.a.size);
    const out = new Uint8Array(end - offset);
    let pos = 0;
    parts.forEach((buf, k) => {
      const start = (first + k) * this.a.chunk;
      const from = Math.max(offset, start) - start;
      const to = Math.min(end, start + buf.byteLength) - start;
      out.set(new Uint8Array(buf, from, to - from), pos);
      pos += to - from;
    });
    if (pos !== out.length) throw new Error(`short read at ${offset}+${length}: ${pos} of ${out.length} bytes`);
    return { data: out.buffer };
  }
}
