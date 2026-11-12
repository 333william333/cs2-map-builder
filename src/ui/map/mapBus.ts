import type { Map as MlMap } from 'maplibre-gl';
import { createFrame } from '../../core/geo/frame';
import { CS2, type Selection } from '../../core/types';

/**
 * Tiny module that lets components outside MapView (TopBar) reach the map instance
 * or request a camera move, without touching the zustand store shape.
 */

let map: MlMap | null = null;
let pending: { sel: Selection; animate: boolean } | null = null;

export const FIT_PADDING_PX = 90;

function doFit(m: MlMap, sel: Selection, animate: boolean): void {
  const [s, w, n, e] = createFrame(sel).bbox(CS2.PLAYABLE_SIZE_M);
  m.fitBounds(
    [[w, s], [e, n]],
    { padding: FIT_PADDING_PX, maxZoom: 17, animate, duration: 1600 },
  );
}

export function registerMap(m: MlMap | null): void {
  map = m;
  if (m && pending) {
    const p = pending;
    pending = null;
    doFit(m, p.sel, p.animate);
  }
}

export function getMap(): MlMap | null {
  return map;
}

/** Fits the camera to a selection square (queued if the map is not mounted yet). */
export function fitSelection(sel: Selection, animate = false): void {
  if (map) doFit(map, sel, animate);
  else pending = { sel, animate };
}

/** Animated fly-to used by place search. */
export function flyToSelection(sel: Selection): void {
  fitSelection(sel, true);
}
