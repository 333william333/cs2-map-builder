import type { Pt } from '../types';
import { CS2 } from '../types';

/** Half the playable side in game metres. */
export const HALF = CS2.PLAYABLE_SIZE_M / 2;
/** Perimeter of the playable square. */
export const PERIMETER = 8 * HALF;
/** Keep road and rail connections this far from the corners (the connector refuses corners). */
export const ROAD_CORNER_MARGIN = 320;
/** Margin for connections that do not need a road (ship, air, power, water). */
export const OTHER_CORNER_MARGIN = 48;

export type Side = 'north' | 'east' | 'south' | 'west';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Nearest point on the playable border. `margin` keeps the point away from the corners. */
export function snapToBorder(p: Pt, margin = 0): Pt {
  const lim = HALF - margin;
  const x = clamp(p[0], -HALF, HALF);
  const z = clamp(p[1], -HALF, HALF);
  const dW = x + HALF, dE = HALF - x, dS = z + HALF, dN = HALF - z;
  const m = Math.min(dW, dE, dS, dN);
  if (m === dN) return [clamp(x, -lim, lim), HALF];
  if (m === dE) return [HALF, clamp(z, -lim, lim)];
  if (m === dS) return [clamp(x, -lim, lim), -HALF];
  return [-HALF, clamp(z, -lim, lim)];
}

/** Distance (game m) from a point to the border, 0 on the border, also for points outside. */
export function borderDistance(p: Pt): number {
  const dx = HALF - Math.abs(p[0]);
  const dz = HALF - Math.abs(p[1]);
  return Math.abs(Math.min(dx, dz));
}

/** Which side of the square a border point is on (ties: north, east, south, west). */
export function sideOf(p: Pt): Side {
  const q = snapToBorder(p);
  if (q[1] === HALF) return 'north';
  if (q[0] === HALF) return 'east';
  if (q[1] === -HALF) return 'south';
  return 'west';
}

/** Position along the border, clockwise from the top-left corner, in 0 .. PERIMETER. */
export function borderParam(p: Pt): number {
  const q = snapToBorder(p);
  const side = 2 * HALF;
  switch (sideOf(q)) {
    case 'north': return q[0] + HALF;
    case 'east': return side + (HALF - q[1]);
    case 'south': return 2 * side + (HALF - q[0]);
    default: return 3 * side + (q[1] + HALF);
  }
}

/** Inverse of {@link borderParam}; wraps around. */
export function borderPointAt(t: number): Pt {
  const side = 2 * HALF;
  const u = ((t % PERIMETER) + PERIMETER) % PERIMETER;
  if (u < side) return [-HALF + u, HALF];
  if (u < 2 * side) return [HALF, HALF - (u - side)];
  if (u < 3 * side) return [HALF - (u - 2 * side), -HALF];
  return [-HALF, -HALF + (u - 3 * side)];
}
