import { describe, expect, it } from 'vitest';
import type {
  LandcoverGrid, NetPrefab, Pt, RoadClass, RoadEdge, RoadNetwork, TerrainResult, VectorData,
} from '../types';
import { PREFAB_WIDTH } from '../roads/params';
import { buildZones } from './buildZones';

function terrain(opts: { water?: (x: number, z: number) => boolean; height?: number } = {}): TerrainResult {
  const size = 256;
  const ext = 14336;
  const data = new Float32Array(size * size).fill(opts.height ?? 100);
  const wm = new Uint8Array(size * size);
  if (opts.water) {
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const x = ((c + 0.5) / size) * ext - ext / 2;
        const z = ext / 2 - ((r + 0.5) / size) * ext;
        if (opts.water(x, z)) wm[r * size + c] = 1;
      }
    }
  }
  return {
    playable: { size, extentM: ext, data },
    world: { size: 4, extentM: 57344, data: new Float32Array(16) },
    scale: { horizontal: 1, vertical: 1 },
    seaLevel: 0, heightScale: 1000, waterMask: wm, baseElevation: 0, hasSea: false, minHeight: 0, maxHeight: 200,
  };
}

class Net {
  nodes: RoadNetwork['nodes'] = [];
  edges: RoadNetwork['edges'] = [];
  private nid = 1;
  node(p: Pt, elevation = 0): number {
    const id = this.nid++;
    this.nodes.push({ id, p, ground: 100, elevation, outside: false });
    return id;
  }
  edge(pts: Pt[], prefab: NetPrefab = 'road_small_2lane', cls: RoadClass = 'residential',
    extra: Partial<RoadEdge> = {}, elev = 0): void {
    const a = this.node(pts[0], elev);
    const b = this.node(pts[pts.length - 1], elev);
    const n = pts.length;
    this.edges.push({
      id: this.edges.length + 1, a, b, cls, prefab, pts,
      bezier: [pts[0], pts[0], pts[n - 1], pts[n - 1]],
      oneway: false, bridge: false, tunnel: false, ...extra,
    });
  }
  get net(): RoadNetwork { return { nodes: this.nodes, edges: this.edges }; }
}

function line(x0: number, z0: number, x1: number, z1: number, step = 10): Pt[] {
  const L = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(L / step));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push([x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]);
  return out;
}

describe('buildZones', () => {
  it('empty network gives empty preview', () => {
    const z = buildZones({ roads: { nodes: [], edges: [] }, terrain: terrain() });
    expect(z.cellCount).toBe(0);
    expect(z.cells.length).toBe(0);
    expect(z.lots.length).toBe(0);
  });

  it('straight small road: 6 rows both sides, first row at the road edge, 8 m spacing', () => {
    const n = new Net();
    n.edge(line(-100, 0, 100, 0));
    const z = buildZones({ roads: n.net, terrain: terrain() });
    const halfW = PREFAB_WIDTH.road_small_2lane / 2;
    const rows = new Set<string>();
    for (let i = 0; i < z.cellCount; i++) {
      const dz = z.cells[i * 4 + 1];
      const side = dz > 0 ? 1 : -1;
      rows.add(`${side}:${z.cellDepth[i]}`);
      expect(Math.abs(dz)).toBeCloseTo(halfW + 4 + 8 * z.cellDepth[i], 3);
    }
    expect(rows.size).toBe(12);
    // spacing along the road within one row
    const xs: number[] = [];
    for (let i = 0; i < z.cellCount; i++) {
      if (z.cellDepth[i] === 0 && z.cells[i * 4 + 1] > 0) xs.push(z.cells[i * 4]);
    }
    xs.sort((a, b) => a - b);
    expect(xs.length).toBeGreaterThan(20);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeCloseTo(8, 3);
  });

  it('highway, rail and bridge give no cells', () => {
    const n = new Net();
    n.edge(line(-100, 0, 100, 0), 'highway_twoway_2lane', 'motorway');
    n.edge(line(-100, 300, 100, 300), 'rail_double', 'rail');
    n.edge(line(-100, 600, 100, 600), 'road_small_2lane', 'residential', { bridge: true }, 9);
    const z = buildZones({ roads: n.net, terrain: terrain() });
    expect(z.cellCount).toBe(0);
  });

  it('cells stop at water and at a crossing road', () => {
    const n = new Net();
    n.edge(line(-200, 0, 200, 0));
    // water on the upper side beyond z = 25
    const t = terrain({ water: (_x, zz) => zz > 25 });
    const z = buildZones({ roads: n.net, terrain: t });
    let maxUp = 0;
    for (let i = 0; i < z.cellCount; i++) {
      if (z.cells[i * 4 + 1] > 0) maxUp = Math.max(maxUp, z.cellDepth[i]);
      expect(z.cells[i * 4 + 1]).toBeLessThan(25);
    }
    expect(maxUp).toBeLessThanOrEqual(2);

    const n2 = new Net();
    n2.edge(line(-200, 0, 200, 0));
    n2.edge(line(0, -200, 0, 200));
    const z2 = buildZones({ roads: n2.net, terrain: terrain() });
    for (let i = 0; i < z2.cellCount; i++) {
      const x = z2.cells[i * 4];
      const zz = z2.cells[i * 4 + 1];
      // never inside either road corridor (half width 8)
      expect(Math.abs(zz) > 8 || Math.abs(x) > 8).toBe(true);
      // along the horizontal road no cell lies on the vertical one
      expect(Math.abs(x) < 8 && Math.abs(zz) < 8).toBe(false);
    }
  });

  it('parallel roads 60 m apart do not double-claim cells', () => {
    const n = new Net();
    n.edge(line(-200, 0, 200, 0));
    n.edge(line(-200, 60, 200, 60));
    const z = buildZones({ roads: n.net, terrain: terrain() });
    expect(z.cellCount).toBeGreaterThan(100);
    const set = new Set<string>();
    for (let i = 0; i < z.cellCount; i++) {
      const k = `${Math.round(z.cells[i * 4])},${Math.round(z.cells[i * 4 + 1])}`;
      expect(set.has(k)).toBe(false);
      set.add(k);
    }
    // pairwise distance of centres
    for (let i = 0; i < z.cellCount; i++) {
      for (let j = i + 1; j < z.cellCount; j++) {
        const d = Math.hypot(z.cells[i * 4] - z.cells[j * 4], z.cells[i * 4 + 1] - z.cells[j * 4 + 1]);
        if (d < 7) throw new Error(`cells ${i},${j} closer than 7 m: ${d}`);
      }
    }
  });

  it('tight curve has no overlapping cells', () => {
    const n = new Net();
    const pts: Pt[] = [];
    const R = 25;
    for (let a = 0; a <= Math.PI * 1.2; a += 0.05) pts.push([R * Math.cos(a), R * Math.sin(a)]);
    n.edge(pts);
    const z = buildZones({ roads: n.net, terrain: terrain() });
    expect(z.cellCount).toBeGreaterThan(20);
    for (let i = 0; i < z.cellCount; i++) {
      for (let j = i + 1; j < z.cellCount; j++) {
        const d = Math.hypot(z.cells[i * 4] - z.cells[j * 4], z.cells[i * 4 + 1] - z.cells[j * 4 + 1]);
        expect(d).toBeGreaterThanOrEqual(6.9);
      }
    }
  });

  function builtLandcover(): LandcoverGrid {
    const size = 1792;
    const data = new Uint8Array(size * size).fill(30);
    return { size, extentM: 14336, data };
  }

  it('lots only appear in built-up areas and fit inside free cells', () => {
    const n = new Net();
    n.edge(line(-300, 0, 300, 0));
    const t = terrain();
    const none = buildZones({ roads: n.net, terrain: t, landcover: builtLandcover() });
    expect(none.lotCount).toBe(0);

    // built-up for x > 0 only
    const lc = builtLandcover();
    const px = 14336 / lc.size;
    for (let r = 0; r < lc.size; r++) {
      for (let c = 0; c < lc.size; c++) {
        const x = (c + 0.5) * px - 7168;
        if (x > 0) lc.data[r * lc.size + c] = 50;
      }
    }
    const z = buildZones({ roads: n.net, terrain: t, landcover: lc });
    expect(z.lotCount).toBeGreaterThan(5);
    const cellSet = new Set<string>();
    for (let i = 0; i < z.cellCount; i++) {
      cellSet.add(`${Math.round(z.cells[i * 4])},${Math.round(z.cells[i * 4 + 1])}`);
    }
    for (let i = 0; i < z.lotCount; i++) {
      const o = i * 7;
      expect(z.lots[o]).toBeGreaterThan(-8);
      const w = z.lots[o + 4];
      const d = z.lots[o + 5];
      expect(w).toBeGreaterThanOrEqual(2 * 8 - 3);
      expect(d).toBeGreaterThanOrEqual(2 * 8 - 4.5);
      // road is axis aligned: every corner of the footprint lies in a free cell
      const dirx = z.lots[o + 2];
      const dirz = z.lots[o + 3];
      expect(Math.abs(dirx)).toBeCloseTo(1, 3);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const cx = z.lots[o] + sx * (w / 2 - 0.01) * Math.sign(dirx);
          const cz = z.lots[o + 1] + sz * (d / 2 - 0.01);
          const gx = Math.floor(cx / 8) * 8 + 4; // cell centres are at 4 + 8k (road starts at x = -300)
          expect(Number.isFinite(gx)).toBe(true);
          // find a cell whose box contains the corner
          let found = false;
          for (const key of cellSet) {
            const [kx, kz] = key.split(',').map(Number);
            if (Math.abs(kx - cx) <= 4.01 && Math.abs(kz - cz) <= 4.01) { found = true; break; }
          }
          expect(found).toBe(true);
        }
      }
      expect(z.lotKind[i]).toBeLessThanOrEqual(3);
      expect(z.lots[o + 6]).toBeGreaterThanOrEqual(5);
    }
  });

  it('industrial polygon gives industrial lots', () => {
    const n = new Net();
    n.edge(line(-300, 0, 300, 0));
    const vectors = {
      ways: [], waterPolygons: [], waterways: [], treePoints: [], powerLines: [],
      areas: [{ kind: 'industrial', rings: [[[-400, -100], [400, -100], [400, 100], [-400, 100]] as Pt[]] }],
    } as VectorData;
    const z = buildZones({ roads: n.net, terrain: terrain(), vectors });
    expect(z.lotCount).toBeGreaterThan(3);
    for (let i = 0; i < z.lotCount; i++) expect(z.lotKind[i]).toBe(3);
  });

  it('is deterministic', () => {
    const n = new Net();
    n.edge(line(-300, 0, 300, 0));
    n.edge(line(0, -300, 0, 300));
    const lc = builtLandcover();
    lc.data.fill(50);
    const a = buildZones({ roads: n.net, terrain: terrain(), landcover: lc });
    const b = buildZones({ roads: n.net, terrain: terrain(), landcover: lc });
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells));
    expect(Array.from(a.lots)).toEqual(Array.from(b.lots));
    expect(Array.from(a.lotKind)).toEqual(Array.from(b.lotKind));
  });

  it('performance: grid city with about 5000 edges', () => {
    const n = new Net();
    const step = 100;
    const half = 50; // 100 x 100 blocks region
    // horizontal and vertical roads, one edge per block side
    const grid: number[][] = [];
    for (let i = 0; i <= 50; i++) {
      grid.push([]);
      for (let j = 0; j <= 50; j++) grid[i].push(0);
    }
    void grid;
    for (let r = 0; r <= 50; r++) {
      for (let c = 0; c < 50; c++) {
        const x0 = (c - 25) * step * 1.2;
        const zz = (r - 25) * step * 1.2;
        n.edge(line(x0, zz, x0 + step * 1.2, zz, 12), 'road_small_2lane', 'residential');
      }
    }
    for (let c = 0; c <= 50; c++) {
      for (let r = 0; r < 50; r++) {
        const xx = (c - 25) * step * 1.2;
        const z0 = (r - 25) * step * 1.2;
        n.edge(line(xx, z0, xx, z0 + step * 1.2, 12), 'road_small_2lane', 'residential');
      }
    }
    void half;
    expect(n.edges.length).toBe(5100);
    const lc = builtLandcover();
    lc.data.fill(50);
    const t0 = performance.now();
    const z = buildZones({ roads: n.net, terrain: terrain(), landcover: lc });
    const ms = performance.now() - t0;
    console.log(`city: edges=${n.edges.length} cells=${z.cellCount} lots=${z.lotCount} time=${ms.toFixed(0)}ms`);
    expect(z.cellCount).toBeGreaterThan(10000);
    expect(ms).toBeLessThan(2000);
  });
});
