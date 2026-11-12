/** Pure helpers for the offscreen render: sample jitter, tiling, file names. */

/** Radical inverse in `base` (Halton sequence), i >= 1 gives values in (0, 1). */
export function halton(i: number, base: number): number {
  let f = 1;
  let r = 0;
  let n = i;
  while (n > 0) {
    f /= base;
    r += f * (n % base);
    n = Math.floor(n / base);
  }
  return r;
}

/** Sub-pixel jitter for sample k (0-based), in [-0.5, 0.5) pixels; sample 0 is unjittered. */
export function jitter(k: number): [number, number] {
  if (k === 0) return [0, 0];
  return [halton(k, 2) - 0.5, halton(k, 3) - 0.5];
}

export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Splits a W x H image into tiles no larger than `maxTile` (row-major, top-left first). */
export function tileLayout(W: number, H: number, maxTile: number): Tile[] {
  const nx = Math.max(1, Math.ceil(W / maxTile));
  const ny = Math.max(1, Math.ceil(H / maxTile));
  const tw = Math.ceil(W / nx);
  const th = Math.ceil(H / ny);
  const out: Tile[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * tw;
      const y = j * th;
      out.push({ x, y, w: Math.min(tw, W - x), h: Math.min(th, H - y) });
    }
  }
  return out;
}

/** "cs2-map-59.859N-17.639E-1920x1080-1530.png" */
export function renderFileName(lat: number, lon: number, w: number, h: number, hour: number): string {
  const la = `${Math.abs(lat).toFixed(3)}${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lon).toFixed(3)}${lon >= 0 ? 'E' : 'W'}`;
  const total = Math.round(hour * 60);
  const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `cs2-map-${la}-${lo}-${w}x${h}-${hh}${mm}.png`;
}

/**
 * Number of samples per pixel for a resolution, so bigger renders do not take forever:
 * full HD gets `base`, 4K about half.
 */
export function samplesFor(w: number, h: number, base = 32): number {
  const px = w * h;
  const k = Math.sqrt((1920 * 1080) / px);
  return Math.max(8, Math.min(base, Math.round(base * k)));
}
