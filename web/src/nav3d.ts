// Compass and 3D switch beside the readout: the needle shows where north is and turns the map back to it, the
// arrows turn the view by 45 degrees, the 3D button tilts the camera (and flattens it again). Mouse and touch
// gestures still do the same; this makes the state visible and the moves reachable without a right-drag.
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

const ARROW = (flip: boolean) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${flip ? ' style="transform:scaleX(-1)"' : ''}><path d="M7 7a7 7 0 1 1-1.6 7.3"/><path d="M7 3v4h4"/></svg>`;

export function mountNav3d(map: MlMap, host: HTMLElement): { el: HTMLElement; sync: () => void } {
  const el = document.createElement('div');
  el.className = 'nav3d';
  el.id = 'nav3d';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Map orientation');
  el.innerHTML = `
    <div class="nav3d-ring">
      <button type="button" class="nav3d-turn" id="nav-left" aria-label="Rotate the map anticlockwise" title="Rotate anticlockwise">${ARROW(false)}</button>
      <button type="button" class="nav3d-compass" id="nav-north" aria-label="Turn north up" title="North up">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><g class="needle"><path d="M12 2.5 15.2 12H8.8Z" fill="#e5484d"/><path d="M12 21.5 8.8 12h6.4Z" fill="#e6eef0"/></g></svg>
      </button>
      <button type="button" class="nav3d-turn" id="nav-right" aria-label="Rotate the map clockwise" title="Rotate clockwise">${ARROW(true)}</button>
    </div>
    <button type="button" class="nav3d-tilt" id="nav-tilt" aria-pressed="false" title="Tilt the view">3D</button>
    <button type="button" class="nav3d-tilt nav3d-measure" id="nav-measure" aria-pressed="false" aria-label="Measure distance" title="Measure distance">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="2.5" y="7.5" width="19" height="9" rx="1.5" transform="rotate(-35 12 12)"/><path d="m8.2 9.6 1.4 2M10.9 7.7l1 1.4M13.6 5.8l1.4 2M6.4 12.2l1 1.4" stroke-linecap="round" transform="translate(1.6 2.2)"/></svg>
    </button>`;
  host.appendChild(el);
  const needle = el.querySelector<SVGGElement>('.needle')!;
  const tilt = el.querySelector<HTMLButtonElement>('#nav-tilt')!;
  const ease = { duration: 450, essential: true };

  const sync = () => {
    needle.style.transform = `rotate(${-map.getBearing()}deg)`;
    const flat = map.getPitch() < FLAT_BELOW;
    tilt.textContent = flat ? '3D' : '2D';
    tilt.setAttribute('aria-pressed', String(!flat));
    tilt.title = flat ? 'Tilt the view (3D)' : 'Look straight down (2D)';
  };
  // a new ease stops the running one, so clicks in quick succession keep each other's targets (north + 3D both land)
  let goal: { bearing?: number; pitch?: number } = {};
  const go = (g: { bearing?: number; pitch?: number }) => { goal = { ...goal, ...g }; map.easeTo({ ...goal, ...ease }); };
  map.on('moveend', () => { goal = {}; });
  el.querySelector('#nav-north')!.addEventListener('click', () => go({ bearing: 0 }));
  el.querySelector('#nav-left')!.addEventListener('click', () => go({ bearing: turned(goal.bearing ?? map.getBearing(), TURN_DEG) }));
  el.querySelector('#nav-right')!.addEventListener('click', () => go({ bearing: turned(goal.bearing ?? map.getBearing(), -TURN_DEG) }));
  tilt.addEventListener('click', () => go({ pitch: nextTilt(goal.pitch ?? map.getPitch()).pitch }));
  map.on('rotate', sync);
  map.on('pitch', sync);
  sync();
  return { el, sync };
}
