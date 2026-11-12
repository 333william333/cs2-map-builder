import type { TerrainResult } from '../types';
import { downsampleArea } from './filters';
import { centreRegion } from './world';

export interface SeamStat {
  /** border positions counted */
  n: number;
  /** jump at the border line: world centre cells and world cells outside, each extrapolated linearly to it (m) */
  maxJump: number;
  meanJump: number;
  /** plain difference between the playable edge (block mean) and the world cell just outside (m) */
  maxDiff: number;
  meanDiff: number;
  /** the jump measure on a parallel line 8 world cells further out (natural terrain variation) */
  maxBase: number;
  meanBase: number;
}

export interface SeamReport {
  land: SeamStat;
  water: SeamStat;
  /** border positions with water on one side and land on the other */
  mixed: number;
  /** the same count between two world cells on a parallel line further out (natural shorelines) */
  mixedBaseline: number;
  /** positions along the border (4 sides) */
  positions: number;
  /** max |world centre - area-averaged playable| (m) */
  centreError: number;
  /** with `detail`: one line per mixed or large-jump position */
  notes?: string[];
}

const BASE_OFFSET = 8;

function stat(): SeamStat {
  return { n: 0, maxJump: 0, meanJump: 0, maxDiff: 0, meanDiff: 0, maxBase: 0, meanBase: 0 };
}

/**
 * Seam metrics along the playable border, measured on the final grids: for every world cell just
 * outside the centre quarter, the matching strip of playable edge cells inside.
 */
export function seamMetrics(t: TerrainResult, detail = false): SeamReport {
  const notes: string[] = [];
  const Np = t.playable.size, Nw = t.world.size;
  const P = t.playable.data, W = t.world.data;
  const { lo, hi } = centreRegion(Nw);
  const S = hi - lo;
  const f = Np / S;
  const land = stat(), water = stat();
  let mixed = 0;
  let mixedBaseline = 0;
  const wMask = t.worldWaterMask;
  const isWaterW = (i: number) => (wMask ? wMask[i] !== 0 : W[i] < t.seaLevel - 0.25);
  // side: 0 top, 1 bottom, 2 left, 3 right. (along k, depth d >= 0 inward / outward)
  const wIdx = (side: number, k: number, out: number) => {
    const a = lo + k;
    if (side === 0) return (lo - 1 - out) * Nw + a;
    if (side === 1) return (hi + out) * Nw + a;
    if (side === 2) return a * Nw + lo - 1 - out;
    return a * Nw + hi + out;
  };
  const pIdx = (side: number, j: number, inn: number) => {
    if (side === 0) return inn * Np + j;
    if (side === 1) return (Np - 1 - inn) * Np + j;
    if (side === 2) return j * Np + inn;
    return j * Np + Np - 1 - inn;
  };
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < S; k++) {
      const j0 = Math.floor(k * f), j1 = Math.max(j0 + 1, Math.floor((k + 1) * f));
      let p0 = 0, p1 = 0, wet = 0;
      const kinds = [0, 0, 0, 0];
      for (let j = j0; j < j1; j++) {
        p0 += P[pIdx(side, j, 0)];
        p1 += P[pIdx(side, j, 1)];
        kinds[t.waterMask[pIdx(side, j, 0)]]++;
        if (t.waterMask[pIdx(side, j, 0)] !== 0) wet++;
      }
      const m = j1 - j0;
      p0 /= m;
      p1 /= m;
      const b1i = wIdx(side, k, 0);
      const b1 = W[b1i], b2 = W[wIdx(side, k, 1)];
      // jump at world resolution: centre cells (= area-averaged playable) vs the world just outside
      const a1 = W[wIdx(side, k, -1)], a2 = W[wIdx(side, k, -2)];
      const jump = Math.abs(a1 + 0.5 * (a1 - a2) - (b1 + 0.5 * (b1 - b2)));
      // same measure on a parallel line well outside the blend band: what the terrain itself gives
      const o = BASE_OFFSET;
      const u1 = W[wIdx(side, k, o)], u2 = W[wIdx(side, k, o - 1)], v1 = W[wIdx(side, k, o + 1)], v2 = W[wIdx(side, k, o + 2)];
      const baseJump = Math.abs(u1 + 0.5 * (u1 - u2) - (v1 + 0.5 * (v1 - v2)));
      const diff = Math.abs(p0 - b1);
      const inWet = wet * 2 > m;
      const outWet = isWaterW(b1i);
      if (detail && (inWet !== outWet || jump > 5)) {
        notes.push(`side ${side} k ${k}: in kinds ${kinds.join('/')} out ${wMask ? wMask[b1i] : '?'} p0 ${p0.toFixed(1)} p1 ${p1.toFixed(1)} b1 ${b1.toFixed(1)} b2 ${b2.toFixed(1)} jump ${jump.toFixed(1)}`);
      }
      if (isWaterW(wIdx(side, k, o)) !== isWaterW(wIdx(side, k, o + 1))) mixedBaseline++;
      if (inWet !== outWet) { mixed++; continue; }
      const s = inWet ? water : land;
      s.n++;
      s.meanBase += baseJump;
      if (baseJump > s.maxBase) s.maxBase = baseJump;
      s.meanJump += jump;
      s.meanDiff += diff;
      if (jump > s.maxJump) s.maxJump = jump;
      if (diff > s.maxDiff) s.maxDiff = diff;
    }
  }
  for (const s of [land, water]) {
    if (s.n) { s.meanJump /= s.n; s.meanDiff /= s.n; s.meanBase /= s.n; }
  }
  const down = downsampleArea(P, Np, S);
  let centreError = 0;
  for (let r = 0; r < S; r++) {
    for (let c = 0; c < S; c++) {
      const e = Math.abs(W[(lo + r) * Nw + lo + c] - down[r * S + c]);
      if (e > centreError) centreError = e;
    }
  }
  return { land, water, mixed, mixedBaseline, positions: 4 * S, centreError, notes: detail ? notes : undefined };
}
