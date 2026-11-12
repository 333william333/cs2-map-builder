/**
 * Per-vertex and texture fields that drive the terrain shader: valley ambient occlusion, height
 * above the nearest water (for shore sand), soft landcover weights and tree canopy density.
 * Pure, typed arrays only.
 */
import { LC, type LandcoverGrid, type TreeSet } from '../../core/types';
import type { VertexGrid } from './terrainGrid';
import type { WaterSurface } from './waterSurface';

function sstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Separable box blur with clamped edges, radius in samples. Returns a new array. */
export function boxBlur(src: Float32Array, n: number, radius: number): Float32Array {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return src.slice();
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const w = 2 * r + 1;
  for (let y = 0; y < n; y++) {
    const row = y * n;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(n - 1, Math.max(0, k))];
    for (let x = 0; x < n; x++) {
      tmp[row + x] = acc / w;
      acc += src[row + Math.min(n - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(n - 1, Math.max(0, k)) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = acc / w;
      acc += tmp[Math.min(n - 1, y + r + 1) * n + x] - tmp[Math.max(0, y - r) * n + x];
    }
  }
  return out;
}

/**
 * Cheap ambient occlusion from the height field: vertices lying below the local mean height
 * (valleys, gullies, the foot of cliffs) get darker. 1 = open, down to ~0.4 in deep cuts.
 */
export function terrainAO(v: VertexGrid): Float32Array {
  const n = v.n;
  const d = v.extentM / (n - 1);
  const b1 = boxBlur(v.data, n, Math.max(1, Math.round(70 / d)));
  const b2 = boxBlur(v.data, n, Math.max(2, Math.round(300 / d)));
  const out = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const h = v.data[i];
    const c1 = b1[i] - h;
    const c2 = b2[i] - h;
    const ao = 1 - 0.32 * sstep(2, 30, c1) - 0.3 * sstep(8, 120, c2) + 0.06 * sstep(4, 40, -c1);
    out[i] = Math.min(1.05, Math.max(0.38, ao));
  }
  return out;
}

/**
 * Water surface level carried from the water out to `rings` vertices over dry land
 * (breadth-first), NaN beyond. Lets shaders know the height above the nearest water.
 */
export function nearWaterLevel(v: VertexGrid, surface: WaterSurface, rings: number): Float32Array {
  const n = v.n;
  const lvl = new Float32Array(n * n).fill(NaN);
  if (!surface.hasWater) return lvl;
  const dist = new Int16Array(n * n).fill(-1);
  const queue = new Int32Array(n * n);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < n * n; i++) {
    if (surface.wet[i] && Number.isFinite(surface.level[i])) {
      lvl[i] = surface.level[i];
      dist[i] = 0;
      queue[qt++] = i;
    }
  }
  while (qh < qt) {
    const i = queue[qh++];
    if (dist[i] >= rings) continue;
    const r = (i / n) | 0;
    const c = i - r * n;
    for (let k = 0; k < 4; k++) {
      const rr = r + (k === 0 ? -1 : k === 1 ? 1 : 0);
      const cc = c + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
      const j = rr * n + cc;
      if (dist[j] >= 0) continue;
      dist[j] = dist[i] + 1;
      lvl[j] = lvl[i];
      queue[qt++] = j;
    }
  }
  return lvl;
}

/** Height above the nearest water (`far` where no water is near; negative = under water). */
export function shoreHeights(v: VertexGrid, surface: WaterSurface, rings: number, far = 999): Float32Array {
  const lvl = nearWaterLevel(v, surface, rings);
  const out = new Float32Array(v.n * v.n);
  for (let i = 0; i < out.length; i++) out[i] = Number.isFinite(lvl[i]) ? v.data[i] - lvl[i] : far;
  return out;
}

/**
 * Bilinear sample of a vertex-grid field (n x n spanning the extent) at an m x m vertex grid of the
 * same extent. NaN corners are skipped (weights renormalised); all-NaN gives NaN.
 */
export function upsampleField(src: Float32Array, n: number, m: number): Float32Array {
  const out = new Float32Array(m * m);
  const f = (n - 1) / (m - 1);
  for (let r = 0; r < m; r++) {
    const fr = r * f;
    const r0 = Math.min(n - 2, Math.floor(fr));
    const v = fr - r0;
    for (let c = 0; c < m; c++) {
      const fc = c * f;
      const c0 = Math.min(n - 2, Math.floor(fc));
      const u = fc - c0;
      const i = r0 * n + c0;
      const a = src[i], b = src[i + 1], cc = src[i + n], d = src[i + n + 1];
      let acc = 0;
      let w = 0;
      const wa = (1 - u) * (1 - v), wb = u * (1 - v), wc = (1 - u) * v, wd = u * v;
      if (a === a) { acc += a * wa; w += wa; }
      if (b === b) { acc += b * wb; w += wb; }
      if (cc === cc) { acc += cc * wc; w += wc; }
      if (d === d) { acc += d * wd; w += wd; }
      out[r * m + c] = w > 1e-6 ? acc / w : NaN;
    }
  }
  return out;
}

export interface GroundWeights {
  size: number;
  /** RGBA8: forest, crop, built, bare */
  a: Uint8Array;
  /** RGBA8: shrub, wetland, tree canopy density, snow */
  b: Uint8Array;
}

/** Channel weights (0..1) for one landcover class: [forest, crop, built, bare, shrub, wetland, snow]. */
export function classWeights(cls: number): [number, number, number, number, number, number, number] {
  switch (cls) {
    case LC.Tree: return [1, 0, 0, 0, 0, 0, 0];
    case LC.Shrub: return [0, 0, 0, 0, 1, 0, 0];
    case LC.Crop: return [0, 1, 0, 0, 0, 0, 0];
    case LC.Built: return [0, 0, 1, 0, 0, 0, 0];
    case LC.Bare: return [0, 0, 0, 1, 0, 0, 0];
    case LC.Snow: return [0, 0, 0, 0, 0, 0, 1];
    case LC.Wetland: return [0, 0, 0, 0, 0, 1, 0];
    case LC.Mangrove: return [0.6, 0, 0, 0, 0, 0.4, 0];
    case LC.Moss: return [0, 0, 0, 0.15, 0.35, 0, 0];
    default: return [0, 0, 0, 0, 0, 0, 0];
  }
}

/**
 * Soft ground-cover weights over the playable area, `size` x `size` texels, row 0 = top
 * (texel row r covers gz = E/2 - (r + 0.5) * E/size). Classes are blurred by `blur` texels so
 * the shader can blend them with soft edges instead of blocky cells.
 */
export function groundWeights(
  playableExtent: number,
  size: number,
  lc: LandcoverGrid | undefined,
  trees: TreeSet | undefined,
  blur = 1,
): GroundWeights {
  const n = size;
  const ch: Float32Array[] = [];
  for (let k = 0; k < 8; k++) ch.push(new Float32Array(n * n));
  const cell = playableExtent / n;
  if (lc && lc.data.length === lc.size * lc.size) {
    // average all source samples falling into each texel (or nearest when upsampling)
    const ratio = lc.size * (playableExtent / lc.extentM) / n;
    const sub = Math.max(1, Math.min(4, Math.round(ratio)));
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const acc = [0, 0, 0, 0, 0, 0, 0];
        let cnt = 0;
        for (let sr = 0; sr < sub; sr++) {
          for (let sc = 0; sc < sub; sc++) {
            const gx = -playableExtent / 2 + (c + (sc + 0.5) / sub) * cell;
            const gz = playableExtent / 2 - (r + (sr + 0.5) / sub) * cell;
            const lcC = Math.floor((gx / lc.extentM + 0.5) * lc.size);
            const lcR = Math.floor((0.5 - gz / lc.extentM) * lc.size);
            if (lcC < 0 || lcR < 0 || lcC >= lc.size || lcR >= lc.size) continue;
            const w = classWeights(lc.data[lcR * lc.size + lcC]);
            for (let k = 0; k < 7; k++) acc[k] += w[k];
            cnt++;
          }
        }
        if (cnt === 0) continue;
        const i = r * n + c;
        ch[0][i] = acc[0] / cnt; ch[1][i] = acc[1] / cnt; ch[2][i] = acc[2] / cnt; ch[3][i] = acc[3] / cnt;
        ch[4][i] = acc[4] / cnt; ch[5][i] = acc[5] / cnt; ch[7][i] = acc[6] / cnt;
      }
    }
  }
  if (trees && trees.count > 0) {
    const canopy = ch[6];
    for (let i = 0; i < trees.count; i++) {
      const c = Math.floor((trees.xz[i * 2] / playableExtent + 0.5) * n);
      const r = Math.floor((0.5 - trees.xz[i * 2 + 1] / playableExtent) * n);
      if (c >= 0 && r >= 0 && c < n && r < n) canopy[r * n + c] += 1;
    }
    // ~one adult crown per 45 m2 counts as closed canopy
    const full = (cell * cell) / 45;
    for (let i = 0; i < n * n; i++) canopy[i] = Math.min(1, canopy[i] / full);
  }
  const a = new Uint8Array(n * n * 4);
  const b = new Uint8Array(n * n * 4);
  const blurred = ch.map((x) => (blur > 0 ? boxBlur(x, n, blur) : x));
  for (let i = 0; i < n * n; i++) {
    a[i * 4] = Math.round(blurred[0][i] * 255);
    a[i * 4 + 1] = Math.round(blurred[1][i] * 255);
    a[i * 4 + 2] = Math.round(blurred[2][i] * 255);
    a[i * 4 + 3] = Math.round(blurred[3][i] * 255);
    b[i * 4] = Math.round(blurred[4][i] * 255);
    b[i * 4 + 1] = Math.round(blurred[5][i] * 255);
    b[i * 4 + 2] = Math.round(blurred[6][i] * 255);
    b[i * 4 + 3] = Math.round(blurred[7][i] * 255);
  }
  return { size: n, a, b };
}
