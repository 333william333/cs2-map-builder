/**
 * Pure grid helpers for the 3D preview: decimation to a vertex grid, normals,
 * triangle-exact height lookup and index building.
 *
 * Scene frame: x = gx, y = height, z = -gz. Vertex row 0 is the top (north), so z
 * increases with the row index and x with the column index.
 */
import type { HeightGrid } from '../../core/types';

/** A square grid of vertices that spans the FULL extent (first/last vertex on the edge). */
export interface VertexGrid {
  /** vertices per side */
  n: number;
  extentM: number;
  /** row-major, n * n */
  data: Float32Array;
}

type NumArr = Float32Array | Uint8Array | Uint16Array | number[];

/**
 * Resamples a cell-centred source grid (`size` x `size`) to `n` x `n` vertices spanning the
 * whole extent. Downscaling uses a box average ('mean') or a box maximum ('max'); otherwise
 * it is bilinear ('mean') / 2x2 maximum ('max').
 */
export function resampleToVertices(src: NumArr, size: number, n: number, mode: 'mean' | 'max' = 'mean'): Float32Array {
  const out = new Float32Array(n * n);
  if (n < 2 || size < 1) return out;
  const f = size / (n - 1);
  const last = size - 1;
  if (f > 1.5) {
    const half = f / 2;
    for (let r = 0; r < n; r++) {
      const v = r * f - 0.5;
      const r0 = Math.max(0, Math.min(last, Math.ceil(v - half)));
      const r1 = Math.max(r0, Math.min(last, Math.floor(v + half)));
      for (let c = 0; c < n; c++) {
        const u = c * f - 0.5;
        const c0 = Math.max(0, Math.min(last, Math.ceil(u - half)));
        const c1 = Math.max(c0, Math.min(last, Math.floor(u + half)));
        let acc = mode === 'max' ? -Infinity : 0;
        for (let rr = r0; rr <= r1; rr++) {
          const base = rr * size;
          if (mode === 'max') {
            for (let cc = c0; cc <= c1; cc++) {
              const s = src[base + cc];
              if (s > acc) acc = s;
            }
          } else {
            for (let cc = c0; cc <= c1; cc++) acc += src[base + cc];
          }
        }
        out[r * n + c] = mode === 'max' ? acc : acc / ((r1 - r0 + 1) * (c1 - c0 + 1));
      }
    }
    return out;
  }
  for (let r = 0; r < n; r++) {
    const v = Math.max(0, Math.min(last, r * f - 0.5));
    const rA = Math.floor(v);
    const rB = Math.min(last, rA + 1);
    const fv = v - rA;
    for (let c = 0; c < n; c++) {
      const u = Math.max(0, Math.min(last, c * f - 0.5));
      const cA = Math.floor(u);
      const cB = Math.min(last, cA + 1);
      const fu = u - cA;
      const a = src[rA * size + cA];
      const b = src[rA * size + cB];
      const cc = src[rB * size + cA];
      const d = src[rB * size + cB];
      if (mode === 'max') {
        out[r * n + c] = Math.max(a, b, cc, d);
      } else {
        out[r * n + c] = a + (b - a) * fu + (cc - a) * fv + (a - b - cc + d) * fu * fv;
      }
    }
  }
  return out;
}

/** Nearest-neighbour resample of a class grid to the vertex grid. */
export function resampleNearest(src: Uint8Array, size: number, n: number): Uint8Array {
  const out = new Uint8Array(n * n);
  const last = size - 1;
  for (let r = 0; r < n; r++) {
    const sr = Math.min(last, Math.max(0, Math.round((r / (n - 1)) * size - 0.5)));
    for (let c = 0; c < n; c++) {
      const sc = Math.min(last, Math.max(0, Math.round((c / (n - 1)) * size - 0.5)));
      out[r * n + c] = src[sr * size + sc];
    }
  }
  return out;
}

/** Decimates a HeightGrid to at most `maxVerts` x `maxVerts` vertices. */
export function decimateHeightGrid(grid: HeightGrid, maxVerts: number): VertexGrid {
  const n = Math.max(2, Math.min(maxVerts, grid.size));
  return { n, extentM: grid.extentM, data: resampleToVertices(grid.data, grid.size, n, 'mean') };
}

/**
 * Picks the world vertex count so that the playable border falls on a vertex line
 * (no partial quads under the playable area). Returns vertices per side.
 */
export function alignedWorldVertexCount(worldExtent: number, playableExtent: number, maxCells: number): number {
  const ratio = worldExtent / playableExtent;
  if (Number.isInteger(ratio)) {
    // cells must be a multiple of `ratio` so that the playable edge is on a grid line
    const cells = Math.floor(maxCells / ratio) * ratio;
    if (cells >= ratio) return cells + 1;
  }
  return maxCells + 1;
}

/** Unit normals from height differences (central, one-sided at the border). 3 floats per vertex. */
export function computeNormals(v: VertexGrid): Float32Array {
  const { n, data } = v;
  const d = v.extentM / (n - 1);
  const out = new Float32Array(n * n * 3);
  for (let r = 0; r < n; r++) {
    const rm = Math.max(0, r - 1);
    const rp = Math.min(n - 1, r + 1);
    for (let c = 0; c < n; c++) {
      const cm = Math.max(0, c - 1);
      const cp = Math.min(n - 1, c + 1);
      const dhdx = (data[r * n + cp] - data[r * n + cm]) / ((cp - cm) * d);
      const dhdz = (data[rp * n + c] - data[rm * n + c]) / ((rp - rm) * d);
      const inv = 1 / Math.hypot(dhdx, 1, dhdz);
      const o = (r * n + c) * 3;
      out[o] = -dhdx * inv;
      out[o + 1] = inv;
      out[o + 2] = -dhdz * inv;
    }
  }
  return out;
}

/**
 * Height of the rendered mesh surface at scene position (x, z): triangle-exact for the
 * diagonal used by `buildGridIndices`. Positions outside the grid are clamped to the edge.
 */
export function meshHeightAt(v: VertexGrid, x: number, z: number): number {
  const { n, data } = v;
  const d = v.extentM / (n - 1);
  const half = v.extentM / 2;
  let fc = (x + half) / d;
  let fr = (z + half) / d;
  fc = fc < 0 ? 0 : fc > n - 1 ? n - 1 : fc;
  fr = fr < 0 ? 0 : fr > n - 1 ? n - 1 : fr;
  let c = Math.floor(fc);
  let r = Math.floor(fr);
  if (c > n - 2) c = n - 2;
  if (r > n - 2) r = n - 2;
  const fu = fc - c;
  const fv = fr - r;
  const h00 = data[r * n + c];
  const h01 = data[r * n + c + 1];
  const h10 = data[(r + 1) * n + c];
  const h11 = data[(r + 1) * n + c + 1];
  if (fu + fv <= 1) return h00 + fu * (h01 - h00) + fv * (h10 - h00);
  return h11 + (1 - fu) * (h10 - h11) + (1 - fv) * (h01 - h11);
}

/** Vertex positions (x, y, z) for a vertex grid. `yOffset` is added to every height. */
export function buildGridPositions(v: VertexGrid, yOffset = 0): Float32Array {
  const { n, data } = v;
  const d = v.extentM / (n - 1);
  const half = v.extentM / 2;
  const out = new Float32Array(n * n * 3);
  let o = 0;
  for (let r = 0; r < n; r++) {
    const z = -half + r * d;
    for (let c = 0; c < n; c++) {
      out[o++] = -half + c * d;
      out[o++] = data[r * n + c] + yOffset;
      out[o++] = z;
    }
  }
  return out;
}

/**
 * Triangle indices (CCW seen from above) for an n x n vertex grid. `skipQuad(r, c)` may
 * exclude individual quads (e.g. the world mesh under the playable area).
 */
export function buildGridIndices(n: number, skipQuad?: (r: number, c: number) => boolean): Uint32Array {
  const max = (n - 1) * (n - 1) * 6;
  const out = new Uint32Array(max);
  let k = 0;
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      if (skipQuad && skipQuad(r, c)) continue;
      const i = r * n + c;
      out[k++] = i;
      out[k++] = i + n;
      out[k++] = i + 1;
      out[k++] = i + 1;
      out[k++] = i + n;
      out[k++] = i + n + 1;
    }
  }
  return k === max ? out : out.slice(0, k);
}
