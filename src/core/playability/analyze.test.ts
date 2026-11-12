import { describe, expect, it } from 'vitest';
import { analyzePlayability } from './analyze';
import { makeSynthRoads, makeSynthTerrain, SYNTH } from './synthTerrain';
import { DEFAULT_SETTINGS, LC } from '../types';
import type { BuildSettings, TreeSet } from '../types';

const settings = (over: Partial<BuildSettings> = {}): BuildSettings => ({ ...DEFAULT_SETTINGS, quality: 'full', ...over });
const status = (rep: ReturnType<typeof analyzePlayability>, id: string) => rep.checks.find((c) => c.id === id)?.status;
const tileCentre = (t: { col: number; row: number }) => [-7168 + (t.col + 0.5) * (14336 / 23), 7168 - (t.row + 0.5) * (14336 / 23)];

describe('analyzePlayability', () => {
  const terrain = makeSynthTerrain({ size: 128 });
  const roads = makeSynthRoads([[-7168, -1200], [-2000, -1200], [-1000, -3000]], 'primary');
  const rep = analyzePlayability({ terrain, settings: settings(), roads });

  it('picks a start tile on flat land near the road and the lake', () => {
    const [cx, cz] = tileCentre(rep.startTile);
    expect(rep.startTile.col).toBeGreaterThanOrEqual(2);
    expect(rep.startTile.col).toBeLessThanOrEqual(20);
    expect(rep.startTile.row).toBeGreaterThanOrEqual(2);
    expect(rep.startTile.row).toBeLessThanOrEqual(20);
    expect(Math.hypot(cx - SYNTH.lakeCentre[0], cz - SYNTH.lakeCentre[1])).toBeLessThan(2500);
    // not on the mountain (4500, 4000) and not on the sea (gz < -6000)
    expect(Math.hypot(cx - 4500, cz - 4000)).toBeGreaterThan(2500);
    expect(cz).toBeGreaterThan(-6000);
    expect(status(rep, 'startRoad')).toBe('ok');
    expect(status(rep, 'freshWater')).toBe('ok');
  });

  it('is deterministic', () => {
    expect(analyzePlayability({ terrain, settings: settings(), roads })).toEqual(rep);
  });

  it('reports fractions and a real road outside connection', () => {
    expect(rep.buildableFraction).toBeGreaterThan(0.6);
    expect(rep.waterFraction).toBeGreaterThan(0.02);
    expect(rep.waterFraction).toBeLessThan(0.3);
    const road = rep.outsideConnections.find((c) => c.kind === 'road');
    expect(road?.synthetic).toBe(false);
    expect(road?.p[0]).toBeCloseTo(-7168, 3);
    expect(rep.outsideConnections.some((c) => c.kind === 'ship')).toBe(true);
    expect(rep.outsideConnections.some((c) => c.kind === 'air')).toBe(true);
    expect(rep.outsideConnections.some((c) => c.kind === 'power')).toBe(true);
    expect(rep.outsideConnections.some((c) => c.kind === 'water')).toBe(true);
    expect(status(rep, 'roadConnection')).toBe('ok');
  });

  it('synthesises a road connection when none exists', () => {
    const r = analyzePlayability({ terrain, settings: settings() });
    const road = r.outsideConnections.find((c) => c.kind === 'road');
    expect(road?.synthetic).toBe(true);
    expect(Math.max(Math.abs(road!.p[0]), Math.abs(road!.p[1]))).toBeCloseTo(7168, 3);
    expect(status(r, 'roadConnection')).toBe('warn');
    expect(status(r, 'startRoad')).toBe('warn');
  });

  it('flips the buildable check with terrain relief', () => {
    const steep = makeSynthTerrain({ size: 128, relief: 12 });
    // make everything steep
    for (let i = 0; i < steep.playable.data.length; i++) {
      const r = (i / 128) | 0, c = i % 128;
      steep.playable.data[i] += 40 * Math.sin(c * 0.9) * Math.cos(r * 0.9);
    }
    const r = analyzePlayability({ terrain: steep, settings: settings() });
    expect(status(r, 'buildable')).not.toBe('ok');
    expect(status(rep, 'buildable')).toBe('ok');
    const mid = analyzePlayability({ terrain, settings: settings() });
    expect(mid.checks.length).toBeGreaterThan(8);
  });

  it('checks height scale, sea level, trees, water share and draft', () => {
    const bad = { ...terrain, heightScale: 100, maxHeight: 500, seaLevel: 2500 };
    const r = analyzePlayability({ terrain: bad, settings: settings() });
    expect(status(r, 'heightRange')).toBe('fail');
    expect(status(r, 'heightScale')).toBe('fail');
    expect(status(r, 'seaLevel')).toBe('fail');

    const many: TreeSet = { count: 600000, xz: new Float32Array(0), species: new Uint8Array(0), age: new Uint8Array(0), speciesTable: ['oak'] };
    expect(status(analyzePlayability({ terrain, settings: settings(), trees: many }), 'treeCount')).toBe('warn');
    expect(status(rep, 'treeCount')).toBe('ok');

    const wet = makeSynthTerrain({ size: 64 });
    wet.waterMask.fill(1);
    expect(status(analyzePlayability({ terrain: wet, settings: settings() }), 'waterDominant')).toBe('warn');

    expect(status(analyzePlayability({ terrain, settings: settings({ quality: 'draft' }) }), 'draft')).toBe('warn');
    expect(status(rep, 'draft')).toBeUndefined();
  });

  it('builds 256 x 256 resource masks without ore or oil under water', () => {
    const n = 256;
    const t = makeSynthTerrain({ size: n });
    const lc = { size: 64, extentM: 14336, data: new Uint8Array(64 * 64).fill(LC.Grass) };
    for (let i = 0; i < lc.data.length; i += 3) lc.data[i] = LC.Crop;
    const r = analyzePlayability({ terrain: t, settings: settings(), landcover: lc });
    const res = r.resources!;
    expect(res.size).toBe(256);
    for (const k of ['fertile', 'forest', 'ore', 'oil', 'groundwater'] as const) expect(res[k].length).toBe(256 * 256);
    let ore = 0, oil = 0, fert = 0;
    for (let i = 0; i < n * n; i++) {
      if (t.waterMask[i] !== 0) {
        expect(res.ore[i]).toBe(0);
        expect(res.oil[i]).toBe(0);
      }
      if (res.ore[i] > 0) ore++;
      if (res.oil[i] > 0) oil++;
      if (res.fertile[i] > 0) fert++;
    }
    expect(ore).toBeGreaterThan(20);
    expect(oil).toBeGreaterThan(20);
    expect(ore).toBeLessThan(0.15 * n * n);
    expect(oil).toBeLessThan(0.15 * n * n);
    expect(fert).toBeGreaterThan(1000);
    // deterministic
    const again = analyzePlayability({ terrain: t, settings: settings(), landcover: lc }).resources!;
    expect(Buffer.from(again.ore).equals(Buffer.from(res.ore))).toBe(true);
    // disabled
    const off = analyzePlayability({ terrain: t, settings: { ...settings(), resources: { enabled: false } } });
    expect(off.resources).toBeUndefined();
  });
});
