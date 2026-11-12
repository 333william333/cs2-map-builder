/**
 * Quadtree level of detail for the game view terrain. Every selected node is drawn as the same
 * 64 x 64 cell patch scaled to the node size, so near nodes are fine and far nodes are coarse.
 * Pure: no three.js. Scene frame: x = gx, z = -gz.
 */

export const PATCH_CELLS = 64;

export interface LodNode {
  x0: number;
  z0: number;
  size: number;
}

/** Min/max height pyramid, level 0 = finest blocks. Row 0 = smallest scene z. */
export interface MinMaxPyramid {
  extent: number;
  levels: { n: number; min: Float32Array; max: Float32Array }[];
}

/**
 * Builds the pyramid from a cell-centred grid (row 0 = north = smallest scene z) so that the
 * finest level has `blocks` x `blocks` entries.
 */
export function buildMinMax(data: Float32Array, size: number, extent: number, blocks: number): MinMaxPyramid {
  const n0 = Math.max(1, Math.min(blocks, size));
  const min = new Float32Array(n0 * n0).fill(Infinity);
  const max = new Float32Array(n0 * n0).fill(-Infinity);
  const f = n0 / size;
  for (let r = 0; r < size; r++) {
    const br = Math.min(n0 - 1, Math.floor(r * f));
    for (let c = 0; c < size; c++) {
      const bc = Math.min(n0 - 1, Math.floor(c * f));
      const v = data[r * size + c];
      const i = br * n0 + bc;
      if (v < min[i]) min[i] = v;
      if (v > max[i]) max[i] = v;
    }
  }
  const levels = [{ n: n0, min, max }];
  let cur = levels[0];
  while (cur.n > 1) {
    const n = Math.ceil(cur.n / 2);
    const mn = new Float32Array(n * n).fill(Infinity);
    const mx = new Float32Array(n * n).fill(-Infinity);
    for (let r = 0; r < cur.n; r++) {
      for (let c = 0; c < cur.n; c++) {
        const i = (r >> 1) * n + (c >> 1);
        const j = r * cur.n + c;
        if (cur.min[j] < mn[i]) mn[i] = cur.min[j];
        if (cur.max[j] > mx[i]) mx[i] = cur.max[j];
      }
    }
    cur = { n, min: mn, max: mx };
    levels.push(cur);
  }
  return { extent, levels };
}

/** Height range under a node (conservative). */
export function nodeRange(p: MinMaxPyramid, node: LodNode): [number, number] {
  const n0 = p.levels[0].n;
  const block = p.extent / n0;
  const lvl = Math.max(0, Math.min(p.levels.length - 1, Math.round(Math.log2(Math.max(1, node.size / block)))));
  const L = p.levels[lvl];
  const bs = p.extent / L.n;
  const c0 = Math.max(0, Math.floor((node.x0 + p.extent / 2) / bs));
  const r0 = Math.max(0, Math.floor((node.z0 + p.extent / 2) / bs));
  const c1 = Math.min(L.n - 1, Math.floor((node.x0 + node.size + p.extent / 2 - 1e-6) / bs));
  const r1 = Math.min(L.n - 1, Math.floor((node.z0 + node.size + p.extent / 2 - 1e-6) / bs));
  let mn = Infinity;
  let mx = -Infinity;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (L.min[r * L.n + c] < mn) mn = L.min[r * L.n + c];
      if (L.max[r * L.n + c] > mx) mx = L.max[r * L.n + c];
    }
  }
  return Number.isFinite(mn) ? [mn, mx] : [0, 0];
}

export interface SelectOptions {
  extent: number;
  /** smallest node edge (finest detail = minNode / PATCH_CELLS per cell) */
  minNode: number;
  camera: [number, number, number];
  /** split while distance < size * splitK */
  splitK: number;
  pyramid: MinMaxPyramid;
  /** frustum test on the node box; return false to drop it */
  visible?: (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => boolean;
  /** hard cap on the number of nodes */
  maxNodes?: number;
}

/** Distance from a point to an axis-aligned box. */
export function boxDistance(px: number, py: number, pz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dy = Math.max(y0 - py, 0, py - y1);
  const dz = Math.max(z0 - pz, 0, pz - z1);
  return Math.hypot(dx, dy, dz);
}

/** Selects the quadtree nodes to draw for this camera. */
export function selectNodes(o: SelectOptions): LodNode[] {
  const out: LodNode[] = [];
  const cap = o.maxNodes ?? 4096;
  const [cx, cy, cz] = o.camera;
  const stack: LodNode[] = [{ x0: -o.extent / 2, z0: -o.extent / 2, size: o.extent }];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const [y0, y1] = nodeRange(o.pyramid, node);
    const x1 = node.x0 + node.size;
    const z1 = node.z0 + node.size;
    if (o.visible && !o.visible(node.x0, y0 - 5, node.z0, x1, y1 + 5, z1)) continue;
    const d = boxDistance(cx, cy, cz, node.x0, y0, node.z0, x1, y1, z1);
    if (node.size > o.minNode * 1.001 && d < node.size * o.splitK && out.length + stack.length + 4 < cap) {
      const h = node.size / 2;
      stack.push(
        { x0: node.x0, z0: node.z0, size: h },
        { x0: node.x0 + h, z0: node.z0, size: h },
        { x0: node.x0, z0: node.z0 + h, size: h },
        { x0: node.x0 + h, z0: node.z0 + h, size: h },
      );
    } else {
      out.push(node);
    }
  }
  return out;
}

/**
 * Unit patch: (PATCH_CELLS + 1)^2 vertices with x, z in [0, 1] and y = 0, plus a skirt ring with
 * y = -1 that the shader pulls down to hide cracks between neighbouring levels.
 */
export function patchGrid(cells = PATCH_CELLS): { positions: Float32Array; indices: Uint32Array } {
  const n = cells + 1;
  const pos: number[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) pos.push(c / cells, 0, r / cells);
  const idx: number[] = [];
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      const i = r * n + c;
      idx.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
    }
  }
  // skirt: walk the border, duplicate each vertex with y = -1
  const border: number[] = [];
  for (let c = 0; c < cells; c++) border.push(c);
  for (let r = 0; r < cells; r++) border.push(r * n + cells);
  for (let c = cells; c > 0; c--) border.push(cells * n + c);
  for (let r = cells; r > 0; r--) border.push(r * n);
  const base = n * n;
  for (const b of border) pos.push(pos[b * 3], -1, pos[b * 3 + 2]);
  const m = border.length;
  for (let k = 0; k < m; k++) {
    const a = border[k];
    const b = border[(k + 1) % m];
    const sa = base + k;
    const sb = base + ((k + 1) % m);
    // two-sided enough: both windings
    idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
