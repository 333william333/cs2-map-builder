import { describe, expect, it } from 'vitest';
import { createFrame, type Frame } from '../geo/frame';
import {
  CS2,
  DEFAULT_SETTINGS,
  type ElevationSampler,
  type TerrainSettings,
  type VectorData,
  type Pt,
} from '../types';
import { buildTerrain, chooseHeightScale, type TerrainInput } from './buildTerrain';
import { downsampleArea } from './filters';
import { centreRegion } from './world';
import { seamMetrics } from './seam';
import type { WorldWater } from '../data/worldWater';

const SEL = { centerLat: 59.85, centerLon: 17.64, sizeMeters: 14336, rotationDeg: 0 };

/** Sampler defined as a function of REAL metres in the selection frame (x east, y north). */
function sampler(frame: Frame, f: (x: number, y: number) => number): ElevationSampler {
  return {
    sample(lat: number, lon: number) {
      const [gx, gz] = frame.geoToGame(lat, lon);
      return f(gx / frame.scale, gz / frame.scale);
    },
  };
}

function settings(patch: Partial<TerrainSettings>): TerrainSettings {
  return { ...DEFAULT_SETTINGS.terrain, smoothing: 0, carveWater: false, ...patch };
}

function input(
  frame: Frame,
  f: (x: number, y: number) => number,
  s: Partial<TerrainSettings>,
  vectors?: VectorData,
): TerrainInput {
  const smp = sampler(frame, f);
  return { frame, settings: settings(s), quality: 'draft', playableElev: smp, worldElev: smp, vectors };
}

function vectors(patch: Partial<VectorData>): VectorData {
  return { ways: [], waterPolygons: [], waterways: [], areas: [], treePoints: [], powerLines: [], ...patch };
}

/** game x/z of the centre of cell (r, c) */
function cellPos(N: number, E: number, r: number, c: number): Pt {
  return [-E / 2 + (c + 0.5) * (E / N), E / 2 - (r + 0.5) * (E / N)];
}

describe('buildTerrain vertical mapping', () => {
  const plane = (x: number) => 500 + 0.005 * x;

  it('reproduces an inclined plane in all vertical modes', () => {
    const cases: { sel: typeof SEL; s: Partial<TerrainSettings>; v: number }[] = [
      { sel: SEL, s: { verticalMode: 'true' }, v: 1 },
      { sel: { ...SEL, sizeMeters: 7168 }, s: { verticalMode: 'proportional' }, v: 2 },
      { sel: SEL, s: { verticalMode: 'custom', verticalFactor: 1.5, exaggeration: 2 }, v: 3 },
    ];
    for (const { sel, s, v } of cases) {
      const frame = createFrame(sel);
      const res = buildTerrain(input(frame, plane, s));
      expect(res.scale.horizontal).toBeCloseTo(frame.scale, 9);
      expect(res.scale.vertical).toBeCloseTo(v, 9);
      // inland: base = lowest real elevation of the world grid (its first column of cells)
      const Nw = res.world.size;
      const base = plane((-CS2.WORLD_SIZE_M / 2 + (0.5 * CS2.WORLD_SIZE_M) / Nw) / frame.scale);
      const { size: N, extentM: E, data } = res.playable;
      for (const [r, c] of [[0, 0], [100, 300], [256, 256], [511, 511]]) {
        const [gx] = cellPos(N, E, r, c);
        const expected = 64 + (plane(gx / frame.scale) - base) * v;
        expect(data[r * N + c]).toBeCloseTo(expected, 1);
      }
      expect(res.heightScale).toBe(4096);
      expect(res.minHeight).toBeGreaterThanOrEqual(63.9);
      expect(res.waterMask.every((m) => m === 0)).toBe(true);
    }
  });

  it('uses the lowest elevation as base on an inland plateau and grows heightScale', () => {
    const frame = createFrame(SEL);
    const plateau = (x: number, y: number) => 2000 + 400 * Math.sin(x / 3000) * Math.cos(y / 2500);
    const res = buildTerrain(input(frame, plateau, { verticalMode: 'true' }));
    // base is a robust low quantile, so the very lowest cells sit slightly below seaLevelGame
    expect(res.minHeight).toBeGreaterThan(55);
    expect(res.minHeight).toBeLessThan(80);
    expect(res.maxHeight).toBeLessThan(64 + 820);
    expect(res.heightScale).toBe(4096);

    const tall = buildTerrain(input(frame, plateau, { verticalMode: 'custom', verticalFactor: 6 }));
    expect(tall.maxHeight).toBeGreaterThan(4096);
    expect(tall.heightScale % 512).toBe(0);
    expect(tall.heightScale).toBeGreaterThan(tall.maxHeight);
    expect(tall.heightScale - tall.maxHeight).toBeLessThanOrEqual(512);
    expect(chooseHeightScale(4096)).toBe(4096);
    expect(chooseHeightScale(4096.5)).toBe(4608);
  });
});

describe('buildTerrain water', () => {
  it('makes sea below seaLevelGame with a clean shore on a coastal ramp', () => {
    const frame = createFrame(SEL);
    const ramp = (x: number) => 0.004 * x; // sea west of x = 0
    const res = buildTerrain(input(frame, ramp, { verticalMode: 'true', carveWater: true, smoothing: 0.5 }));
    const { size: N, extentM: E, data } = res.playable;
    expect(res.seaLevel).toBe(64);
    let sea = 0;
    for (let r = 0; r < N; r += 7) {
      for (let c = 0; c < N; c++) {
        const i = r * N + c;
        const [gx] = cellPos(N, E, r, c);
        if (gx < -20) {
          expect(res.waterMask[i]).toBe(1);
          expect(data[i]).toBeLessThanOrEqual(64 - 2 + 1e-4); // guaranteed minimum depth
          sea++;
        } else if (gx > 20) {
          expect(res.waterMask[i]).toBe(0);
          expect(data[i]).toBeGreaterThanOrEqual(64 + 1.5 - 1e-4); // land never floods
        }
      }
    }
    expect(sea).toBeGreaterThan(1000);
    // depth grows offshore
    const mid = 256 * N;
    expect(data[mid + 50]).toBeLessThan(data[mid + 250]);
  });

  it('flattens a lake polygon on bumpy terrain and deepens it inside', () => {
    const frame = createFrame(SEL);
    const bumpy = (x: number, y: number) => 300 + 0.002 * x + 3 * Math.sin(x / 200) * Math.cos(y / 170);
    const ring: Pt[] = [];
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      ring.push([1500 * Math.cos(a), 1500 * Math.sin(a)]);
    }
    const vec = vectors({ waterPolygons: [{ kind: 'lake', rings: [ring] }] });
    const res = buildTerrain(input(frame, bumpy, { verticalMode: 'true', carveWater: true }, vec));
    const { size: N, data } = res.playable;
    // waterMask holds water kinds (1 sea, 2 lake, 3 river); the test only needs wet/dry
    const m = res.waterMask.map((v) => (v ? 1 : 0));
    const rim: number[] = [];
    const shore: number[] = [];
    for (let r = 1; r < N - 1; r++) {
      for (let c = 1; c < N - 1; c++) {
        const i = r * N + c;
        const edge = m[i - 1] + m[i + 1] + m[i - N] + m[i + N];
        if (m[i] === 1 && edge < 4) rim.push(data[i]);
        if (m[i] === 0 && edge > 0) shore.push(data[i]);
      }
    }
    expect(rim.length).toBeGreaterThan(100);
    const rimMin = Math.min(...rim);
    const rimMax = Math.max(...rim);
    expect(rimMax - rimMin).toBeLessThan(1e-3);
    // shore stays above the water level (level = rim + edge depth)
    expect(Math.min(...shore)).toBeGreaterThan(rimMax);
    const centre = data[(N / 2) * N + N / 2];
    expect(m[(N / 2) * N + N / 2]).toBe(1);
    expect(centre).toBeLessThan(rimMin - 5);
  });

  it('carves a river line with a monotone bed over a bumpy slope', () => {
    const frame = createFrame(SEL);
    // falls to the east, with bumps and a 12 m "bridge" artefact on the line
    const slope = (x: number, y: number) =>
      400 - 0.01 * x + 4 * Math.sin(x / 90) + 2 * Math.cos(y / 130) + (Math.abs(x - 1000) < 60 ? 12 : 0);
    // drawn downstream -> upstream to exercise direction detection
    const pts: Pt[] = [[6500, -400], [3000, 200], [0, -100], [-3000, 300], [-6500, 0]];
    const vec = vectors({ waterways: [{ kind: 'river', pts }] });
    const res = buildTerrain(input(frame, slope, { verticalMode: 'true', carveWater: true, smoothing: 0.3 }, vec));
    const { size: N, extentM: E, data } = res.playable;
    const cell = E / N;
    // cells whose centre lies on the line, ordered by distance along the line (from upstream = west)
    const onLine: { s: number; h: number; i: number }[] = [];
    const up = [...pts].reverse();
    let acc = 0;
    for (let k = 0; k + 1 < up.length; k++) {
      const [ax, az] = up[k];
      const [bx, bz] = up[k + 1];
      const len = Math.hypot(bx - ax, bz - az);
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const [gx, gz] = cellPos(N, E, r, c);
          const t = ((gx - ax) * (bx - ax) + (gz - az) * (bz - az)) / (len * len);
          if (t < 0 || t > 1) continue;
          const d = Math.hypot(ax + t * (bx - ax) - gx, az + t * (bz - az) - gz);
          if (d < 0.35 * cell) onLine.push({ s: acc + t * len, h: data[r * N + c], i: r * N + c });
        }
      }
      acc += len;
    }
    onLine.sort((a, b) => a.s - b.s);
    expect(onLine.length).toBeGreaterThan(100);
    for (let k = 1; k < onLine.length; k++) {
      expect(onLine[k].h).toBeLessThanOrEqual(onLine[k - 1].h + 0.05);
      expect(res.waterMask[onLine[k].i]).toBe(3);
    }
    // channel is below the surrounding land
    const mid = onLine[onLine.length >> 1];
    expect(mid.h).toBeLessThan(data[mid.i - 6 * N] - 1);
  });
});

describe('world map consistency', () => {
  it('centre quarter matches the area-averaged playable grid', () => {
    const frame = createFrame(SEL);
    const f = (x: number, y: number) => 200 + 0.003 * x + 20 * Math.sin(x / 700) * Math.cos(y / 900);
    const res = buildTerrain(input(frame, f, { smoothing: 0.4 }));
    const Nw = res.world.size;
    const { lo, hi } = centreRegion(Nw);
    const S = hi - lo;
    const down = downsampleArea(res.playable.data, res.playable.size, S);
    let maxErr = 0;
    for (let r = 0; r < S; r++) {
      for (let c = 0; c < S; c++) {
        maxErr = Math.max(maxErr, Math.abs(res.world.data[(lo + r) * Nw + lo + c] - down[r * S + c]));
      }
    }
    expect(maxErr).toBeLessThan(1e-3);
    // no seam: neighbours across the boundary differ by no more than the terrain gradient allows
    let seam = 0;
    for (let r = lo; r < hi; r++) {
      seam = Math.max(seam, Math.abs(res.world.data[r * Nw + lo] - res.world.data[r * Nw + lo - 1]));
    }
    expect(seam).toBeLessThan(10);
  });
});

describe('water across the playable border', () => {
  const circle = (cx: number, cz: number, rad: number, k = 64): Pt[] => {
    const ring: Pt[] = [];
    for (let q = 0; q < k; q++) {
      const a = (q / k) * Math.PI * 2;
      ring.push([cx + rad * Math.cos(a), cz + rad * Math.sin(a)]);
    }
    return ring;
  };
  const world = (patch: Partial<WorldWater>): WorldWater => ({ waterPolygons: [], waterways: [], zoom: 10, tiles: 1, ...patch });
  const worldRowCells = (Nw: number, gz: number) => Math.floor(((CS2.WORLD_SIZE_M / 2 - gz) / CS2.WORLD_SIZE_M) * Nw);

  it('gives a lake cut by the border one level on both grids and continues it outside', () => {
    const frame = createFrame(SEL);
    const bumpy = (x: number, y: number) => 300 + 0.002 * x + 3 * Math.sin(x / 400) * Math.cos(y / 350);
    const detail = vectors({ waterPolygons: [{ kind: 'lake', rings: [circle(7168, 0, 2500)] }] });
    const coarse = world({ waterPolygons: [{ kind: 'lake', rings: [circle(7180, 10, 2490, 24)] }] });
    const res = buildTerrain({ ...input(frame, bumpy, { verticalMode: 'true', carveWater: true }, detail), worldWater: coarse });
    const lv = res.waterLevel!, wlv = res.worldWaterLevel!, wm = res.worldWaterMask!;
    const levels = new Set<number>();
    for (let i = 0; i < res.waterMask.length; i++) if (res.waterMask[i] === 2) levels.add(Math.round(lv[i] * 1000));
    expect(levels.size).toBe(1);
    const level = [...levels][0] / 1000;
    const Nw = res.world.size;
    const { hi } = centreRegion(Nw);
    const r = worldRowCells(Nw, 0);
    // just outside the right border the lake continues with the same surface
    for (const c of [hi, hi + 2, hi + 5]) {
      expect(wm[r * Nw + c]).toBe(2);
      expect(wlv[r * Nw + c]).toBeCloseTo(level, 3);
      expect(res.world.data[r * Nw + c]).toBeLessThan(level);
    }
    const seam = seamMetrics(res);
    expect(seam.water.n).toBeGreaterThan(5);
    expect(seam.water.maxJump).toBeLessThan(2);
    expect(seam.mixed).toBeLessThanOrEqual(seam.mixedBaseline + 2);
  });

  it('keeps a river crossing the border on one falling surface on both grids', () => {
    const frame = createFrame(SEL);
    const slope = (x: number, y: number) => 300 - 0.004 * x + 3 * Math.sin(x / 150) + Math.cos(y / 300);
    const line: Pt[] = [[-25000, 40], [-9000, -30], [0, 0], [9000, 30], [25000, -20]];
    const detail = vectors({ waterways: [{ kind: 'river', widthM: 400, pts: line.slice(1, 4) }] });
    const coarse = world({ waterways: [{ kind: 'river', widthM: 400, pts: line }] });
    const res = buildTerrain({ ...input(frame, slope, { verticalMode: 'true', carveWater: true, smoothing: 0.3 }, detail), worldWater: coarse });
    const Nw = res.world.size, wlv = res.worldWaterLevel!, wm = res.worldWaterMask!;
    const r = worldRowCells(Nw, 0);
    let prevL = Infinity, prevH = Infinity, count = 0;
    // cells along the line from x = -24 km to +24 km, across both borders
    const cell = CS2.WORLD_SIZE_M / Nw;
    for (let c = Math.ceil((CS2.WORLD_SIZE_M / 2 - 24000) / cell); c < Nw - (CS2.WORLD_SIZE_M / 2 - 24000) / cell; c++) {
      const i = r * Nw + c;
      expect(wm[i]).toBe(3);
      expect(wlv[i]).toBeLessThanOrEqual(prevL + 1e-3);
      expect(res.world.data[i]).toBeLessThanOrEqual(prevH + 1);
      prevL = wlv[i];
      prevH = res.world.data[i];
      count++;
    }
    expect(count).toBeGreaterThan(200);
    expect(seamMetrics(res).water.maxJump).toBeLessThan(2);
  });

  it('classifies a coast crossing the border the same on both grids, trusting the outline offshore', () => {
    const frame = createFrame(SEL);
    // the DEM shows a flat +5 m "surface" over the sea (as some surface models do) west of x = -100
    const coast = (x: number) => (x < -100 ? 5 : 5 + 0.01 * (x + 100));
    const sea: Pt[] = [[-40000, -40000], [0, -40000], [0, 40000], [-40000, 40000]];
    const res = buildTerrain({
      ...input(frame, coast, { verticalMode: 'true', carveWater: true }, vectors({})),
      worldWater: world({ waterPolygons: [{ kind: 'sea', rings: [sea] }] }),
    });
    expect(res.hasSea).toBe(true);
    const { size: N, extentM: E } = res.playable;
    for (let c = 0; c < N; c += 16) {
      const [gx] = cellPos(N, E, 256, c);
      if (gx < -200) {
        expect(res.waterMask[256 * N + c]).toBe(1);
        expect(res.playable.data[256 * N + c]).toBeLessThan(res.seaLevel);
      }
      if (gx > 100) expect(res.waterMask[256 * N + c]).toBe(0);
    }
    const Nw = res.world.size;
    const { lo } = centreRegion(Nw);
    expect(res.worldWaterMask![worldRowCells(Nw, 0) * Nw + lo - 3]).toBe(1);
    const seam = seamMetrics(res);
    expect(seam.mixed).toBeLessThanOrEqual(4);
    expect(seam.water.maxJump).toBeLessThan(1);
    expect(seam.land.maxJump).toBeLessThan(2);
  });

  it('has no step along the border on plain land', () => {
    const frame = createFrame(SEL);
    const hills = (x: number, y: number) => 120 + 30 * Math.sin(x / 2100) * Math.cos(y / 1700) + 0.003 * y;
    const res = buildTerrain(input(frame, hills, { smoothing: 0.3 }));
    const seam = seamMetrics(res);
    expect(seam.mixed).toBe(0);
    expect(seam.land.maxJump).toBeLessThan(Math.max(0.5, 2 * seam.land.maxBase));
  });
});
