import { describe, expect, it } from 'vitest';
import type { RoadEdge, RoadNetwork, RoadNode, TerrainResult, WaterSource } from '../../core/types';
import { clampState, liftPitch, moveTarget, poseOf, DEFAULT_LIMITS } from './cameraRig';
import { deserializeResult } from './devCache';
import { downsampleLevels, downsampleMin, growLevels, inlandWaterLevels, waterGrids } from './gameWater';
import { chunkTrees, treeLook } from './instances';
import { buildRoadScene, JUNCTION_KIND, pointAt, trimPolyline } from './roadNetwork';
import { acceptRect, labelCandidates, labelText } from './roadLabels';
import { boxDistance, buildMinMax, nodeRange, patchGrid, selectNodes, PATCH_CELLS } from './terrainLod';

describe('terrain LOD', () => {
  const size = 64;
  const data = new Float32Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = (i % size) * 2; // rises to the east
  const pyr = buildMinMax(data, size, 6400, 16);

  it('keeps conservative height ranges per node', () => {
    const [mn, mx] = nodeRange(pyr, { x0: -3200, z0: -3200, size: 6400 });
    expect(mn).toBe(0);
    expect(mx).toBe(126);
    const [a, b] = nodeRange(pyr, { x0: 0, z0: 0, size: 400 });
    expect(a).toBeGreaterThanOrEqual(60);
    expect(b).toBeLessThanOrEqual(80);
  });

  it('refines near the camera and stays coarse far away, covering the whole area once', () => {
    const nodes = selectNodes({ extent: 6400, minNode: 100, camera: [-3000, 50, -3000], splitK: 2, pyramid: pyr });
    const area = nodes.reduce((s, n) => s + n.size * n.size, 0);
    expect(area).toBeCloseTo(6400 * 6400, 0);
    const near = nodes.find((n) => n.x0 <= -3000 && n.x0 + n.size > -3000 && n.z0 <= -3000 && n.z0 + n.size > -3000)!;
    const far = nodes.find((n) => n.x0 + n.size >= 3200 && n.z0 + n.size >= 3200)!;
    expect(near.size).toBe(100);
    expect(far.size).toBeGreaterThan(near.size * 4);
  });

  it('drops nodes outside the frustum test', () => {
    const nodes = selectNodes({ extent: 6400, minNode: 100, camera: [0, 500, 0], splitK: 2, pyramid: pyr, visible: (x0) => x0 >= 0 });
    expect(nodes.every((n) => n.x0 >= 0)).toBe(true);
  });

  it('builds a patch with a skirt', () => {
    const g = patchGrid(4);
    const n = 5;
    expect(g.positions.length / 3).toBe(n * n + 16);
    let skirts = 0;
    for (let i = 1; i < g.positions.length; i += 3) if (g.positions[i] < 0) skirts++;
    expect(skirts).toBe(16);
    expect(PATCH_CELLS).toBe(64);
    expect(boxDistance(0, 0, 0, 1, 0, 0, 2, 1, 1)).toBe(1);
  });
});

function terrain(size: number, h: (r: number, c: number) => number, mask: (r: number, c: number) => number): TerrainResult {
  const data = new Float32Array(size * size);
  const wm = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) { data[r * size + c] = h(r, c); wm[r * size + c] = mask(r, c); }
  return {
    playable: { size, extentM: 1000, data },
    world: { size: 4, extentM: 4000, data: new Float32Array(16).fill(100) },
    scale: { horizontal: 1, vertical: 1 }, seaLevel: 50, heightScale: 4096, waterMask: wm,
    baseElevation: 0, hasSea: false, minHeight: 0, maxHeight: 200,
  };
}

describe('game water', () => {
  // a lake in the west half (mask 2, bed at 80) and a river strip in the east (mask 3, sloping bed)
  const t = terrain(40, (r, c) => (c < 15 ? 80 : c >= 25 && c < 28 ? 90 - r * 0.2 : 100), (r, c) => (c < 15 ? 2 : c >= 25 && c < 28 ? 3 : 0));

  it('fills masked lakes to their source level and leaves areas without a source dry', () => {
    const lake: WaterSource = { kind: 'lake', p: [-400, 0], radius: 50, level: 85 };
    const w = inlandWaterLevels(t, [lake], 40);
    expect(w.filled).toBe(1);
    expect(w.dry).toBe(1);
    expect(w.level[20 * 40 + 5]).toBe(85);
    expect(Number.isNaN(w.level[20 * 40 + 26])).toBe(true);
  });

  it('lets rivers follow their bed downstream with the source depth', () => {
    const river: WaterSource = { kind: 'borderRiver', p: [162, 495], radius: 20, level: 91.5 };
    const w = inlandWaterLevels(t, [river], 40);
    const top = w.level[1 * 40 + 26];
    const bottom = w.level[38 * 40 + 26];
    expect(top).toBeGreaterThan(bottom);
    expect(top - (90 - 0.2)).toBeGreaterThan(0.3);
  });

  it('uses per-cell levels from the build when present and never spills onto lower land', () => {
    const t2 = terrain(8, (_r, c) => (c === 3 ? 40 : c === 2 ? 65 : 75), () => 0);
    const lv = new Float32Array(64).fill(NaN);
    for (let r = 0; r < 8; r++) lv[r * 8 + 2] = 70;
    (t2 as TerrainResult).waterLevel = lv;
    const g = waterGrids(t2, [], 8, 4);
    expect(g.fromData).toBe(true);
    expect(g.play.level[3 * 8 + 2]).toBe(70);
    expect(g.play.level[3 * 8 + 1]).toBe(70); // grown into the higher bank
    expect(Number.isNaN(g.play.level[3 * 8 + 3])).toBe(true); // lower land next to the water stays dry
    const grown = growLevels(lv, 8);
    expect(grown[3 * 8 + 3]).toBe(70); // without ground data every neighbour is grown
    expect(downsampleMin(new Float32Array([4, 2, 3, 1]), 2, 1)[0]).toBe(1);
    expect(downsampleLevels(new Float32Array([NaN, 1, 2, NaN]), 2, 1)[0]).toBe(2);
  });
});

function edge(id: number, a: number, b: number, pts: [number, number][], prefab: RoadEdge['prefab'] = 'road_small_2lane', extra: Partial<RoadEdge> = {}): RoadEdge {
  return { id, a, b, cls: 'residential', prefab, pts, bezier: [pts[0], pts[0], pts[pts.length - 1], pts[pts.length - 1]], oneway: false, bridge: false, tunnel: false, ...extra };
}
function node(id: number, p: [number, number], elevation = 0): RoadNode {
  return { id, p, ground: 10, elevation, outside: false };
}

describe('road network geometry', () => {
  const flat = (): number => 10;
  const cross: RoadNetwork = {
    nodes: [node(0, [0, 0]), node(1, [100, 0]), node(2, [-100, 0]), node(3, [0, 100]), node(4, [0, -100])],
    edges: [edge(0, 0, 1, [[0, 0], [100, 0]]), edge(1, 2, 0, [[-100, 0], [0, 0]]), edge(2, 0, 3, [[0, 0], [0, 100]]), edge(3, 4, 0, [[0, -100], [0, 0]])],
  };

  it('trims arms at a junction and fills it with one upward-facing surface', () => {
    const s = buildRoadScene(cross, flat);
    expect(s.ribbons).toHaveLength(4);
    for (const r of s.ribbons) {
      const d0 = Math.hypot(r.pts[0][0], r.pts[0][1]);
      const d1 = Math.hypot(r.pts[r.pts.length - 1][0], r.pts[r.pts.length - 1][1]);
      expect(Math.min(d0, d1)).toBeGreaterThan(5);
    }
    const j = s.junctions;
    expect(j.vertexCount).toBeGreaterThan(0);
    expect(j.vertexCount % 3).toBe(0);
    for (let i = 0; i < j.vertexCount; i += 3) {
      const a = i * 3, b = a + 3, c = a + 6;
      const ux = j.positions[b] - j.positions[a], uz = j.positions[b + 2] - j.positions[a + 2];
      const vx = j.positions[c] - j.positions[a], vz = j.positions[c + 2] - j.positions[a + 2];
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
    }
    expect(j.params[3]).toBe(JUNCTION_KIND);
    // wedges carry a sidewalk band (some vertices at kerb distance 0)
    let kerb = 0;
    for (let i = 0; i < j.vertexCount; i++) if (j.uvs[i * 2] === 0) kerb++;
    expect(kerb).toBeGreaterThan(0);
  });

  it('builds decks between node elevations and portals where roads go underground', () => {
    const net: RoadNetwork = {
      nodes: [node(0, [0, 0]), node(1, [100, 0], 10), node(2, [200, 0], 10), node(3, [300, 0]), node(4, [400, 0], -8), node(5, [600, 0], -8)],
      edges: [
        edge(0, 0, 1, [[0, 0], [100, 0]]), edge(1, 1, 2, [[100, 0], [200, 0]], 'road_small_2lane', { bridge: true }),
        edge(2, 2, 3, [[200, 0], [300, 0]]), edge(3, 3, 4, [[300, 0], [400, 0]]),
        edge(4, 4, 5, [[400, 0], [600, 0]], 'road_small_2lane', { tunnel: true }),
      ],
    };
    const s = buildRoadScene(net, flat);
    expect(s.bridgeCount).toBe(1);
    expect(s.bridges.length).toBeGreaterThanOrEqual(1);
    const deck = s.ribbons.find((r) => r.deck && r.deck.y0 > 15 && r.deck.y1 > 15)!;
    expect(deck.deck!.y0).toBeCloseTo(20 + 0.45, 1);
    expect(s.tunnels).toBe(1);
    expect(s.underground).toHaveLength(1);
    expect(s.portals.length).toBeGreaterThanOrEqual(1);
    const ramp = s.ribbons.find((r) => r.deck?.exact);
    expect(ramp).toBeDefined();
  });

  it('trims polylines from both ends', () => {
    const t = trimPolyline([[0, 0], [50, 0], [100, 0]], 10, 20);
    expect(t[0][0]).toBeCloseTo(10);
    expect(t[t.length - 1][0]).toBeCloseTo(80);
    expect(pointAt([[0, 0], [0, 10]], 4)[1]).toBeCloseTo(4);
  });
});

describe('road labels', () => {
  it('uses names, falls back to refs and declutters', () => {
    expect(labelText({ name: ' Kungsgatan ' })).toBe('Kungsgatan');
    expect(labelText({ ref: 'E4' })).toBe('E4');
    expect(labelText({})).toBeUndefined();
    const net: RoadNetwork = {
      nodes: [],
      edges: [
        edge(0, 0, 1, [[0, 0], [100, 0]], 'road_small_2lane', { name: 'A' }),
        edge(1, 1, 2, [[100, 0], [200, 0]], 'road_small_2lane', { name: 'A' }),
        edge(2, 3, 4, [[0, 1000], [200, 1000]], 'highway_2lane_oneway', { cls: 'motorway', ref: 'E4' }),
      ],
    };
    const c = labelCandidates(net, 350);
    expect(c[0].text).toBe('E4');
    expect(c.filter((x) => x.text === 'A')).toHaveLength(1);
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    expect(acceptRect(placed, { x0: 0, y0: 0, x1: 10, y1: 10 })).toBe(true);
    expect(acceptRect(placed, { x0: 5, y0: 5, x1: 15, y1: 15 })).toBe(false);
  });
});

describe('camera rig', () => {
  it('orbits the target and moves in the view frame', () => {
    const s = { tx: 0, tz: 0, yaw: 0, pitch: Math.PI / 4, distance: 100 };
    const [x, y, z] = poseOf(s, 10);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(10 + 100 * Math.SQRT1_2);
    expect(z).toBeCloseTo(100 * Math.SQRT1_2);
    const f = moveTarget(s, 10, 0);
    expect(f.tz).toBeCloseTo(-10); // forward = north = -z
    const r = moveTarget(s, 0, 10);
    expect(r.tx).toBeCloseTo(10);
  });

  it('clamps to the map and lifts the camera above the ground', () => {
    const c = clampState({ tx: 1e6, tz: -1e6, yaw: 0, pitch: 3, distance: 1 }, DEFAULT_LIMITS);
    expect(c.tx).toBe(DEFAULT_LIMITS.half);
    expect(c.tz).toBe(-DEFAULT_LIMITS.half);
    expect(c.pitch).toBe(DEFAULT_LIMITS.maxPitch);
    expect(c.distance).toBe(DEFAULT_LIMITS.minDistance);
    const s = { tx: 0, tz: 0, yaw: 0, pitch: 0.1, distance: 500 };
    const p = liftPitch(s, 0, () => 200, 3, 1.5);
    expect(poseOf({ ...s, pitch: p }, 0)[1]).toBeGreaterThanOrEqual(203);
  });
});

describe('tree chunks', () => {
  it('keeps every tree, sorted into chunks by type', () => {
    const n = 1000;
    const xz = new Float32Array(n * 2);
    const species = new Uint8Array(n);
    for (let i = 0; i < n; i++) { xz[i * 2] = (i % 40) * 50 - 990; xz[i * 2 + 1] = Math.floor(i / 40) * 80 - 990; species[i] = i % 2; }
    const chunks = chunkTrees({ count: n, xz, species, age: new Uint8Array(n).fill(2), speciesTable: ['spruce', 'oak'] }, 2000, 500, () => 5);
    const total = chunks.reduce((s, c) => s + c.conifer.count + c.broadleaf.count, 0);
    expect(total).toBe(n);
    expect(chunks.reduce((s, c) => s + c.conifer.count, 0)).toBe(n / 2);
    for (const c of chunks) {
      for (let k = 0; k < c.conifer.count; k++) {
        const x = c.conifer.pos[k * 4];
        expect(x).toBeGreaterThanOrEqual(c.x0 - 1e-3);
        expect(x).toBeLessThanOrEqual(c.x0 + c.size + 1e-3);
      }
    }
    const look = treeLook('spruce', 2, 1, { conifer: false, radius: 0, height: 0, rot: 0, r: 0, g: 0, b: 0 });
    expect(look.conifer).toBe(true);
    expect(look.height).toBeGreaterThan(14);
  });
});

describe('dev result files', () => {
  it('restores typed arrays and non-finite numbers', () => {
    const json = JSON.stringify({ a: { $ta: 'Float32Array', o: 0, n: 2 }, b: { $num: 'Infinity' }, c: 3 });
    const head = new TextEncoder().encode(json);
    const base = Math.ceil((8 + head.length) / 8) * 8;
    const buf = new ArrayBuffer(base + 8);
    const dv = new DataView(buf);
    dv.setUint32(0, head.length, true);
    dv.setUint32(4, base, true);
    new Uint8Array(buf).set(head, 8);
    new Float32Array(buf, base, 2).set([1.5, -2]);
    const r = deserializeResult(buf) as unknown as { a: Float32Array; b: number; c: number };
    expect(Array.from(r.a)).toEqual([1.5, -2]);
    expect(r.b).toBe(Infinity);
    expect(r.c).toBe(3);
  });
});
