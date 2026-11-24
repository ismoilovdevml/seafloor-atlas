// One control rail above the readout: the compass needle shows where north is and turns the map back to it, the 3D
// button tilts the camera (and flattens it again), the ruler starts the measure tool (wired in main.ts). Turning the
// view stays on the gestures (right-drag, two fingers, Shift + arrow keys); turned() is kept for keyboard use.
import type { Map as MlMap } from 'maplibre-gl';

export const TURN_DEG = 45;
export const TILT_DEG = 60;
const FLAT_BELOW = 8; // pitch under this counts as flat (2D)

/** Bearing after turning by delta degrees, in (-180, 180]. */
export function turned(bearing: number, delta: number): number {
  let b = ((bearing + delta) % 360 + 360) % 360;
  if (b > 180) b -= 360;
  return Math.round(b * 1000) / 1000;
}

/** Pitch the 3D button goes to from the current pitch, and the label it shows for that action. */
export function nextTilt(pitch: number): { pitch: number; label: '3D' | '2D' } {
  return pitch < FLAT_BELOW ? { pitch: TILT_DEG, label: '3D' } : { pitch: 0, label: '2D' };
}

/** What the 3D button says at this pitch: its visible text and its accessible name name the same action, so a
 *  screen reader never hears "3D tilted view" on a button that shows "2D". */
export function tiltButton(pitch: number): { text: '3D' | '2D'; name: string; tilted: boolean } {
  const { label } = nextTilt(pitch);
  return label === '3D'
    ? { text: '3D', name: 'Tilt the view (3D)', tilted: false }
    : { text: '2D', name: 'Look straight down (2D)', tilted: true };
}


export function mountNav3d(map: MlMap, host: HTMLElement): { el: HTMLElement; sync: () => void } {
  const el = document.createElement('div');
  el.className = 'nav3d';
  el.id = 'nav3d';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Map orientation');
  el.innerHTML = `
    <button type="button" class="nav3d-btn nav3d-compass" id="nav-north" aria-label="Turn north up" title="North up">
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><g class="needle"><path d="M12 3 15 12H9Z" fill="#e5484d"/><path d="M12 21 9 12h6Z" fill="#e6eef0"/></g></svg>
    </button>
    <button type="button" class="nav3d-btn nav3d-tilt" id="nav-tilt" aria-label="Tilt the view (3D)" title="Tilt the view (3D)">3D</button>
    <button type="button" class="nav3d-btn nav3d-measure" id="nav-measure" aria-pressed="false" aria-label="Measure distance" title="Measure distance">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="2.5" y="7.5" width="19" height="9" rx="1.5" transform="rotate(-35 12 12)"/><path d="m8.2 9.6 1.4 2M10.9 7.7l1 1.4M13.6 5.8l1.4 2M6.4 12.2l1 1.4" stroke-linecap="round" transform="translate(1.6 2.2)"/></svg>
    </button>`;
  host.appendChild(el);
  const needle = el.querySelector<SVGGElement>('.needle')!;
  const tilt = el.querySelector<HTMLButtonElement>('#nav-tilt')!;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const sync = () => {
    needle.style.transform = `rotate(${-map.getBearing()}deg)`;
    // an action button (its name says what a press does), not a toggle: the tilted look comes from data-tilted
    const b = tiltButton(map.getPitch());
    tilt.textContent = b.text;
    tilt.setAttribute('aria-label', b.name);
    tilt.title = b.name;
    tilt.toggleAttribute('data-tilted', b.tilted);
  };
  // a new ease stops the running one, so clicks in quick succession keep each other's targets (north + 3D both land)
  let goal: { bearing?: number; pitch?: number } = {};
  const go = (g: { bearing?: number; pitch?: number }) => {
    goal = { ...goal, ...g };
    if (reduceMotion.matches) map.jumpTo(goal);
    else map.easeTo({ ...goal, duration: 450 });
  };
  map.on('moveend', () => { goal = {}; });
  el.querySelector('#nav-north')!.addEventListener('click', () => go({ bearing: 0 }));
  tilt.addEventListener('click', () => go({ pitch: nextTilt(goal.pitch ?? map.getPitch()).pitch }));
  map.on('rotate', sync);
  map.on('pitch', sync);
  sync();
  return { el, sync };
}
