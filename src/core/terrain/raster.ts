import type { Pt } from '../types';

/** Fractional grid column of game x (cell centres at integer values). */
export function toCol(gx: number, N: number, E: number): number {
  return ((gx + E / 2) * N) / E - 0.5;
}

/** Fractional grid row of game z (row 0 = top). */
export function toRow(gz: number, N: number, E: number): number {
  return ((E / 2 - gz) * N) / E - 0.5;
}

/**
 * Scanline fill of a polygon (rings[0] outer, others holes; even-odd rule over all rings) into
 * `out` with `value`, for every cell whose centre lies inside. Returns the number of cells set.
 */
export function fillPolygon(
  rings: Pt[][],
  N: number,
  E: number,
  out: Int32Array | Uint8Array,
  value: number,
): number {
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      const y = toRow(p[1], N, E);
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  }
  const r0 = Math.max(0, Math.ceil(ymin));
  const r1 = Math.min(N - 1, Math.floor(ymax));
  if (!(r0 <= r1)) return 0;
  const rows = r1 - r0 + 1;
  const counts = new Int32Array(rows + 1);
  const pass = (fill: Float64Array | null, cursor: Int32Array | null): void => {
    for (const ring of rings) {
      const m = ring.length;
      if (m < 3) continue;
      for (let k = 0; k < m; k++) {
        const p = ring[k];
        const q = ring[(k + 1) % m];
        const ya = toRow(p[1], N, E);
        const yb = toRow(q[1], N, E);
        if (ya === yb) continue;
        const lo = ya < yb ? ya : yb;
        const hi = ya < yb ? yb : ya;
        const rs = Math.max(r0, Math.ceil(lo));
        const re = Math.min(r1, Math.ceil(hi) - 1);
        if (rs > re) continue;
        if (!fill || !cursor) {
          for (let r = rs; r <= re; r++) counts[r - r0]++;
          continue;
        }
        const xa = toCol(p[0], N, E);
        const xb = toCol(q[0], N, E);
        const slope = (xb - xa) / (yb - ya);
        for (let r = rs; r <= re; r++) fill[cursor[r - r0]++] = xa + (r - ya) * slope;
      }
    }
  };
  pass(null, null);
  const offs = new Int32Array(rows + 1);
  for (let i = 0; i < rows; i++) offs[i + 1] = offs[i] + counts[i];
  const xs = new Float64Array(offs[rows]);
  const cursor = offs.slice(0, rows);
  pass(xs, cursor);
  let filled = 0;
  for (let i = 0; i < rows; i++) {
    const a = offs[i];
    const b = offs[i + 1];
    if (b - a < 2) continue;
    const seg = xs.subarray(a, b);
    seg.sort();
    const o = (r0 + i) * N;
    for (let k = 0; k + 1 < seg.length; k += 2) {
      const ca = Math.max(0, Math.ceil(seg[k]));
      const cb = Math.min(N - 1, Math.ceil(seg[k + 1]) - 1);
      for (let c = ca; c <= cb; c++) out[o + c] = value;
      if (cb >= ca) filled += cb - ca + 1;
    }
  }
  return filled;
}
