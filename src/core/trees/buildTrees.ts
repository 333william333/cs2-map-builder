import type {
  AreaPolygon, ClimateProfile, LandcoverGrid, Pt, RoadClass, RoadNetwork, TerrainResult, TreeSet,
  TreeSettings, TreeSpecies, VectorData,
} from '../types';
import { LC } from '../types';
import {
  biomeFromClimate, COAST_FACTOR, COLD_FACTOR, DRY_FACTOR, Group, LEAF_FACTOR, NEAR_WATER_FACTOR, NS, SP,
  SPECIES, STUNTED, warmestMonthC, weightsFor, NGROUPS,
} from './species';

export interface TreeInput {
  terrain: TerrainResult;
  settings: TreeSettings;
  landcover?: LandcoverGrid;
  vectors?: VectorData;
  climate?: ClimateProfile;
  roads?: RoadNetwork; // keep trees off roads
  centerLat: number; // fallback biome when climate is missing
}

// ---------------------------------------------------------------- constants

/** Mask raster resolution (cells across the playable area). 3.5 game m per cell for a 14336 m map. */
const MS = 4096;
/** Candidate cell size (game m). One jittered candidate per cell, accepted by a dither threshold. */
const CAND = 6;

// mask byte layout
const CLS_MASK = 0x0f;
const LEAF_SHIFT = 4; // bits 4-5: 0 unknown, 1 broadleaved, 2 needleleaved, 3 mixed
const ROAD_CORE = 0x40;
const ROAD_FULL = 0x80;

// ground classes (low nibble of the mask)
const C_FOREST = 1;
const C_SHRUB = 2;
const C_WETLAND = 3;
const C_PARK = 4;
const C_BUILT = 5;
const C_LONE = 6;
const C_MANGROVE = 7;

/** Natural area (square game metres) per tree before the density setting is applied. */
const CLS_AREA = [0, 80, 350, 220, 420, 1000, 30000, 150];
const CLS_GROUP: Group[] = [
  Group.Tree, Group.Tree, Group.Shrub, Group.Wetland, Group.Park, Group.Built, Group.Lone, Group.Mangrove,
];

/** Half-width plus margin (game m) of the no-tree buffer per road class. */
const ROAD_BUFFER: Record<RoadClass, number> = {
  motorway: 16, trunk: 12, primary: 10, secondary: 9, tertiary: 8, residential: 7,
  service: 5, pedestrian: 3.5, rail: 12, tram: 7, subway: 0,
};

const TAN30 = Math.tan((30 * Math.PI) / 180);
const TAN40 = Math.tan((40 * Math.PI) / 180);
const TAN14 = Math.tan((14 * Math.PI) / 180);

// ---------------------------------------------------------------- hashing and noise

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35) ^ Math.imul(c | 0, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}
const h01 = (a: number, b: number, c: number) => hash3(a, b, c) / 4294967296;

/** Smooth value noise in [0, 1]. */
function vn(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = h01(xi, yi, seed);
  const b = h01(xi + 1, yi, seed);
  const c = h01(xi, yi + 1, seed);
  const d = h01(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ---------------------------------------------------------------- rasterisation

/** Even-odd scanline fill of polygon rings into the mask. mode: see paint modes below. */
const MODE_CLEAR = 0;
const MODE_BUILT = 1;
const MODE_WETLAND = 2;
const MODE_PARK = 3;
const MODE_FOREST = 4;

function fillPolygon(
  mask: Uint8Array, rings: Pt[][], half: number, extent: number, mode: number, leaf: number,
): void {
  if (!rings.length) return;
  const k = MS / extent;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      const y = (half - p[1]) * k;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const r0 = Math.max(0, Math.ceil(minY - 0.5));
  const r1 = Math.min(MS - 1, Math.ceil(maxY - 0.5) - 1);
  if (r1 < r0) return;
  const rows: number[][] = new Array(r1 - r0 + 1);
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const ax = (a[0] + half) * k;
      const ay = (half - a[1]) * k;
      const bx = (b[0] + half) * k;
      const by = (half - b[1]) * k;
      if (ay === by) continue;
      const lo = Math.max(r0, Math.ceil(Math.min(ay, by) - 0.5));
      const hi = Math.min(r1, Math.ceil(Math.max(ay, by) - 0.5) - 1);
      const slope = (bx - ax) / (by - ay);
      for (let r = lo; r <= hi; r++) {
        const x = ax + (r + 0.5 - ay) * slope;
        (rows[r - r0] ??= []).push(x);
      }
    }
  }
  const leafBits = leaf << LEAF_SHIFT;
  for (let r = r0; r <= r1; r++) {
    const xs = rows[r - r0];
    if (!xs || xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const base = r * MS;
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const c0 = Math.max(0, Math.ceil(xs[s] - 0.5));
      const c1 = Math.min(MS - 1, Math.ceil(xs[s + 1] - 0.5) - 1);
      switch (mode) {
        case MODE_CLEAR:
          for (let c = c0; c <= c1; c++) mask[base + c] = 0;
          break;
        case MODE_BUILT:
          for (let c = c0; c <= c1; c++) if ((mask[base + c] & CLS_MASK) === 0) mask[base + c] = C_BUILT;
          break;
        case MODE_WETLAND:
          for (let c = c0; c <= c1; c++) {
            const cl = mask[base + c] & CLS_MASK;
            if (cl === 0 || cl === C_LONE) mask[base + c] = C_WETLAND;
          }
          break;
        case MODE_PARK:
          for (let c = c0; c <= c1; c++) {
            const cl = mask[base + c] & CLS_MASK;
            if (cl === 0 || cl === C_BUILT || cl === C_LONE) mask[base + c] = C_PARK;
          }
          break;
        default:
          for (let c = c0; c <= c1; c++) mask[base + c] = C_FOREST | leafBits;
      }
    }
  }
}

function stampSegment(
  mask: Uint8Array, ax: number, az: number, bx: number, bz: number, r: number, core: number,
  half: number, extent: number,
): void {
  const cell = extent / MS;
  const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - r + half) / cell));
  const c1 = Math.min(MS - 1, Math.floor((Math.max(ax, bx) + r + half) / cell));
  const r0 = Math.max(0, Math.floor((half - Math.max(az, bz) - r) / cell));
  const r1 = Math.min(MS - 1, Math.floor((half - Math.min(az, bz) + r) / cell));
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const r2 = r * r;
  const core2 = core * core;
  for (let row = r0; row <= r1; row++) {
    const z = half - (row + 0.5) * cell;
    for (let col = c0; col <= c1; col++) {
      const x = -half + (col + 0.5) * cell;
      let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - (ax + t * dx);
      const ez = z - (az + t * dz);
      const d2 = ex * ex + ez * ez;
      if (d2 < r2) mask[row * MS + col] |= d2 < core2 ? ROAD_FULL | ROAD_CORE : ROAD_FULL;
    }
  }
}

function stampPolyline(mask: Uint8Array, pts: Pt[], cls: RoadClass, half: number, extent: number): void {
  const r = ROAD_BUFFER[cls];
  if (r <= 0) return;
  const core = r * 0.55;
  for (let i = 0; i + 1 < pts.length; i++) {
    stampSegment(mask, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r, core, half, extent);
  }
}

// ---------------------------------------------------------------- main

const LC_TO_CLASS = (() => {
  const t = new Uint8Array(256);
  t[LC.Tree] = C_FOREST;
  t[LC.Shrub] = C_SHRUB;
  t[LC.Grass] = C_LONE;
  t[LC.Built] = C_BUILT;
  t[LC.Wetland] = C_WETLAND;
  t[LC.Mangrove] = C_MANGROVE;
  return t;
})();

const R2_A = 0.7548776662466927;
const R2_B = 0.5698402909980532;

// age index: 0 young, 1 teen, 2 adult, 3 elderly, 4 dead
const AGE_INTERIOR = [0.05, 0.18, 0.8, 0.97, 1];
const AGE_EDGE = [0.18, 0.48, 0.93, 0.99, 1];
const AGE_URBAN = [0.03, 0.11, 0.8, 0.99, 1];
const AGE_YOUNG = [0.3, 0.65, 0.95, 1, 1];

function pickAge(cum: number[], u: number): number {
  for (let i = 0; i < 5; i++) if (u < cum[i]) return i;
  return 2;
}

function emptyTreeSet(): TreeSet {
  return { count: 0, xz: new Float32Array(0), species: new Uint8Array(0), age: new Uint8Array(0), speciesTable: [] };
}

export function buildTrees(input: TreeInput): TreeSet {
  const { terrain, settings, landcover, vectors, climate, roads, centerLat } = input;
  if (!settings.enabled || settings.budget <= 0) return emptyTreeSet();

  const grid = terrain.playable;
  const N = grid.size;
  const H = grid.data;
  const extent = grid.extentM;
  const half = extent / 2;
  const cellG = extent / N;
  const wm = terrain.waterMask;
  const sea = terrain.seaLevel;
  const vertical = terrain.scale.vertical > 0 ? terrain.scale.vertical : 1;
  const density = Math.max(0, Math.min(1, settings.density));

  // ---- seed from the inputs
  let seed = hash3(settings.budget, Math.round(density * 1e4), Math.round(centerLat * 1e4));
  seed = hash3(seed, N, (vectors?.areas.length ?? 0) * 31 + (vectors?.treePoints.length ?? 0));
  const stride = Math.max(1, Math.floor((N * N) / 97));
  for (let k = 0; k < N * N; k += stride) seed = hash3(seed, Math.round(H[k] * 8), k & 0xffff);
  const seedA = seed;
  const seedB = hash3(seed, 1, 2);

  // ---- ground class mask
  const mask = new Uint8Array(MS * MS);
  if (landcover) {
    const lsz = landcover.size;
    const lext = landcover.extentM;
    const ld = landcover.data;
    const toCell = lsz / lext;
    for (let r = 0; r < MS; r++) {
      const z = half - ((r + 0.5) * extent) / MS;
      const lr = Math.min(lsz - 1, Math.max(0, Math.floor((lext / 2 - z) * toCell)));
      const base = r * MS;
      const lbase = lr * lsz;
      for (let c = 0; c < MS; c++) {
        const x = -half + ((c + 0.5) * extent) / MS;
        const lc = Math.min(lsz - 1, Math.max(0, Math.floor((x + lext / 2) * toCell)));
        mask[base + c] = LC_TO_CLASS[ld[lbase + lc]];
      }
    }
  }
  if (vectors) {
    const areas = vectors.areas;
    const pass = (kinds: AreaPolygon['kind'][], mode: number) => {
      for (const a of areas) if (kinds.includes(a.kind)) fillPolygon(mask, a.rings, half, extent, mode, 0);
    };
    pass(['beach', 'rock', 'quarry', 'airport', 'harbour'], MODE_CLEAR);
    pass(['residential', 'commercial', 'industrial'], MODE_BUILT);
    pass(['wetland'], MODE_WETLAND);
    pass(['park'], MODE_PARK);
    for (const a of areas) {
      if (a.kind !== 'forest') continue;
      const leaf = a.leafType === 'broadleaved' ? 1 : a.leafType === 'needleleaved' ? 2 : a.leafType === 'mixed' ? 3 : 0;
      fillPolygon(mask, a.rings, half, extent, MODE_FOREST, leaf);
    }
  }
  // roads and rails
  if (roads && roads.edges.length) {
    for (const e of roads.edges) {
      if (e.tunnel) continue;
      stampPolyline(mask, e.pts, e.cls, half, extent);
    }
  } else if (vectors) {
    for (const w of vectors.ways) {
      if (w.tunnel) continue;
      stampPolyline(mask, w.pts, w.cls, half, extent);
    }
  }

  // ---- water proximity (coarse), for species choice
  const CW = 256;
  const near = new Uint8Array(CW * CW); // bit 1 fresh water, bit 2 sea
  {
    const kk = CW / N;
    for (let r = 0; r < N; r++) {
      const cr = Math.min(CW - 1, Math.floor(r * kk)) * CW;
      for (let c = 0; c < N; c++) {
        const v = wm[r * N + c];
        if (v === 0) continue;
        near[cr + Math.min(CW - 1, Math.floor(c * kk))] |= v === 1 ? 2 : 1;
      }
    }
    const tmp = new Uint8Array(CW * CW);
    const R = 2;
    for (let r = 0; r < CW; r++) {
      for (let c = 0; c < CW; c++) {
        let f = 0;
        for (let dr = -R; dr <= R; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= CW) continue;
          for (let dc = -R; dc <= R; dc++) {
            const cc = c + dc;
            if (cc >= 0 && cc < CW) f |= near[rr * CW + cc];
          }
        }
        tmp[r * CW + c] = f;
      }
    }
    near.set(tmp);
  }
  const nearAt = (x: number, z: number) => {
    const c = Math.min(CW - 1, Math.max(0, Math.floor(((x + half) / extent) * CW)));
    const r = Math.min(CW - 1, Math.max(0, Math.floor(((half - z) / extent) * CW)));
    return near[r * CW + c];
  };

  // ---- terrain helpers
  const hIndex = (x: number, z: number) => {
    const c = Math.min(N - 1, Math.max(0, Math.floor((x + half) / cellG)));
    const r = Math.min(N - 1, Math.max(0, Math.floor((half - z) / cellG)));
    return r * N + c;
  };
  const slopeAt = (x: number, z: number) => {
    const c = Math.min(N - 1, Math.max(0, Math.floor((x + half) / cellG)));
    const r = Math.min(N - 1, Math.max(0, Math.floor((half - z) / cellG)));
    const c0 = c > 0 ? c - 1 : c;
    const c1 = c < N - 1 ? c + 1 : c;
    const r0 = r > 0 ? r - 1 : r;
    const r1 = r < N - 1 ? r + 1 : r;
    const gx = (H[r * N + c1] - H[r * N + c0]) / ((c1 - c0 || 1) * cellG);
    const gz = (H[r0 * N + c] - H[r1 * N + c]) / ((r1 - r0 || 1) * cellG);
    return Math.sqrt(gx * gx + gz * gz);
  };
  const realElev = (h: number) => terrain.baseElevation + (h - sea) / vertical;
  const warmest = warmestMonthC(climate, centerLat);
  const refElev = realElev(H[hIndex(0, 0)]);
  /** Warmest-month mean temperature at a game height (6.5 C per km lapse rate). */
  const tempAt = (h: number) => warmest - 0.0065 * (realElev(h) - refElev);

  const biome = biomeFromClimate(climate, centerLat);
  const groupWeights: Float32Array[] = [];
  for (let g = 0; g < NGROUPS; g++) groupWeights.push(weightsFor(biome, g as Group));

  const maskIndex = (x: number, z: number) => {
    const c = Math.min(MS - 1, Math.max(0, Math.floor(((x + half) / extent) * MS)));
    const r = Math.min(MS - 1, Math.max(0, Math.floor(((half - z) / extent) * MS)));
    return r * MS + c;
  };

  // ---- species and age
  const w = new Float32Array(NS);
  function pickSpecies(x: number, z: number, cls: number, h: number, slope: number, tree: number): number {
    const group = CLS_GROUP[cls];
    const T = tempAt(h);
    if (T < 12 && group !== Group.Wetland) {
      // stunted band: birch and bush only
      return h01(tree, 7, seedA) < STUNTED[SP.birch] ? SP.birch : SP.bush;
    }
    const base = groupWeights[group];
    const m = mask[maskIndex(x, z)];
    const leafF = LEAF_FACTOR[(m >> LEAF_SHIFT) & 3];
    const useLeaf = group === Group.Tree || group === Group.Lone;
    const nr = nearAt(x, z);
    const dry = slope > TAN14;
    const k = T < 14 ? Math.min(1, (14 - T) / 4) : 0;
    let total = 0;
    for (let i = 0; i < NS; i++) {
      let v = base[i];
      if (v === 0) { w[i] = 0; continue; }
      if (useLeaf) v *= leafF[i];
      if (nr & 1) v *= NEAR_WATER_FACTOR[i];
      if (nr & 2) v *= COAST_FACTOR[i];
      if (dry) v *= DRY_FACTOR[i];
      if (k > 0) v *= 1 + k * (COLD_FACTOR[i] - 1);
      w[i] = v;
      total += v;
    }
    if (total <= 0) return SP.bush;
    // patches: warped coarse cells share one random draw, a few trees deviate
    const patch = group === Group.Built || group === Group.Park ? 60 : 150;
    const wx = x + (vn(x / 130, z / 130, seedB) - 0.5) * 120;
    const wz = z + (vn(x / 130 + 31.7, z / 130 + 17.3, seedB) - 0.5) * 120;
    let u = h01(Math.floor(wx / patch), Math.floor(wz / patch), seedA ^ 0x9e3779b9);
    if (h01(tree, 3, seedA) < 0.1) u = h01(tree, 5, seedA);
    let target = u * total;
    for (let i = 0; i < NS; i++) {
      target -= w[i];
      if (target < 0 && w[i] > 0) return i;
    }
    return SP.bush;
  }

  function ageFor(x: number, z: number, cls: number, tree: number, stuntedOrCold: boolean): number {
    const u = h01(tree, 11, seedA);
    if (stuntedOrCold) return pickAge(AGE_YOUNG, u);
    const group = CLS_GROUP[cls];
    if (group === Group.Park || group === Group.Built || group === Group.Lone) return pickAge(AGE_URBAN, u);
    if (cls === C_FOREST) {
      const e = 10;
      const ok = (px: number, pz: number) => {
        const cl = mask[maskIndex(px, pz)] & CLS_MASK;
        return cl === C_FOREST || cl === C_MANGROVE;
      };
      if (!ok(x + e, z) || !ok(x - e, z) || !ok(x, z + e) || !ok(x, z - e)) return pickAge(AGE_EDGE, u);
    }
    return pickAge(AGE_INTERIOR, u);
  }

  // ---- output buffers
  let cap = 4096;
  let xz = new Float32Array(cap * 2);
  let spIdx = new Uint8Array(cap);
  let ages = new Uint8Array(cap);
  let count = 0;
  const push = (x: number, z: number, s: number, a: number) => {
    if (count === cap) {
      cap *= 2;
      const nx = new Float32Array(cap * 2);
      nx.set(xz);
      xz = nx;
      const ns = new Uint8Array(cap);
      ns.set(spIdx);
      spIdx = ns;
      const na = new Uint8Array(cap);
      na.set(ages);
      ages = na;
    }
    xz[count * 2] = x;
    xz[count * 2 + 1] = z;
    spIdx[count] = s;
    ages[count] = a;
    count++;
  };

  const occ = new Uint8Array(MS * MS);
  const margin = 1.5;
  const lim = half - margin;

  // ---- 1. exact OSM tree points (never thinned by density, but never in water or on the road)
  const budget = Math.floor(settings.budget);
  if (vectors) {
    const pts = vectors.treePoints;
    for (let t = 0; t < pts.length && count < budget; t++) {
      const x = pts[t][0];
      const z = pts[t][1];
      if (!(Math.abs(x) <= lim && Math.abs(z) <= lim)) continue;
      const mi = maskIndex(x, z);
      const m = mask[mi];
      if (m & ROAD_CORE) continue;
      const hi = hIndex(x, z);
      if (wm[hi] !== 0 || H[hi] < sea + 0.2) continue;
      const sl = slopeAt(x, z);
      if (sl >= TAN40) continue;
      let cls = m & CLS_MASK;
      if (cls === 0 || cls === C_FOREST || cls === C_LONE || cls === C_SHRUB) cls = C_BUILT;
      const s = pickSpecies(x, z, cls, H[hi], sl, t + 1_000_003);
      push(x, z, s, ageFor(x, z, cls, t + 1_000_003, false));
      occ[mi] = 1;
    }
  }
  const pointCount = count;

  // ---- 2. generated trees: pass 1 computes acceptance probabilities
  const n = Math.ceil(extent / CAND);
  const prob = new Float32Array(n * n);
  const candArea = CAND * CAND;
  let expected = 0;
  if (density > 0) {
    for (let j = 0; j < n; j++) {
      const z = half - (j + 0.5) * CAND;
      if (Math.abs(z) > lim) continue;
      for (let i = 0; i < n; i++) {
        const x = -half + (i + 0.5) * CAND;
        if (Math.abs(x) > lim) continue;
        const m = mask[maskIndex(x, z)];
        const cls = m & CLS_MASK;
        if (cls === 0 || (m & ROAD_FULL)) continue;
        const hi = hIndex(x, z);
        if (wm[hi] !== 0) continue;
        const h = H[hi];
        if (h < sea + 0.2) continue;
        const sl = slopeAt(x, z);
        if (sl >= TAN40) continue;
        let f = sl <= TAN30 ? 1 : (TAN40 - sl) / (TAN40 - TAN30);
        const T = tempAt(h);
        if (T < 10) continue;
        if (T < 12) f *= 0.15 + (0.35 * (T - 10)) / 2;
        else if (T < 14) f *= 0.7 + (0.3 * (T - 12)) / 2;
        let dm = 0.8 + 0.4 * vn(x / 70, z / 70, seedB ^ 3);
        if (cls === C_FOREST || cls === C_MANGROVE) {
          const g = vn(x * 0.011, z * 0.011, seedB ^ 5);
          if (g < 0.25) {
            const s = g / 0.25;
            dm *= 0.2 + 0.8 * s * s * (3 - 2 * s);
          }
        }
        let p = (candArea / CLS_AREA[cls]) * density * f * dm;
        if (p > 1) p = 1;
        prob[j * n + i] = p;
        expected += p;
      }
    }
  }

  // ---- 3. uniform budget scaling keeps every forest footprint
  const room = Math.max(0, budget - pointCount);
  const scale = expected > 0 ? Math.min(1, room / expected) : 0;

  // ---- 4. pass 2: place
  if (scale > 0) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const p = prob[j * n + i];
        if (p <= 0) continue;
        const hh = hash3(i, j, seedA);
        let thr = i * R2_A + j * R2_B + 0.2 * (hh / 4294967296);
        thr -= Math.floor(thr);
        if (thr >= p * scale) continue;
        const x = -half + (i + h01(i, j, seedA ^ 0x1234567)) * CAND;
        const z = half - (j + h01(i, j, seedA ^ 0x7654321)) * CAND;
        if (!(Math.abs(x) <= lim && Math.abs(z) <= lim)) continue;
        const mi = maskIndex(x, z);
        const m = mask[mi];
        const cls = m & CLS_MASK;
        if (cls === 0 || (m & ROAD_FULL) || occ[mi]) continue;
        const hi = hIndex(x, z);
        if (wm[hi] !== 0) continue;
        const h = H[hi];
        if (h < sea + 0.2) continue;
        const sl = slopeAt(x, z);
        if (sl >= TAN40) continue;
        const tree = j * n + i;
        const s = pickSpecies(x, z, cls, h, sl, tree);
        const cold = tempAt(h) < 12.5;
        push(x, z, s, ageFor(x, z, cls, tree, cold));
        occ[mi] = 1;
      }
    }
    // rare overshoot from the dither: thin uniformly
    if (count > budget) {
      const keep = (budget - pointCount) / (count - pointCount);
      let w2 = pointCount;
      for (let r = pointCount; r < count; r++) {
        if (h01(r, 99, seedA) < keep && w2 < budget) {
          xz[w2 * 2] = xz[r * 2];
          xz[w2 * 2 + 1] = xz[r * 2 + 1];
          spIdx[w2] = spIdx[r];
          ages[w2] = ages[r];
          w2++;
        }
      }
      count = w2;
    }
  }

  // ---- 5. species table with only the used species
  const used = new Int16Array(NS).fill(-1);
  const table: TreeSpecies[] = [];
  for (let i = 0; i < count; i++) {
    const s = spIdx[i];
    if (used[s] < 0) {
      used[s] = table.length;
      table.push(SPECIES[s]);
    }
  }
  const species = new Uint8Array(count);
  for (let i = 0; i < count; i++) species[i] = used[spIdx[i]];
  return {
    count,
    xz: xz.slice(0, count * 2),
    species,
    age: ages.slice(0, count),
    speciesTable: table,
  };
}
