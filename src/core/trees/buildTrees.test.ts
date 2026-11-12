import { describe, expect, it } from 'vitest';
import { buildTrees, type TreeInput } from './buildTrees';
import { LC, type ClimateProfile, type LandcoverGrid, type Pt, type RoadNetwork, type TerrainResult, type VectorData } from '../types';

const EXTENT = 14336;
const HALF = EXTENT / 2;

function makeTerrain(
  height: (gx: number, gz: number) => number = () => 100,
  water: (gx: number, gz: number) => number = () => 0,
  n = 256,
): TerrainResult {
  const data = new Float32Array(n * n);
  const waterMask = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const gx = -HALF + ((c + 0.5) * EXTENT) / n;
      const gz = HALF - ((r + 0.5) * EXTENT) / n;
      data[r * n + c] = height(gx, gz);
      waterMask[r * n + c] = water(gx, gz);
    }
  }
  const grid = { size: n, extentM: EXTENT, data };
  return {
    playable: grid,
    world: grid,
    scale: { horizontal: 1, vertical: 1 },
    seaLevel: 64,
    heightScale: 4096,
    waterMask,
    baseElevation: 0,
    hasSea: false,
    minHeight: 64,
    maxHeight: 4096,
  };
}

function rect(x0: number, z0: number, x1: number, z1: number): Pt[] {
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
}

function emptyVectors(): VectorData {
  return { ways: [], waterPolygons: [], waterways: [], areas: [], treePoints: [], powerLines: [] };
}

function forestVectors(rects: [number, number, number, number][], leaf?: 'broadleaved' | 'needleleaved' | 'mixed'): VectorData {
  const v = emptyVectors();
  for (const [a, b, c, d] of rects) v.areas.push({ kind: 'forest', rings: [rect(a, b, c, d)], leafType: leaf });
  return v;
}

const base = { enabled: true, budget: 2_000_000, density: 1 };
const climate = (koppen: string, warm = 17, lon = 17): ClimateProfile => ({
  latitude: 60, longitude: lon, koppen,
  monthlyMeanC: [-2, -1, 2, 6, 11, 15, warm, warm - 1, 12, 7, 3, 0],
  monthlyMinC: new Array(12).fill(0), monthlyMaxC: new Array(12).fill(0),
  monthlyPrecipMm: new Array(12).fill(50), monthlyCloud: new Array(12).fill(0.5),
  theme: lon < -30 && lon > -170 ? 'northAmerican' : 'european',
});

function speciesCounts(t: ReturnType<typeof buildTrees>): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < t.count; i++) {
    const s = t.speciesTable[t.species[i]];
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

const forest: [number, number, number, number][] = [[-3000, -3000, 3000, 3000]];

describe('buildTrees', { timeout: 30_000 }, () => {
  it('returns an empty set when disabled', () => {
    const t = buildTrees({
      terrain: makeTerrain(), settings: { ...base, enabled: false }, vectors: forestVectors(forest), centerLat: 60,
    });
    expect(t.count).toBe(0);
    expect(t.xz.length).toBe(0);
    expect(t.speciesTable).toEqual([]);
  });

  it('puts trees in a forest polygon at roughly the natural density', () => {
    const t = buildTrees({
      terrain: makeTerrain(), settings: { ...base, density: 1 }, vectors: forestVectors(forest), centerLat: 60,
    });
    const area = 6000 * 6000;
    const perTree = area / t.count;
    expect(perTree).toBeGreaterThan(60);
    expect(perTree).toBeLessThan(140);
    for (let i = 0; i < t.count; i++) {
      expect(Math.abs(t.xz[i * 2])).toBeLessThanOrEqual(3010);
      expect(Math.abs(t.xz[i * 2 + 1])).toBeLessThanOrEqual(3010);
    }
    expect(t.species.length).toBe(t.count);
    expect(t.age.length).toBe(t.count);
    const ages = new Set(Array.from(t.age));
    expect(ages.has(2)).toBe(true);
  });

  it('uses no trees in water, below sea level, or on road buffers', () => {
    const terrain = makeTerrain(
      (x) => (x > 2000 ? 60 : 100), // below sea level east of x = 2000
      (x, z) => (z > 1000 && z < 1600 ? 2 : 0), // lake band
    );
    const road: RoadNetwork = {
      nodes: [],
      edges: [{
        id: 1, a: 0, b: 1, cls: 'motorway', prefab: 'highway_2lane_oneway',
        pts: [[-3000, -500], [3000, -500]], bezier: [[-3000, -500], [-1000, -500], [1000, -500], [3000, -500]],
        oneway: true, bridge: false, tunnel: false,
      }, {
        id: 2, a: 0, b: 1, cls: 'rail', prefab: 'rail_double',
        pts: [[500, -3000], [500, 3000]], bezier: [[500, -3000], [500, -1000], [500, 1000], [500, 3000]],
        oneway: false, bridge: false, tunnel: false,
      }],
    };
    const t = buildTrees({
      terrain, settings: base, vectors: forestVectors(forest), roads: road, centerLat: 60,
    });
    expect(t.count).toBeGreaterThan(1000);
    let nearRoad = 0;
    for (let i = 0; i < t.count; i++) {
      const x = t.xz[i * 2];
      const z = t.xz[i * 2 + 1];
      expect(z > 1060 && z < 1540).toBe(false);
      expect(x > 2060).toBe(false);
      if (Math.abs(z + 500) < 12 && x > -3000 && x < 3000) nearRoad++;
      if (Math.abs(x - 500) < 9) nearRoad++;
    }
    expect(nearRoad).toBe(0);
  });

  it('respects the budget while every forest patch keeps trees', () => {
    const patches: [number, number, number, number][] = [
      [-5000, -5000, -4000, -4000], [4000, 4000, 5000, 5000], [-1000, 3000, 1000, 5000], [2000, -4000, 5000, -2000],
    ];
    const terrain = makeTerrain();
    const full = buildTrees({ terrain, settings: base, vectors: forestVectors(patches), centerLat: 60 });
    const budget = Math.floor(full.count / 5);
    const small = buildTrees({ terrain, settings: { ...base, budget }, vectors: forestVectors(patches), centerLat: 60 });
    expect(small.count).toBeLessThanOrEqual(budget);
    expect(small.count).toBeGreaterThan(budget * 0.8);
    for (const [x0, z0, x1, z1] of patches) {
      let inside = 0;
      for (let i = 0; i < small.count; i++) {
        const x = small.xz[i * 2];
        const z = small.xz[i * 2 + 1];
        if (x >= x0 && x <= x1 && z >= z0 && z <= z1) inside++;
      }
      expect(inside).toBeGreaterThan(50);
    }
  });

  it('density setting scales the count roughly linearly', () => {
    const terrain = makeTerrain();
    const v = forestVectors(forest);
    const a = buildTrees({ terrain, settings: { ...base, density: 0.3 }, vectors: v, centerLat: 60 });
    const b = buildTrees({ terrain, settings: { ...base, density: 0.6 }, vectors: v, centerLat: 60 });
    const ratio = b.count / a.count;
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
  });

  it('tree line removes trees high up', () => {
    // real elevation rises 0 .. 1400 m across x; with 17 C warmest month at the centre (x = 0, h = 100)
    // the 10 C line sits about 1080 m above the centre
    const terrain = makeTerrain((x) => 64 + ((x + HALF) / EXTENT) * 1400, () => 0);
    const t = buildTrees({
      terrain, settings: base, climate: climate('Dfb'),
      vectors: forestVectors([[-HALF + 100, -2000, HALF - 100, 2000]]), centerLat: 60,
    });
    expect(t.count).toBeGreaterThan(1000);
    const hAt = (x: number) => 64 + ((x + HALF) / EXTENT) * 1400;
    const hCentre = hAt(0);
    let maxLapseElev = -Infinity;
    let low = 0;
    let band = 0;
    for (let i = 0; i < t.count; i++) {
      const x = t.xz[i * 2];
      const rise = hAt(x) - hCentre;
      maxLapseElev = Math.max(maxLapseElev, rise);
      if (rise < 500) low++;
      if (rise > 900) band++;
    }
    expect(maxLapseElev).toBeLessThan(1100); // never above the 10 C line (17 - 0.0065 * 1077 = 10)
    expect(low).toBeGreaterThan(band * 10);
    // stunted band is birch and bush only
    for (let i = 0; i < t.count; i++) {
      const x = t.xz[i * 2];
      if (hAt(x) - hCentre > 1000) {
        expect(['birch', 'bush']).toContain(t.speciesTable[t.species[i]]);
      }
    }
  });

  it('biome changes the species mix', () => {
    const terrain = makeTerrain();
    const v = forestVectors(forest);
    const boreal = speciesCounts(buildTrees({ terrain, settings: base, vectors: v, climate: climate('Dfc'), centerLat: 64 }));
    const med = speciesCounts(buildTrees({ terrain, settings: base, vectors: v, climate: climate('Csa', 25), centerLat: 38 }));
    const na = speciesCounts(buildTrees({ terrain, settings: base, vectors: v, climate: climate('Cfa', 24, -80), centerLat: 36 }));
    const arid = speciesCounts(buildTrees({ terrain, settings: base, vectors: v, climate: climate('BWh', 32), centerLat: 30 }));
    const tropical = speciesCounts(buildTrees({ terrain, settings: base, vectors: v, climate: climate('Af', 28), centerLat: 1 }));
    const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
    const frac = (c: Record<string, number>, ...names: string[]) =>
      names.reduce((a, n) => a + (c[n] ?? 0), 0) / total(c);
    expect(frac(boreal, 'spruce', 'pine', 'birch')).toBeGreaterThan(0.7);
    expect(boreal.hickory ?? 0).toBe(0);
    expect(frac(med, 'pine', 'oak', 'bush')).toBeGreaterThan(0.6);
    expect(med.spruce ?? 0).toBe(0);
    expect(frac(na, 'hickory', 'plane', 'oak')).toBeGreaterThan(0.3);
    expect(frac(arid, 'bush')).toBeGreaterThan(0.7);
    expect(frac(tropical, 'palm')).toBeGreaterThan(0.15);
  });

  it('leafType steers conifers versus broadleaves', () => {
    const terrain = makeTerrain();
    const needle = speciesCounts(buildTrees({
      terrain, settings: base, vectors: forestVectors(forest, 'needleleaved'), climate: climate('Dfb'), centerLat: 60,
    }));
    const broad = speciesCounts(buildTrees({
      terrain, settings: base, vectors: forestVectors(forest, 'broadleaved'), climate: climate('Dfb'), centerLat: 60,
    }));
    const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
    const conif = (c: Record<string, number>) => ((c.pine ?? 0) + (c.spruce ?? 0)) / total(c);
    expect(conif(needle)).toBeGreaterThan(0.7);
    expect(conif(broad)).toBeLessThan(0.3);
  });

  it('forms patches rather than salt and pepper', () => {
    const t = buildTrees({
      terrain: makeTerrain(), settings: base, vectors: forestVectors(forest), climate: climate('Dfb'), centerLat: 60,
    });
    // bucket into 150 m cells: dominant species share per cell should be well above the global share
    const cells = new Map<string, Map<number, number>>();
    for (let i = 0; i < t.count; i++) {
      const key = `${Math.floor(t.xz[i * 2] / 150)},${Math.floor(t.xz[i * 2 + 1] / 150)}`;
      const m = cells.get(key) ?? new Map<number, number>();
      m.set(t.species[i], (m.get(t.species[i]) ?? 0) + 1);
      cells.set(key, m);
    }
    let dom = 0;
    let all = 0;
    for (const m of cells.values()) {
      const tot = [...m.values()].reduce((a, b) => a + b, 0);
      dom += Math.max(...m.values());
      all += tot;
    }
    expect(dom / all).toBeGreaterThan(0.55);
  });

  it('keeps exact tree points and drops those in water', () => {
    const terrain = makeTerrain(() => 100, (x) => (x > 5000 ? 2 : 0));
    const v = emptyVectors();
    v.treePoints = [[10, 10], [20, 20], [6000, 0], [30, 30]];
    const t = buildTrees({ terrain, settings: { ...base, density: 0.01, budget: 100 }, vectors: v, centerLat: 50 });
    expect(t.count).toBe(3);
    expect(t.xz[0]).toBeCloseTo(10);
    expect(t.xz[1]).toBeCloseTo(10);
  });

  it('works from land cover alone and from OSM alone', () => {
    const size = 128;
    const data = new Uint8Array(size * size).fill(LC.Crop);
    for (let r = 20; r < 60; r++) for (let c = 20; c < 60; c++) data[r * size + c] = LC.Tree;
    for (let r = 80; r < 100; r++) for (let c = 80; c < 100; c++) data[r * size + c] = LC.Shrub;
    const lc: LandcoverGrid = { size, extentM: EXTENT, data };
    const t = buildTrees({ terrain: makeTerrain(), settings: base, landcover: lc, centerLat: 50 });
    expect(t.count).toBeGreaterThan(1000);
    const counts = speciesCounts(t);
    expect(counts.bush ?? 0).toBeGreaterThan(50);
    // no trees in the crop area
    for (let i = 0; i < t.count; i++) {
      const c = Math.floor(((t.xz[i * 2] + HALF) / EXTENT) * size);
      const r = Math.floor(((HALF - t.xz[i * 2 + 1]) / EXTENT) * size);
      expect(data[r * size + c]).not.toBe(LC.Crop);
    }
  });

  it('is deterministic', () => {
    const input: TreeInput = {
      terrain: makeTerrain(), settings: { ...base, budget: 50_000 }, vectors: forestVectors(forest),
      climate: climate('Dfb'), centerLat: 60,
    };
    const a = buildTrees(input);
    const b = buildTrees(input);
    expect(a.count).toBe(b.count);
    expect(Buffer.from(a.xz.buffer).equals(Buffer.from(b.xz.buffer))).toBe(true);
    expect(Buffer.from(a.species).equals(Buffer.from(b.species))).toBe(true);
    expect(a.speciesTable).toEqual(b.speciesTable);
  });

  it('handles 800k trees on a 4096 grid within a few seconds', () => {
    const terrain = makeTerrain((x, z) => 100 + 20 * Math.sin(x / 900) * Math.cos(z / 700), () => 0, 4096);
    const lcSize = 1024;
    const data = new Uint8Array(lcSize * lcSize).fill(LC.Tree);
    const lc: LandcoverGrid = { size: lcSize, extentM: EXTENT, data };
    const t0 = performance.now();
    const t = buildTrees({
      terrain, landcover: lc, settings: { enabled: true, budget: 800_000, density: 1 }, centerLat: 50,
    });
    const ms = performance.now() - t0;
    expect(t.count).toBeGreaterThan(600_000);
    expect(t.count).toBeLessThanOrEqual(800_000);
    expect(ms).toBeLessThan(6000);
  }, 30_000);
});
