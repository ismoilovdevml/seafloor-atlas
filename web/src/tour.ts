// Guided tour: a small guide (Ping, a sonar buoy) whose speech bubble drives the real UI. Each chapter sets
// the tools and layers it talks about, flies the camera, then spotlights the control it describes; it moves on
// by itself after the reading time (words at 200 per minute, at least 6 s) once the camera has settled.
// Back / Next / Pause / Exit, chapter dots, keys (Left / Right, Space, Esc), optional read-aloud (Web Speech,
// off by default), #tour=N deep link. Exiting restores the layers, tool, exaggeration and drawers the viewer
// had before. Loaded on demand (main.ts); scenes in tour-chapters.ts, words in tour-text-en.ts.
import './tour.css';
import { CHAPTERS } from './tour-chapters';
import { TEXT_EN } from './tour-text-en';
import { cameraFor, hashWithTour, nearCamera, readingMs, type TourCamera, type TourScene, type TourText, type TourTool } from './tour-model';

export interface TourHost {
  phone(): boolean;
  reduceMotion(): boolean;
  getLayers(): string[];
  setLayers(tokens: string[]): Promise<void>;
  getTool(): TourTool;
  setTool(t: TourTool): Promise<void>;
  getExaggeration(): number | 'auto';
  setExaggeration(v: number | 'auto'): void;
  getDrawers(): { explore: boolean; layers: boolean };
  setDrawers(d: { explore: boolean; layers: boolean }): void;
  camera(): { lng: number; lat: number; zoom: number };
  /** resolves when the move ends (or is interrupted) */
  fly(cam: TourCamera, instant: boolean): Promise<void>;
  /** stops a running camera move */
  stop(): void;
  /** resolves when the map has drawn its tiles, or after maxMs */
  idle(maxMs: number): Promise<void>;
  layout(): void;
  /** at globe scale, zoom out just enough that the whole globe fits beside the open panels */
  fit(): void;
  setTouring(on: boolean): void;
  /** calls back when the viewer moves the map themselves; returns the unsubscribe */
  onUserMove(cb: () => void): () => void;
  timePlay(on: boolean): void;
  /** gives focus back to the Tour button */
  focusStart(): void;
}
interface Snapshot { layers: string[]; tool: TourTool; exaggeration: number | 'auto'; drawers: { explore: boolean; layers: boolean } }

/** Ping: an original sonar-buoy glyph (hull with two eyes, mast light, waterline, sonar arcs). */
const AVATAR = `<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true" focusable="false">
  <circle cx="24" cy="24" r="23" class="tav-bg"/>
  <path d="M24 9.5v6.5" class="tav-mast"/>
  <circle cx="24" cy="8" r="2.5" class="tav-light"/>
  <path d="M15 26.5v-3.8a9 9 0 0 1 18 0v3.8z" class="tav-hull"/>
  <circle cx="20.6" cy="21.6" r="1.35" class="tav-eye"/><circle cx="27.4" cy="21.6" r="1.35" class="tav-eye"/>
  <path d="M7.5 27.2c2.7 0 2.7-1.6 5.4-1.6s2.7 1.6 5.4 1.6 2.7-1.6 5.4-1.6 2.7 1.6 5.4 1.6 2.7-1.6 5.4-1.6 2.7 1.6 5.4 1.6" class="tav-wave"/>
  <path d="M18.6 32.4a7.6 7.6 0 0 0 10.8 0" class="tav-arc a1"/>
  <path d="M14.6 36.4a13.2 13.2 0 0 0 18.8 0" class="tav-arc a2"/>
</svg>`;
const ICON = {
  back: '<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg class="i-play" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5v13l11-6.5z" fill="currentColor"/></svg><svg class="i-pause" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3.5h3.5v13H5zM11.5 3.5H15v13h-3.5z" fill="currentColor"/></svg>',
  voice: '<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 7.5h3l4-3.5v12l-4-3.5h-3z" fill="currentColor"/><path d="M13.3 7a4 4 0 0 1 0 6M15.6 4.8a7.2 7.2 0 0 1 0 10.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Shown on screen: laid out, not hidden by CSS, and at least partly inside the window. */
function onScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

export class Tour {
  active = false;
  index = 0;
  playing = true;
  settled = false;
  voice = false;
  /** id of the element spotlit now (null: none) */
  spotId: string | null = null;
  /** read aloud only where the browser has speech, and for a non-English tour only with a voice for that language */
  readonly canSpeak: boolean;
  readonly stats = { flights: 0, retries: 0, lastFlyMs: 0 };
  private token = 0;
  private elapsed = 0;
  private total = 0;
  private lastTick = 0;
  private interval = 0;
  private speaking = false;
  private utter: SpeechSynthesisUtterance | null = null;
  private snap: Snapshot | null = null;
  private spotIds: string[] | null = null;
  private unsubscribe: (() => void) | null = null;
  private root: HTMLElement;
  private spot: HTMLElement;
  private current: Promise<void> = Promise.resolve();
  /** tools and layers are applied one chapter at a time, so a quick Next or Exit never interleaves two */
  private applying: Promise<void> = Promise.resolve();

  constructor(private host: TourHost, readonly chapters: TourScene[] = CHAPTERS, private t: TourText = TEXT_EN) {
    const speech = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
    let voiced = t.lang === 'en';
    if (speech && !voiced) { try { voiced = speechSynthesis.getVoices().some((v) => v.lang.toLowerCase().startsWith(t.lang)); } catch { /* none */ } }
    this.canSpeak = speech && voiced;
    this.root = document.createElement('section');
    this.root.lang = t.lang; // screen readers and hyphenation follow the tour's language
    this.build(this.root);
    this.spot = document.createElement('div');
    this.spot.className = 'tour-spot';
    this.spot.setAttribute('aria-hidden', 'true');
    this.spot.hidden = true;
    document.body.append(this.spot);
  }

  private $<T extends HTMLElement = HTMLElement>(id: string) { return this.root.querySelector<T>(`#${id}`)!; }

  private build(el: HTMLElement) {
    const u = this.t.ui;
    el.className = 'tour';
    el.id = 'tour';
    el.hidden = true;
    el.setAttribute('aria-label', u.region);
    el.setAttribute('aria-describedby', 'tour-keys');
    el.innerHTML = `
      <div class="tour-head">
        <span class="tour-avatar">${AVATAR}</span>
        <p class="tour-count"><span class="tour-name">${u.region}</span><span id="tour-count"></span></p>
        <button type="button" class="close tour-exit" id="tour-exit" aria-label="${u.exit}"><svg width="18" height="18" aria-hidden="true"><use href="#i-close"/></svg></button>
      </div>
      <div class="tour-bubble">
        <div class="tour-say" id="tour-say" aria-live="polite" aria-atomic="true">
          <h2 class="tour-title" id="tour-title"></h2>
          <p class="tour-text" id="tour-text"></p>
        </div>
        <p class="tour-src" id="tour-src"></p>
      </div>
      <div class="tour-timer" aria-hidden="true"><span id="tour-timer-fill"></span></div>
      <div class="tour-dots" id="tour-dots" role="group" aria-label="${u.chapters}"></div>
      <div class="tour-ctrl">
        <button type="button" class="tour-btn" id="tour-back">${ICON.back}<span>${u.back}</span></button>
        <button type="button" class="tour-btn tour-play" id="tour-play">${ICON.play}<span id="tour-play-t">${u.pause}</span></button>
        <button type="button" class="tour-btn primary" id="tour-next"><span id="tour-next-t">${u.next}</span>${ICON.next}</button>
        <button type="button" class="tour-btn icon" id="tour-voice" aria-pressed="false" aria-label="${u.voiceOff}" title="${u.voiceOff}"${this.canSpeak ? '' : ' hidden'}>${ICON.voice}</button>
      </div>
      <p class="sr-only" id="tour-keys">${u.keys}</p>`;
    this.$('tour-dots').innerHTML = this.chapters.map((c, i) =>
      `<button type="button" class="tour-dot" data-i="${i}" aria-label="${u.chapter(i + 1, this.t.chapters[c.id].title)}" tabindex="-1"></button>`).join('');
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b) return;
      if (b.id === 'tour-exit') this.exit();
      else if (b.id === 'tour-back') this.back();
      else if (b.id === 'tour-next') this.next();
      else if (b.id === 'tour-play') this.setPlaying(!this.playing);
      else if (b.id === 'tour-voice') this.setVoice(!this.voice);
      else if (b.dataset.i) this.go(Number(b.dataset.i));
    });
    document.getElementById('ui')!.append(el);
  }

  // ---------- lifecycle ----------
  /** Starts (or jumps, when running) at chapter n (1-based); resolves when that chapter has settled. */
  start(n = 1): Promise<void> {
    if (!this.active) {
      this.snap = { layers: this.host.getLayers(), tool: this.host.getTool(), exaggeration: this.host.getExaggeration(), drawers: this.host.getDrawers() };
      this.active = true;
      this.playing = true;
      this.root.hidden = false;
      this.host.setTouring(true);
      this.host.setDrawers({ explore: false, layers: false });
      this.unsubscribe = this.host.onUserMove(() => { if (this.settled) this.setPlaying(false); });
      document.addEventListener('keydown', this.onKey);
      this.lastTick = performance.now();
      this.interval = window.setInterval(() => this.tick(), 200);
      window.addEventListener('resize', this.onResize);
      this.renderPlay();
      this.$('tour-play').focus({ preventScroll: true });
    }
    return this.go(n - 1);
  }

  /** Leaves the tour and puts back what the viewer had before (the camera stays where it is). */
  async exit(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.token++;
    this.settled = false;
    this.stopSpeech();
    this.host.timePlay(false);
    clearInterval(this.interval);
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.setSpot(null);
    this.root.hidden = true;
    this.host.setTouring(false);
    this.host.stop(); // ends a flight in progress, so the chapter being left gives up at once
    await this.applying;
    const s = this.snap;
    this.snap = null;
    if (s) {
      try { await this.host.setTool(s.tool); await this.host.setLayers(s.layers); } catch { /* a layer that failed to load stays off */ }
      this.host.setExaggeration(s.exaggeration);
      this.host.setDrawers(s.drawers);
    }
    this.writeHash(null);
    this.host.layout();
    this.host.focusStart();
  }

  next(): Promise<void> { return this.index < this.chapters.length - 1 ? this.go(this.index + 1) : this.exit(); }
  back(): Promise<void> { return this.index > 0 ? this.go(this.index - 1) : this.current; }

  setPlaying(on: boolean) {
    this.playing = on;
    this.lastTick = performance.now();
    if (!on) this.stopSpeech();
    else if (this.voice && this.settled) this.speak();
    this.renderPlay();
  }

  setVoice(on: boolean) {
    if (!this.canSpeak) return;
    this.voice = on;
    // a toggle keeps its name; aria-pressed carries the state
    this.$('tour-voice').setAttribute('aria-pressed', String(on));
    this.$('tour-voice').title = on ? this.t.ui.voiceOn : this.t.ui.voiceOff;
    if (on && this.settled) this.speak(); else if (!on) this.stopSpeech();
  }

  /** Goes to chapter i (0-based): tools and layers first, then the camera, then the spotlight and the timer. */
  go(i: number): Promise<void> {
    if (!this.active) return Promise.resolve();
    this.current = this.run(Math.max(0, Math.min(this.chapters.length - 1, i)));
    return this.current;
  }

  private async run(i: number) {
    const tok = ++this.token;
    const ch = this.chapters[i], tx = this.t.chapters[ch.id];
    const refocusDot = (document.activeElement as HTMLElement | null)?.classList?.contains('tour-dot');
    this.index = i;
    this.settled = false;
    this.elapsed = 0;
    this.total = readingMs(tx.text);
    this.stopSpeech();
    this.host.timePlay(false);
    this.setSpot(null);
    this.render();
    if (refocusDot) this.$('tour-dots').querySelector<HTMLButtonElement>(`[data-i="${i}"]`)?.focus();
    this.writeHash(i + 1);
    const prev = this.applying;
    let release = () => {};
    this.applying = new Promise<void>((r) => { release = r; });
    try {
      await prev;
      if (tok !== this.token) return;
      await this.host.setTool(ch.tool);
      if (tok !== this.token) return;
      await this.host.setLayers(ch.layers);
    } catch { /* a layer that failed to load: the chapter still runs */ } finally { release(); }
    if (tok !== this.token) return;
    this.host.setExaggeration(ch.exaggeration ?? 'auto');
    // let the panels the chapter opened take their size, then pad the map around them before flying
    // (setPadding stops a running camera animation)
    await frame(); await frame();
    if (tok !== this.token) return;
    this.host.layout();
    const cam = cameraFor(ch.camera, this.host.phone());
    const reduce = this.host.reduceMotion();
    const f0 = performance.now();
    for (let k = 0; k < 3; k++) {
      this.stats.flights++;
      if (k) this.stats.retries++;
      // a late layout change can interrupt a flight: continue it, the last try without animation
      await this.host.fly(cam, reduce || k === 2);
      if (tok !== this.token) return;
      if (nearCamera(this.host.camera(), cam)) break;
    }
    this.stats.lastFlyMs = Math.round(performance.now() - f0);
    this.host.fit();
    await this.host.idle(2500);
    if (tok !== this.token) return;
    if (ch.tool.kind === 'time' && ch.tool.play) this.host.timePlay(true);
    this.settled = true;
    this.lastTick = performance.now();
    this.setSpot(ch.spotlight);
    if (this.voice && this.playing) this.speak();
  }

  // ---------- timer, spotlight ----------
  private tick() {
    this.placeSpot();
    const now = performance.now(), dt = now - this.lastTick;
    this.lastTick = now;
    if (this.active && this.playing && this.settled) {
      this.elapsed += dt;
      // read-aloud holds the page until the voice ends (up to three reading times, in case it never reports)
      const done = this.elapsed >= this.total && (!this.speaking || this.elapsed >= 3 * this.total);
      if (done) {
        if (this.index < this.chapters.length - 1) this.go(this.index + 1);
        else this.setPlaying(false);
      }
    }
    this.$('tour-timer-fill').style.transform = `scaleX(${this.total ? Math.min(1, this.elapsed / this.total).toFixed(3) : 0})`;
  }
  private onResize = () => this.placeSpot();

  private setSpot(ids: string[] | null) {
    this.spotIds = ids;
    const el = ids ? this.target() : null;
    // a section of the legend dock can sit below its scroll edge
    if (el && el.closest('#legend-body')) el.scrollIntoView({ block: 'nearest' });
    this.placeSpot();
  }
  /** The first of the chapter's controls that is on screen now. */
  private target(): HTMLElement | null {
    for (const id of this.spotIds ?? []) {
      const el = document.getElementById(id);
      if (el && onScreen(el)) return el;
    }
    return null;
  }
  private placeSpot() {
    const el = this.active && this.settled ? this.target() : null;
    this.spotId = el?.id ?? null;
    if (!el) { this.spot.hidden = true; return; }
    const r = el.getBoundingClientRect(), pad = 4;
    const s = this.spot.style;
    s.transform = `translate(${Math.round(r.left - pad)}px, ${Math.round(r.top - pad)}px)`;
    s.width = `${Math.round(r.width + 2 * pad)}px`;
    s.height = `${Math.round(r.height + 2 * pad)}px`;
    s.borderRadius = `${Math.min(14, Math.round(r.height / 2 + pad))}px`;
    this.spot.hidden = false;
  }

  // ---------- speech ----------
  private speak() {
    if (!this.canSpeak) return;
    try {
      speechSynthesis.cancel();
      const tx = this.t.chapters[this.chapters[this.index].id];
      const u = new SpeechSynthesisUtterance(`${tx.title}. ${tx.text}`);
      u.lang = this.t.lang;
      const end = () => { if (this.utter === u) { this.speaking = false; this.utter = null; } };
      u.onend = end;
      u.onerror = end;
      this.utter = u;
      this.speaking = true;
      speechSynthesis.speak(u);
    } catch { this.speaking = false; this.utter = null; }
  }
  private stopSpeech() {
    const was = this.speaking;
    this.speaking = false;
    this.utter = null;
    if (this.canSpeak && was) { try { speechSynthesis.cancel(); } catch { /* not available after all */ } }
  }

  // ---------- keys ----------
  private onKey = (e: KeyboardEvent) => {
    if (!this.active || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    const typing = t.matches?.('input:not([type="checkbox"]), textarea, select') || t.isContentEditable;
    if (e.key === 'Escape') {
      if (typing) return; // Esc first leaves the search box
      e.preventDefault(); this.exit(); return;
    }
    // the tool panels, a text field and the map (arrow keys pan) keep their own keys
    if (typing || t.closest?.('#time, #sea, #water, #profile, #map, .popover')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); this.next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.back(); }
    else if (e.key === ' ' && !t.closest('button, a, summary, [role="switch"], label')) { e.preventDefault(); this.setPlaying(!this.playing); }
  };

  // ---------- rendering ----------
  private render() {
    const i = this.index, n = this.chapters.length, ch = this.chapters[i], tx = this.t.chapters[ch.id], u = this.t.ui;
    this.$('tour-count').textContent = u.count(i + 1, n);
    this.$('tour-title').textContent = tx.title;
    // a number stays on the line of its unit ("10,935 m", "361.7 million km²") and of its thousands ("10 927")
    this.$('tour-text').textContent = tx.text.replace(/(\d) (?=(m|km|cm|sm|mg|million|years|yil|foiz|foizi|ta)\b|\d{3}\b)/g, '$1\u00a0');
    this.$('tour-src').textContent = `${u.sourcePrefix}${tx.source}`;
    this.root.dataset.chapter = ch.id;
    this.$('tour-dots').querySelectorAll<HTMLButtonElement>('button').forEach((b, k) => {
      if (k === i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.classList.toggle('seen', k < i);
      b.tabIndex = k === i ? 0 : -1;
    });
    this.$<HTMLButtonElement>('tour-back').disabled = i === 0;
    this.$('tour-next-t').textContent = i === n - 1 ? u.finish : u.next;
    this.$('tour-timer-fill').style.transform = 'scaleX(0)';
  }
  private renderPlay() {
    const b = this.$('tour-play');
    b.classList.toggle('paused', !this.playing);
    this.$('tour-play-t').textContent = this.playing ? this.t.ui.pause : this.t.ui.play;
    this.root.classList.toggle('playing', this.playing);
  }

  private writeHash(n: number | null) {
    const h = hashWithTour(location.hash, n);
    if (h !== location.hash && !(h === '' && location.hash === '')) history.replaceState(null, '', h || location.pathname + location.search);
  }

  /** QA: what the tour shows now. */
  state() {
    const sp = this.spotId ? document.getElementById(this.spotId)!.getBoundingClientRect() : null;
    const s = this.spot.getBoundingClientRect();
    return {
      active: this.active, index: this.index, n: this.chapters.length, id: this.chapters[this.index].id, playing: this.playing, settled: this.settled,
      voice: this.voice, canSpeak: this.canSpeak, title: this.$('tour-title').textContent, totalMs: this.total, elapsedMs: Math.round(this.elapsed),
      spot: { id: this.spotId, shown: !this.spot.hidden, target: sp && { left: sp.left, top: sp.top, w: sp.width, h: sp.height }, ring: { left: s.left, top: s.top, w: s.width, h: s.height },
        animation: getComputedStyle(this.spot).animationName, pointerEvents: getComputedStyle(this.spot).pointerEvents },
      layers: this.host.getLayers(), tool: this.host.getTool(), camera: this.host.camera(), hash: location.hash, stats: { ...this.stats },
      focus: document.activeElement?.id ?? null,
    };
  }
}
