/**
 * Local water surface for the playable terrain. Lakes and rivers sit above sea level, so a single
 * plane is not enough: every wet vertex gets its own surface height.
 *
 * Wet vertices that touch dry land take the lowest bank height around them; the level is then
 * propagated through the water with a small slope allowance (3 %), which keeps lakes flat at their
 * lowest bank (the outlet) while a river can still fall downstream.
 */
import type { VertexGrid } from './terrainGrid';

export interface WaterSurface {
  /** surface height per vertex; NaN where the vertex is dry and not next to water */
  level: Float32Array;
  /** 1 where the vertex is wet */
  wet: Uint8Array;
  hasWater: boolean;
}

const PEN = 0.03;
const NB: [number, number, number][] = [
  [-1, -1, Math.SQRT2], [-1, 0, 1], [-1, 1, Math.SQRT2], [0, -1, 1],
  [0, 1, 1], [1, -1, Math.SQRT2], [1, 0, 1], [1, 1, Math.SQRT2],
];

/**
 * @param v     decimated terrain heights
 * @param mask  decimated water mask (n*n, non-zero = water)
 * @param seaLevel game height of the sea
 */
export function computeWaterSurface(v: VertexGrid, mask: ArrayLike<number>, seaLevel: number): WaterSurface {
  const n = v.n;
  const h = v.data;
  const d = v.extentM / (n - 1);
  const wet = new Uint8Array(n * n);
  let any = false;
  for (let i = 0; i < n * n; i++) {
    if (mask[i] > 0 || h[i] < seaLevel - 0.05) {
      wet[i] = 1;
      any = true;
    }
  }
  const level = new Float32Array(n * n).fill(NaN);
  if (!any) return { level, wet, hasWater: false };

  const S = new Float32Array(n * n).fill(Infinity);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (!wet[i]) continue;
      if (h[i] < seaLevel) {
        S[i] = seaLevel;
        continue;
      }
      let best = Infinity;
      for (const [dr, dc] of NB) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const j = rr * n + cc;
        if (!wet[j] && h[j] < best) best = h[j];
      }
      S[i] = best;
    }
  }

  // chamfer-style propagation of the minimum, a few sweeps in alternating directions
  const relax = (r: number, c: number): void => {
    const i = r * n + c;
    if (!wet[i]) return;
    let s = S[i];
    for (const [dr, dc, w] of NB) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
      const j = rr * n + cc;
      if (!wet[j]) continue;
      const cand = S[j] + PEN * d * w;
      if (cand < s) s = cand;
    }
    S[i] = s;
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) relax(r, c);
    for (let r = n - 1; r >= 0; r--) for (let c = n - 1; c >= 0; c--) relax(r, c);
  }

  for (let i = 0; i < n * n; i++) {
    if (!wet[i]) continue;
    let s = S[i];
    if (!Number.isFinite(s)) s = seaLevel;
    if (h[i] < seaLevel) s = seaLevel;
    else if (s < h[i] + 0.3) s = h[i] + 0.3;
    level[i] = s;
  }
  // dry vertices next to water: lowest neighbouring surface, so the water polygon ends under the bank
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (wet[i]) continue;
      let best = Infinity;
      for (const [dr, dc] of NB) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const j = rr * n + cc;
        if (wet[j] && level[j] < best) best = level[j];
      }
      if (Number.isFinite(best)) level[i] = best;
    }
  }
  return { level, wet, hasWater: true };
}

/** Quad indices (CCW from above) of all quads that have at least one wet-or-adjacent corner. */
export function buildWaterIndices(n: number, level: Float32Array, skipQuad?: (r: number, c: number) => boolean): Uint32Array {
  const out = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const i = r * n + c;
      if (Number.isNaN(level[i]) || Number.isNaN(level[i + 1]) || Number.isNaN(level[i + n]) || Number.isNaN(level[i + n + 1])) continue;
      if (skipQuad && skipQuad(r, c)) continue;
      out[k++] = i;
      out[k++] = i + n;
      out[k++] = i + 1;
      out[k++] = i + 1;
      out[k++] = i + n;
      out[k++] = i + n + 1;
    }
  }
  return out.slice(0, k);
}
