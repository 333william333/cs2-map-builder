/** Scale bar and camera height formatting for the 3D view. Pure. */

/** Ground metres covered by one CSS pixel at `distance` from a perspective camera. */
export function metresPerPixel(distance: number, fovDeg: number, viewportHeightPx: number): number {
  if (viewportHeightPx <= 0) return 0;
  return (2 * distance * Math.tan((fovDeg * Math.PI) / 360)) / viewportHeightPx;
}

export interface ScaleBar {
  metres: number;
  px: number;
  label: string;
}

const STEPS = [1, 2, 5];

/** Largest 1-2-5 length whose bar is at most `maxPx` wide (and at least a sensible minimum). */
export function niceScaleBar(mPerPx: number, maxPx = 120): ScaleBar {
  if (!(mPerPx > 0) || !Number.isFinite(mPerPx)) return { metres: 0, px: 0, label: '' };
  const maxM = mPerPx * maxPx;
  let best = 1;
  const e = Math.floor(Math.log10(maxM));
  for (let k = e - 1; k <= e; k++) {
    for (const s of STEPS) {
      const v = s * Math.pow(10, k);
      if (v <= maxM && v > best) best = v;
    }
  }
  if (best > maxM) best = maxM;
  return { metres: best, px: best / mPerPx, label: formatDistance(best) };
}

/** "8 m", "250 m", "1 km", "2.5 km". */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  const s = km >= 10 ? String(Math.round(km)) : String(Math.round(km * 10) / 10);
  return `${s} km`;
}
