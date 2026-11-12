import { LC, type LandcoverGrid, type Pt, type WaterPolygon, type Waterway } from '../types';
import { chamferDistance, minFilter, sampleBilinear } from './filters';
import { polygonSpans, toCol, toRow, type CellBox } from './raster';

/**
 * One water model for both grids. Every water body is identified once (polygon ids joined by a
 * union-find across overlapping and touching pieces, in both grids), gets one surface level
 * (lakes: robust shore statistic over both grids) or one monotone bed profile (waterways, in game
 * coordinates), and is then carved into the playable and the world grid with the same rules.
 * The playable grid uses the detailed vectors; the world grid uses them inside the detail box
 * (playable area + margin) and the coarse world-water outlines outside it, so both grids agree
 * along the playable border.
 */

/** Water classes in the per-grid water array. */
export const WATER = { none: 0, sea: 1, lake: 2, river: 3 } as const;
/** temporary code while rasterizing waterway cores */
const CORE_SHOWN = 5;

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
  /** ocean outlines (generalized) count as sea only where the DEM is at most this high (real m) */
  oceanMaxReal: 3,
  /** ... and everywhere deeper inside them than this (real m), whatever the DEM says */
  oceanSureReal: 40,
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
  /** in PLAYABLE cells, so the channel is the same on both grids */
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export type Labels = Uint16Array | Int32Array;

export interface WGrid {
  N: number;
  /** game metres covered */
  E: number;
  /** game metres per cell */
  cell: number;
  H: Float32Array;
  /** water kind per cell */
  water: Uint8Array;
  /** water surface height, NaN on land */
  level: Float32Array;
  /** water body id per cell (0 = none) */
  labels: Labels;
  isWorld: boolean;
  /** cells where the detailed vectors apply; null when there are none */
  detailBox: CellBox | null;
  /** cells to leave out of shared statistics (world: the centre quarter, covered by the playable grid) */
  skipBox: CellBox | null;
  /**
   * world: cells whose raw elevation was blended from the playable DEM (fine enough to judge a
   * shoreline); outside it the coarse DEM cannot, and ocean outlines alone decide. null = everywhere.
   */
  fineDemBox: CellBox | null;
}

/** Cells whose centres lie within +-half game metres of the centre. */
export function boxFor(N: number, E: number, half: number): CellBox {
  return {
    c0: Math.max(0, Math.ceil(toCol(-half, N, E) - 1e-9)),
    c1: Math.min(N - 1, Math.floor(toCol(half, N, E) + 1e-9)),
    r0: Math.max(0, Math.ceil(toRow(half, N, E) - 1e-9)),
    r1: Math.min(N - 1, Math.floor(toRow(-half, N, E) + 1e-9)),
  };
}

const inBox = (b: CellBox, r: number, c: number) => r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1;

// ---------------------------------------------------------------- water bodies

export interface WaterBodies {
  /** polygon id = index + 1. kind 1 = lake (flat level), 2 = river polygon */
  polys: { kind: number; rings: Pt[][]; detail: boolean }[];
  ocean: Pt[][][];
  /** per id */
  kind: number[];
  parent: number[];
  hasDetail: boolean;
}

export function collectBodies(detail: WaterPolygon[] | undefined, coarse: WaterPolygon[] | undefined): WaterBodies {
  const B: WaterBodies = { polys: [], ocean: [], kind: [0], parent: [0], hasDetail: !!detail };
  const add = (list: WaterPolygon[] | undefined, isDetail: boolean) => {
    for (const p of list ?? []) {
      if (!p.rings.length || p.rings[0].length < 3) continue;
      if (p.kind === 'sea') { B.ocean.push(p.rings); continue; }
      // coarse outlines are only needed where detail is missing
      const kind = p.kind === 'river' ? 2 : 1;
      B.polys.push({ kind, rings: p.rings, detail: isDetail });
      B.kind.push(kind);
      B.parent.push(B.kind.length - 1);
    }
  };
  add(detail, true);
  add(coarse, false);
  return B;
}

export function newBodyId(B: WaterBodies, kind: number): number {
  B.kind.push(kind);
  B.parent.push(B.kind.length - 1);
  return B.kind.length - 1;
}

function find(parent: number[], a: number): number {
  while (parent[a] !== a) {
    parent[a] = parent[parent[a]];
    a = parent[a];
  }
  return a;
}

function union(parent: number[], a: number, b: number): void {
  const ra = find(parent, a), rb = find(parent, b);
  if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
}

/** Root id per body id, after all unions. */
export function bodyRoots(B: WaterBodies): Int32Array {
  const r = new Int32Array(B.kind.length);
  for (let i = 1; i < r.length; i++) r[i] = find(B.parent, i);
  return r;
}

/**
 * Rasterizes the water polygons into g.labels. Rivers first, lakes over them. Overlapping or
 * touching pieces of the same kind are joined into one body.
 */
export function labelGrid(g: WGrid, B: WaterBodies): void {
  const { N, E, labels: L } = g;
  L.fill(0);
  for (const pass of [2, 1]) {
    for (let k = 0; k < B.polys.length; k++) {
      const p = B.polys[k];
      if (p.kind !== pass) continue;
      const id = k + 1;
      let clip: CellBox | null = null;
      let exclude = false;
      if (B.hasDetail) {
        if (!g.isWorld) {
          if (!p.detail) continue;
        } else if (g.detailBox) {
          clip = g.detailBox;
          exclude = !p.detail;
        }
      }
      const run = (row: number, c0: number, c1: number) => {
        const o = row * N;
        for (let c = c0; c <= c1; c++) {
          const prev = L[o + c];
          if (prev !== 0 && prev !== id && B.kind[prev] === pass) union(B.parent, prev, id);
          L[o + c] = id;
        }
      };
      polygonSpans(p.rings, N, E, (row, c0, c1) => {
        if (!clip) return run(row, c0, c1);
        const inRow = row >= clip.r0 && row <= clip.r1;
        if (!exclude) {
          if (!inRow) return;
          const a = Math.max(c0, clip.c0), b = Math.min(c1, clip.c1);
          if (a <= b) run(row, a, b);
        } else if (!inRow) run(row, c0, c1);
        else {
          if (c0 < clip.c0) run(row, c0, Math.min(c1, clip.c0 - 1));
          if (c1 > clip.c1) run(row, Math.max(c0, clip.c1 + 1), c1);
        }
      });
    }
  }
  // touching pieces (tile cuts, detail / coarse switch) of the same kind are one body
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      const a = L[i];
      if (a === 0) continue;
      if (c < N - 1) { const b = L[i + 1]; if (b !== 0 && b !== a && B.kind[a] === B.kind[b]) union(B.parent, a, b); }
      if (r < N - 1) { const b = L[i + N]; if (b !== 0 && b !== a && B.kind[a] === B.kind[b]) union(B.parent, a, b); }
    }
  }
}

// ---------------------------------------------------------------- sea

function flood(cand: Uint8Array, water: Uint8Array, N: number, Q: Int32Array, tail0: number): void {
  let tail = tail0;
  let head = 0;
  while (head < tail) {
    const i = Q[head++];
    const r = (i / N) | 0;
    const c = i - r * N;
    if (c > 0 && cand[i - 1] !== 0 && water[i - 1] === 0) { water[i - 1] = WATER.sea; Q[tail++] = i - 1; }
    if (c < N - 1 && cand[i + 1] !== 0 && water[i + 1] === 0) { water[i + 1] = WATER.sea; Q[tail++] = i + 1; }
    if (r > 0 && cand[i - N] !== 0 && water[i - N] === 0) { water[i - N] = WATER.sea; Q[tail++] = i - N; }
    if (r < N - 1 && cand[i + N] !== 0 && water[i + N] === 0) { water[i + N] = WATER.sea; Q[tail++] = i + N; }
  }
}

function seaCandidates(
  g: WGrid, real: Float32Array, ocean: Pt[][][], cand: Uint8Array, scaleH: number, scratch: Scratch,
): void {
  const n = g.N * g.N;
  const L = g.labels;
  for (let i = 0; i < n; i++) cand[i] = real[i] <= 0 && L[i] === 0 ? 1 : 0;
  if (ocean.length === 0) return;
  const om = u8(scratch.m2, n);
  om.fill(0);
  for (const rings of ocean) {
    polygonSpans(rings, g.N, g.E, (row, c0, c1) => {
      om.fill(1, row * g.N + c0, row * g.N + c1 + 1);
    });
  }
  // Outlines are generalized (tens of metres at zoom 10): deep inside them it is sea whatever the
  // DEM says (some DEMs carry a surface model over water); near the outline the DEM must agree.
  const D = f32(scratch.a, n);
  chamferDistance(om, g.N, g.cell, D);
  const sure = WATER_PARAMS.oceanSureReal * scaleH;
  const maxReal = WATER_PARAMS.oceanMaxReal;
  const fine = g.fineDemBox;
  const N = g.N;
  for (let i = 0; i < n; i++) {
    if (om[i] === 0 || L[i] !== 0) continue;
    const r = (i / N) | 0;
    const coarseOnly = fine !== null && !inBox(fine, r, i - r * N);
    if (coarseOnly || D[i] > sure || real[i] <= maxReal) cand[i] = 2;
  }
}

/**
 * Sea on both grids, in real metres. With world water outlines the sea grows from ocean
 * polygons (DEM cells at or below 0 m join when connected); without them it grows from the world
 * border. The playable grid is also seeded where the world just outside its border is sea, so
 * both grids agree. Lakes and rivers (polygons) never become sea.
 */
export function classifySea(
  world: WGrid,
  play: WGrid,
  realW: Float32Array,
  realP: Float32Array,
  B: WaterBodies,
  useOcean: boolean,
  scaleH: number,
  scratch: Scratch,
): void {
  for (const g of [world, play]) {
    const n = g.N * g.N;
    const cand = u8(scratch.m1, n);
    seaCandidates(g, g.isWorld ? realW : realP, useOcean ? B.ocean : [], cand, scaleH, scratch);
    const Q = i32(scratch.c, n);
    let tail = 0;
    const N = g.N;
    for (let i = 0; i < n; i++) if (cand[i] === 2) { g.water[i] = WATER.sea; Q[tail++] = i; }
    const seedBorder = (i: number, ok: boolean) => {
      if (ok && cand[i] !== 0 && g.water[i] === 0) { g.water[i] = WATER.sea; Q[tail++] = i; }
    };
    if (g.isWorld) {
      if (!useOcean) {
        for (let k = 0; k < N; k++) {
          seedBorder(k, true);
          seedBorder((N - 1) * N + k, true);
          seedBorder(k * N, true);
          seedBorder(k * N + N - 1, true);
        }
      }
    } else {
      const W = world;
      const half = g.E / 2;
      const off = W.cell * 0.75;
      const seaAt = (gx: number, gz: number) => {
        const c = Math.round(toCol(gx, W.N, W.E)), r = Math.round(toRow(gz, W.N, W.E));
        return r >= 0 && c >= 0 && r < W.N && c < W.N && W.water[r * W.N + c] === WATER.sea;
      };
      for (let k = 0; k < N; k++) {
        const t = -half + (k + 0.5) * g.cell;
        seedBorder(k, seaAt(t, half + off));
        seedBorder((N - 1) * N + k, seaAt(t, -half - off));
        seedBorder(k * N, seaAt(-half - off, -t));
        seedBorder(k * N + N - 1, seaAt(half + off, -t));
      }
    }
    flood(cand, g.water, N, Q, tail);
  }
}

/** Minimum sea depth near the shore and land kept above sea level (coastal maps). */
export function carveSea(g: WGrid, seaLevel: number, carve: boolean, scratch: Scratch): void {
  const { N, H, cell } = g;
  const n = N * N;
  const P = WATER_PARAMS;
  if (carve) {
    const D = f32(scratch.a, n);
    chamferDistance(g.water, N, cell, D); // water holds only sea (1) here
    const land = seaLevel + P.coastFreeboard;
    for (let i = 0; i < n; i++) {
      if (g.water[i] === WATER.sea) {
        const md = Math.min(P.seaMinDepthCap, P.seaShoreDepth + P.seaDepthSlope * Math.max(0, D[i] - 1.5 * cell));
        const t = seaLevel - md;
        if (H[i] > t) H[i] = t;
      } else if (g.labels[i] === 0 && H[i] < land) H[i] = land;
    }
  }
  for (let i = 0; i < n; i++) if (g.water[i] === WATER.sea) g.level[i] = seaLevel;
}

// ---------------------------------------------------------------- landcover lakes (playable only)

export function addLandcoverLakes(
  g: WGrid,
  lc: LandcoverGrid,
  B: WaterBodies,
  scaleH: number,
  vertical: number,
  scratch: Scratch,
): void {
  if (lc.size <= 0) return;
  const { N, E, cell, H, water, labels } = g;
  const n = N * N;
  const m = u8(scratch.m1, n);
  m.fill(0);
  const idx = new Int32Array(N);
  for (let c = 0; c < N; c++) {
    const gpos = -E / 2 + (c + 0.5) * cell;
    const j = Math.floor(((gpos + lc.extentM / 2) / lc.extentM) * lc.size);
    idx[c] = j < 0 || j >= lc.size ? -1 : j;
  }
  let any = false;
  for (let r = 0; r < N; r++) {
    const rr = idx[r]; // square grids: row r maps like column r (gz = -gpos, rows count downward)
    if (rr < 0) continue;
    for (let c = 0; c < N; c++) {
      const lcI = idx[c];
      if (lcI < 0) continue;
      const i = r * N + c;
      if (lc.data[rr * lc.size + lcI] === LC.Water && water[i] === 0 && labels[i] === 0) {
        m[i] = 1;
        any = true;
      }
    }
  }
  if (!any) return;
  const rad = Math.max(cell, 20 * scaleH);
  const A = f32(scratch.a, n);
  chamferDistance(m, N, cell, A);
  const m2 = u8(scratch.m2, n);
  for (let i = 0; i < n; i++) m2[i] = m[i] !== 0 && A[i] > rad ? 0 : 1;
  const C = f32(scratch.c, n);
  chamferDistance(m2, N, cell, C);
  for (let i = 0; i < n; i++) m[i] = m[i] !== 0 && C[i] <= rad ? 1 : 0;
  const Q = i32(scratch.c, n);
  const minCells = Math.max(16, 20000 / (cell * cell));
  const tol = Math.max(1, 1.5 * vertical);
  const maxId = labels instanceof Uint16Array ? 65535 : 2 ** 31 - 1;
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
      // touching the grid border: the world grid cannot see this lake, so skip it
      if (r === 0 || c === 0 || r === N - 1 || c === N - 1) touches = true;
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
    if (touches || tail < minCells || B.kind.length >= maxId) continue;
    const vals = A.subarray(0, tail);
    for (let k = 0; k < tail; k++) vals[k] = H[Q[k]];
    vals.sort();
    if (vals[Math.floor(0.9 * (tail - 1))] - vals[Math.floor(0.1 * (tail - 1))] > tol) continue;
    const id = newBodyId(B, 1);
    for (let k = 0; k < tail; k++) labels[Q[k]] = id;
  }
}

// ---------------------------------------------------------------- lakes and river polygons

export interface BodyStats {
  root: Int32Array;
  /** per root: surface level for lakes */
  level: Float32Array;
  /** per root: depth cap */
  cap: Float32Array;
}

const NB = [0, 0, 0, 0];

/** Shore-ring level per lake body over both grids, area-based depth caps. */
export function bodyStats(grids: WGrid[], B: WaterBodies, scratch: Scratch): BodyStats {
  const root = bodyRoots(B);
  const nB = root.length;
  const ringCount = new Int32Array(nB + 1);
  const inSum = new Float64Array(nB);
  const inCnt = new Float64Array(nB);
  const area = new Float64Array(nB);
  const maxD = new Float32Array(nB);
  const ringPass = (g: WGrid, fill: Float32Array | null, cur: Int32Array | null) => {
    const { N, labels: L, water, H } = g;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const i = r * N + c;
        if (g.skipBox && inBox(g.skipBox, r, c)) continue;
        const own = L[i];
        if (own !== 0) {
          if (!fill) {
            const q = root[own];
            inSum[q] += H[i];
            inCnt[q]++;
          }
          continue;
        }
        if (water[i] !== 0) continue;
        NB[0] = c > 0 ? L[i - 1] : 0;
        NB[1] = c < N - 1 ? L[i + 1] : 0;
        NB[2] = r > 0 ? L[i - N] : 0;
        NB[3] = r < N - 1 ? L[i + N] : 0;
        for (let k = 0; k < 4; k++) {
          const lb = NB[k];
          if (lb === 0 || B.kind[lb] !== 1) continue;
          const q = root[lb];
          if (fill && cur) fill[cur[q]++] = H[i];
          else ringCount[q]++;
        }
      }
    }
  };
  for (const g of grids) {
    ringPass(g, null, null);
    // areas and distances (river caps) per body, max over grids
    const n = g.N * g.N;
    const cnt = new Float64Array(nB);
    const mask = u8(scratch.m1, n);
    for (let i = 0; i < n; i++) {
      const l = g.labels[i];
      mask[i] = l !== 0 ? 1 : 0;
      if (l !== 0) cnt[root[l]]++;
    }
    for (let q = 1; q < nB; q++) area[q] = Math.max(area[q], cnt[q] * g.cell * g.cell);
    const A = f32(scratch.a, n);
    chamferDistance(mask, g.N, g.cell, A);
    for (let i = 0; i < n; i++) {
      const l = g.labels[i];
      if (l !== 0 && A[i] > maxD[root[l]]) maxD[root[l]] = A[i];
    }
  }
  const offs = new Int32Array(nB + 1);
  for (let q = 0; q < nB; q++) offs[q + 1] = offs[q] + ringCount[q];
  const ring = new Float32Array(offs[nB]);
  const cur = offs.slice(0, nB);
  for (const g of grids) ringPass(g, ring, cur);
  const level = new Float32Array(nB);
  const cap = new Float32Array(nB);
  for (let q = 1; q < nB; q++) {
    if (root[q] !== q) continue;
    if (B.kind[q] === 1) {
      const a = offs[q], b = offs[q + 1];
      if (b > a) {
        const seg = ring.subarray(a, b);
        seg.sort();
        level[q] = seg[Math.floor(WATER_PARAMS.lakeLevelPercentile * (b - a - 1))];
      } else level[q] = inCnt[q] > 0 ? inSum[q] / inCnt[q] : 0;
      cap[q] = clamp(2 + 0.03 * Math.sqrt(area[q] / Math.PI), 3, 25);
    } else cap[q] = clamp(1.5 + 0.1 * maxD[q], 2.5, 10);
  }
  return { root, level, cap };
}

/** Lakes: flat level and a bed deepening from the shore. River polygons: local-minimum surface. */
export function carveAreas(g: WGrid, B: WaterBodies, S: BodyStats, carve: boolean, scratch: Scratch): void {
  const { N, H, cell, labels: L, water, level } = g;
  const n = N * N;
  const P = WATER_PARAMS;
  let hasRiver = false;
  let hasAny = false;
  for (let i = 0; i < n; i++) {
    const l = L[i];
    if (l === 0) continue;
    hasAny = true;
    if (B.kind[l] === 2) { hasRiver = true; break; }
  }
  if (!hasAny) return;
  const A = f32(scratch.a, n);
  const C = f32(scratch.c, n);
  if (hasRiver) minFilter(H, C, A, N, clamp(Math.round(40 / cell), 1, 12));
  const mask = u8(scratch.m1, n);
  for (let i = 0; i < n; i++) mask[i] = L[i] !== 0 ? 1 : 0;
  chamferDistance(mask, N, cell, A);
  for (let i = 0; i < n; i++) {
    const l = L[i];
    if (l === 0 || water[i] !== 0) continue;
    const q = S.root[l];
    const d = Math.max(0, A[i] - 1.5 * cell); // cells on the shore line share one depth
    if (B.kind[l] === 1) {
      if (carve) H[i] = S.level[q] - Math.min(S.cap[q], P.lakeEdgeDepth + P.lakeDepthSlope * d);
      water[i] = WATER.lake;
      level[i] = S.level[q];
    } else {
      const surf = hasRiver ? C[i] : H[i];
      if (carve) {
        const t = surf - Math.min(S.cap[q], P.riverPolyEdgeDepth + P.riverPolyDepthSlope * d);
        if (t < H[i]) H[i] = t;
      }
      water[i] = WATER.river;
      level[i] = surf;
    }
  }
  if (!carve) return;
  // shore rim: land touching a lake stays a little above its level so it does not spill
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      if (L[i] !== 0 || water[i] !== 0) continue;
      let rim = -Infinity;
      NB[0] = c > 0 ? L[i - 1] : 0;
      NB[1] = c < N - 1 ? L[i + 1] : 0;
      NB[2] = r > 0 ? L[i - N] : 0;
      NB[3] = r < N - 1 ? L[i + N] : 0;
      for (let k = 0; k < 4; k++) {
        const lb = NB[k];
        if (lb !== 0 && B.kind[lb] === 1 && S.level[S.root[lb]] > rim) rim = S.level[S.root[lb]];
      }
      rim += P.lakeRimFreeboard;
      if (H[i] < rim) H[i] = rim;
    }
  }
}

// ---------------------------------------------------------------- waterways

/** A waterway with its channel and monotone surface profile, in game coordinates. */
export interface LineGeo {
  gx: Float64Array;
  gz: Float64Array;
  /** water surface per point, non-increasing downstream */
  surf: Float32Array;
  n: number;
  halfW: number;
  bankW: number;
  depth: number;
  detail: boolean;
  /** source waterway (for recomputing the profile) */
  src: Waterway;
}

function riverDepth(kind: Waterway['kind'], width: number): number {
  if (kind === 'river') return clamp(1.5 + 0.05 * width, 2.5, 10);
  if (kind === 'canal') return clamp(1.5 + 0.04 * width, 2, 6);
  return clamp(1 + 0.05 * width, 1.2, 2.5);
}

/** Channel geometry for a waterway in game metres; `cell` is the playable cell size. */
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

/** Coarse field of waterway surfaces over the world area, used to tie profiles together. */
export interface SurfField {
  N: number;
  E: number;
  data: Float32Array;
}

export function createSurfField(E: number, N: number): SurfField {
  return { N, E, data: new Float32Array(N * N).fill(Infinity) };
}

function fieldAt(F: SurfField, gx: number, gz: number): number {
  const c = Math.round(toCol(gx, F.N, F.E)), r = Math.round(toRow(gz, F.N, F.E));
  let best = Infinity;
  for (let rr = Math.max(0, r - 1); rr <= Math.min(F.N - 1, r + 1); rr++) {
    for (let cc = Math.max(0, c - 1); cc <= Math.min(F.N - 1, c + 1); cc++) {
      const v = F.data[rr * F.N + cc];
      if (v < best) best = v;
    }
  }
  return best;
}

export function addToField(F: SurfField, lines: LineGeo[]): void {
  const cell = F.E / F.N;
  for (const ln of lines) {
    const hw = Math.max(ln.halfW, 0.75 * cell) / cell;
    for (let k = 0; k + 1 < ln.n; k++) {
      const x0 = toCol(ln.gx[k], F.N, F.E), y0 = toRow(ln.gz[k], F.N, F.E);
      const x1 = toCol(ln.gx[k + 1], F.N, F.E), y1 = toRow(ln.gz[k + 1], F.N, F.E);
      const s0 = ln.surf[k], ds = ln.surf[k + 1] - s0;
      segmentCells(F.N, x0, y0, x1, y1, hw, (i, t) => {
        const v = s0 + t * ds;
        if (v < F.data[i]) F.data[i] = v;
      });
    }
  }
}

/** Calls fn(index, t) for cells within radius (grid units) of the segment. Per segment, not per cell. */
function segmentCells(
  N: number, x0: number, y0: number, x1: number, y1: number, rad: number,
  fn: (i: number, t: number) => void,
): void {
  const c0 = Math.max(0, Math.floor(Math.min(x0, x1) - rad));
  const c1 = Math.min(N - 1, Math.ceil(Math.max(x0, x1) + rad));
  const r0 = Math.max(0, Math.floor(Math.min(y0, y1) - rad));
  const r1 = Math.min(N - 1, Math.ceil(Math.max(y0, y1) + rad));
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const inv = len2 > 0 ? 1 / len2 : 0;
  const R2 = rad * rad;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      let t = ((c - x0) * dx + (r - y0) * dy) * inv;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = c - x0 - t * dx, ey = r - y0 - t * dy;
      if (ex * ex + ey * ey <= R2) fn(r * N + c, t);
    }
  }
}

/**
 * Monotone surface profiles for waterways, in game coordinates. `heightAt` gives the smoothed,
 * uncarved terrain (NaN outside the data). Direction: the higher end is upstream. With a field,
 * the profile is also kept at or below other waterways' surfaces there (ties the detailed and
 * the coarse representation of a river together).
 */
export function prepareLines(
  list: Waterway[],
  detail: boolean,
  heightAt: (gx: number, gz: number) => number,
  field: SurfField | null,
  scaleH: number,
  cellP: number,
  lim: number,
): LineGeo[] {
  const out: LineGeo[] = [];
  for (const ww of list) {
    if (ww.pts.length < 2) continue;
    const g = waterwayGeometry(ww, scaleH, cellP);
    const halfW = g.width / 2;
    const bankW = Math.max(3 * cellP, halfW);
    const m = ww.pts.length;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ww.pts) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    if (x1 < -lim || z1 < -lim || x0 > lim || z0 > lim) continue;
    const cum = new Float64Array(m);
    for (let k = 1; k < m; k++) cum[k] = cum[k - 1] + Math.hypot(ww.pts[k][0] - ww.pts[k - 1][0], ww.pts[k][1] - ww.pts[k - 1][1]);
    const total = cum[m - 1];
    if (total <= 0) continue;
    const step = Math.max(cellP, 0.5 * halfW);
    const n = Math.max(2, Math.ceil(total / step) + 1);
    const gx = new Float64Array(n);
    const gz = new Float64Array(n);
    let seg = 0;
    for (let k = 0; k < n; k++) {
      const s = (k * total) / (n - 1);
      while (seg < m - 2 && cum[seg + 1] < s) seg++;
      const len = cum[seg + 1] - cum[seg];
      const t = len > 0 ? clamp((s - cum[seg]) / len, 0, 1) : 0;
      gx[k] = ww.pts[seg][0] + (ww.pts[seg + 1][0] - ww.pts[seg][0]) * t;
      gz[k] = ww.pts[seg][1] + (ww.pts[seg + 1][1] - ww.pts[seg][1]) * t;
    }
    const prof = new Float32Array(n);
    const valid = new Uint8Array(n);
    let nv = 0;
    for (let k = 0; k < n; k++) {
      const h = heightAt(gx[k], gz[k]);
      if (Number.isFinite(h)) { prof[k] = h; valid[k] = 1; nv++; }
    }
    if (nv === 0) continue;
    // median filter over valid points (removes isolated spikes and pits before the running min)
    const compact = new Float32Array(nv);
    const where = new Int32Array(nv);
    for (let k = 0, j = 0; k < n; k++) if (valid[k]) { compact[j] = prof[k]; where[j++] = k; }
    const half = Math.max(1, Math.round(60 / step));
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
    if (field) {
      for (let j = 0; j < nv; j++) {
        const k = where[j];
        const f = fieldAt(field, gx[k], gz[k]);
        if (f < prof[k]) prof[k] = f;
      }
    }
    const surf = new Float32Array(n);
    let cur = prof[where[reverse ? nv - 1 : 0]];
    for (let q = 0; q < n; q++) {
      const k = reverse ? n - 1 - q : q;
      if (valid[k] && prof[k] < cur) cur = prof[k];
      surf[k] = cur;
    }
    out.push({ gx, gz, surf, n, halfW, bankW, depth: g.depth, detail, src: ww });
  }
  return out;
}

/**
 * Carves waterway channels into one grid. Where the grid is too coarse for the channel (narrower
 * than 1.5 cells, e.g. the world grid) a cell crossed by the line is lowered toward the bed by the
 * share of the cell the channel covers, which is what averaging a fine grid would give; such
 * sub-cell channels are not marked as water.
 */
export function carveLines(g: WGrid, lines: LineGeo[], hasDetail: boolean, carve: boolean, scratch: Scratch): void {
  if (lines.length === 0) return;
  const { N, E, cell, H, water, level } = g;
  const n = N * N;
  const T = f32(scratch.a, n);
  const S = f32(scratch.c, n);
  const U = f32(scratch.b, n);
  T.fill(Infinity);
  S.fill(Infinity);
  U.fill(Infinity);
  const bankSlope = WATER_PARAMS.bankSlope;
  const box = g.isWorld && hasDetail ? g.detailBox : null;
  for (const ln of lines) {
    if (!g.isWorld && hasDetail && !ln.detail) continue;
    const sub = ln.halfW < 0.75 * cell;
    const hw = ln.halfW;
    const coreFlat = 0.5 * hw;
    const R = sub ? 0.6 * cell : hw + ln.bankW;
    const cov = Math.min(1, (2 * hw) / cell);
    const Rg = R / cell;
    const R2 = Rg * Rg;
    const wantInside = ln.detail;
    const depth = ln.depth;
    for (let k = 0; k + 1 < ln.n; k++) {
      const x0 = toCol(ln.gx[k], N, E), y0 = toRow(ln.gz[k], N, E);
      const x1 = toCol(ln.gx[k + 1], N, E), y1 = toRow(ln.gz[k + 1], N, E);
      const s0 = ln.surf[k], dsf = ln.surf[k + 1] - s0;
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
        const rowIn = box ? r >= box.r0 && r <= box.r1 : true;
        for (let c = c0; c <= c1; c++) {
          if (box) {
            const inside = rowIn && c >= box.c0 && c <= box.c1;
            if (inside !== wantInside) continue;
          }
          const px = c - x0;
          let t = (px * dx + py * dy) * invLen2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = px - t * dx;
          const ey = py - t * dy;
          const e2 = ex * ex + ey * ey;
          if (e2 > R2) continue;
          const s = s0 + t * dsf;
          const i = r * N + c;
          if (sub) {
            const bed = s - depth;
            const h = H[i];
            const v = h > bed ? h - cov * (h - bed) : h;
            if (v < U[i]) U[i] = v;
            continue;
          }
          const dist = Math.sqrt(e2) * cell;
          let tv: number;
          if (dist <= hw) {
            const bed = s - depth;
            if (dist <= coreFlat) tv = bed;
            else {
              const u = (dist - coreFlat) / (hw - coreFlat);
              tv = bed + depth * u * u * (3 - 2 * u);
            }
            if (water[i] === 0) water[i] = CORE_SHOWN;
            if (s < S[i]) S[i] = s;
          } else tv = s + (dist - hw) * bankSlope;
          if (tv < T[i]) T[i] = tv;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const t = T[i];
    if (t !== Infinity) {
      if (water[i] === CORE_SHOWN) {
        if (carve) H[i] = t; // core: assign, cutting through bridges and DEM bumps
        water[i] = WATER.river;
        level[i] = S[i];
      } else if (carve && t < H[i]) H[i] = t;
    }
    if (carve && U[i] < H[i]) H[i] = U[i];
  }
}

/** Sampler of smoothed heights over both grids (playable inside its extent, else world). */
export function makeHeightAt(play: WGrid, world: WGrid): (gx: number, gz: number) => number {
  const hp = play.E / 2, hw = world.E / 2;
  return (gx, gz) => {
    if (Math.abs(gx) <= hp && Math.abs(gz) <= hp) {
      return sampleBilinear(play.H, play.N, toCol(gx, play.N, play.E), toRow(gz, play.N, play.E));
    }
    if (Math.abs(gx) <= hw && Math.abs(gz) <= hw) {
      return sampleBilinear(world.H, world.N, toCol(gx, world.N, world.E), toRow(gz, world.N, world.E));
    }
    return NaN;
  };
}
