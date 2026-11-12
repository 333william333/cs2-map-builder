import type { OutsideConnection, Pt } from '../../core/types';
import { CS2 } from '../../core/types';
import {
  HALF,
  OTHER_CORNER_MARGIN,
  ROAD_CORNER_MARGIN,
  snapToBorder,
} from '../../core/manual/border';

/**
 * Pure geometry for the top-down hand editor. The playable square (game metres, +gx right, +gz up)
 * is drawn into a square canvas of `size` CSS pixels with a `pad` pixel margin around it, north up.
 */
export interface EditorView {
  size: number;
  pad: number;
}

export interface Tile { col: number; row: number }

export const PLAYABLE_M = CS2.PLAYABLE_SIZE_M;
export const TILE_M = PLAYABLE_M / CS2.TILE_GRID;

/** Canvas pixels per game metre. */
export function viewScale(v: EditorView): number {
  return (v.size - 2 * v.pad) / PLAYABLE_M;
}

export function gameToCanvas(p: Pt, v: EditorView): Pt {
  const k = viewScale(v);
  return [v.pad + (p[0] + HALF) * k, v.pad + (HALF - p[1]) * k];
}

export function canvasToGame(px: Pt, v: EditorView): Pt {
  const k = viewScale(v);
  return [(px[0] - v.pad) / k - HALF, HALF - (px[1] - v.pad) / k];
}

/** Tile under a game point, or null outside the playable square. Row 0 is the top (north). */
export function tileAt(p: Pt): Tile | null {
  if (!(p[0] >= -HALF && p[0] <= HALF && p[1] >= -HALF && p[1] <= HALF)) return null;
  const col = Math.min(CS2.TILE_GRID - 1, Math.floor((p[0] + HALF) / TILE_M));
  const row = Math.min(CS2.TILE_GRID - 1, Math.floor((HALF - p[1]) / TILE_M));
  return { col, row };
}

export function tileCentre(t: Tile): Pt {
  return [-HALF + (t.col + 0.5) * TILE_M, HALF - (t.row + 0.5) * TILE_M];
}

/** Tile rectangle in game metres: west, east, south, north. */
export function tileBounds(t: Tile): { x0: number; x1: number; z0: number; z1: number } {
  return {
    x0: -HALF + t.col * TILE_M,
    x1: -HALF + (t.col + 1) * TILE_M,
    z1: HALF - t.row * TILE_M,
    z0: HALF - (t.row + 1) * TILE_M,
  };
}

/** Moves a tile by whole tiles and keeps it inside the grid. */
export function moveTile(t: Tile, dCol: number, dRow: number): Tile {
  const c = (v: number) => Math.min(CS2.TILE_GRID - 1, Math.max(0, v));
  return { col: c(t.col + dCol), row: c(t.row + dRow) };
}

export type ConnectionKind = OutsideConnection['kind'];

/** Corner margin for a connection kind (roads and rails need more room for the connector). */
export function cornerMargin(kind: ConnectionKind): number {
  return kind === 'road' || kind === 'rail' ? ROAD_CORNER_MARGIN : OTHER_CORNER_MARGIN;
}

/**
 * Snaps a pointer position to the border for adding a connection of `kind`.
 * Returns null when the pointer is further than `maxPx` canvas pixels from the border line.
 */
export function snapPointerToBorder(px: Pt, v: EditorView, kind: ConnectionKind, maxPx = 40): Pt | null {
  const g = canvasToGame(px, v);
  const q = snapToBorder(g, cornerMargin(kind));
  // distance to the (unmargined) border line in pixels
  const onBorder = snapToBorder(g, 0);
  const d = Math.hypot(onBorder[0] - g[0], onBorder[1] - g[1]) * viewScale(v);
  if (d > maxPx) return null;
  return q;
}

export interface MarkerLike { key: string; p: Pt }

/** Offset (canvas px) of the small remove badge relative to the marker centre. */
export const BADGE_OFFSET: Pt = [10, -10];
export const BADGE_RADIUS = 7;
export const MARKER_RADIUS = 13;

export interface MarkerHit<M extends MarkerLike> { marker: M; badge: boolean }

/**
 * Finds the marker under a canvas point. A hit on the remove badge wins over a hit on the marker
 * body; otherwise the nearest marker within `radius` wins. `hasBadge` says which markers show one.
 */
export function hitTestMarkers<M extends MarkerLike>(
  markers: M[],
  px: Pt,
  v: EditorView,
  hasBadge: (m: M) => boolean = () => false,
  radius = MARKER_RADIUS + 2,
): MarkerHit<M> | null {
  let best: MarkerHit<M> | null = null;
  let bestD = Infinity;
  for (const m of markers) {
    const c = gameToCanvas(m.p, v);
    if (hasBadge(m)) {
      const db = Math.hypot(px[0] - (c[0] + BADGE_OFFSET[0]), px[1] - (c[1] + BADGE_OFFSET[1]));
      if (db <= BADGE_RADIUS + 2 && db < bestD) { best = { marker: m, badge: true }; bestD = db; }
    }
  }
  if (best) return best;
  for (const m of markers) {
    const c = gameToCanvas(m.p, v);
    const d = Math.hypot(px[0] - c[0], px[1] - c[1]);
    if (d <= radius && d < bestD) { best = { marker: m, badge: false }; bestD = d; }
  }
  return best;
}

export const SIDE_NAMES: Record<'north' | 'east' | 'south' | 'west', string> = {
  north: 'north edge',
  east: 'east edge',
  south: 'south edge',
  west: 'west edge',
};

/** Fits a square canvas into a box; at least `min` px. */
export function fitSquare(width: number, height: number, min = 240): number {
  return Math.max(min, Math.floor(Math.min(width, height)));
}
