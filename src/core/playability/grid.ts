import type { TerrainResult } from '../types';

/** Terrain resampled to a coarse analysis grid (block means), with slope in percent. */
export interface Coarse {
  m: number;
  ext: number;
  /** game metres per coarse cell */
  cell: number;
  h: Float32Array;
  /** water kind (0 land, 1 sea, 2 lake, 3 river) sampled at the block centre */
  water: Uint8Array;
  /** 1 when any source cell of the block is water */
  wet: Uint8Array;
  /** slope in percent */
  slope: Float32Array;
}

export function resample(t: TerrainResult, target: number): Coarse {
  const g = t.playable;
  const n = g.size;
  const m = Math.max(2, Math.min(target, n));
  const h = new Float32Array(m * m);
  const water = new Uint8Array(m * m);
  const wet = new Uint8Array(m * m);
  for (let r = 0; r < m; r++) {
    const r0 = Math.floor((r * n) / m), r1 = Math.max(r0 + 1, Math.floor(((r + 1) * n) / m));
    for (let c = 0; c < m; c++) {
      const c0 = Math.floor((c * n) / m), c1 = Math.max(c0 + 1, Math.floor(((c + 1) * n) / m));
      let sum = 0, cnt = 0, anyWet = 0;
      for (let rr = r0; rr < r1; rr++) {
        for (let cc = c0; cc < c1; cc++) {
          sum += g.data[rr * n + cc];
          cnt++;
          if (t.waterMask[rr * n + cc] !== 0) anyWet = 1;
        }
      }
      wet[r * m + c] = anyWet;
      h[r * m + c] = sum / cnt;
      const mr = Math.min(n - 1, (r0 + r1) >> 1), mc = Math.min(n - 1, (c0 + c1) >> 1);
      water[r * m + c] = t.waterMask[mr * n + mc];
    }
  }
  const cell = g.extentM / m;
  return { m, ext: g.extentM, cell, h, water, wet, slope: slopePercent(h, m, cell) };
}

export function slopePercent(h: Float32Array, m: number, cell: number): Float32Array {
  const out = new Float32Array(m * m);
  for (let r = 0; r < m; r++) {
    const ra = Math.max(0, r - 1), rb = Math.min(m - 1, r + 1);
    for (let c = 0; c < m; c++) {
      const ca = Math.max(0, c - 1), cb = Math.min(m - 1, c + 1);
      const dx = (h[r * m + cb] - h[r * m + ca]) / ((cb - ca) * cell);
      const dz = (h[rb * m + c] - h[ra * m + c]) / ((rb - ra) * cell);
      out[r * m + c] = 100 * Math.hypot(dx, dz);
    }
  }
  return out;
}

export function gxOf(C: { m: number; ext: number }, c: number): number {
  return -C.ext / 2 + ((c + 0.5) * C.ext) / C.m;
}
export function gzOf(C: { m: number; ext: number }, r: number): number {
  return C.ext / 2 - ((r + 0.5) * C.ext) / C.m;
}
