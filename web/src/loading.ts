// "Loading map detail · 64%": a slim bar at the bottom of the free map area while tiles load, like a web map's
// own progress line. Pure state here (test/loading.test.ts); main.ts feeds it tile starts / finishes
// (tilesource.tileActivity for the protocol tiles, MapLibre 'dataloading' / 'data' events for the plain raster
// and GeoJSON sources) and the map's 'idle' event, and draws it.
//
// A burst begins with the first start after the meter was done; progress = finished / started within the
// burst; the bar appears only when the burst has lasted `delay` ms (no flicker on cached pans) and the burst ends
// when the map goes idle (aborted tiles never report back, so idle, not the counts, decides "done").
export interface LoadView { visible: boolean; pct: number; done: boolean }

export class LoadMeter {
  started = 0;
  finished = 0;
  burstStart = -1;
  done = true;
  /** completed bursts, for QA: duration, whether the bar was shown, highest percentage reached */
  readonly log: { ms: number; shown: boolean; tiles: number }[] = [];
  shown = false;

  constructor(private now: () => number = () => performance.now(), readonly delay = 300) {}

  start() {
    if (this.done) { this.started = 0; this.finished = 0; this.burstStart = this.now(); this.done = false; this.shown = false; }
    this.started++;
  }
  finish() {
    if (!this.done) this.finished = Math.min(this.started, this.finished + 1);
  }
  /** The map is idle: the burst is complete. Returns true when a burst actually ended. */
  end(): boolean {
    if (this.done) return false;
    this.finished = this.started;
    this.done = true;
    if (this.log.length > 200) this.log.shift();
    this.log.push({ ms: Math.round(this.now() - this.burstStart), shown: this.shown, tiles: this.started });
    return true;
  }
  get pct(): number {
    if (this.done) return 100;
    return this.started ? Math.min(99, Math.floor((100 * this.finished) / this.started)) : 0;
  }
  /** Whether the bar should be on screen now (a running burst older than the delay). */
  view(): LoadView {
    const visible = !this.done && this.now() - this.burstStart >= this.delay;
    if (visible) this.shown = true;
    return { visible, pct: this.pct, done: this.done };
  }
}
