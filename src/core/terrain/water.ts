import { LC, type LandcoverGrid, type VectorData, type Waterway } from '../types';
import { chamferDistance, minFilter, sampleBilinear } from './filters';
import { fillPolygon, toCol, toRow } from './raster';

/** Water classes in the per-grid water array. */
export const WATER = { none: 0, sea: 1, lake: 2, river: 3 } as const;
const PENDING_CORE = 5;

/**
 * Tuning (all heights/distances in GAME metres). CS2 water behaviour depends on game metres,
 * so depths are not tied to the vertical scale; lake depth caps grow with lake size.
 */
export const WATER_PARAMS = {
  /** sea: minimum depth at the first sea cell, growth per metre offshore, and its cap */
  seaShoreDepth: 2,
  seaDepthSlope: 0.08,
  seaMinDepthCap: 12,
  /** land in coastal maps is kept at least this high above sea level */
  coastFreeboard: 1.5,
  /** lakes: percentile of the shore ring used as the water level */
  lakeLevelPercentile: 0.15,
  lakeEdgeDepth: 0.8,
  lakeDepthSlope: 0.12,
  lakeRimFreeboard: 0.3,
  /** river polygons */
  riverPolyEdgeDepth: 0.8,
  riverPolyDepthSlope: 0.25,
  /** waterways: default real widths by kind, and minimum game widths */
  defaultWidthReal: { river: 20, canal: 12, stream: 3 } as Record<Waterway['kind'], number>,
  minWidthGame: { river: 20, canal: 12, stream: 6 } as Record<Waterway['kind'], number>,
  minWidthCells: 2.5,
  bankSlope: 0.5,
} as const;

export interface Scratch {
  a: ArrayBuffer;
  b: ArrayBuffer;
  c: ArrayBuffer;
  m1: ArrayBuffer;
  m2: ArrayBuffer;
}

export function createScratch(n: number): Scratch {
  return {
    a: new ArrayBuffer(n * 4),
    b: new ArrayBuffer(n * 4),
    c: new ArrayBuffer(n * 4),
    m1: new ArrayBuffer(n),
    m2: new ArrayBuffer(n),
  };
}

const f32 = (buf: ArrayBuffer, n: number) => new Float32Array(buf, 0, n);
const i32 = (buf: ArrayBuffer, n: number) => new Int32Array(buf, 0, n);
const u8 = (buf: ArrayBuffer, n: number) => new Uint8Array(buf, 0, n);

export interface GridCtx {
  N: number;
  /** game metres covered */
  E: number;
  /** game metres per cell */
  cell: number;
  H: Float32Array;
  /** 1 where real elevation <= 0 (coastal mode only) */
  seaCand: Uint8Array | null;
  seaLevel: number;
  coastal: boolean;
  scaleH: number;
  vertical: number;
  carve: boolean;
  vectors?: VectorData;
  landcover?: LandcoverGrid;
  isWorld: boolean;
  scratch: Scratch;
}

// ---------------------------------------------------------------- river centre lines

export interface LinePrep {
  /** resampled points, fractional grid coords */
  x: Float64Array;
  y: Float64Array;
  /** bed height per point, non-increasing downstream */
  bed: Float32Array;
  n: number;
  /** game metres */
  halfW: number;
  bankW: number;
  depth: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function riverDepth(kind: Waterway['kind'], width: number): number {
  if (kind === 'river') return clamp(1.5 + 0.05 * width, 2.5, 10);
  if (kind === 'canal') return clamp(1.5 + 0.04 * width, 2, 6);
  return clamp(1 + 0.05 * width, 1.2, 2.5);
}

/** Channel geometry for a waterway in game metres (exported for tests and other modules). */
export function waterwayGeometry(
  ww: Waterway,
  scaleH: number,
  cell: number,
): { natural: number; width: number; depth: number } {
  const P = WATER_PARAMS;
  const real = ww.widthM && ww.widthM > 0 ? ww.widthM : P.defaultWidthReal[ww.kind];
  const natural = real * scaleH;
  const width = Math.max(natural, P.minWidthCells * cell, P.minWidthGame[ww.kind]);
  return { natural, width, depth: riverDepth(ww.kind, width) };
}

/**
 * Builds monotone bed profiles for waterways from the (smoothed, uncarved) heights.
 * Direction: the higher end (mean of the first/last 10 % of the profile) is upstream.
 */
export function prepareLines(ctx: GridCtx): LinePrep[] {
  const out: LinePrep[] = [];
  if (!ctx.carve || !ctx.vectors) return out;
  const { N, E, cell, H } = ctx;
  for (const ww of ctx.vectors.waterways) {
    if (ww.pts.length < 2) continue;
    const g = waterwayGeometry(ww, ctx.scaleH, cell);
    if (ctx.isWorld && (ww.kind !== 'river' || g.natural < cell)) continue;
    const halfW = g.width / 2;
    const bankW = Math.max(3 * cell, halfW);
    const marg = (halfW + bankW) / cell + 1;
    const m = ww.pts.length;
    const px = new Float64Array(m);
    const py = new Float64Array(m);
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (let k = 0; k < m; k++) {
      px[k] = toCol(ww.pts[k][0], N, E);
      py[k] = toRow(ww.pts[k][1], N, E);
      if (px[k] < bx0) bx0 = px[k];
      if (px[k] > bx1) bx1 = px[k];
      if (py[k] < by0) by0 = py[k];
      if (py[k] > by1) by1 = py[k];
    }
    if (bx1 < -marg || by1 < -marg || bx0 > N - 1 + marg || by0 > N - 1 + marg) continue;
    // resample at a step of max(1 cell, halfW/2)
    const cum = new Float64Array(m);
    for (let k = 1; k < m; k++) cum[k] = cum[k - 1] + Math.hypot(px[k] - px[k - 1], py[k] - py[k - 1]);
    const total = cum[m - 1];
    if (total <= 0) continue;
    const step = Math.max(1, (0.5 * halfW) / cell);
    const n = Math.max(2, Math.ceil(total / step) + 1);
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    let seg = 0;
    for (let k = 0; k < n; k++) {
      const s = (k * total) / (n - 1);
      while (seg < m - 2 && cum[seg + 1] < s) seg++;
      const len = cum[seg + 1] - cum[seg];
      const t = len > 0 ? clamp((s - cum[seg]) / len, 0, 1) : 0;
      x[k] = px[seg] + (px[seg + 1] - px[seg]) * t;
      y[k] = py[seg] + (py[seg + 1] - py[seg]) * t;
    }
    // profile of valid (inside grid) points
    const valid = new Uint8Array(n);
    const prof = new Float32Array(n);
    let nv = 0;
    for (let k = 0; k < n; k++) {
      if (x[k] >= -0.5 && x[k] <= N - 0.5 && y[k] >= -0.5 && y[k] <= N - 0.5) {
        valid[k] = 1;
        prof[k] = sampleBilinear(H, N, x[k], y[k]);
        nv++;
      }
    }
    if (nv === 0) continue;
    // median filter over valid points (removes isolated spikes and pits before the running min)
    const compact = new Float32Array(nv);
    const where = new Int32Array(nv);
    for (let k = 0, j = 0; k < n; k++) if (valid[k]) { compact[j] = prof[k]; where[j++] = k; }
    const half = Math.max(1, Math.round(60 / (step * cell)));
    const win = new Float32Array(2 * half + 1);
    for (let j = 0; j < nv; j++) {
      const a = Math.max(0, j - half);
      const b = Math.min(nv - 1, j + half);
      const w = win.subarray(0, b - a + 1);
      w.set(compact.subarray(a, b + 1));
      w.sort();
      prof[where[j]] = w[(w.length - 1) >> 1];
    }
    const cnt = Math.max(1, Math.floor(nv * 0.1));
    let headSum = 0, tailSum = 0;
    for (let j = 0; j < cnt; j++) {
      headSum += prof[where[j]];
      tailSum += prof[where[nv - 1 - j]];
    }
    const reverse = tailSum > headSum;
    // running minimum downstream; points outside the grid carry the current value
    const bed = new Float32Array(n);
    let cur = prof[where[reverse ? nv - 1 : 0]];
    for (let q = 0; q < n; q++) {
      const k = reverse ? n - 1 - q : q;
      if (valid[k] && prof[k] < cur) cur = prof[k];
      bed[k] = cur - g.depth;
    }
    out.push({ x, y, bed, n, halfW, bankW, depth: g.depth });
  }
  return out;
}

function rasterLines(ctx: GridCtx, lines: LinePrep[], target: Float32Array, water: Uint8Array): void {
  const { N, cell } = ctx;
  const bankSlope = WATER_PARAMS.bankSlope;
  for (const ln of lines) {
    const R = ln.halfW + ln.bankW;
    const Rg = R / cell;
    const R2 = Rg * Rg;
    const halfW = ln.halfW;
    const coreFlat = 0.5 * halfW;
    const depth = ln.depth;
    for (let k = 0; k + 1 < ln.n; k++) {
      const x0 = ln.x[k], y0 = ln.y[k], x1 = ln.x[k + 1], y1 = ln.y[k + 1];
      const b0 = ln.bed[k], db = ln.bed[k + 1] - b0;
      const c0 = Math.max(0, Math.floor(Math.min(x0, x1) - Rg));
      const c1 = Math.min(N - 1, Math.ceil(Math.max(x0, x1) + Rg));
      const r0 = Math.max(0, Math.floor(Math.min(y0, y1) - Rg));
      const r1 = Math.min(N - 1, Math.ceil(Math.max(y0, y1) + Rg));
      if (c0 > c1 || r0 > r1) continue;
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      const invLen2 = len2 > 0 ? 1 / len2 : 0;
      for (let r = r0; r <= r1; r++) {
        const py = r - y0;
        const o = r * N;
        for (let c = c0; c <= c1; c++) {
          const px = c - x0;
          let t = (px * dx + py * dy) * invLen2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = px - t * dx;
          const ey = py - t * dy;
          const e2 = ex * ex + ey * ey;
          if (e2 > R2) continue;
          const dist = Math.sqrt(e2) * cell;
          const bed = b0 + t * db;
          let tv: number;
          if (dist <= coreFlat) tv = bed;
          else if (dist <= halfW) {
            const u = (dist - coreFlat) / (halfW - coreFlat);
            tv = bed + depth * u * u * (3 - 2 * u);
          } else tv = bed + depth + (dist - halfW) * bankSlope;
          const i = o + c;
          if (tv < target[i]) target[i] = tv;
          if (dist <= halfW && water[i] === 0) water[i] = PENDING_CORE;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- sea

function floodFromBorder(cand: Uint8Array, water: Uint8Array, N: number, Q: Int32Array, value: number): void {
  let tail = 0;
  const push = (i: number) => {
    if (cand[i] !== 0 && water[i] === 0) {
      water[i] = value;
      Q[tail++] = i;
    }
  };
  for (let c = 0; c < N; c++) {
    push(c);
    push((N - 1) * N + c);
  }
  for (let r = 1; r < N - 1; r++) {
    push(r * N);
    push(r * N + N - 1);
  }
  let head = 0;
  while (head < tail) {
    const i = Q[head++];
    const r = (i / N) | 0;
    const c = i - r * N;
    if (c > 0 && cand[i - 1] !== 0 && water[i - 1] === 0) { water[i - 1] = value; Q[tail++] = i - 1; }
    if (c < N - 1 && cand[i + 1] !== 0 && water[i + 1] === 0) { water[i + 1] = value; Q[tail++] = i + 1; }
    if (r > 0 && cand[i - N] !== 0 && water[i - N] === 0) { water[i - N] = value; Q[tail++] = i - N; }
    if (r < N - 1 && cand[i + N] !== 0 && water[i + N] === 0) { water[i + N] = value; Q[tail++] = i + N; }
  }
}

function carveSea(ctx: GridCtx, water: Uint8Array): void {
  const { N, H, cell, seaLevel } = ctx;
  const n = N * N;
  const P = WATER_PARAMS;
  const D = f32(ctx.scratch.a, n);
  chamferDistance(water, N, cell, D); // water holds only 0/1 here
  const land = seaLevel + P.coastFreeboard;
  for (let i = 0; i < n; i++) {
    if (water[i] === WATER.sea) {
      const md = Math.min(P.seaMinDepthCap, P.seaShoreDepth + P.seaDepthSlope * Math.max(0, D[i] - 1.5 * cell));
      const t = seaLevel - md;
      if (H[i] > t) H[i] = t;
    } else if (H[i] < land) H[i] = land;
  }
}

// ---------------------------------------------------------------- landcover lakes

function addLandcoverLakes(ctx: GridCtx, water: Uint8Array, labels: Int32Array, kinds: number[]): void {
  const lc = ctx.landcover;
  if (!lc || lc.size <= 0) return;
  const { N, E, cell, H } = ctx;
  const n = N * N;
  const m = u8(ctx.scratch.m1, n);
  m.fill(0);
  const colIdx = new Int32Array(N);
  const rowIdx = new Int32Array(N);
  for (let c = 0; c < N; c++) {
    const g = -E / 2 + (c + 0.5) * cell;
    const j = Math.floor(((g + lc.extentM / 2) / lc.extentM) * lc.size);
    colIdx[c] = j < 0 || j >= lc.size ? -1 : j;
    const gz = E / 2 - (c + 0.5) * cell;
    const r = Math.floor(((lc.extentM / 2 - gz) / lc.extentM) * lc.size);
    rowIdx[c] = r < 0 || r >= lc.size ? -1 : r;
  }
  let any = false;
  for (let r = 0; r < N; r++) {
    const lr = rowIdx[r];
    if (lr < 0) continue;
    for (let c = 0; c < N; c++) {
      const lcI = colIdx[c];
      if (lcI < 0) continue;
      const i = r * N + c;
      if (lc.data[lr * lc.size + lcI] === LC.Water && water[i] === 0 && labels[i] === 0) {
        m[i] = 1;
        any = true;
      }
    }
  }
  if (!any) return;
  // morphological opening removes speckle and thin features (< ~40 real m)
  const rad = Math.max(cell, 20 * ctx.scaleH);
  const A = f32(ctx.scratch.a, n);
  chamferDistance(m, N, cell, A);
  const m2 = u8(ctx.scratch.m2, n);
  for (let i = 0; i < n; i++) m2[i] = m[i] !== 0 && A[i] > rad ? 0 : 1;
  const C = f32(ctx.scratch.c, n);
  chamferDistance(m2, N, cell, C);
  for (let i = 0; i < n; i++) m[i] = m[i] !== 0 && C[i] <= rad ? 1 : 0;
  // connected components: keep large, flat, isolated ones as lakes
  const Q = i32(ctx.scratch.c, n);
  const minCells = Math.max(16, 20000 / (cell * cell));
  const tol = Math.max(1, 1.5 * ctx.vertical);
  for (let s = 0; s < n; s++) {
    if (m[s] !== 1) continue;
    let tail = 0;
    let head = 0;
    let touches = false;
    m[s] = 2;
    Q[tail++] = s;
    while (head < tail) {
      const i = Q[head++];
      const r = (i / N) | 0;
      const c = i - r * N;
      for (let q = 0; q < 4; q++) {
        let j: number;
        if (q === 0) { if (c === 0) continue; j = i - 1; }
        else if (q === 1) { if (c === N - 1) continue; j = i + 1; }
        else if (q === 2) { if (r === 0) continue; j = i - N; }
        else { if (r === N - 1) continue; j = i + N; }
        if (water[j] !== 0 || labels[j] !== 0) touches = true;
        if (m[j] === 1) { m[j] = 2; Q[tail++] = j; }
      }
    }
    if (touches || tail < minCells) continue;
    const vals = A.subarray(0, tail);
    for (let k = 0; k < tail; k++) vals[k] = H[Q[k]];
    vals.sort();
    const p10 = vals[Math.floor(0.1 * (tail - 1))];
    const p90 = vals[Math.floor(0.9 * (tail - 1))];
    if (p90 - p10 > tol) continue;
    const id = kinds.length;
    kinds.push(1);
    for (let k = 0; k < tail; k++) labels[Q[k]] = id;
  }
}

// ---------------------------------------------------------------- main

/**
 * Detects and (when ctx.carve) carves sea, lakes, river polygons and waterways into ctx.H.
 * `lines` must come from prepareLines on the uncarved heights. Returns the water class per cell.
 */
export function processWater(ctx: GridCtx, lines: LinePrep[]): Uint8Array {
  const { N, E, H, cell } = ctx;
  const n = N * N;
  const P = WATER_PARAMS;
  const water = new Uint8Array(n);
  const vec = ctx.vectors;

  // 1. sea: real elevation <= 0 (and sea polygons) connected to the grid border
  if (ctx.coastal && ctx.seaCand) {
    if (vec) for (const p of vec.waterPolygons) if (p.kind === 'sea') fillPolygon(p.rings, N, E, ctx.seaCand, 1);
    floodFromBorder(ctx.seaCand, water, N, i32(ctx.scratch.c, n), WATER.sea);
    if (ctx.carve) carveSea(ctx, water);
  }

  // 2. area water: lakes, reservoirs, river polygons (+ landcover lakes)
  const labels = i32(ctx.scratch.b, n);
  labels.fill(0);
  const kinds: number[] = [0]; // 1 = lake (flat level), 2 = river polygon
  if (vec) {
    for (const p of vec.waterPolygons) {
      if (p.kind === 'sea') continue;
      const id = kinds.length;
      kinds.push(p.kind === 'river' ? 2 : 1);
      fillPolygon(p.rings, N, E, labels, id);
    }
  }
  for (let i = 0; i < n; i++) if (water[i] !== 0) labels[i] = 0;
  if (ctx.carve) addLandcoverLakes(ctx, water, labels, kinds);
  const nL = kinds.length;

  if (!ctx.carve) {
    if (nL > 1) {
      for (let i = 0; i < n; i++) {
        const L = labels[i];
        if (L > 0) water[i] = kinds[L] === 1 ? WATER.lake : WATER.river;
      }
    }
    return water;
  }

  if (nL > 1) {
    // shore ring statistics -> one water level per lake
    const ringCount = new Int32Array(nL + 1);
    const inSum = new Float64Array(nL);
    const inCnt = new Int32Array(nL);
    for (let i = 0; i < n; i++) {
      const L = labels[i];
      if (L > 0) { inSum[L] += H[i]; inCnt[L]++; continue; }
      if (water[i] !== 0) continue;
      const r = (i / N) | 0;
      const c = i - r * N;
      if (c > 0) { const q = labels[i - 1]; if (q > 0 && kinds[q] === 1) ringCount[q]++; }
      if (c < N - 1) { const q = labels[i + 1]; if (q > 0 && kinds[q] === 1) ringCount[q]++; }
      if (r > 0) { const q = labels[i - N]; if (q > 0 && kinds[q] === 1) ringCount[q]++; }
      if (r < N - 1) { const q = labels[i + N]; if (q > 0 && kinds[q] === 1) ringCount[q]++; }
    }
    const offs = new Int32Array(nL + 1);
    for (let L = 0; L < nL; L++) offs[L + 1] = offs[L] + ringCount[L];
    const ring = new Float32Array(offs[nL]);
    const cur = offs.slice(0, nL);
    for (let i = 0; i < n; i++) {
      if (labels[i] !== 0 || water[i] !== 0) continue;
      const r = (i / N) | 0;
      const c = i - r * N;
      const h = H[i];
      if (c > 0) { const q = labels[i - 1]; if (q > 0 && kinds[q] === 1) ring[cur[q]++] = h; }
      if (c < N - 1) { const q = labels[i + 1]; if (q > 0 && kinds[q] === 1) ring[cur[q]++] = h; }
      if (r > 0) { const q = labels[i - N]; if (q > 0 && kinds[q] === 1) ring[cur[q]++] = h; }
      if (r < N - 1) { const q = labels[i + N]; if (q > 0 && kinds[q] === 1) ring[cur[q]++] = h; }
    }
    const level = new Float32Array(nL);
    for (let L = 1; L < nL; L++) {
      if (kinds[L] !== 1) continue;
      const a = offs[L], b = offs[L + 1];
      if (b > a) {
        const seg = ring.subarray(a, b);
        seg.sort();
        level[L] = seg[Math.floor(P.lakeLevelPercentile * (b - a - 1))];
      } else level[L] = inCnt[L] > 0 ? inSum[L] / inCnt[L] : 0;
    }

    // river polygon surface: local minimum removes bridges and DEM bumps over the water
    let hasRiverPoly = false;
    for (let L = 1; L < nL; L++) if (kinds[L] === 2 && inCnt[L] > 0) hasRiverPoly = true;
    const A = f32(ctx.scratch.a, n);
    const C = f32(ctx.scratch.c, n);
    if (hasRiverPoly) minFilter(H, C, A, N, clamp(Math.round(40 / cell), 1, 12));

    // distance from the shore inside all area water
    const mask = u8(ctx.scratch.m1, n);
    for (let i = 0; i < n; i++) mask[i] = labels[i] > 0 ? 1 : 0;
    chamferDistance(mask, N, cell, A);
    const maxD = new Float32Array(nL);
    for (let i = 0; i < n; i++) {
      const L = labels[i];
      if (L > 0 && A[i] > maxD[L]) maxD[L] = A[i];
    }
    const cap = new Float32Array(nL);
    for (let L = 1; L < nL; L++) {
      if (kinds[L] === 1) {
        const R = Math.sqrt((inCnt[L] * cell * cell) / Math.PI);
        cap[L] = clamp(2 + 0.03 * R, 3, 25);
      } else cap[L] = clamp(1.5 + 0.05 * 2 * maxD[L], 2.5, 10);
    }
    for (let i = 0; i < n; i++) {
      const L = labels[i];
      if (L === 0 || water[i] !== 0) continue;
      const d = Math.max(0, A[i] - 1.5 * cell); // cells on the shore line share one depth
      if (kinds[L] === 1) {
        H[i] = level[L] - Math.min(cap[L], P.lakeEdgeDepth + P.lakeDepthSlope * d);
        water[i] = WATER.lake;
      } else {
        const t = C[i] - Math.min(cap[L], P.riverPolyEdgeDepth + P.riverPolyDepthSlope * d);
        if (t < H[i]) H[i] = t;
        water[i] = WATER.river;
      }
    }
    // shore rim: land touching a lake stays a little above its level so it does not spill
    for (let i = 0; i < n; i++) {
      if (labels[i] !== 0 || water[i] !== 0) continue;
      const r = (i / N) | 0;
      const c = i - r * N;
      let rim = -Infinity;
      if (c > 0) { const q = labels[i - 1]; if (q > 0 && kinds[q] === 1 && level[q] > rim) rim = level[q]; }
      if (c < N - 1) { const q = labels[i + 1]; if (q > 0 && kinds[q] === 1 && level[q] > rim) rim = level[q]; }
      if (r > 0) { const q = labels[i - N]; if (q > 0 && kinds[q] === 1 && level[q] > rim) rim = level[q]; }
      if (r < N - 1) { const q = labels[i + N]; if (q > 0 && kinds[q] === 1 && level[q] > rim) rim = level[q]; }
      rim += P.lakeRimFreeboard;
      if (H[i] < rim) H[i] = rim;
    }
  }

  // 3. waterway channels
  if (lines.length > 0) {
    const T = f32(ctx.scratch.a, n);
    T.fill(Infinity);
    rasterLines(ctx, lines, T, water);
    for (let i = 0; i < n; i++) {
      const t = T[i];
      if (t === Infinity) continue;
      if (water[i] === PENDING_CORE) {
        H[i] = t; // core: assign, cutting through bridges and DEM bumps
        water[i] = WATER.river;
      } else if (t < H[i]) H[i] = t;
    }
  }
  return water;
}
