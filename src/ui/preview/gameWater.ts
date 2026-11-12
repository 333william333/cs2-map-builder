/**
 * Inland water for the game view, exactly as the export specifies it: lakes and rivers are the
 * `terrain.waterMask` areas (2 = lake, 3 = river) that hold a `WaterSource`, filled to that
 * source's level. Masked areas without a source stay dry, like they would in the game.
 * Pure, typed arrays only.
 */
import type { TerrainResult, WaterSource } from '../../core/types';

export interface InlandWater {
  /** cells per side of the level grid (cell-centred, row 0 = north = smallest scene z) */
  n: number;
  extentM: number;
  /** water surface per cell, NaN = dry */
  level: Float32Array;
  /** components that received water / stayed dry for lack of a source */
  filled: number;
  dry: number;
}

const LAKE = 2;
const RIVER = 3;

/**
 * Downsamples the mask to `n` x `n` (a cell is lake/river if any source cell is), builds 4-connected
 * components per kind and fills each one from the sources that lie in it.
 *  - lake: flat at the highest lake source level in the component
 *  - river: follows the bed downstream with the source's water depth
 */
export function inlandWaterLevels(terrain: TerrainResult, sources: WaterSource[], n: number): InlandWater {
  const S = terrain.playable.size;
  const E = terrain.playable.extentM;
  const mask = terrain.waterMask;
  const H = terrain.playable.data;
  n = Math.max(2, Math.min(n, S));
  const kind = new Uint8Array(n * n);
  const bed = new Float32Array(n * n).fill(Infinity);
  const f = n / S;
  if (mask.length === S * S) {
    for (let r = 0; r < S; r++) {
      const rr = Math.min(n - 1, Math.floor(r * f));
      for (let c = 0; c < S; c++) {
        const k = mask[r * S + c];
        if (k !== LAKE && k !== RIVER) continue;
        const i = rr * n + Math.min(n - 1, Math.floor(c * f));
        if (kind[i] !== LAKE) kind[i] = k; // lake wins over river in a mixed cell
        const h = H[r * S + c];
        if (h < bed[i]) bed[i] = h;
      }
    }
  }

  // components
  const comp = new Int32Array(n * n).fill(-1);
  const queue = new Int32Array(n * n);
  const compKind: number[] = [];
  for (let i = 0; i < n * n; i++) {
    if (!kind[i] || comp[i] >= 0) continue;
    const id = compKind.length;
    compKind.push(kind[i]);
    let qh = 0;
    let qt = 0;
    queue[qt++] = i;
    comp[i] = id;
    while (qh < qt) {
      const j = queue[qh++];
      const r = (j / n) | 0;
      const c = j - r * n;
      if (c > 0 && kind[j - 1] === kind[i] && comp[j - 1] < 0) { comp[j - 1] = id; queue[qt++] = j - 1; }
      if (c < n - 1 && kind[j + 1] === kind[i] && comp[j + 1] < 0) { comp[j + 1] = id; queue[qt++] = j + 1; }
      if (r > 0 && kind[j - n] === kind[i] && comp[j - n] < 0) { comp[j - n] = id; queue[qt++] = j - n; }
      if (r < n - 1 && kind[j + n] === kind[i] && comp[j + n] < 0) { comp[j + n] = id; queue[qt++] = j + n; }
    }
  }

  // sources -> components (nearest cell of the matching kind within the source radius)
  const cell = E / n;
  const lakeLevel = new Float32Array(compKind.length).fill(NaN);
  const riverDepth = new Float32Array(compKind.length).fill(NaN);
  for (const s of sources) {
    const want = s.kind === 'lake' ? LAKE : RIVER;
    const c0 = Math.floor((s.p[0] / E + 0.5) * n);
    const r0 = Math.floor((0.5 - s.p[1] / E) * n);
    const rad = Math.max(2, Math.ceil(s.radius / cell) + 2);
    let best = -1;
    let bestD = Infinity;
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= n || c >= n) continue;
        const i = r * n + c;
        if (kind[i] !== want) continue;
        const d = dr * dr + dc * dc;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best < 0) continue;
    const id = comp[best];
    if (want === LAKE) {
      lakeLevel[id] = Number.isNaN(lakeLevel[id]) ? s.level : Math.max(lakeLevel[id], s.level);
    } else {
      const depth = Math.max(0.3, Math.min(8, s.level - bed[best]));
      riverDepth[id] = Number.isNaN(riverDepth[id]) ? depth : Math.max(riverDepth[id], depth);
    }
  }

  // river beds: local minimum across the channel so the surface is level from bank to bank
  const rad = 2;
  const bedMin = new Float32Array(n * n).fill(Infinity);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (kind[i] !== RIVER) continue;
      let m = bed[i];
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
          const j = rr * n + cc;
          if (comp[j] === comp[i] && bed[j] < m) m = bed[j];
        }
      }
      bedMin[i] = m;
    }
  }

  const level = new Float32Array(n * n).fill(NaN);
  const wetComp = new Uint8Array(compKind.length);
  for (let i = 0; i < n * n; i++) {
    const id = comp[i];
    if (id < 0) continue;
    if (compKind[id] === LAKE && !Number.isNaN(lakeLevel[id])) level[i] = lakeLevel[id];
    else if (compKind[id] === RIVER && !Number.isNaN(riverDepth[id])) level[i] = bedMin[i] + riverDepth[id];
    if (!Number.isNaN(level[i])) wetComp[id] = 1;
  }
  // one ring into the banks so the surface meets the terrain instead of ending in mid-air
  const grown = level.slice();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (!Number.isNaN(level[i])) continue;
      let best = NaN;
      for (let k = 0; k < 8; k++) {
        const dr = k < 3 ? -1 : k < 5 ? 0 : 1;
        const dc = k === 0 || k === 5 ? -1 : k === 1 || k === 6 ? 0 : k === 3 ? -1 : 1;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const v = level[rr * n + cc];
        if (!Number.isNaN(v) && !(v <= best)) best = v;
      }
      grown[i] = best;
    }
  }
  let filled = 0;
  for (let k = 0; k < wetComp.length; k++) filled += wetComp[k];
  return { n, extentM: E, level: grown, filled, dry: compKind.length - filled };
}

export interface LevelGrid {
  n: number;
  extentM: number;
  /** cell-centred, row 0 = north, NaN = no inland water */
  level: Float32Array;
}

export interface WaterGrids {
  play: LevelGrid;
  world: LevelGrid | null;
  /** true when the levels came from the build's own water fields */
  fromData: boolean;
  filled: number;
  dry: number;
}

/** Block maximum of the finite values of a cell grid (NaN where a block has none). */
export function downsampleLevels(src: Float32Array, size: number, n: number): Float32Array {
  n = Math.max(1, Math.min(n, size));
  const out = new Float32Array(n * n).fill(NaN);
  const f = n / size;
  for (let r = 0; r < size; r++) {
    const rr = Math.min(n - 1, Math.floor(r * f));
    for (let c = 0; c < size; c++) {
      const v = src[r * size + c];
      if (v !== v) continue;
      const i = rr * n + Math.min(n - 1, Math.floor(c * f));
      const o = out[i];
      if (o !== o || v > o) out[i] = v;
    }
  }
  return out;
}

/**
 * Grows wet cells by one ring (8-neighbourhood, highest neighbour) so surfaces reach the banks.
 * With `ground` (lowest terrain per cell) a cell is only grown into when its ground lies less than
 * 1.5 m below the water, so water never floods large areas of land that lie lower than the surface.
 */
export function growLevels(level: Float32Array, n: number, ground?: Float32Array): Float32Array {
  const out = level.slice();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (level[i] === level[i]) continue;
      let best = NaN;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if ((dr === 0 && dc === 0) || rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
          const v = level[rr * n + cc];
          if (v === v && !(v <= best)) best = v;
        }
      }
      out[i] = ground && best === best && ground[i] < best - 1.5 ? NaN : best;
    }
  }
  return out;
}

/** Block mean of a cell grid (returns the input when no reduction is needed). */
export function downsampleMean(data: Float32Array, size: number, n: number): Float32Array {
  if (n >= size) return data;
  const out = new Float32Array(n * n);
  const cnt = new Float32Array(n * n);
  const f = n / size;
  for (let r = 0; r < size; r++) {
    const rr = Math.min(n - 1, Math.floor(r * f));
    for (let c = 0; c < size; c++) {
      const i = rr * n + Math.min(n - 1, Math.floor(c * f));
      out[i] += data[r * size + c];
      cnt[i]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= Math.max(1, cnt[i]);
  return out;
}

/** Block minimum of a cell grid. */
export function downsampleMin(src: Float32Array, size: number, n: number): Float32Array {
  n = Math.max(1, Math.min(n, size));
  const out = new Float32Array(n * n).fill(Infinity);
  const f = n / size;
  for (let r = 0; r < size; r++) {
    const rr = Math.min(n - 1, Math.floor(r * f));
    for (let c = 0; c < size; c++) {
      const i = rr * n + Math.min(n - 1, Math.floor(c * f));
      const v = src[r * size + c];
      if (v < out[i]) out[i] = v;
    }
  }
  return out;
}

/**
 * Inland water level grids for the playable area and the world backdrop. Sea cells are left out
 * (the sea is one global plane at `terrain.seaLevel`). Uses the build's own per-cell levels when
 * present, otherwise derives lakes and rivers from the mask and the water sources.
 */
export function waterGrids(terrain: TerrainResult, sources: WaterSource[], playN: number, worldN: number): WaterGrids {
  const t = terrain;
  const sea = terrain.seaLevel;
  const dropSea = (lv: Float32Array): Float32Array => {
    if (!terrain.hasSea) return lv;
    for (let i = 0; i < lv.length; i++) if (lv[i] === lv[i] && lv[i] <= sea + 0.05) lv[i] = NaN;
    return lv;
  };
  const P = terrain.playable;
  const W = terrain.world;
  if (t.waterLevel && t.waterLevel.length === P.size * P.size) {
    const pn = Math.min(playN, P.size);
    const play = { n: pn, extentM: P.extentM, level: growLevels(dropSea(downsampleLevels(t.waterLevel, P.size, pn)), pn, downsampleMin(P.data, P.size, pn)) };
    let world: LevelGrid | null = null;
    if (t.worldWaterLevel && t.worldWaterLevel.length === W.size * W.size) {
      const wn = Math.min(worldN, W.size);
      world = { n: wn, extentM: W.extentM, level: growLevels(dropSea(downsampleLevels(t.worldWaterLevel, W.size, wn)), wn, downsampleMin(W.data, W.size, wn)) };
    }
    return { play, world, fromData: true, filled: 0, dry: 0 };
  }
  const iw = inlandWaterLevels(terrain, sources, playN);
  return { play: { n: iw.n, extentM: iw.extentM, level: iw.level }, world: null, fromData: false, filled: iw.filled, dry: iw.dry };
}
