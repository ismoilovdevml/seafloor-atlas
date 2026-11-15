// Phytoplankton (chlorophyll-a, NASA MODIS-Aqua R2022.0 climatology): mask, colour scale and readout text.
// No DOM (test/chl.test.ts). The grid is the same 0.25 deg north-up layout as the WOA map layers, so decoding
// (water.decodeMapLayer, values are log10 mg/m³) and the Mercator reprojection (water.renderMercator) are shared.
// Format: docs/data-contract.md, "Phytoplankton, winds and currents".

export interface ChlManifest {
  attribution: string; licence: string; doi: string;
  variable: { name: string; units: string; range: [number, number] };
  grid: { res_deg: number; width: number; height: number; north: number; west: number; lo: number; step: number };
  months: string[];
  annual: string;
  layers: Record<string, { period: string; bytes: number; ocean_cells: number; log10_p2: number; log10_p50: number; log10_p98: number }>;
  caveats?: string[];
}

/** cmocean `algae` (Thyng et al. 2016), 17 evenly spaced samples: pale (little chlorophyll) to dark green (bloom). */
export const ALGAE = ['#d7f9d0', '#c3ebb9', '#afdda2', '#9ad08d', '#84c47a', '#6cb868', '#50ad59', '#2ea152', '#129450', '#07864d', '#0d7748', '#146942', '#185b3b', '#1a4d32', '#193f29', '#16311e', '#122414'];

/** File key: 1..12 -> '01'..'12', 0 -> 'annual'. */
export const chlKey = (month: number) => (month >= 1 && month <= 12 ? String(month).padStart(2, '0') : 'annual');

/**
 * Inland waters the satellite grid includes but the ocean mask (WOA surface cells) does not drop: the Caspian
 * Sea and the Great Lakes (WOA has values in both). Neither box holds any sea: the St Lawrence estuary starts
 * east of 72° W. [west, south, east, north].
 */
export const LAKE_BOXES: [number, number, number, number][] = [
  [46.5, 36.4, 55.2, 47.4], // Caspian Sea
  [-92.5, 41.2, -75.9, 49.2], // Great Lakes
];

/**
 * Ocean mask on the chlorophyll grid: a cell is ocean when it, or one of its 8 neighbours, has a World Ocean
 * Atlas surface value (the one-cell margin keeps coastal chlorophyll the coarser WOA coastline misses), minus
 * LAKE_BOXES. Measured on the 2026 files: keeps 98.4 % of the chlorophyll cells; drops Victoria, Tanganyika, Baikal, Ladoga, Titicaca, the Aral and the Great Salt Lake.
 * `woa` is the decoded WOA layer (NaN = no data), same width/height/north/west as the chlorophyll grid.
 */
export function oceanMask(woa: Float32Array, width: number, height: number, north: number, west: number, res: number): Uint8Array {
  const base = new Uint8Array(width * height);
  for (let i = 0; i < base.length; i++) base[i] = woa[i] === woa[i] ? 1 : 0;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        const row = yy * width;
        if (base[row + ((x - 1 + width) % width)] || base[row + x] || base[row + ((x + 1) % width)]) v = 1;
      }
      out[y * width + x] = v;
    }
  }
  for (const [w, s, e, n] of LAKE_BOXES) {
    const r0 = Math.max(0, Math.floor((north - n) / res)), r1 = Math.min(height - 1, Math.floor((north - s) / res));
    const c0 = Math.max(0, Math.floor((w - west) / res)), c1 = Math.min(width - 1, Math.floor((e - west) / res));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out[r * width + c] = 0;
  }
  return out;
}

/** Applies the mask in place (masked cells become NaN = no data). Returns how many cells were dropped. */
export function applyMask(values: Float32Array, mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (!mask[i] && values[i] === values[i]) { values[i] = NaN; n++; }
  return n;
}

/** mg/m³ with sensible precision: 0.045, 0.32, 2.3, 14. */
export function formatChl(mg: number): string {
  if (!Number.isFinite(mg)) return 'no data';
  const s = mg < 0.1 ? mg.toFixed(3) : mg < 1 ? mg.toFixed(2) : mg < 10 ? mg.toFixed(1) : Math.round(mg).toString();
  return `${s} mg/m³`;
}

/** Legend ticks on the log scale [lo, hi] mg/m³ (positions 0..1). */
export function chlTicks(lo: number, hi: number): { v: number; pos: number; label: string }[] {
  const L0 = Math.log10(lo), L1 = Math.log10(hi);
  return [0.01, 0.1, 1, 10].filter((v) => v >= lo && v <= hi).map((v) => ({ v, pos: (Math.log10(v) - L0) / (L1 - L0), label: String(v) }));
}
