// Render quality for slow GPUs. The globe's cost is mostly fill rate: pixels drawn per frame grow with the square
// of the pixel ratio, and multisample antialiasing multiplies that again. Measured with a software GPU
// (SwiftShader) while dragging the globe on a 390 x 844 phone at devicePixelRatio 3 (README, "Performance"):
// full quality 6.7 fps, pixel ratio 1.5 without antialiasing 19.3 fps.
//
// 1. Start capped: pixel ratio <= 1.5 on touch screens, <= 2 elsewhere; antialias only on 1x screens, where
//    jagged edges are visible (at 2x and above they are smaller than a CSS pixel).
// 2. FrameGovernor watches the frame interval while the map moves and steps the pixel ratio down by 0.5 (to 1 at
//    the lowest) when the median of the last frames is slower than ~22 fps. It only steps down, at most once
//    per window, so it cannot oscillate.
// ?pr=<ratio> and ?aa=0|1 override both (QA compares settings with them).

export interface QualityStart { pixelRatio: number; antialias: boolean }

export function startQuality(dpr: number, touch: boolean, params: URLSearchParams): QualityStart {
  const forced = Number(params.get('pr'));
  const pixelRatio = forced > 0 && Number.isFinite(forced) ? Math.min(4, Math.max(0.5, forced)) : Math.min(dpr || 1, touch ? 1.5 : 2);
  const aa = params.get('aa');
  return { pixelRatio, antialias: aa === '1' ? true : aa === '0' ? false : (dpr || 1) < 1.5 };
}

export const SLOW_FRAME_MS = 45;
export const WINDOW = 30;
export const MIN_RATIO = 1;
export const STEP = 0.5;

export class FrameGovernor {
  private gaps: number[] = [];
  steps = 0;
  constructor(public ratio: number, private readonly fixed = false) {}

  /** One frame interval (ms) while the map was moving. Returns the new pixel ratio when it should drop, else null. */
  push(gapMs: number): number | null {
    if (this.fixed || this.ratio <= MIN_RATIO || !(gapMs > 0) || gapMs > 1000) return null; // >1 s: tab was hidden, not slow
    this.gaps.push(gapMs);
    if (this.gaps.length < WINDOW) return null;
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.gaps = [];
    if (median <= SLOW_FRAME_MS) return null;
    this.ratio = Math.max(MIN_RATIO, Math.round((this.ratio - STEP) * 2) / 2);
    this.steps++;
    return this.ratio;
  }
}
