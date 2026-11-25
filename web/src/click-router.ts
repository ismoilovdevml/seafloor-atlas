// Map clicks and pointer cursors (split from main.ts): one click handler routes a click to the ruler, the depth
// profile, the AMOC line, the ocean-water column, a clickable feature (names, plates, seal dives, overlays,
// earthquakes, seamounts), a marine-life card or the point inspector, in that order. Also the right-click
// "Measure distance" menu.
import type * as maplibregl from 'maplibre-gl';
import type { MapGeoJSONFeature } from 'maplibre-gl';
import { FEATURE_LAYERS } from './style';
import { sealCard, type SealProps } from './certainty';
import { amocCard } from './amoc';
import { $, appReady, map, measureTool } from './app-state';
import { showCard, showFeature, showPlate, type FeatureProps } from './cards-ui';
import { canInspect, inspect, readout } from './inspector-ui';
import { ATTRIBUTION_SEALS, amocLast, certaintyOn, eventsUI, marine, overlays, tPlates } from './layers-ui';
import { profileA, profilePts, profiling, runProfile, setProfileStart, water } from './tools-ui';
import { updatePadding } from './layout-ui';

/** "Measure distance" on right-click (the ruler under the compass is measure.ts's own). */
export function initContextMenu() {
    const menu = document.createElement('div');
    menu.className = 'ctx-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
    menu.innerHTML = '<button type="button" role="menuitem">Measure distance</button>';
    document.body.appendChild(menu);
    let at: [number, number] | null = null;
    const hide = () => { menu.hidden = true; };
    map.on('contextmenu', (e) => {
      e.preventDefault();
      at = [e.lngLat.lng, e.lngLat.lat];
      menu.style.left = `${Math.min(e.originalEvent.clientX, window.innerWidth - 190)}px`;
      menu.style.top = `${Math.min(e.originalEvent.clientY, window.innerHeight - 60)}px`;
      menu.hidden = false;
      menu.querySelector('button')!.focus({ preventScroll: true });
    });
    menu.querySelector('button')!.addEventListener('click', () => { hide(); if (at) measureTool.start(at); });
    map.on('movestart', hide); map.on('click', hide);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target as Node)) hide(); });
}

/** Click tolerance (px each side) for thin lines and small symbols; the AMOC hover cursor uses the same box. */
export const HIT_PX = 6;
export const hitBox = (p: maplibregl.Point): [maplibregl.PointLike, maplibregl.PointLike] => [[p.x - HIT_PX, p.y - HIT_PX], [p.x + HIT_PX, p.y + HIT_PX]];
/** The AMOC line is on the map and within the box. */
export const amocHit = (box: [maplibregl.PointLike, maplibregl.PointLike]) => !!map.getLayer('amoc-line') && map.getLayoutProperty('amoc-line', 'visibility') !== 'none'
  && map.queryRenderedFeatures(box, { layers: ['amoc-line', 'amoc-casing'] }).length > 0;
export function initClickRouter() {
  map.on('click', (e) => {
    // until the end of this module has run, the panels a click opens (and the layout code) are not all there yet
    if (!appReady) return;
    if (measureTool.active) return; // measure.ts handles the click
    if (profiling) {
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (!profileA || profilePts) {
        setProfileStart(p);
        $('profile-stats').hidden = true; $('profile-status').hidden = false;
        $('profile-status').textContent = 'Now click the end point.';
      } else { runProfile(profileA, p); }
      return;
    }
    readout(e.lngLat.lng, e.lngLat.lat);
    const box = hitBox(e.point);
    // the AMOC line first: a thin line in open water, where any other click would open the inspector or a marine card
    if (amocLast && amocHit(box)) {
      showCard(amocCard(amocLast)); updatePadding(); return;
    }
    if (water.open) water.showColumn(e.lngLat.lng, e.lngLat.lat);
    const layers = [...FEATURE_LAYERS, ...overlays.clickableLayers(), ...(eventsUI?.clickable ?? []), ...(certaintyOn.has('seals') ? ['seals'] : []), ...(tPlates.checked ? ['plates'] : [])];
    const hit: MapGeoJSONFeature | undefined = map.queryRenderedFeatures(box, { layers })[0];
    if (!hit) {
      if (marine.on) marine.card(e.lngLat.lng, e.lngLat.lat).then((c) => { if (c) { showCard(c); updatePadding(); } });
      else if (canInspect()) inspect(e.lngLat.lng, e.lngLat.lat);
      return;
    }
    if (hit.layer.id === 'plates') showPlate(hit.properties);
    else if (hit.layer.id === 'seals') { const [lon, lat] = (hit.geometry as GeoJSON.Point).coordinates; showCard(sealCard(hit.properties as SealProps, lon, lat, ATTRIBUTION_SEALS)); updatePadding(); }
    else if (FEATURE_LAYERS.includes(hit.layer.id)) showFeature(hit.properties as FeatureProps);
    else if (eventsUI && (hit.layer.id === 'quakes' || hit.layer.id === 'seamounts')) {
      const r = eventsUI.card(hit);
      if (r) { showCard(r.card); overlays.highlightGeometry(r.geometry); updatePadding(); }
    }
    else overlays.cardFor(hit).then((c) => { if (c && c !== 'cluster') { showCard(c); updatePadding(); } });
  });
  // pointer only over an otherwise default cursor, so the profile / measure crosshair is never overwritten
  for (const id of [...FEATURE_LAYERS, 'plates']) {
    map.on('mouseenter', id, () => { if (!map.getCanvas().style.cursor) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { if (map.getCanvas().style.cursor === 'pointer') map.getCanvas().style.cursor = ''; });
  }
}
