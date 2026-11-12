import { describe, expect, it } from 'vitest';
import { PREFAB_WIDTH } from '../../core/roads/params';
import { buildRibbons, hexToLinear, roadRibbonStyle, ROAD_PROFILES, RoadKind, type RibbonInput } from './roadRibbons';

const flat = (): number => 10;
const style = { width: 10, color: [1, 0, 0] as const, lift: 1 };

describe('road ribbons', () => {
  it('builds a straight ribbon of the right width on the terrain', () => {
    const g = buildRibbons([{ pts: [[0, 0], [100, 0]], style }], flat, { maxStep: 50 });
    expect(g.vertexCount).toBe(6); // 3 samples x 2
    expect(g.triangleCount).toBe(4);
    // all vertices at terrain + lift
    for (let i = 0; i < g.vertexCount; i++) expect(g.positions[i * 3 + 1]).toBeCloseTo(11);
    // width across the first pair is 10 in z
    expect(Math.abs(g.positions[2] - g.positions[5])).toBeCloseTo(10);
    // x runs 0..100
    expect(g.positions[0]).toBeCloseTo(0);
    expect(g.positions[(g.vertexCount - 2) * 3]).toBeCloseTo(100);
  });

  it('flips gz to z (north is -z)', () => {
    const g = buildRibbons([{ pts: [[0, 0], [0, 100]], style }], flat, { maxStep: 100 });
    const zs = [g.positions[2], g.positions[8]];
    expect(Math.min(...zs)).toBeCloseTo(-100, 0);
  });

  it('all triangles face upward', () => {
    const pts: [number, number][] = [[0, 0], [60, 20], [100, 80], [90, 160], [20, 200]];
    const g = buildRibbons([{ pts, style }], (x, z) => Math.sin(x / 50) * 4 + z * 0.02, { maxStep: 20 });
    for (let t = 0; t < g.indices.length; t += 3) {
      const a = g.indices[t] * 3, b = g.indices[t + 1] * 3, c = g.indices[t + 2] * 3;
      const ux = g.positions[b] - g.positions[a], uz = g.positions[b + 2] - g.positions[a + 2];
      const vx = g.positions[c] - g.positions[a], vz = g.positions[c + 2] - g.positions[a + 2];
      expect(uz * vx - ux * vz).toBeGreaterThan(-1e-6);
    }
  });

  it('drapes over a slope', () => {
    const g = buildRibbons([{ pts: [[0, 0], [100, 0]], style }], (x) => x * 0.1, { maxStep: 10 });
    expect(g.positions[1]).toBeCloseTo(0 + 1, 0);
    expect(g.positions[(g.vertexCount - 1) * 3 + 1]).toBeGreaterThan(9);
  });

  it('lifts bridge decks above the terrain', () => {
    const input: RibbonInput = { pts: [[0, 0], [100, 0]], style: { ...style, lift: 0.5 }, deck: { y0: 30, y1: 30 } };
    const g = buildRibbons([input], () => 0, { maxStep: 25 });
    for (let i = 0; i < g.vertexCount; i++) expect(g.positions[i * 3 + 1]).toBeCloseTo(30);
  });

  it('never dips below the ground under a deck', () => {
    const g = buildRibbons(
      [{ pts: [[0, 0], [100, 0]], style, deck: { y0: 5, y1: 5 } }],
      () => 20,
      { maxStep: 25 },
    );
    for (let i = 0; i < g.vertexCount; i++) expect(g.positions[i * 3 + 1]).toBeGreaterThanOrEqual(20);
  });

  it('alternates colours in dash mode with separate quads', () => {
    const c2 = [0, 1, 0] as const;
    const g = buildRibbons(
      [{ pts: [[0, 0], [100, 0]], style: { ...style, dash: 10, color2: c2 } }],
      flat,
    );
    expect(g.vertexCount).toBe(10 * 4);
    const reds = new Set<number>();
    for (let i = 0; i < g.vertexCount; i++) reds.add(g.colors[i * 3]);
    expect(reds.size).toBe(2);
  });

  it('closes outlines with a seam-free corner join', () => {
    const sq: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    const g = buildRibbons([{ pts: sq, style, closed: true }], flat, { maxStep: 50 });
    expect(g.vertexCount).toBeGreaterThan(8);
    // the first and the last vertex pair coincide
    for (let k = 0; k < 6; k++) expect(g.positions[k]).toBeCloseTo(g.positions[(g.vertexCount - 2) * 3 + k], 4);
  });

  it('merges 50 000 edges into one geometry quickly', () => {
    const inputs: RibbonInput[] = [];
    for (let i = 0; i < 50_000; i++) inputs.push({ pts: [[i % 700, Math.floor(i / 700) * 3], [(i % 700) + 90, Math.floor(i / 700) * 3 + 30]], style });
    const t0 = Date.now();
    const g = buildRibbons(inputs, flat, { maxStep: 30 });
    expect(g.vertexCount).toBeGreaterThan(50_000 * 4);
    expect(g.indices.length).toBe(g.triangleCount * 3);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('ignores degenerate lines', () => {
    const g = buildRibbons([{ pts: [[1, 1]], style }, { pts: [[1, 1], [1, 1]], style }], flat);
    expect(g.vertexCount).toBe(0);
  });

  it('styles roads by class', () => {
    expect(roadRibbonStyle('primary').width).toBeGreaterThan(roadRibbonStyle('residential').width);
    // true game widths, no visual boost
    expect(roadRibbonStyle('residential', 'road_small_2lane').width).toBe(PREFAB_WIDTH.road_small_2lane);
    expect(roadRibbonStyle('trunk', 'road_large_6lane').width).toBe(PREFAB_WIDTH.road_large_6lane);
    expect(roadRibbonStyle('rail').params![3]).toBe(RoadKind.railDouble);
    expect(ROAD_PROFILES.path_pedestrian.width).toBeLessThan(ROAD_PROFILES.road_alley.width);
    expect(hexToLinear(0xffffff)[0]).toBeCloseTo(1);
  });

  it('emits across/along coordinates and surface params per vertex', () => {
    const st = roadRibbonStyle('residential');
    const g = buildRibbons([{ pts: [[0, 0], [100, 0]], style: st }], flat, { maxStep: 50 });
    expect(g.uvs.length).toBe(g.vertexCount * 2);
    expect(g.params.length).toBe(g.vertexCount * 4);
    expect(g.uvs[0]).toBe(1);
    expect(g.uvs[2]).toBe(-1);
    expect(g.uvs[(g.vertexCount - 1) * 2 + 1]).toBeCloseTo(100);
    expect(g.params[0]).toBe(PREFAB_WIDTH.road_small_2lane / 2);
    expect(g.params[3]).toBe(RoadKind.street);
  });
});
