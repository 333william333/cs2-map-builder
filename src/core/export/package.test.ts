import { decode } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { buildPackageFiles, buildSeasons, NET_PREFAB_NAMES, TREE_PREFAB_NAMES } from './package';
import { makeSynthResult, makeSynthRoads, makeSynthTerrain } from '../playability/synthTerrain';
import { analyzePlayability } from '../playability/analyze';
import { buildWaterSources } from '../water/buildWaterSources';
import type { BuildResult, ClimateProfile, TreeSet } from '../types';

function build(): BuildResult {
  const terrain = makeSynthTerrain({ size: 64 });
  const result = makeSynthResult(terrain);
  result.roads = makeSynthRoads([[-7168, -1200], [-2000, -1200], [-1000, -3000]], 'primary');
  result.roads.edges[0].name = 'Storgatan';
  result.waterSources = buildWaterSources(terrain);
  result.trees = {
    count: 3,
    xz: new Float32Array([1.5, -2.25, 100.125, 200, -7000, 7000]),
    species: new Uint8Array([0, 1, 1]),
    age: new Uint8Array([2, 3, 0]),
    speciesTable: ['oak', 'pine'],
  };
  result.climate = {
    latitude: 59.8, longitude: 17.6, koppen: 'Dfb', theme: 'european',
    monthlyMeanC: [-2, -2, 1, 6, 11, 15, 18, 17, 12, 7, 2, -1],
    monthlyMinC: [-5, -5, -3, 1, 6, 10, 13, 12, 8, 4, 0, -3],
    monthlyMaxC: [1, 1, 5, 11, 17, 21, 23, 22, 17, 10, 4, 1],
    monthlyPrecipMm: [40, 30, 30, 30, 35, 60, 70, 70, 55, 50, 50, 45],
    monthlyCloud: [0.8, 0.7, 0.6, 0.55, 0.5, 0.5, 0.5, 0.5, 0.6, 0.7, 0.8, 0.8],
  };
  result.playability = analyzePlayability({ terrain, settings: result.settings, roads: result.roads, trees: result.trees });
  result.warnings = ['Test'];
  return result;
}

const find = (files: { path: string; bytes: Uint8Array }[], p: string) => files.find((f) => f.path === p)!;
const parse = (f: { bytes: Uint8Array }) => JSON.parse(new TextDecoder().decode(f.bytes));

describe('buildPackageFiles', () => {
  const result = build();
  const files = buildPackageFiles(result, 'Testkarta', { heightmapSize: 64 });

  it('writes exactly the specified files', () => {
    expect(files.map((f) => f.path).sort()).toEqual([
      'climate.json', 'heightmap.png', 'manifest.json', 'resources/fertile.png', 'resources/groundwater.png',
      'resources/oil.png', 'resources/ore.png', 'roads.json', 'trees.bin', 'water.json', 'worldmap.png',
    ]);
  });

  it('lists the outside connections in the manifest', () => {
    const m = parse(find(files, 'manifest.json'));
    const list = result.playability!.outsideConnections;
    expect(m.outsideConnections).toHaveLength(list.length);
    for (const c of m.outsideConnections) {
      expect(Object.keys(c).sort()).toEqual(['kind', 'manual', 'synthetic', 'x', 'z']);
    }
    expect(m.outsideConnections.some((c: { kind: string }) => c.kind === 'road')).toBe(true);
  });

  it('carries the manual and synthetic flags', () => {
    const r = build();
    r.playability = {
      ...r.playability!,
      outsideConnections: [
        { kind: 'road', p: [-7168, 100.126], synthetic: true },
        { kind: 'ship', p: [0, -7168], synthetic: false, manual: true },
      ],
    };
    const m = parse(find(buildPackageFiles(r, 'X', { heightmapSize: 64 }), 'manifest.json'));
    expect(m.outsideConnections).toEqual([
      { kind: 'road', x: -7168, z: 100.13, synthetic: true, manual: false },
      { kind: 'ship', x: 0, z: -7168, synthetic: false, manual: true },
    ]);
  });

  it('omits outsideConnections without a playability report', () => {
    const r = build();
    delete r.playability;
    const m = parse(find(buildPackageFiles(r, 'X', { heightmapSize: 64 }), 'manifest.json'));
    expect('outsideConnections' in m).toBe(false);
  });

  it('has a manifest with every prefab key', () => {
    const m = parse(find(files, 'manifest.json'));
    expect(m.format).toBe('cs2mapbuilder');
    expect(m.version).toBe(1);
    expect(m.name).toBe('Testkarta');
    expect(Object.keys(m.netPrefabs).sort()).toEqual(Object.keys(NET_PREFAB_NAMES).sort());
    expect(Object.keys(m.treePrefabs).sort()).toEqual(Object.keys(TREE_PREFAB_NAMES).sort());
    expect(m.treeSpecies).toEqual(['oak', 'pine']);
    expect(m.counts).toEqual({
      nodes: result.roads!.nodes.length, edges: result.roads!.edges.length, trees: 3, waterSources: result.waterSources.length,
    });
    expect(m.startTile).toEqual(result.playability!.startTile);
    expect(m.theme).toBe('european');
    expect(m.warnings).toEqual(['Test']);
    expect(typeof m.attribution).toBe('string');
  });

  it('round trips trees.bin', () => {
    const bytes = find(files, 'trees.bin').bytes;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    expect(magic).toBe('CS2T');
    expect(dv.getUint32(4, true)).toBe(1);
    const n = dv.getUint32(8, true);
    expect(n).toBe(3);
    expect(bytes.byteLength).toBe(12 + n * 10);
    const t: TreeSet = result.trees!;
    for (let i = 0; i < n; i++) {
      expect(dv.getFloat32(12 + i * 8, true)).toBeCloseTo(t.xz[2 * i], 4);
      expect(dv.getFloat32(16 + i * 8, true)).toBeCloseTo(t.xz[2 * i + 1], 4);
      expect(dv.getUint8(12 + n * 8 + i)).toBe(t.species[i]);
      expect(dv.getUint8(12 + n * 9 + i)).toBe(t.age[i]);
    }
  });

  it('writes roads.json to schema', () => {
    const r = parse(find(files, 'roads.json'));
    expect(r.nodes.length).toBe(result.roads!.nodes.length);
    for (const nd of r.nodes) {
      expect(nd).toHaveLength(5);
      expect([0, 1]).toContain(nd[4]);
    }
    expect(r.nodes[0][4]).toBe(1);
    for (const e of r.edges) {
      expect(e.bezier).toHaveLength(8);
      expect(e.bezier.every((v: number) => Number.isFinite(v) && Math.round(v * 100) / 100 === v)).toBe(true);
      expect(Object.keys(NET_PREFAB_NAMES)).toContain(e.prefab);
      expect(typeof e.oneway).toBe('boolean');
    }
    expect(r.edges.some((e: { name?: string }) => e.name === 'Storgatan')).toBe(true);
  });

  it('encodes heightmaps as 16-bit and resources as 8-bit greyscale', () => {
    const h = decode(find(files, 'heightmap.png').bytes);
    expect([h.width, h.height, h.depth, h.channels]).toEqual([64, 64, 16, 1]);
    const w = decode(find(files, 'worldmap.png').bytes);
    expect([w.width, w.height, w.depth]).toEqual([64, 64, 16]);
    for (const k of ['fertile', 'ore', 'oil', 'groundwater']) {
      const p = decode(find(files, `resources/${k}.png`).bytes);
      expect([p.width, p.height, p.depth, p.channels]).toEqual([256, 256, 8, 1]);
    }
  });

  it('writes water.json and climate.json with four seasons', () => {
    const w = parse(find(files, 'water.json'));
    expect(w.hasSea).toBe(true);
    expect(w.sources.length).toBe(result.waterSources.length);
    expect(w.sources[0]).toHaveProperty('x');
    const c = parse(find(files, 'climate.json'));
    expect(c.seasons.map((s: { name: string }) => s.name)).toEqual(['winter', 'spring', 'summer', 'autumn']);
    expect(c.koppen).toBe('Dfb');
  });

  it('derives seasons per hemisphere', () => {
    const clim = result.climate as ClimateProfile;
    const north = buildSeasons(clim);
    expect(north[0].startMonth).toBe(12);
    expect(north[2].tempDayC).toBeGreaterThan(north[0].tempDayC);
    expect(north[0].tempNightC).toBeLessThan(north[0].tempDayC);
    const south = buildSeasons({ ...clim, latitude: -30 });
    expect(south[0].startMonth).toBe(6);
    expect(south[0].tempDayC).toBeGreaterThan(north[0].tempDayC);
    for (const s of north) {
      expect(s.cloudChance).toBeGreaterThanOrEqual(0);
      expect(s.precipChance).toBeLessThanOrEqual(1);
    }
  });

  it('leaves out missing optional parts', () => {
    const bare = makeSynthResult(makeSynthTerrain({ size: 64 }));
    const f = buildPackageFiles(bare, 'x', { heightmapSize: 64 });
    expect(f.map((q) => q.path).sort()).toEqual(['heightmap.png', 'manifest.json', 'water.json', 'worldmap.png']);
    expect(parse(find(f, 'manifest.json')).counts).toEqual({ nodes: 0, edges: 0, trees: 0, waterSources: 0 });
  });

  it('throws for draft results and wrong heightmap sizes', () => {
    const draft = makeSynthResult(makeSynthTerrain({ size: 64 }), 'draft');
    expect(() => buildPackageFiles(draft, 'x', { heightmapSize: 64 })).toThrow(/full quality/);
    expect(() => buildPackageFiles(makeSynthResult(makeSynthTerrain({ size: 64 })), 'x')).toThrow(/wrong size/);
  });
});
