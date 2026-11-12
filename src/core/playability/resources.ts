import type { AreaKind, LandcoverGrid, Pt, ResourceMasks, TerrainResult, TreeSet, VectorData } from '../types';
import { LC } from '../types';
import { gxOf, gzOf, resample } from './grid';

export const RES_SIZE = 256;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** smooth value noise in 0..1 */
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** box blur (radius 1) `passes` times */
function blur(src: Float32Array, m: number, passes: number): Float32Array<ArrayBuffer> {
  let a: Float32Array = src, b: Float32Array = new Float32Array(m * m);
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) {
        let s = 0, k = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= m) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= m) continue;
            s += a[rr * m + cc];
            k++;
          }
        }
        b[r * m + c] = s / k;
      }
    }
    [a, b] = [b, a];
  }
  return (a === src ? src.slice() : a) as Float32Array<ArrayBuffer>;
}

/** even-odd scanline fill of polygon rings (game coords) onto an m x m grid, per polygon. */
function rasterizeAreas(vectors: VectorData | undefined, kinds: AreaKind[], m: number, ext: number): Float32Array {
  const out = new Float32Array(m * m);
  if (!vectors) return out;
  const cell = ext / m;
  for (const area of vectors.areas) {
    if (!kinds.includes(area.kind)) continue;
    let zMin = Infinity, zMax = -Infinity;
    for (const ring of area.rings) for (const p of ring) { if (p[1] < zMin) zMin = p[1]; if (p[1] > zMax) zMax = p[1]; }
    if (!Number.isFinite(zMin)) continue;
    const rowOf = (z: number) => Math.floor((ext / 2 - z) / cell);
    const rA = Math.max(0, rowOf(zMax)), rB = Math.min(m - 1, rowOf(zMin));
    if (rB < rA) continue;
    const xs: number[][] = [];
    for (let r = rA; r <= rB; r++) xs.push([]);
    for (const ring of area.rings) {
      for (let k = 0, L = ring.length; k < L; k++) {
        const p: Pt = ring[k], q: Pt = ring[(k + 1) % L];
        if (p[1] === q[1]) continue;
        for (let r = rA; r <= rB; r++) {
          const zc = ext / 2 - (r + 0.5) * cell;
          if ((p[1] <= zc && q[1] > zc) || (q[1] <= zc && p[1] > zc)) {
            xs[r - rA].push(p[0] + ((zc - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
          }
        }
      }
    }
    for (let r = rA; r <= rB; r++) {
      const row = xs[r - rA].sort((a, b) => a - b);
      for (let k = 0; k + 1 < row.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((row[k] + ext / 2) / cell - 0.5));
        const c1 = Math.min(m - 1, Math.floor((row[k + 1] + ext / 2) / cell - 0.5));
        for (let c = c0; c <= c1; c++) out[r * m + c] = 1;
      }
    }
  }
  return out;
}

/** distance (in cells, chamfer) from each cell to the nearest cell where `src` is true */
function distanceTo(src: Uint8Array, m: number): Float32Array {
  const d = new Float32Array(m * m);
  const BIG = 1e9, S2 = Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : BIG;
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < m; c++) {
      const i = r * m + c;
      let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + 1);
      if (r > 0) {
        v = Math.min(v, d[i - m] + 1);
        if (c > 0) v = Math.min(v, d[i - m - 1] + S2);
        if (c < m - 1) v = Math.min(v, d[i - m + 1] + S2);
      }
      d[i] = v;
    }
  }
  for (let r = m - 1; r >= 0; r--) {
    for (let c = m - 1; c >= 0; c--) {
      const i = r * m + c;
      let v = d[i];
      if (c < m - 1) v = Math.min(v, d[i + 1] + 1);
      if (r < m - 1) {
        v = Math.min(v, d[i + m] + 1);
        if (c < m - 1) v = Math.min(v, d[i + m + 1] + S2);
        if (c > 0) v = Math.min(v, d[i + m - 1] + S2);
      }
      d[i] = v;
    }
  }
  return d;
}

/** nearest-neighbour resize of an m x m float field (0..1) to a 256 x 256 uint8 mask */
function toMask(f: Float32Array, m: number): Uint8Array {
  const out = new Uint8Array(RES_SIZE * RES_SIZE);
  for (let r = 0; r < RES_SIZE; r++) {
    const sr = Math.min(m - 1, Math.floor((r * m) / RES_SIZE));
    for (let c = 0; c < RES_SIZE; c++) {
      const sc = Math.min(m - 1, Math.floor((c * m) / RES_SIZE));
      out[r * RES_SIZE + c] = Math.round(clamp01(f[sr * m + sc]) * 255);
    }
  }
  return out;
}

interface Blob { x: number; y: number; sigma: number; ax: number; ay: number; cos: number; sin: number; seed: number }

/** A few smooth blobs placed on the best-scoring land cells; covers about `coverage` of the land. */
function blobField(
  m: number, land: Uint8Array, score: Float32Array, nBlobs: number, coverage: number, seed: number,
): Float32Array {
  const field = new Float32Array(m * m);
  let landCount = 0;
  for (let i = 0; i < land.length; i++) landCount += land[i];
  if (landCount < 16) return field;
  const rng = mulberry32(seed);
  const cands: { i: number; s: number }[] = [];
  for (let k = 0; k < 400; k++) {
    const i = Math.floor(rng() * m * m);
    if (land[i]) cands.push({ i, s: score[i] + 0.25 * rng() });
  }
  cands.sort((a, b) => b.s - a.s || a.i - b.i);
  const picked: number[] = [];
  const minSep = m * 0.12;
  for (const cd of cands) {
    if (picked.length >= nBlobs) break;
    const r = (cd.i / m) | 0, c = cd.i - r * m;
    if (picked.every((p) => Math.hypot(((p / m) | 0) - r, (p % m) - c) >= minSep)) picked.push(cd.i);
  }
  if (picked.length === 0) return field;
  const area = (coverage * landCount) / picked.length;
  const blobs: Blob[] = picked.map((i, k) => {
    const sigma = Math.max(1.5, Math.sqrt(area / 7.57));
    const ang = rng() * Math.PI;
    return {
      x: i % m, y: (i / m) | 0, sigma,
      ax: 0.75 + 0.5 * rng(), ay: 0.75 + 0.5 * rng(),
      cos: Math.cos(ang), sin: Math.sin(ang), seed: seed + k * 101,
    };
  });
  for (const b of blobs) {
    const reach = Math.ceil(b.sigma * 3.5 * 1.3);
    for (let r = Math.max(0, b.y - reach); r <= Math.min(m - 1, b.y + reach); r++) {
      for (let c = Math.max(0, b.x - reach); c <= Math.min(m - 1, b.x + reach); c++) {
        const dx = c - b.x, dy = r - b.y;
        const u = (dx * b.cos + dy * b.sin) / b.ax, v = (-dx * b.sin + dy * b.cos) / b.ay;
        const g = Math.exp(-(u * u + v * v) / (2 * b.sigma * b.sigma));
        const nz = 0.7 + 0.3 * valueNoise(c / (b.sigma * 1.2), r / (b.sigma * 1.2), b.seed);
        const val = g * nz;
        const i = r * m + c;
        if (val > field[i]) field[i] = val;
      }
    }
  }
  return field;
}

export interface ResourceInput {
  terrain: TerrainResult;
  landcover?: LandcoverGrid;
  vectors?: VectorData;
  trees?: TreeSet;
}

/** Five 256 x 256 natural resource masks over the playable area (row 0 = top). */
export function computeResources(input: ResourceInput): ResourceMasks {
  const { terrain, landcover, vectors, trees } = input;
  const C = resample(terrain, RES_SIZE);
  const m = C.m, N = m * m, cell = C.cell, ext = C.ext;

  const land = new Uint8Array(N);
  const wat = new Uint8Array(N);
  let landCount = 0;
  let hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < N; i++) {
    if (C.water[i] === 0) {
      land[i] = 1;
      landCount++;
      if (C.h[i] < hMin) hMin = C.h[i];
      if (C.h[i] > hMax) hMax = C.h[i];
    } else wat[i] = 1;
  }
  const hRange = Math.max(1e-3, hMax - hMin);
  const flat = new Float32Array(N);
  for (let i = 0; i < N; i++) flat[i] = 1 - clamp01((C.slope[i] - 5) / 10);

  // land cover per cell
  const lcAt = (r: number, c: number): number => {
    if (!landcover) return -1;
    const col = Math.min(landcover.size - 1, Math.max(0, Math.floor(((gxOf(C, c) + landcover.extentM / 2) / landcover.extentM) * landcover.size)));
    const row = Math.min(landcover.size - 1, Math.max(0, Math.floor(((landcover.extentM / 2 - gzOf(C, r)) / landcover.extentM) * landcover.size)));
    return landcover.data[row * landcover.size + col];
  };
  const farmRaster = rasterizeAreas(vectors, ['farmland'], m, ext);
  const quarryRaster = rasterizeAreas(vectors, ['quarry'], m, ext);
  const forestRaster = rasterizeAreas(vectors, ['forest'], m, ext);
  const lc = new Int16Array(N);
  for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) lc[r * m + c] = lcAt(r, c);

  // fertile
  let fertile = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!land[i]) continue;
    let base = 0;
    if (lc[i] === LC.Crop) base = 1;
    else if (lc[i] === LC.Grass) base = 0.35;
    else if (lc[i] === LC.Shrub) base = 0.12;
    else if (lc[i] < 0 && !vectors) base = 0.15;
    base = Math.max(base, farmRaster[i]);
    fertile[i] = base * flat[i];
  }
  fertile = blur(fertile, m, 1);

  // forest
  let forest = new Float32Array(N);
  if (trees && trees.count > 0) {
    const cnt = new Float32Array(N);
    for (let k = 0; k < trees.count; k++) {
      const c = Math.floor(((trees.xz[2 * k] + ext / 2) / ext) * m);
      const r = Math.floor(((ext / 2 - trees.xz[2 * k + 1]) / ext) * m);
      if (c >= 0 && c < m && r >= 0 && r < m) cnt[r * m + c]++;
    }
    const full = 0.02 * cell * cell; // trees per cell that counts as dense forest
    for (let i = 0; i < N; i++) forest[i] = land[i] ? clamp01(cnt[i] / full) : 0;
  } else {
    for (let i = 0; i < N; i++) {
      if (!land[i]) continue;
      let v = 0;
      if (lc[i] === LC.Tree || lc[i] === LC.Mangrove) v = 1;
      else if (lc[i] === LC.Shrub) v = 0.3;
      v = Math.max(v, forestRaster[i]);
      forest[i] = v;
    }
  }
  forest = blur(forest, m, 1);

  // groundwater: low, flat land near water
  const dWater = distanceTo(wat, m);
  let ground = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (C.water[i] === 1) continue;
    const low = 1 - clamp01((C.h[i] - hMin) / hRange);
    const near = Math.exp(-(dWater[i] * cell) / 600);
    ground[i] = clamp01((0.15 + 0.35 * low + 0.5 * near) * (0.5 + 0.5 * flat[i]));
  }
  ground = blur(ground, m, 2);

  // ore and oil: deterministic blobs
  let seed = 0x5bd1e995;
  seed = Math.imul(seed ^ terrain.playable.size, 0x01000193);
  seed = Math.imul(seed ^ Math.round(terrain.maxHeight * 100), 0x01000193);
  seed = Math.imul(seed ^ Math.round(terrain.minHeight * 100), 0x01000193);
  seed = Math.imul(seed ^ landCount, 0x01000193);

  const oreScore = new Float32Array(N), oilScore = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!land[i]) continue;
    const s = C.slope[i];
    const hill = clamp01(1 - Math.abs(s - 16) / 14);
    const high = clamp01((C.h[i] - hMin) / hRange);
    const bare = lc[i] === LC.Bare ? 1 : 0;
    oreScore[i] = 0.5 * hill + 0.3 * high + 0.4 * bare + 1.0 * quarryRaster[i];
    oilScore[i] = flat[i] > 0.5 ? 0.6 * flat[i] + 0.4 * (1 - high) : 0;
  }
  const nOre = landCount < 400 ? 1 : 3, nOil = landCount < 400 ? 1 : 2;
  const oilLand = new Uint8Array(N);
  for (let i = 0; i < N; i++) oilLand[i] = land[i] && flat[i] > 0.5 ? 1 : 0;
  const oreField = blobField(m, land, oreScore, nOre, 0.03, seed ^ 0xa11ce);
  for (let i = 0; i < N; i++) if (quarryRaster[i] > 0 && land[i]) oreField[i] = Math.max(oreField[i], 0.8);
  const oilField = blobField(m, oilLand.some((v) => v) ? oilLand : land, oilScore, nOil, 0.03, seed ^ 0x0112);

  const finish = (f: Float32Array): Float32Array => {
    const b = blur(f, m, 2);
    let max = 0;
    for (let i = 0; i < N; i++) {
      if (!land[i] || C.wet[i]) b[i] = 0;
      if (b[i] > max) max = b[i];
    }
    if (max > 0) for (let i = 0; i < N; i++) b[i] = b[i] / max < 0.04 ? 0 : b[i] / max;
    return b;
  };

  return {
    size: RES_SIZE,
    fertile: toMask(fertile, m),
    forest: toMask(forest, m),
    ore: toMask(finish(oreField), m),
    oil: toMask(finish(oilField), m),
    groundwater: toMask(ground, m),
  };
}
