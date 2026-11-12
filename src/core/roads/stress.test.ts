import { describe, expect, it } from 'vitest';
import type { Pt, RawWay, RoadClass } from '../types';
import { buildRoads, lastBuildRoadsStats, validateNetwork } from './buildRoads';
import { rng, settings, terrain, vectors, way } from './testutil';

const CLASSES: RoadClass[] = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'residential', 'residential',
  'service', 'pedestrian', 'rail', 'tram', 'subway',
];

function randomWays(seed: number, n: number, extent: number): RawWay[] {
  const r = rng(seed);
  const ways: RawWay[] = [];
  for (let i = 0; i < n; i++) {
    const cls = CLASSES[Math.floor(r() * CLASSES.length)];
    let x = (r() * 2 - 1) * extent;
    let z = (r() * 2 - 1) * extent;
    let h = r() * Math.PI * 2;
    const pts: Pt[] = [[x, z]];
    const segs = 2 + Math.floor(r() * 30);
    const step = 5 + r() * 60;
    for (let k = 0; k < segs; k++) {
      h += (r() - 0.5) * (cls === 'motorway' || cls === 'rail' ? 0.15 : 0.8);
      x += Math.cos(h) * step;
      z += Math.sin(h) * step;
      pts.push([x, z]);
    }
    const roll = r();
    ways.push(way(cls, pts, {
      oneway: roll < 0.2 || cls === 'motorway',
      bridge: roll > 0.92,
      tunnel: roll > 0.88 && roll <= 0.92,
      layer: roll > 0.92 ? 1 : roll > 0.88 ? -1 : 0,
      lanes: r() < 0.3 ? 1 + Math.floor(r() * 4) : undefined,
      link: r() < 0.05,
    }));
  }
  // snap some endpoints together to create shared vertices
  for (let i = 0; i + 1 < ways.length; i += 3) {
    const a = ways[i].pts;
    const b = ways[i + 1].pts;
    if (Math.hypot(a[a.length - 1][0] - b[0][0], a[a.length - 1][1] - b[0][1]) < 400) b[0] = a[a.length - 1];
  }
  return ways;
}

describe('randomised stress', () => {
  for (const [seed, scale, detail] of [[1, 1, 1], [2, 0.3, 0.7], [3, 3, 0.4], [4, 0.08, 0.2]] as const) {
    it(`seed ${seed}: 3000 random ways at scale ${scale}, detail ${detail} validate clean`, () => {
      const ways = randomWays(seed, 3000, 7600);
      const t = terrain({
        scale,
        height: (x, z) => 100 + 30 * Math.sin(x / 900) + 20 * Math.cos(z / 700),
        water: (x, z) => Math.abs(x - 1500 - 300 * Math.sin(z / 800)) < 60 || Math.hypot(x + 3000, z - 2000) < 400,
      });
      const t0 = Date.now();
      const net = buildRoads(vectors(ways), t, settings({ detail }));
      const ms = Date.now() - t0;
      const v = validateNetwork(net);
      if (v.length) console.log(v.slice(0, 20).join('\n'));
      console.log(`seed ${seed}: ${net.nodes.length} nodes, ${net.edges.length} edges, ${ms} ms`, JSON.stringify(lastBuildRoadsStats()));
      expect(v).toEqual([]);
      expect(net.edges.length).toBeGreaterThan(50);
      expect(ms).toBeLessThan(20000);
    }, 60000);
  }

  it('dense 1:1 city grid (~12k ways) runs in bounded time', () => {
    const ways: RawWay[] = [];
    const r = rng(9);
    // 2 x 2 km blocks of 70 m streets, each street cut into block-length ways
    for (let gx = -3; gx < 3; gx++) {
      for (let gz = -3; gz < 3; gz++) {
        const ox = gx * 2000;
        const oz = gz * 2000;
        for (let i = 0; i <= 28; i++) {
          for (let j = 0; j < 28; j++) {
            const jit = () => (r() - 0.5) * 2;
            ways.push(way('residential', [[ox + j * 70, oz + i * 70 + jit()], [ox + j * 70 + 35, oz + i * 70 + jit()], [ox + (j + 1) * 70, oz + i * 70]]));
            ways.push(way('residential', [[ox + i * 70 + jit(), oz + j * 70], [ox + i * 70 + jit(), oz + j * 70 + 35], [ox + i * 70, oz + (j + 1) * 70]]));
          }
        }
      }
    }
    for (let k = -3; k <= 3; k++) ways.push(way('primary', [[-7500, k * 2000 + 10], [7500, k * 2000 + 10]]));
    const t0 = Date.now();
    const net = buildRoads(vectors(ways), terrain(), settings({ detail: 1 }));
    const ms = Date.now() - t0;
    console.log(`city: ${ways.length} ways -> ${net.nodes.length} nodes, ${net.edges.length} edges, ${ms} ms`, JSON.stringify(lastBuildRoadsStats()));
    const v = validateNetwork(net);
    if (v.length) console.log(v.slice(0, 20).join('\n'));
    expect(v).toEqual([]);
    expect(ms).toBeLessThan(30000);
  }, 120000);
});
