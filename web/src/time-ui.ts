// The Time panel: one bottom tool (like Sea level or Ocean water) with three scales, one at a time.
//   Years      one year drives every year-aware layer on the map; the followed set gives the slider's range,
//              the bar strip above it (its numbers per year) and the headline counter
//   Months     one month drives sea temperature, phytoplankton, winds and currents together
//   Since the ice age   years before present drive the sea-level shading
// Play / pause, step, speed, keyboard (Space, arrows, Home / End on the slider), #time= deep link, and reduced
// motion respected (no pulses, coarser steps). Model and parsing in timeline.ts.
import {
  formatAgo, hashWithTime, levelAtAgo, MONTH_LONG, MONTH_SHORT, SPEEDS, stepMs, YEAR_SET_LABEL, YEAR_SETS,
  type SeaHistory, type TimeMode, type TimeState, type YearSet,
} from './timeline';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface YearTarget {
  available: boolean;
  isOn: () => boolean;
  turnOn: () => Promise<void>;
  /** range and one number per year (first..last) for the strip, and what the strip shows */
  timeline: () => Promise<{ first: number; last: number; values: number[]; unit: string }>;
  apply: (year: number | null, only: boolean) => void | Promise<void>;
  headline: (year: number, only: boolean) => { main: string; sub: string };
  note: string;
  pulse?: (year: number) => void;
  supportsOnly?: boolean;
}
export type MonthId = 'temp' | 'chl' | 'wind' | 'currents';
export interface MonthTarget { label: string; period: string; available: boolean; isOn: () => boolean; setOn: (on: boolean) => Promise<void>; apply: (month: number) => void | Promise<void>; attribution: string }
export interface AgoTarget { history: SeaHistory; attribution: string; apply: (level: number | null) => void; landNote: (level: number) => string }
export interface TimeHost {
  /** close the other tools (one tool at a time) */
  beforeOpen: () => void;
  layout: () => void;
  onChange: () => void;
}

const MODE_LABEL: Record<TimeMode, string> = { years: 'Years', months: 'Months', ago: 'Since the ice age' };
const MONTH_ORDER: MonthId[] = ['temp', 'chl', 'wind', 'currents'];

export class TimeUI {
  open = false;
  mode: TimeMode = 'years';
  set: YearSet = 'quakes';
  year = 2004;
  only = false;
  month = new Date().getUTCMonth() + 1;
  ago = 20500;
  playing = false;
  speed = 1;
  private span: { first: number; last: number; values: number[]; unit: string } | null = null;
  private applied = new Set<YearSet>();
  private monthApplied = false;
  private agoApplied = false;
  private raf = 0;
  private acc = 0;
  private lastT = 0;
  private busy: Promise<unknown> = Promise.resolve();
  private hashTimer = 0;
  readonly stats = { steps: 0, frames: [] as number[] };
  private reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private host: TimeHost, readonly years: Record<YearSet, YearTarget | null>, readonly months: Record<MonthId, MonthTarget | null>, readonly agoT: AgoTarget | null) {
    $('time-modes').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');
      if (b && !b.disabled) this.setMode(b.dataset.mode as TimeMode);
    });
    this.radioKeys($('time-modes'), 'button[data-mode]:not([disabled])');
    $('time-sets').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-set]');
      if (!b) return;
      if (this.mode === 'years') this.follow(b.dataset.set as YearSet);
      else if (this.mode === 'months') this.toggleMonthLayer(b.dataset.set as MonthId);
    });
    $<HTMLInputElement>('time-range').addEventListener('input', (e) => { this.setPlaying(false); this.seek(this.fromRange(Number((e.target as HTMLInputElement).value))); });
    $('time-play').addEventListener('click', () => this.setPlaying(!this.playing));
    $('time-back').addEventListener('click', () => { this.setPlaying(false); this.step(-1); });
    $('time-fwd').addEventListener('click', () => { this.setPlaying(false); this.step(1); });
    $('time-speed').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-speed]');
      if (b) { this.speed = Number(b.dataset.speed); this.renderControls(); }
    });
    $('time-only').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-only]');
      if (b) { this.only = b.dataset.only === '1'; this.applyYear(); this.render(); this.writeHash(); }
    });
    $('time-btn').addEventListener('click', () => (this.open ? this.close() : this.show()));
    $('time-close').addEventListener('click', () => this.close());
    // keyboard inside the panel: Space plays / pauses (not on a button, which Space already presses), [ ] step
    $('time').addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key === ' ' && !t.matches('button, select')) { e.preventDefault(); this.setPlaying(!this.playing); }
      else if (e.key === '[' || e.key === ']') { e.preventDefault(); this.setPlaying(false); this.step(e.key === ']' ? 1 : -1); }
    });
    document.addEventListener('visibilitychange', () => { this.lastT = 0; });
    $('time-modes').innerHTML = (['years', 'months', 'ago'] as TimeMode[]).map((m) => `<button type="button" role="radio" data-mode="${m}" aria-checked="false"${this.modeAvailable(m) ? '' : ' disabled'}>${MODE_LABEL[m]}</button>`).join('');
    $('time-speed').innerHTML = SPEEDS.map((s) => `<button type="button" role="radio" data-speed="${s}" aria-checked="false" aria-label="${s} times speed">${s === 0.5 ? '½' : s}×</button>`).join('');
    this.radioKeys($('time-speed'), 'button[data-speed]');
  }

  /** Arrow keys move between the options of a radio group (and select them). */
  private radioKeys(el: HTMLElement, sel: string) {
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const bs = [...el.querySelectorAll<HTMLButtonElement>(sel)];
      const i = bs.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
      n.focus(); n.click(); e.preventDefault();
    });
  }

  modeAvailable(m: TimeMode): boolean {
    if (m === 'years') return YEAR_SETS.some((s) => this.years[s]?.available);
    if (m === 'months') return MONTH_ORDER.some((s) => this.months[s]?.available);
    return !!this.agoT;
  }
  get state(): TimeState {
    if (this.mode === 'months') return { mode: 'months', month: this.month };
    if (this.mode === 'ago') return { mode: 'ago', ago: this.ago };
    return { mode: 'years', set: this.set, year: this.year, only: this.only };
  }

  // ---------- open / close ----------
  async show(s?: TimeState | { mode: TimeMode; set?: YearSet }) {
    if (!this.open) {
      this.host.beforeOpen();
      this.open = true;
      $('time').hidden = false;
      $('ui').classList.add('time-open');
      $('time-btn').setAttribute('aria-pressed', 'true');
      $('time-offer').hidden = true;
    }
    const mode = s?.mode ?? this.mode;
    if (s && 'year' in s) { this.set = s.set; this.year = s.year; this.only = s.only; }
    else if (s && 'set' in s && s.set) this.set = s.set;
    if (s && 'month' in s) this.month = s.month;
    if (s && 'ago' in s) this.ago = s.ago;
    await this.setMode(this.modeAvailable(mode) ? mode : (['years', 'months', 'ago'] as TimeMode[]).find((m) => this.modeAvailable(m))!, true);
    this.host.layout();
  }
  close(writeHash = true) {
    if (!this.open) return;
    this.setPlaying(false);
    this.resetMode(this.mode);
    this.open = false;
    $('time').hidden = true;
    $('ui').classList.remove('time-open');
    $('time-btn').setAttribute('aria-pressed', 'false');
    if (writeHash) this.writeHash();
    this.host.onChange();
    this.host.layout();
  }
  /** Undo what a mode did to the map: all years shown, annual means, today's sea level. */
  private resetMode(m: TimeMode) {
    if (m === 'years') { for (const s of this.applied) this.years[s]?.apply(null, false); this.applied.clear(); }
    if (m === 'months' && this.monthApplied) { for (const id of MONTH_ORDER) this.months[id]?.apply(0); this.monthApplied = false; }
    if (m === 'ago' && this.agoApplied) { this.agoT?.apply(null); this.agoApplied = false; }
  }

  async setMode(m: TimeMode, force = false) {
    if (m === this.mode && !force) return;
    this.setPlaying(false);
    if (m !== this.mode) this.resetMode(this.mode);
    this.mode = m;
    $('time').dataset.mode = m;
    if (m === 'years') {
      if (!this.years[this.set]?.available) this.set = YEAR_SETS.find((s) => this.years[s]?.available)!;
      await this.follow(this.set, true);
      return;
    }
    if (m === 'months') {
      // nothing monthly on yet: the July-monsoon pairing, phytoplankton and winds
      if (!MONTH_ORDER.some((id) => this.months[id]?.isOn())) {
        await Promise.all([this.months.chl?.setOn(true), this.months.wind?.setOn(true)]);
      }
      this.span = { first: 1, last: 12, values: [], unit: '' };
    } else {
      const h = this.agoT!.history;
      this.span = { first: 0, last: Math.round(h.ago[h.ago.length - 1] / 100) * 100, values: [], unit: '' };
      this.ago = Math.min(this.ago, this.span.last);
    }
    this.renderStrip();
    await this.applyCurrent();
    this.render();
    this.writeHash();
  }

  /** Years: follow a set (its range, strip and headline); its layer is switched on if it was off. */
  async follow(set: YearSet, force = false) {
    const t = this.years[set];
    if (!t?.available || (set === this.set && !force && this.span)) return;
    this.set = set;
    if (!t.isOn()) await t.turnOn();
    this.span = await t.timeline();
    this.year = Math.max(this.span.first, Math.min(this.span.last, this.year));
    if (!t.supportsOnly) this.only = false;
    this.renderStrip();
    await this.applyYear();
    this.render();
    this.writeHash();
  }
  /** A layer was switched on or off elsewhere: apply the current time to it, follow another set if needed. */
  async layerChanged() {
    if (!this.open) return;
    if (this.mode === 'years') {
      if (!this.years[this.set]?.isOn()) {
        const other = YEAR_SETS.find((s) => this.years[s]?.available && this.years[s]!.isOn());
        if (other) { await this.follow(other); return; }
      }
      await this.applyYear();
    }
    if (this.mode === 'months') await this.applyCurrent();
    this.render();
  }
  private async toggleMonthLayer(id: MonthId) {
    const t = this.months[id];
    if (!t?.available) return;
    await t.setOn(!t.isOn());
    await this.applyCurrent();
    this.render();
  }

  // ---------- applying the time ----------
  private applyYear(): Promise<unknown> {
    const jobs: unknown[] = [];
    for (const s of YEAR_SETS) {
      const t = this.years[s];
      if (!t?.available) continue;
      if (t.isOn() || s === this.set) { jobs.push(t.apply(this.year, s === 'quakes' && this.only)); this.applied.add(s); }
      else if (this.applied.has(s)) { t.apply(null, false); this.applied.delete(s); }
    }
    this.busy = Promise.all(jobs);
    return this.busy;
  }
  private applyCurrent(): Promise<unknown> {
    if (this.mode === 'years') return this.applyYear();
    if (this.mode === 'months') {
      this.monthApplied = true;
      this.busy = Promise.all(MONTH_ORDER.map((id) => this.months[id]?.apply(this.month)));
      return this.busy;
    }
    this.agoApplied = true;
    this.agoT!.apply(levelAtAgo(this.agoT!.history, this.ago));
    this.busy = Promise.resolve();
    return this.busy;
  }
  /** Resolves when the last applied time step is drawn (test hook). */
  ready(): Promise<unknown> { return this.busy; }

  private get pos(): number { return this.mode === 'years' ? this.year : this.mode === 'months' ? this.month : this.span!.last - this.ago; }
  private fromRange(v: number): number { return this.mode === 'ago' ? this.span!.last - v : v; }
  /** Jump to a value (year, month 1..12, or years ago). */
  async seek(v: number) {
    if (!this.span) return;
    if (this.mode === 'years') this.year = Math.max(this.span.first, Math.min(this.span.last, Math.round(v)));
    else if (this.mode === 'months') this.month = ((Math.round(v) - 1 + 120) % 12) + 1;
    else this.ago = Math.max(0, Math.min(this.span.last, Math.round(v / 50) * 50));
    this.stats.steps++;
    const p = this.applyCurrent();
    this.render();
    this.writeHash();
    await p;
  }
  /** One step forward / back: a year, a month (wrapping), or 500 years (100 while playing). */
  step(dir: number, playingStep = false): boolean {
    if (!this.span) return false;
    if (this.mode === 'years') {
      const y = this.year + dir;
      if (y < this.span.first || y > this.span.last) return false;
      this.seek(y);
      if (dir > 0) this.years[this.set]?.pulse?.(y);
    } else if (this.mode === 'months') this.seek(this.month + dir);
    else {
      const d = playingStep ? (this.reduce.matches ? 1000 : 100) : 500;
      const a = this.ago - dir * d;
      if (a < 0 && this.ago === 0) return false;
      this.seek(Math.max(0, Math.min(this.span.last, a)));
    }
    return true;
  }

  // ---------- play ----------
  setPlaying(on: boolean) {
    if (on === this.playing) return;
    this.playing = on;
    $('time-play').setAttribute('aria-pressed', String(on));
    $('time-play').setAttribute('aria-label', on ? 'Pause' : 'Play');
    cancelAnimationFrame(this.raf);
    if (on && this.span) {
      // at the end of a range, play starts again from the beginning
      if (this.mode === 'years' && this.year >= this.span.last) this.seek(this.span.first);
      if (this.mode === 'ago' && this.ago <= 0) this.seek(this.span.last);
      this.acc = 0; this.lastT = 0;
      this.raf = requestAnimationFrame((t) => this.tick(t));
    }
    this.writeHash();
  }
  private tick(t: number) {
    if (!this.playing) return;
    if (this.lastT) {
      const dt = Math.min(250, t - this.lastT);
      if (this.stats.frames.length < 4000) this.stats.frames.push(t - this.lastT);
      this.acc += dt * this.speed;
      const span = this.span ? this.span.last - this.span.first : 1;
      const ms = this.mode === 'ago' && this.reduce.matches ? 600 : stepMs(this.mode, span);
      if (this.acc >= ms) {
        this.acc -= ms;
        if (this.acc > ms) this.acc = 0; // fell behind (slow frame): do not burst-step
        if (!this.step(1, true)) { this.setPlaying(false); return; }
      }
    }
    this.lastT = t;
    this.raf = requestAnimationFrame((x) => this.tick(x));
  }

  // ---------- rendering ----------
  private renderStrip() {
    const sp = this.span!, r = $<HTMLInputElement>('time-range');
    if (this.mode === 'ago') { r.min = '0'; r.max = String(sp.last); r.step = '50'; }
    else { r.min = String(sp.first); r.max = String(sp.last); r.step = '1'; }
    const W = 1000, H = 40;
    let svg = '';
    if (this.mode === 'years' && sp.values.length) {
      const n = sp.values.length, max = Math.max(...sp.values) || 1, bw = W / n;
      svg = sp.values.map((v, i) => { const h = Math.max(v > 0 ? 1.5 : 0, (H - 2) * (v / max)); return `<rect x="${(i * bw + bw * 0.12).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(0.8, bw * 0.76).toFixed(1)}" height="${h.toFixed(1)}" data-i="${i}"/>`; }).join('');
    } else if (this.mode === 'ago') {
      const h = this.agoT!.history, minL = Math.min(...(h.lo ?? h.level)), y = (l: number) => (H * l) / minL;
      const x = (a: number) => W * (1 - a / sp.last);
      const pts = h.ago.filter((a) => a <= sp.last).map((a, i) => `${x(a).toFixed(1)},${y(h.level[i]).toFixed(1)}`);
      const band = h.lo && h.hi ? `<path class="band" d="M${h.ago.map((a, i) => `${x(a).toFixed(1)},${y(h.hi![i]).toFixed(1)}`).join(' L')} L${[...h.ago].reverse().map((a, i) => `${x(a).toFixed(1)},${y(h.lo![h.ago.length - 1 - i]).toFixed(1)}`).join(' L')} Z"/>` : '';
      svg = `<path class="sea" d="M0,0 L${pts.join(' L')} L0,0 Z"/>${band}<path class="edge" d="M${pts.join(' L')}" vector-effect="non-scaling-stroke"/>`;
    }
    $('time-strip').innerHTML = svg ? `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg}</svg><span class="time-marker" id="time-marker"></span>${sp.unit ? `<span class="time-strip-label">${sp.unit}</span>` : ''}` : '';
    $('time-strip').hidden = !svg;
    // ticks
    let ticks: [number, string][] = [];
    if (this.mode === 'years') {
      // fewer labels when the panel is narrow (phone, short windows where it docks in the right column)
      const narrow = $('time').clientWidth < 560;
      const span = sp.last - sp.first, step = span > 60 ? (narrow ? 50 : 25) : span > 20 ? (narrow ? 10 : 5) : narrow && span > 5 ? 2 : 1;
      for (let y = Math.ceil(sp.first / step) * step; y <= sp.last; y += step) ticks.push([y, String(y)]);
      if (ticks[0]?.[0] !== sp.first && (ticks[0]?.[0] ?? Infinity) - sp.first > step / 3) ticks.unshift([sp.first, String(sp.first)]);
      if (ticks[ticks.length - 1][0] !== sp.last && sp.last - ticks[ticks.length - 1][0] > step / 3) ticks.push([sp.last, String(sp.last)]);
    } else if (this.mode === 'months') ticks = MONTH_SHORT.map((m, i) => [i + 1, window.innerWidth < 600 ? m[0] : m]);
    else {
      const st = $('time').clientWidth < 560 ? 10000 : 5000;
      for (let a = Math.floor(sp.last / st) * st; a >= 0; a -= st) ticks.push([sp.last - a, a ? `${a / 1000}k` : 'Today']);
    }
    const lo = Number(r.min), hi = Number(r.max);
    $('time-ticks').innerHTML = ticks.map(([v, l]) => `<span style="left:${((100 * (v - lo)) / (hi - lo || 1)).toFixed(2)}%">${l}</span>`).join('');
    $('time-ticks').classList.toggle('months', this.mode === 'months');
  }

  private render() {
    if (!this.span) return;
    const r = $<HTMLInputElement>('time-range');
    r.value = String(this.pos);
    const sp = this.span, lo = Number(r.min), hi = Number(r.max);
    const frac = (this.pos - lo) / (hi - lo || 1);
    const mk = document.getElementById('time-marker');
    if (mk) mk.style.left = `${(100 * frac).toFixed(2)}%`;
    document.querySelectorAll<SVGRectElement>('#time-strip rect').forEach((b) => b.classList.toggle('now', this.mode === 'years' && Number(b.dataset.i) + sp.first === this.year));
    let value = '', unit = '', head = { main: '', sub: '' }, note = '', aria = '';
    if (this.mode === 'years') {
      const t = this.years[this.set]!;
      value = String(this.year); aria = value;
      head = t.headline(this.year, this.only);
      note = t.note;
    } else if (this.mode === 'months') {
      value = MONTH_LONG[this.month - 1]; aria = value;
      const on = MONTH_ORDER.map((id) => this.months[id]).filter((t): t is MonthTarget => !!t?.available && t.isOn());
      head = on.length
        ? { main: `${listText(on.map((t) => `${t.label.toLowerCase()} ${t.period}`)).replace(/^./, (c) => c.toUpperCase())}, averaged over every ${value}.`, sub: '' }
        : { main: 'Switch on a layer below to see its seasons.', sub: '' };
      note = on.map((t) => t.attribution).join('. ');
    } else {
      const a = this.agoT!, L = levelAtAgo(a.history, this.ago);
      value = this.ago ? Math.round(this.ago).toLocaleString('en-US') : 'Today';
      unit = this.ago ? 'years ago' : '';
      aria = formatAgo(this.ago);
      const k = a.history.ago.findIndex((x) => x >= this.ago);
      const band = a.history.lo && a.history.hi && k >= 0 ? (a.history.hi[k] - a.history.lo[k]) / 2 : NaN;
      head = { main: `Sea level <strong>${L < -0.05 ? '−' : ''}${Math.abs(L).toFixed(L > -10 ? 1 : 0)} m</strong>${Number.isFinite(band) && band > 0.05 ? ` (±${band.toFixed(band < 10 ? 1 : 0)} m)` : ''}; ${a.landNote(L)}`, sub: agoEvent(this.ago, a.history) };
      note = `${a.attribution}. A global mean: local coasts differed, and today’s land and seafloor are simply flooded or drained.`;
    }
    $('time-value').textContent = value;
    $('time-unit').textContent = unit;
    $('time-value').setAttribute('aria-label', aria);
    r.setAttribute('aria-valuetext', aria);
    $('time-headline').innerHTML = head.main;
    $('time-sub').textContent = head.sub;
    $('time-sub').hidden = !head.sub;
    $('time-note').textContent = note;
    $('time-sum').textContent = `${aria}${this.mode === 'years' ? `, ${YEAR_SET_LABEL[this.set].toLowerCase()}` : ''}`;
    this.renderControls();
    this.host.onChange();
  }

  private renderControls() {
    $('time-modes').querySelectorAll<HTMLButtonElement>('button').forEach((b) => { b.setAttribute('aria-checked', String(b.dataset.mode === this.mode)); b.tabIndex = b.dataset.mode === this.mode ? 0 : -1; });
    $('time-speed').querySelectorAll<HTMLButtonElement>('button').forEach((b) => { const on = Number(b.dataset.speed) === this.speed; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    const sets = $('time-sets');
    if (this.mode === 'years') {
      sets.setAttribute('role', 'radiogroup'); sets.setAttribute('aria-label', 'Follow');
      sets.innerHTML = `<span class="time-sets-label" aria-hidden="true">Follow</span>` + YEAR_SETS.filter((s) => this.years[s]?.available).map((s) =>
        `<button type="button" role="radio" data-set="${s}" aria-checked="${s === this.set}"${this.years[s]!.isOn() && s !== this.set ? ' class="also"' : ''}>${YEAR_SET_LABEL[s]}</button>`).join('');
    } else if (this.mode === 'months') {
      sets.setAttribute('role', 'group'); sets.setAttribute('aria-label', 'Layers that follow the month');
      sets.innerHTML = `<span class="time-sets-label" aria-hidden="true">Show</span>` + MONTH_ORDER.filter((id) => this.months[id]?.available).map((id) =>
        `<button type="button" data-set="${id}" aria-pressed="${this.months[id]!.isOn()}">${this.months[id]!.label}</button>`).join('');
    } else sets.innerHTML = '';
    sets.hidden = this.mode === 'ago';
    const onlyOk = this.mode === 'years' && !!this.years[this.set]?.supportsOnly;
    $('time-only').hidden = !onlyOk;
    $('time-only').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.only === '1') === this.only)));
    const at0 = this.span && (this.mode === 'years' ? this.year <= this.span.first : this.mode === 'ago' ? this.ago >= this.span.last : false);
    const atEnd = this.span && (this.mode === 'years' ? this.year >= this.span.last : this.mode === 'ago' ? this.ago <= 0 : false);
    $<HTMLButtonElement>('time-back').disabled = !!at0;
    $<HTMLButtonElement>('time-fwd').disabled = !!atEnd;
  }

  // ---------- deep link ----------
  writeHash() {
    clearTimeout(this.hashTimer);
    const write = () => {
      const h = hashWithTime(location.hash, this.open ? this.state : null);
      if (h !== location.hash && !(h === '' && location.hash === '')) history.replaceState(null, '', h || location.pathname + location.search);
    };
    // at once for a deliberate change, throttled while playing
    if (this.playing) this.hashTimer = window.setTimeout(write, 600); else write();
  }

  /** Frame intervals while playing, since the last call (QA). */
  takeStats() {
    const a = [...this.stats.frames].sort((x, y) => x - y), q = (p: number) => (a.length ? +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2) : null);
    const out = { steps: this.stats.steps, frames: a.length, medianMs: q(0.5), p95Ms: q(0.95) };
    this.stats.steps = 0; this.stats.frames = [];
    return out;
  }
}

function listText(xs: string[]): string {
  return xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? '');
}
/** One line for the moments people ask about (values from the data file, Lambeck et al. 2014). */
function agoEvent(ago: number, h: SeaHistory): string {
  if (h.lgm && Math.abs(ago - h.lgm.ago) <= 700) return `Last Glacial Maximum: the lowest sea in this record, ${Math.abs(h.lgm.level).toFixed(0)} m below today, about ${(Math.round(h.lgm.ago / 100) * 100).toLocaleString('en-US')} years ago.`;
  if (ago <= 14650 && ago >= 14000) return 'Meltwater Pulse 1A: the sea rose about 16 m in some 600 years (14,600 to 14,000 years ago) as ice sheets collapsed.';
  if (ago > 0 && ago <= 7000) return 'By 7,000 years ago the sea was within about 5 m of today’s level.';
  return '';
}
