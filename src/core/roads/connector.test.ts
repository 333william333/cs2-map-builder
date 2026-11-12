import { describe, expect, it } from 'vitest';
import type { Pt, RawWay, RoadNetwork, TerrainResult } from '../types';
import { buildRoads, validateNetwork } from './buildRoads';
import { addOutsideConnection } from './connector';
import { line, settings, terrain, vectors, way } from './testutil';

function city(t: TerrainResult): RoadNetwork {
  const ways: RawWay[] = [];
  for (let i = -6; i <= 6; i++) {
    ways.push(way('residential', line(-700, i * 110, 700, i * 110, 40)));
    ways.push(way('residential', line(i * 110, -700, i * 110, 700, 40)));
  }
  ways.push(way('primary', line(-1500, 55, 1500, 55, 100)));
  ways.push(way('rail', line(-1800, -1600, 1800, -1500, 100)));
  return buildRoads(vectors(ways), t, settings({ detail: 1 }));
}

function components(net: RoadNetwork): Map<number, number> {
  const parent = new Map<number, number>();
  for (const n of net.nodes) parent.set(n.id, n.id);
  const find = (i: number): number => {
    while (parent.get(i) !== i) i = parent.get(i)!;
    return i;
  };
  for (const e of net.edges) parent.set(find(e.a), find(e.b));
  const out = new Map<number, number>();
  for (const n of net.nodes) out.set(n.id, find(n.id));
  return out;
}

function expectClean(net: RoadNetwork) {
  const v = validateNetwork(net);
  if (v.length) console.log(v.slice(0, 10).join('\n'));
  expect(v).toEqual([]);
}

function outsideNear(net: RoadNetwork, p: Pt) {
  return net.nodes.find((n) => n.outside && Math.hypot(n.p[0] - p[0], n.p[1] - p[1]) < 400);
}

describe('addOutsideConnection', () => {
  const t = terrain();
  const base = city(t);
  const snapshot = JSON.stringify(base);
  const cityNode = base.nodes.find((n) => Math.hypot(n.p[0], n.p[1] - 55) < 60)!;

  for (const p of [[7168, 300], [-7100, -200], [400, 7168], [-300, -7150]] as Pt[]) {
    it(`connects the city from border point ${p.join(',')}`, () => {
      const t0 = Date.now();
      const r = addOutsideConnection(base, t, 'road', p);
      const ms = Date.now() - t0;
      expect(r.ok).toBe(true);
      expect(r.reason).toBeUndefined();
      expectClean(r.net);
      const o = outsideNear(r.net, p)!;
      expect(o).toBeDefined();
      expect(Math.abs(o.p[0]) === 7168 || Math.abs(o.p[1]) === 7168).toBe(true);
      const comp = components(r.net);
      expect(comp.get(o.id)).toBe(comp.get(cityNode.id));
      expect(r.net.edges.filter((e) => e.prefab === 'highway_twoway_2lane').length).toBeGreaterThan(5);
      expect(JSON.stringify(base)).toBe(snapshot);
      expect(ms).toBeLessThan(1000);
    });
  }

  it('connects rail to the rail line', () => {
    const r = addOutsideConnection(base, t, 'rail', [7168, -2500]);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expectClean(r.net);
    const o = outsideNear(r.net, [7168, -2500])!;
    const comp = components(r.net);
    const railNode = r.net.nodes.find((n) => !n.outside && r.net.edges.some((e) => e.cls === 'rail' && e.prefab !== 'rail_double' && (e.a === n.id || e.b === n.id)))!;
    expect(comp.get(o.id)).toBe(comp.get(railNode.id));
  });

  it('bridges a river between the border and the city', () => {
    const river = (x: number) => Math.abs(x - 4000) < 80;
    const tw = terrain({ water: (x) => river(x), height: (x) => (river(x) ? 92 : 100) });
    const net = city(tw);
    const r = addOutsideConnection(net, tw, 'road', [7168, 100]);
    expect(r.ok).toBe(true);
    expectClean(r.net);
    const bridges = r.net.edges.filter((e) => e.bridge && e.cls === 'motorway');
    expect(bridges.length).toBeGreaterThan(0);
    const ids = new Map(r.net.nodes.map((n) => [n.id, n]));
    for (const e of bridges) {
      expect(ids.get(e.a)!.elevation).toBeGreaterThanOrEqual(8);
      expect(ids.get(e.b)!.elevation).toBeGreaterThanOrEqual(8);
    }
  });

  it('builds an unconnected stub on an empty map', () => {
    const empty: RoadNetwork = { nodes: [], edges: [] };
    const r = addOutsideConnection(empty, t, 'road', [0, 7300]);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeTruthy();
    expectClean(r.net);
    expect(r.net.edges.length).toBeGreaterThanOrEqual(2);
    expect(r.net.nodes.filter((n) => n.outside)).toHaveLength(1);
    expect(r.net.nodes.find((n) => n.outside)!.p[1]).toBe(7168);
    const rail = addOutsideConnection(base, t, 'rail', [-7168, 3000]);
    expectClean(rail.net);
  });

  it('refuses a point in open sea', () => {
    const sea = terrain({ water: (x) => x > 5000 });
    const r = addOutsideConnection({ nodes: [], edges: [] }, sea, 'road', [7168, 0]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/water/);
    expect(r.net.edges.length).toBe(0);
  });

  it('chains connectors, keeps their distance and snaps away from corners', () => {
    const a = addOutsideConnection(base, t, 'road', [7168, 1000]);
    expect(a.ok).toBe(true);
    const tooClose = addOutsideConnection(a.net, t, 'road', [7168, 1250]);
    expect(tooClose.ok).toBe(false);
    expect(tooClose.net).toBe(a.net);
    const b = addOutsideConnection(a.net, t, 'road', [7168, -1500]);
    expect(b.ok).toBe(true);
    expectClean(b.net);
    expect(b.net.nodes.filter((n) => n.outside).length).toBe(a.net.nodes.filter((n) => n.outside).length + 1);
    const ids = new Set(b.net.edges.map((e) => e.id));
    expect(ids.size).toBe(b.net.edges.length);
    const corner = addOutsideConnection(base, t, 'road', [7168, 7168]);
    const o = corner.net.nodes.find((n) => n.outside && n.p[0] === 7168 && n.p[1] > 6000);
    expect(o?.p[1]).toBe(7168 - 300);
  });
});
