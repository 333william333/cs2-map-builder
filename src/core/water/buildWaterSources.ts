import type { Pt, TerrainResult, VectorData, WaterSource } from '../types';

/** Tunable numbers for water source placement. */
export const WATER_SRC = {
  /** lakes smaller than this (game m2) get no source */
  minLakeAreaM2: 1500,
  /** rivers shorter than this (game m, cell count x cell size) get no source */
  minRiverLengthM: 150,
  /** metres below the lowest shore height */
  lakeMargin: 0.15,
  /** one lake source per roughly this much extent */
  lakeSourceSpacingM: 1500,
  maxSourcesPerLake: 12,
  /** sources closer than this are merged */
  mergeDistM: 100,
  /** working grid is coarsened to at most this size */
  maxWorkSize: 1024,
  /** river sources sit at least this far (game m) inside the playable border */
  borderInsetM: 150,
};

interface Coarse {
  m: number;
  /** stride in source cells */
  s: number;
  n: number;
  ext: number;
  /** game metres per work cell */
  cell: number;
  /** 0 land, 1 sea, 2 lake, 3 river */
  kind: Uint8Array;
  h: Float32Array;
  /** water surface from the terrain's common water model (NaN when unknown) */
  lvl: Float32Array;
}

function coarsen(t: TerrainResult): Coarse {
  const g = t.playable;
  const n = g.size;
  const s = Math.max(1, Math.ceil(n / WATER_SRC.maxWorkSize));
  const m = Math.ceil(n / s);
  const kind = new Uint8Array(m * m);
  const h = new Float32Array(m * m);
  const lvl = new Float32Array(m * m).fill(NaN);
  const mask = t.waterMask;
  const wl = t.waterLevel && t.waterLevel.length === n * n ? t.waterLevel : null;
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < m; c++) {
      const r0 = r * s, c0 = c * s;
      const r1 = Math.min(n, r0 + s), c1 = Math.min(n, c0 + s);
      let nLand = 0, nSea = 0, nLake = 0, nRiver = 0;
      let minLand = Infinity, minLake = Infinity, minRiver = Infinity, minAll = Infinity;
      let sLake = 0, nlLake = 0, sRiver = 0, nlRiver = 0;
      for (let rr = r0; rr < r1; rr++) {
        for (let cc = c0; cc < c1; cc++) {
          const i = rr * n + cc;
          const v = g.data[i];
          if (v < minAll) minAll = v;
          switch (mask[i]) {
            case 1: nSea++; break;
            case 2: nLake++; if (v < minLake) minLake = v; if (wl && wl[i] === wl[i]) { sLake += wl[i]; nlLake++; } break;
            case 3: nRiver++; if (v < minRiver) minRiver = v; if (wl && wl[i] === wl[i]) { sRiver += wl[i]; nlRiver++; } break;
            default: nLand++; if (v < minLand) minLand = v;
          }
        }
      }
      const o = r * m + c;
      if (nLake + nRiver > 0) {
        if (nLake >= nRiver) {
          kind[o] = 2; h[o] = minLake;
          if (nlLake) lvl[o] = sLake / nlLake;
        } else {
          kind[o] = 3; h[o] = minRiver;
          if (nlRiver) lvl[o] = sRiver / nlRiver;
        }
      } else if (nSea > 0 && nSea >= nLand) { kind[o] = 1; h[o] = minAll; }
      else if (nLand > 0) { kind[o] = 0; h[o] = minLand; }
      else { kind[o] = 1; h[o] = minAll; }
    }
  }
  return { m, s, n, ext: g.extentM, cell: (g.extentM / n) * s, kind, h, lvl };
}

function gxOf(C: Coarse, c: number): number {
  const bs = Math.min(C.s, C.n - c * C.s);
  return -C.ext / 2 + (c * C.s + bs / 2) * (C.ext / C.n);
}
function gzOf(C: Coarse, r: number): number {
  const bs = Math.min(C.s, C.n - r * C.s);
  return C.ext / 2 - (r * C.s + bs / 2) * (C.ext / C.n);
}

interface Component { start: number; end: number; kind: number }

/** 8-connected components of cells with kind 2 and 3. Cells are stored contiguously in `order`. */
function labelComponents(C: Coarse): { order: Int32Array; comps: Component[] } {
  const { m, kind } = C;
  const seen = new Uint8Array(m * m);
  const order = new Int32Array(m * m);
  const comps: Component[] = [];
  let tail = 0;
  for (let i0 = 0; i0 < m * m; i0++) {
    const k = kind[i0];
    if ((k !== 2 && k !== 3) || seen[i0]) continue;
    const start = tail;
    seen[i0] = 1;
    order[tail++] = i0;
    for (let head = start; head < tail; head++) {
      const i = order[head];
      const r = (i / m) | 0, c = i - r * m;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= m) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= m) continue;
          const j = rr * m + cc;
          if (kind[j] === k && !seen[j]) { seen[j] = 1; order[tail++] = j; }
        }
      }
    }
    comps.push({ start, end: tail, kind: k });
  }
  return { order, comps };
}

interface Dist { r0: number; c0: number; w: number; hgt: number; d: Float32Array }

/** Chamfer distance (in cells) from each component cell to the nearest non-component cell. */
function componentDistance(C: Coarse, order: Int32Array, comp: Component): Dist {
  const { m } = C;
  let rMin = m, rMax = -1, cMin = m, cMax = -1;
  for (let k = comp.start; k < comp.end; k++) {
    const i = order[k];
    const r = (i / m) | 0, c = i - r * m;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (c < cMin) cMin = c;
    if (c > cMax) cMax = c;
  }
  const r0 = rMin - 1, c0 = cMin - 1;
  const hgt = rMax - rMin + 3, w = cMax - cMin + 3;
  const d = new Float32Array(w * hgt); // 0 = outside
  const BIG = 1e9;
  for (let k = comp.start; k < comp.end; k++) {
    const i = order[k];
    const r = (i / m) | 0, c = i - r * m;
    d[(r - r0) * w + (c - c0)] = BIG;
  }
  const S2 = Math.SQRT2;
  for (let r = 1; r < hgt - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], d[i - 1] + 1, d[i - w] + 1, d[i - w - 1] + S2, d[i - w + 1] + S2);
    }
  }
  for (let r = hgt - 2; r >= 1; r--) {
    for (let c = w - 2; c >= 1; c--) {
      const i = r * w + c;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], d[i + 1] + 1, d[i + w] + 1, d[i + w + 1] + S2, d[i + w - 1] + S2);
    }
  }
  return { r0, c0, w, hgt, d };
}

interface Cand { kind: WaterSource['kind']; p: Pt; radius: number; level: number; rate?: number; weight: number }

function minLandAround(C: Coarse, r: number, c: number, rad: number): number {
  let best = Infinity;
  for (let rr = Math.max(0, r - rad); rr <= Math.min(C.m - 1, r + rad); rr++) {
    for (let cc = Math.max(0, c - rad); cc <= Math.min(C.m - 1, c + rad); cc++) {
      const j = rr * C.m + cc;
      if (C.kind[j] === 0 && C.h[j] < best) best = C.h[j];
    }
  }
  return best;
}

function lakeCandidates(C: Coarse, order: Int32Array, comp: Component, out: Cand[]): void {
  const { m, cell } = C;
  const count = comp.end - comp.start;
  if (count * cell * cell < WATER_SRC.minLakeAreaM2) return;
  const dist = componentDistance(C, order, comp);
  const dAt = (i: number) => {
    const r = (i / m) | 0, c = i - r * m;
    return dist.d[(r - dist.r0) * dist.w + (c - dist.c0)];
  };

  // lake level: lowest land height touching the component, minus a margin
  let shore = Infinity, hMax = -Infinity;
  let rMin = m, rMax = -1, cMin = m, cMax = -1;
  for (let k = comp.start; k < comp.end; k++) {
    const i = order[k];
    const r = (i / m) | 0, c = i - r * m;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (c < cMin) cMin = c;
    if (c > cMax) cMax = c;
    if (C.h[i] > hMax) hMax = C.h[i];
    for (let dr = -1; dr <= 1; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= m) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc;
        if (cc < 0 || cc >= m) continue;
        const j = rr * m + cc;
        if (C.kind[j] === 0 && C.h[j] < shore) shore = C.h[j];
      }
    }
  }
  const level = Number.isFinite(shore) ? shore - WATER_SRC.lakeMargin : hMax + 0.5;

  let bestK = comp.start, bestD = -1;
  for (let k = comp.start; k < comp.end; k++) {
    const dv = dAt(order[k]);
    if (dv > bestD) { bestD = dv; bestK = k; }
  }
  const area = count * cell * cell;
  const radiusOf = (dv: number) => Math.min(2500, Math.max(cell * 0.5, (dv - 0.5) * cell * 0.9));
  const place = (k: number, dv: number, weight: number) => {
    const i = order[k];
    const r = (i / m) | 0, c = i - r * m;
    // the terrain's common surface level for this body when known (same on both grids)
    const lv = Number.isFinite(C.lvl[i]) ? C.lvl[i] : level;
    out.push({ kind: 'lake', p: [gxOf(C, c), gzOf(C, r)], radius: radiusOf(dv), level: lv, weight });
  };
  place(bestK, bestD, area);

  const extentM = Math.max(cMax - cMin + 1, rMax - rMin + 1) * cell;
  const want = Math.min(WATER_SRC.maxSourcesPerLake, Math.ceil(extentM / WATER_SRC.lakeSourceSpacingM));
  if (want <= 1) return;

  // farthest-point sampling among interior cells
  const thr = Math.max(1, bestD * 0.35);
  const cand: number[] = [];
  const stride = Math.max(1, Math.floor(count / 20000));
  for (let k = comp.start; k < comp.end; k += stride) if (dAt(order[k]) >= thr) cand.push(k);
  const minD2 = new Float64Array(cand.length).fill(Infinity);
  const upd = (px: number, pz: number) => {
    for (let a = 0; a < cand.length; a++) {
      const i = order[cand[a]];
      const r = (i / m) | 0, c = i - r * m;
      const dx = gxOf(C, c) - px, dz = gzOf(C, r) - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD2[a]) minD2[a] = d2;
    }
  };
  upd(out[out.length - 1].p[0], out[out.length - 1].p[1]);
  for (let j = 1; j < want; j++) {
    let ba = -1, bv = -1;
    for (let a = 0; a < cand.length; a++) if (minD2[a] > bv) { bv = minD2[a]; ba = a; }
    if (ba < 0 || Math.sqrt(bv) < WATER_SRC.lakeSourceSpacingM * 0.4) break;
    const i = order[cand[ba]];
    const r = (i / m) | 0, c = i - r * m;
    place(cand[ba], dAt(i), area * Math.pow(0.999, j));
    upd(gxOf(C, c), gzOf(C, r));
  }
}

function riverCandidate(C: Coarse, order: Int32Array, comp: Component, out: Cand[]): void {
  const { m, cell } = C;
  const count = comp.end - comp.start;
  if (count * cell < WATER_SRC.minRiverLengthM) return;
  const dist = componentDistance(C, order, comp);
  const distAt = (r: number, c: number) => {
    const rr = r - dist.r0, cc = c - dist.c0;
    if (rr < 0 || cc < 0 || rr >= dist.hgt || cc >= dist.w) return 0;
    return dist.d[rr * dist.w + cc];
  };

  let borderK = -1, borderH = -Infinity, topK = comp.start, topH = -Infinity;
  for (let k = comp.start; k < comp.end; k++) {
    const i = order[k];
    const r = (i / m) | 0, c = i - r * m;
    const hv = C.h[i];
    if (hv > topH) { topH = hv; topK = k; }
    if ((r === 0 || c === 0 || r === m - 1 || c === m - 1) && hv > borderH) { borderH = hv; borderK = k; }
  }
  const onBorder = borderK >= 0;
  let i = order[onBorder ? borderK : topK];
  if (onBorder) {
    // keep the source inside the playable area, a little away from the open border
    const i0 = i;
    const r0 = (i0 / m) | 0, c0 = i0 - r0 * m;
    const inset = Math.max(1, Math.ceil(WATER_SRC.borderInsetM / cell - 0.5));
    let best = -1, bestD = Infinity;
    for (let k = comp.start; k < comp.end; k++) {
      const j = order[k];
      const rr = (j / m) | 0, cc = j - rr * m;
      if (Math.min(rr, cc, m - 1 - rr, m - 1 - cc) < inset) continue;
      const d2 = (rr - r0) ** 2 + (cc - c0) ** 2;
      if (d2 < bestD) { bestD = d2; best = j; }
    }
    if (best >= 0) i = best;
  }
  const r = (i / m) | 0, c = i - r * m;

  // local channel width from the distance field around the source
  let dMax = 0;
  for (let rr = r - 3; rr <= r + 3; rr++) for (let cc = c - 3; cc <= c + 3; cc++) dMax = Math.max(dMax, distAt(rr, cc));
  const width = Math.max(cell, 2 * Math.max(dMax - 0.5, 0.5) * cell);
  const bed = C.h[i];
  const bank = minLandAround(C, r, c, 4);
  let level: number;
  if (Number.isFinite(C.lvl[i]) && C.lvl[i] > bed) {
    level = C.lvl[i]; // the terrain's common water surface
  } else if (Number.isFinite(bank) && bank > bed) {
    level = bed + Math.min(2, Math.max(0.2, (bank - bed) * 0.5));
    level = Math.max(bed + 0.05, Math.min(level, bank - 0.05));
  } else level = bed + 0.5;

  out.push({
    kind: onBorder ? 'borderRiver' : 'river',
    p: [gxOf(C, c), gzOf(C, r)],
    radius: Math.max(cell * 0.5, Math.min(width * 0.5, 60)),
    level,
    rate: Math.min(1, Math.max(0.1, width / 60)),
    weight: count * cell * cell,
  });
}

/**
 * Water sources for the game: a constant-level source per lake and a source where each river enters
 * or starts. The sea is a global level and needs none. Largest first, deterministic.
 */
export function buildWaterSources(terrain: TerrainResult, vectors?: VectorData): WaterSource[] {
  void vectors; // reserved: waterway widths could refine river rates
  const C = coarsen(terrain);
  const { order, comps } = labelComponents(C);
  const cands: Cand[] = [];
  for (const comp of comps) {
    if (comp.kind === 2) lakeCandidates(C, order, comp, cands);
    else riverCandidate(C, order, comp, cands);
  }
  // stable sort: largest first, ties keep discovery (scan) order
  const idx = cands.map((_, i) => i).sort((a, b) => cands[b].weight - cands[a].weight || a - b);
  const kept: Cand[] = [];
  const md2 = WATER_SRC.mergeDistM * WATER_SRC.mergeDistM;
  for (const ci of idx) {
    const cd = cands[ci];
    if (!Number.isFinite(cd.p[0]) || !Number.isFinite(cd.p[1]) || !Number.isFinite(cd.level)) continue;
    let clash = false;
    for (const k of kept) {
      const dx = k.p[0] - cd.p[0], dz = k.p[1] - cd.p[1];
      if (dx * dx + dz * dz < md2) { clash = true; break; }
    }
    if (!clash) kept.push(cd);
  }
  return kept.map((k) => {
    const s: WaterSource = { kind: k.kind, p: k.p, radius: k.radius, level: k.level };
    if (k.rate !== undefined) s.rate = k.rate;
    return s;
  });
}
