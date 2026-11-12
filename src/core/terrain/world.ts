import { downsampleArea } from './filters';

/** Centre region [lo, hi) in world cells that covers the playable area (the centre quarter). */
export function centreRegion(Nw: number): { lo: number; hi: number } {
  const lo = Math.round((Nw * 3) / 8);
  const hi = Math.round((Nw * 5) / 8);
  return { lo, hi };
}

/**
 * Overwrites the world grid's centre quarter with the area-averaged playable grid (CS2 requires them
 * to match) and fades the difference out over a narrow band so there is no seam.
 */
export function embedPlayable(world: Float32Array, Nw: number, play: Float32Array, Np: number): void {
  const { lo, hi } = centreRegion(Nw);
  const S = hi - lo;
  const centre = downsampleArea(play, Np, S);
  const diff = new Float32Array(S * S);
  for (let r = 0; r < S; r++) {
    for (let c = 0; c < S; c++) {
      const wi = (lo + r) * Nw + lo + c;
      diff[r * S + c] = centre[r * S + c] - world[wi];
      world[wi] = centre[r * S + c];
    }
  }
  const B = Math.max(4, Math.round(S / 16));
  const r0 = Math.max(0, lo - B);
  const r1 = Math.min(Nw - 1, hi - 1 + B);
  for (let r = r0; r <= r1; r++) {
    const inR = r >= lo && r < hi;
    const dr = r < lo ? lo - r : r >= hi ? r - (hi - 1) : 0;
    const nr = r < lo ? 0 : r >= hi ? S - 1 : r - lo;
    for (let c = r0; c <= r1; c++) {
      const inC = c >= lo && c < hi;
      if (inR && inC) continue;
      const dc = c < lo ? lo - c : c >= hi ? c - (hi - 1) : 0;
      const dist = Math.hypot(dr, dc);
      if (dist >= B) continue;
      const nc = c < lo ? 0 : c >= hi ? S - 1 : c - lo;
      const u = dist / B;
      const w = 1 - u * u * (3 - 2 * u);
      world[r * Nw + c] += diff[nr * S + nc] * w;
    }
  }
}
