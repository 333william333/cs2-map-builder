import { CS2, type Selection } from '../../core/types';
import { createFrame } from '../../core/geo/frame';

/** Pure geometry helpers for the selection tool (no DOM, no MapLibre). */

export const MIN_SIZE_M = 2_000;
export const MAX_SIZE_M = 200_000;
export const SNAP_TOLERANCE_DEG = 3;

const R = 6371008.8; // same radius as core/geo/frame.ts
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function clampSize(sizeMeters: number): number {
  if (!Number.isFinite(sizeMeters)) return CS2.PLAYABLE_SIZE_M;
  return Math.min(MAX_SIZE_M, Math.max(MIN_SIZE_M, sizeMeters));
}

/** Normalises an angle to [0, 360). */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Normalises to [0, 360) and snaps to 0/90/180/270 when within `tol` degrees. */
export function snapRotation(deg: number, tol = SNAP_TOLERANCE_DEG): number {
  const n = normalizeDeg(deg);
  for (const t of [0, 90, 180, 270, 360]) {
    if (Math.abs(n - t) <= tol) return t % 360;
  }
  return n;
}

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing (degrees clockwise from north, 0..360) from point 0 to point 1. */
export function bearingDeg(lat0: number, lon0: number, lat1: number, lon1: number): number {
  const p0 = lat0 * D2R;
  const p1 = lat1 * D2R;
  const dl = (lon1 - lon0) * D2R;
  const y = Math.sin(dl) * Math.cos(p1);
  const x = Math.cos(p0) * Math.sin(p1) - Math.sin(p0) * Math.cos(p1) * Math.cos(dl);
  return normalizeDeg(Math.atan2(y, x) * R2D);
}

/**
 * New side length when a corner handle is dragged to a point `distM` metres from the centre.
 * A corner sits at half the diagonal from the centre, so side = distance * sqrt(2).
 */
export function sizeFromCornerDistance(distM: number): number {
  return clampSize(distM * Math.SQRT2);
}

/** Rotation (snapped) when the rotation handle is dragged to the given point. */
export function rotationFromPointer(sel: Selection, lat: number, lon: number): number {
  return snapRotation(bearingDeg(sel.centerLat, sel.centerLon, lat, lon));
}

/** Square side for the "Place here" button: 40% of the visible width, clamped. */
export function placeSizeFromWidth(visibleWidthM: number): number {
  return clampSize(visibleWidthM * 0.4);
}

function fmtRatio(x: number): string {
  if (x >= 10) return String(Math.round(x));
  return x.toFixed(1).replace(/\.0$/, '');
}

/**
 * Map scale of the selection relative to the 14,336 m playable area.
 * 14336 m -> "1 : 1", larger areas "1 : X", smaller areas (enlargement) "X : 1".
 */
export function formatScale(sizeMeters: number): string {
  const r = sizeMeters / CS2.PLAYABLE_SIZE_M;
  if (!Number.isFinite(r) || r <= 0) return '1 : 1';
  if (Math.abs(r - 1) < 0.0005) return '1 : 1';
  return r > 1 ? `1 : ${fmtRatio(r)}` : `${fmtRatio(1 / r)} : 1`;
}

/** "14.3". */
export function formatKm(sizeMeters: number): string {
  return (sizeMeters / 1000).toFixed(1);
}

/** Closed ring of [lon, lat] following the metric square of `extentGameM` game metres. */
export function ringGeo(sel: Selection, extentGameM: number, perEdge = 16): [number, number][] {
  const frame = createFrame(sel);
  const h = extentGameM / 2;
  // TL, TR, BR, BL in game coordinates
  const c: [number, number][] = [[-h, h], [h, h], [h, -h], [-h, -h]];
  const out: [number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const a = c[i]!;
    const b = c[(i + 1) % 4]!;
    for (let k = 0; k < perEdge; k++) {
      const t = k / perEdge;
      const [lat, lon] = frame.gameToGeo(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      out.push([lon, lat]);
    }
  }
  out.push(out[0]!);
  return out;
}

/** Point in polygon (ray casting), polygon as [x, y] pairs. */
export function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
