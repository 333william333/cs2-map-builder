import { describe, expect, it } from 'vitest';
import type { Pt, RawWay, RoadNetwork } from '../types';
import { buildRoads, validateNetwork } from './buildRoads';
import { line, rng, settings, terrain, vectors, way } from './testutil';
import { angleBetween, bezEndDir, bezLength, bezStartDir } from './geom';

function clean(net: RoadNetwork) {
  const v = validateNetwork(net);
  if (v.length) console.log(v.slice(0, 15).join('\n'));
  expect(v).toEqual([]);
}

function degree(net: RoadNetwork): Int32Array {
  const d = new Int32Array(net.nodes.length);
  for (const e of net.edges) {
    d[e.a]++;
    d[e.b]++;
  }
  return d;
}

function nearestNode(net: RoadNetwork, x: number, z: number) {
  let best = -1;
  let bd = Infinity;
  net.nodes.forEach((n, i) => {
    const d = Math.hypot(n.p[0] - x, n.p[1] - z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return { i: best, d: bd };
}

/** connected components (node index -> component) */
function components(net: RoadNetwork): Int32Array {
  const parent = new Int32Array(net.nodes.length).map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const e of net.edges) parent[find(e.a)] = find(e.b);
  return parent.map((_, i) => find(i));
}

describe('validateNetwork', () => {
  it('reports short edges, close nodes and crossings without junction', () => {
    const net: RoadNetwork = {
      nodes: [
        { id: 0, p: [0, 0], ground: 0, elevation: 0, outside: false },
        { id: 1, p: [10, 0], ground: 0, elevation: 0, outside: false },
        { id: 2, p: [5, -50], ground: 0, elevation: 0, outside: false },
        { id: 3, p: [5, 50], ground: 0, elevation: 0, outside: false },
      ],
      edges: [
        { id: 0, a: 0, b: 1, cls: 'residential', prefab: 'road_small_2lane', pts: [[0, 0], [10, 0]], bezier: [[0, 0], [3, 0], [7, 0], [10, 0]], oneway: false, bridge: false, tunnel: false },
        { id: 1, a: 2, b: 3, cls: 'residential', prefab: 'road_small_2lane', pts: line(5, -50, 5, 50, 10), bezier: [[5, -50], [5, -17], [5, 17], [5, 50]], oneway: false, bridge: false, tunnel: false },
      ],
    };
    const v = validateNetwork(net).join('\n');
    expect(v).toMatch(/length/);
    expect(v).toMatch(/apart without a junction/);
    expect(v).toMatch(/nodes 0 and 1/);
  });
});

describe('buildRoads', () => {
  it('returns nothing when disabled', () => {
    const net = buildRoads(vectors([way('primary', line(0, 0, 1000, 0))]), terrain(), settings({ enabled: false }));
    expect(net.edges.length).toBe(0);
  });

  it('grid city: legal graph with real intersections', () => {
    const ways: RawWay[] = [];
    for (let i = -5; i <= 5; i++) {
      ways.push(way('residential', line(-600, i * 110, 600, i * 110, 40), { name: `Street ${i}` }));
      ways.push(way('residential', line(i * 110, -600, i * 110, 600, 40)));
    }
    ways.push(way('primary', line(-2000, 55, 2000, 55, 100)));
    const net = buildRoads(vectors(ways), terrain(), settings({ detail: 1 }));
    clean(net);
    const deg = degree(net);
    const junctions = [...deg].filter((d) => d >= 3).length;
    expect(junctions).toBeGreaterThan(80);
    expect(net.edges[0].cls).toBe('primary');
    expect(net.edges.some((e) => e.name?.startsWith('Street'))).toBe(true);
    const noNames = buildRoads(vectors(ways), terrain(), settings({ detail: 1, names: false }));
    expect(noNames.edges.every((e) => e.name === undefined)).toBe(true);
  });

  it('crossing without a shared OSM node gets an intersection', () => {
    const a = way('secondary', [[-800, -13], [800, 17]]);
    const b = way('tertiary', [[7, -700], [-9, 900]]);
    const net = buildRoads(vectors([a, b]), terrain(), settings());
    clean(net);
    const { i, d } = nearestNode(net, 0, 0);
    expect(d).toBeLessThan(5);
    expect(degree(net)[i]).toBe(4);
  });

  it('carries a road over a river in the water mask as a bridge', () => {
    const river = (x: number) => Math.abs(x - 300) < 70;
    const t = terrain({ water: (x) => river(x), height: (x) => (river(x) ? 90 : 100) });
    const road = way('primary', line(-1500, 0, 2000, 0, 50));
    const bank = way('residential', line(380, -800, 380, 800, 50));
    const net = buildRoads(vectors([road, bank]), t, settings());
    clean(net);
    const bridges = net.edges.filter((e) => e.bridge);
    expect(bridges.length).toBeGreaterThan(0);
    const spans = bridges.some((e) => Math.min(e.pts[0][0], e.pts[e.pts.length - 1][0]) < 300 && Math.max(e.pts[0][0], e.pts[e.pts.length - 1][0]) > 300);
    expect(spans).toBe(true);
    for (const e of bridges) {
      expect(net.nodes[e.a].elevation).toBeGreaterThanOrEqual(8);
      expect(net.nodes[e.b].elevation).toBeGreaterThanOrEqual(8);
    }
    // ramps come down to the ground away from the river
    const far = nearestNode(net, -1200, 0);
    expect(net.nodes[far.i].elevation).toBe(0);
  });

  it('grade-separated crossing gets no intersection node', () => {
    const over = way('primary', line(-150, 0, 150, 0, 30), { bridge: true, layer: 1 });
    const left = way('primary', line(-1500, 0, -150, 0, 50));
    const right = way('primary', line(150, 0, 1500, 0, 50));
    const under = way('secondary', line(0, -1500, 0, 1500, 50));
    const net = buildRoads(vectors([over, left, right, under]), terrain(), settings());
    clean(net);
    const classesAt = net.nodes.map(() => new Set<string>());
    for (const e of net.edges) {
      classesAt[e.a].add(e.cls);
      classesAt[e.b].add(e.cls);
    }
    expect(classesAt.some((s) => s.has('primary') && s.has('secondary'))).toBe(false);
    expect(net.edges.some((e) => e.bridge)).toBe(true);
    // the secondary stays continuous under the bridge
    const comp = components(net);
    expect(comp[nearestNode(net, 0, -1500).i]).toBe(comp[nearestNode(net, 0, 1500).i]);
  });

  const dual = (scale: number) => {
    // a divided road 25 real metres between carriageways, 4 km real long
    const sep = 25 * scale;
    const half = 2000 * scale;
    const north = way('primary', line(-half, sep / 2, half, sep / 2, 60 * scale), { oneway: true });
    const south = way('primary', line(half, -sep / 2, -half, -sep / 2, 60 * scale), { oneway: true });
    const cross = way('secondary', line(0, -800 * scale, 0, 800 * scale, 60 * scale));
    return buildRoads(vectors([north, south, cross]), terrain({ scale }), settings());
  };

  it('merges a dual carriageway at scale 0.3', () => {
    const net = dual(0.3);
    clean(net);
    const prim = net.edges.filter((e) => e.cls === 'primary');
    expect(prim.length).toBeGreaterThan(0);
    expect(prim.every((e) => !e.oneway)).toBe(true);
    // one line only: no two primary edges overlap in x at different z
    const zs = new Set(prim.map((e) => Math.round(e.pts[Math.floor(e.pts.length / 2)][1] / 5)));
    expect(zs.size).toBe(1);
  });

  it('keeps the carriageways separate at scale 2', () => {
    const net = dual(2);
    clean(net);
    const prim = net.edges.filter((e) => e.cls === 'primary');
    expect(prim.filter((e) => e.oneway).length).toBeGreaterThan(4);
    const zSigns = new Set(prim.map((e) => Math.sign(e.pts[1][1])));
    expect(zSigns.size).toBe(2);
  });

  const ring = (r: number, cx = 0, cz = 0): Pt[] => {
    const pts: Pt[] = [];
    const n = 48;
    for (let i = 0; i <= n; i++) {
      const a = (-2 * Math.PI * i) / n; // clockwise
      pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
    }
    pts[n] = pts[0];
    return pts;
  };
  const roundaboutScene = (r: number) => {
    const rp = ring(r);
    const ways: RawWay[] = [way('tertiary', rp, { roundabout: true, oneway: true })];
    // arms attach at ring vertices 0, 12, 24, 36
    for (const k of [0, 12, 24, 36]) {
      const p = rp[k];
      const d = Math.hypot(p[0], p[1]);
      const ux = p[0] / d;
      const uz = p[1] / d;
      ways.push(way('tertiary', [p, [p[0] + ux * 300, p[1] + uz * 300], [p[0] + ux * 900, p[1] + uz * 900]]));
    }
    return buildRoads(vectors(ways), terrain(), settings());
  };

  it('keeps a large roundabout as a ring of one-way segments', () => {
    const net = roundaboutScene(45);
    clean(net);
    const ringEdges = net.edges.filter((e) => e.oneway && e.cls === 'tertiary');
    expect(ringEdges.length).toBeGreaterThanOrEqual(4);
    const deg = degree(net);
    expect([...deg].filter((d) => d === 3).length).toBe(4);
  });

  it('collapses a small roundabout into one intersection', () => {
    const net = roundaboutScene(12);
    clean(net);
    expect(net.edges.some((e) => e.oneway)).toBe(false);
    const { i, d } = nearestNode(net, 0, 0);
    expect(d).toBeLessThan(15);
    expect(degree(net)[i]).toBe(4);
  });

  it('clips to the border with exact outside nodes and caps connections', () => {
    const ways: RawWay[] = [way('motorway', line(-9000, 100, 9000, 300, 200), { lanes: 2 })];
    for (let i = 0; i < 14; i++) {
      const x = -6500 + i * 1000;
      ways.push(way('primary', line(x, -8000, x + 50, 8000, 150)));
    }
    ways.push(way('residential', line(2000, 6000, 2100, 7600, 40)));
    ways.push(way('rail', line(-7600, -3000, 7600, -2800, 200)));
    const net = buildRoads(vectors(ways), terrain(), settings({ detail: 1 }));
    clean(net);
    const outs = net.nodes.filter((n) => n.outside);
    for (const n of outs) expect(Math.abs(n.p[0]) === 7168 || Math.abs(n.p[1]) === 7168).toBe(true);
    const deg = degree(net);
    const outEdges = net.edges.filter((e) => net.nodes[e.a].outside || net.nodes[e.b].outside);
    const roadOut = outEdges.filter((e) => e.cls !== 'rail').length;
    const railOut = outEdges.filter((e) => e.cls === 'rail').length;
    expect(roadOut).toBe(8);
    expect(railOut).toBe(2);
    // motorway gets both ends
    expect(outEdges.filter((e) => e.cls === 'motorway').length).toBe(2);
    // every other end stays inside
    net.nodes.forEach((n, i) => {
      if (n.outside || deg[i] !== 1) return;
      expect(7168 - Math.max(Math.abs(n.p[0]), Math.abs(n.p[1]))).toBeGreaterThanOrEqual(40);
    });
  });

  it('thinning at low detail keeps the through route', () => {
    const ways: RawWay[] = [];
    // a long through street and dense parallel side streets 30 m apart
    ways.push(way('residential', line(-1200, 0, 1200, 0, 30), { name: 'Storgatan' }));
    for (let i = 1; i <= 12; i++) {
      ways.push(way('residential', line(-300, i * 30, 300, i * 30, 30)));
      ways.push(way('residential', line(-300, -i * 30, 300, -i * 30, 30)));
    }
    ways.push(way('residential', line(-300, -360, -300, 360, 30)));
    ways.push(way('residential', line(300, -360, 300, 360, 30)));
    const net = buildRoads(vectors(ways), terrain(), settings({ detail: 0.6 }));
    clean(net);
    const comp = components(net);
    const w = nearestNode(net, -1200, 0);
    const e = nearestNode(net, 1200, 0);
    expect(w.d).toBeLessThan(60);
    expect(e.d).toBeLessThan(60);
    expect(comp[w.i]).toBe(comp[e.i]);
    // the side streets were thinned
    const sideZ = new Set(net.edges.filter((x) => Math.abs(x.pts[0][1] - x.pts[x.pts.length - 1][1]) < 1 && Math.abs(x.pts[0][1]) > 10).map((x) => Math.round(x.pts[0][1])));
    expect(sideZ.size).toBeLessThan(12);
  });

  it('wiggly rural road becomes smooth Beziers within length limits', () => {
    const r = rng(7);
    const pts: Pt[] = [];
    for (let x = -3000; x <= 3000; x += 12) {
      pts.push([x, 60 * Math.sin(x / 260) + 25 * Math.sin(x / 90) + (r() - 0.5) * 3]);
    }
    const net = buildRoads(vectors([way('secondary', pts)]), terrain(), settings());
    clean(net);
    expect(net.edges.length).toBeGreaterThan(30);
    for (const e of net.edges) {
      const L = bezLength(e.bezier);
      expect(L).toBeGreaterThanOrEqual(24);
      expect(L).toBeLessThanOrEqual(200);
    }
    // tangent continuity at joints
    const deg = degree(net);
    let worst = 0;
    net.nodes.forEach((n, i) => {
      if (deg[i] !== 2) return;
      const inc = net.edges.filter((e) => e.a === i || e.b === i);
      const d0 = inc[0].b === i ? bezEndDir(inc[0].bezier) : bezStartDir(inc[0].bezier);
      const d1 = inc[1].a === i ? bezStartDir(inc[1].bezier) : bezEndDir(inc[1].bezier);
      const flip = (inc[0].b === i) === (inc[1].a === i) ? 1 : -1;
      worst = Math.max(worst, angleBetween(d0, [d1[0] * flip, d1[1] * flip]));
    });
    expect((worst * 180) / Math.PI).toBeLessThan(8);
  });

  it('merges parallel rail tracks into a double track', () => {
    const t1 = way('rail', line(-3000, 0, 3000, 40, 100));
    const t2 = way('rail', line(-3000, 4.5, 3000, 44.5, 100));
    const net = buildRoads(vectors([t1, t2]), terrain(), settings());
    clean(net);
    expect(net.edges.length).toBeGreaterThan(0);
    expect(net.edges.every((e) => e.prefab === 'rail_double')).toBe(true);
  });

  it('handles vector-tile style split ways with near-identical joints and no lanes', () => {
    const ways: RawWay[] = [];
    for (let i = 0; i < 10; i++) {
      const x0 = -2000 + i * 400;
      ways.push(way('primary', line(x0 + (i ? 0.3 : 0), 0.2 * (i % 2), x0 + 400, 0, 25)));
    }
    ways.push(way('tertiary', line(-500, -900, -500, 900, 25)));
    const net = buildRoads(vectors(ways), terrain(), settings());
    clean(net);
    const comp = components(net);
    const a = nearestNode(net, -2000, 0);
    const b = nearestNode(net, 2000, 0);
    expect(comp[a.i]).toBe(comp[b.i]);
  });
});
