/**
 * Synthetic but plausible BuildResult for the 3D preview and for tests (`?demo=1` loads it).
 * A coast with sea in the west, a lake above sea level, a river feeding it and one leaving it,
 * a snowy mountain in the north-east, a small town, a motorway with a bridge, a railway,
 * a landcover grid and 50 000 trees. Deterministic.
 */
import {
  CS2,
  DEFAULT_SELECTION,
  DEFAULT_SETTINGS,
  LC,
  type BuildResult,
  type ClimateProfile,
  type HeightGrid,
  type NetPrefab,
  type PlayabilityReport,
  type Pt,
  type RoadClass,
  type RoadEdge,
  type RoadNode,
  type TreeSet,
  type TreeSpecies,
  type WaterSource,
} from '../../core/types';
import { buildZones } from '../../core/zoning/buildZones';
import { fbm, mulberry32 } from './noise';

const SEA = 64;
const LAKE = { x: 1200, z: -2000, r: 950, level: 104 };
const RIVER_HW = 45;
const RIVER_IN: Pt[] = [[4900, 7900], [4300, 5200], [3300, 3500], [2600, 1600], [1900, -300], [1500, -1200]];
const RIVER_OUT: Pt[] = [[600, -2500], [-700, -2700], [-1900, -3100], [-3200, -3000], [-4700, -3300], [-6200, -3000]];
const TOWN = { x: -1500, z: 800 };
const SNOW_WARM_C = 5.5;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

interface River {
  pts: Pt[];
  /** water surface height at each path vertex */
  level: number[];
}

function baseLand(x: number, gz: number): number {
  const m = Math.exp(-(((x - 4200) ** 2 + (gz - 3600) ** 2) / (2 * 2300 * 2300)));
  let h = 100
    + (fbm(x / 7500 + 3.1, gz / 7500 - 1.7, 4, 11) - 0.5) * 260
    + (fbm(x / 1800, gz / 1800, 3, 21) - 0.5) * 90
    + (fbm(x / 450 + 7, gz / 450, 2, 31) - 0.5) * 22
    + 1000 * Math.pow(m, 1.15);
  const v = h - (SEA + 10);
  h = SEA + 10 + (v > 0 ? v : v * 0.12);
  const xc = -4700 + 1300 * Math.sin(gz / 2600 + 1) + 1200 * (fbm(gz / 1500, 5, 3, 41) - 0.5);
  const d = x - xc;
  if (d >= 0) {
    const s = smoothstep(0, 1100, d);
    const beach = SEA + 1.2 + d * 0.002;
    return beach + (h - beach) * s;
  }
  return SEA + 1.2 - Math.min(120, -d * 0.012 + Math.max(0, -d - 3000) * 0.03);
}

function makeRiver(pts: Pt[], first: number | null, last: number | null): River {
  const level: number[] = [];
  let cur = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const land = baseLand(pts[i][0], pts[i][1]) - 4;
    cur = Math.min(cur, land);
    level.push(cur);
  }
  if (first !== null) {
    // outflow: starts at the lake
    let c = first;
    for (let i = 0; i < level.length; i++) {
      c = Math.min(c, level[i]);
      level[i] = Math.max(SEA + 0.8, c);
    }
    level[0] = first;
  }
  if (last !== null) {
    // inflow: ends at the lake, never below it
    for (let i = 0; i < level.length; i++) level[i] = Math.max(level[i], last + 0.6);
    level[level.length - 1] = last;
    for (let i = level.length - 2; i >= 0; i--) level[i] = Math.max(level[i], level[i + 1]);
  }
  return { pts, level };
}

interface Terrain {
  /** height at (x, gz) game metres; `wl` holds the water surface at that point afterwards */
  sample(x: number, gz: number): number;
  wl: number;
  river: (x: number, gz: number) => number;
  lakeDist: (x: number, gz: number) => number;
}

function createTerrain(): Terrain {
  const inflow = makeRiver(RIVER_IN, null, LAKE.level);
  const outflow = makeRiver(RIVER_OUT, LAKE.level - 0.5, null);
  const rivers = [inflow, outflow];
  let qd = 0;
  let ql = 0;

  const riverQuery = (r: River, x: number, gz: number): void => {
    let best = Infinity;
    let lvl = 0;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [x0, z0] = r.pts[i];
      const [x1, z1] = r.pts[i + 1];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const l2 = dx * dx + dz * dz;
      const t = Math.min(1, Math.max(0, ((x - x0) * dx + (gz - z0) * dz) / l2));
      const d = Math.hypot(x - (x0 + dx * t), gz - (z0 + dz * t));
      if (d < best) {
        best = d;
        lvl = r.level[i] + (r.level[i + 1] - r.level[i]) * t;
      }
    }
    qd = best;
    ql = lvl;
  };

  const lakeDist = (x: number, gz: number): number => {
    const nz = fbm((x - LAKE.x) / 700, (gz - LAKE.z) / 700, 2, 51);
    return Math.hypot(x - LAKE.x, gz - LAKE.z) / (LAKE.r * (0.8 + 0.4 * nz));
  };

  const t: Terrain = {
    wl: SEA,
    sample(x, gz) {
      let h = baseLand(x, gz);
      let wl = SEA;
      const dl = lakeDist(x, gz);
      if (dl < 2.6) {
        const k = 1 - smoothstep(1.5, 2.6, dl);
        h = h + (Math.max(h, LAKE.level + 5) - h) * k;
      }
      if (dl < 1) {
        h = LAKE.level - 1 - 14 * (1 - dl * dl);
      } else if (dl < 1.5) {
        h = LAKE.level - 1 + (h - (LAKE.level - 1)) * smoothstep(1, 1.5, dl);
      }
      if (dl < 1.6) wl = Math.max(wl, LAKE.level);
      if (dl > 1.1 && h > SEA - 1) {
        for (const r of rivers) {
          riverQuery(r, x, gz);
          if (qd < RIVER_HW * 3) {
            const bed = ql - 4;
            const bank = Math.max(h, ql + 1.8);
            const s = smoothstep(RIVER_HW * 0.7, RIVER_HW * 2.2, qd);
            h = bed + (bank - bed) * s;
            wl = Math.max(wl, ql);
          }
        }
      }
      t.wl = wl;
      return h;
    },
    river(x, gz) {
      let best = Infinity;
      for (const r of rivers) {
        riverQuery(r, x, gz);
        if (qd < best) best = qd;
      }
      return best;
    },
    lakeDist,
  };
  return t;
}

function makeGrid(size: number, extent: number, t: Terrain, mask?: Uint8Array): HeightGrid {
  const data = new Float32Array(size * size);
  const cell = extent / size;
  for (let r = 0; r < size; r++) {
    const gz = extent / 2 - (r + 0.5) * cell;
    for (let c = 0; c < size; c++) {
      const x = -extent / 2 + (c + 0.5) * cell;
      const h = t.sample(x, gz);
      data[r * size + c] = h;
      if (mask && h < t.wl - 0.2) mask[r * size + c] = 1;
    }
  }
  return { size, extentM: extent, data };
}

interface SampleInfo {
  p: Pt;
  h: number;
  wl: number;
  river: boolean;
  wet: boolean;
}

const PREFAB: Record<string, NetPrefab> = {
  motorway: 'highway_2lane_oneway',
  trunk: 'road_large_6lane',
  primary: 'road_medium_4lane',
  secondary: 'road_medium_4lane',
  tertiary: 'road_small_2lane',
  residential: 'road_small_2lane',
  service: 'road_alley',
  rail: 'rail_double',
};

function makeRoads(t: Terrain): { nodes: RoadNode[]; edges: RoadEdge[] } {
  const nodes: RoadNode[] = [];
  const edges: RoadEdge[] = [];
  const half = CS2.PLAYABLE_SIZE_M / 2;
  const BRIDGE_H = 8.5;

  const addNode = (p: Pt, ground: number, elevation: number): number => {
    const id = nodes.length;
    nodes.push({
      id,
      p,
      ground,
      elevation,
      outside: Math.abs(p[0]) >= half - 40 || Math.abs(p[1]) >= half - 40,
    });
    return id;
  };

  const info = (p: Pt): SampleInfo => {
    const h = t.sample(p[0], p[1]);
    const river = t.river(p[0], p[1]) < RIVER_HW * 1.7;
    const lake = t.lakeDist(p[0], p[1]) < 1.35;
    return { p, h, wl: t.wl, river, wet: !river && (h < SEA + 2.5 || lake) };
  };

  /** Adds a road along dense samples; wet parts are cut away and river crossings become bridges. */
  const addChain = (samples: Pt[], cls: RoadClass, oneway = false): void => {
    const infos = samples.map(info);
    let i = 0;
    while (i < infos.length) {
      if (infos[i].wet || Math.abs(infos[i].p[0]) > half || Math.abs(infos[i].p[1]) > half) { i++; continue; }
      let j = i;
      while (j + 1 < infos.length && !infos[j + 1].wet && Math.abs(infos[j + 1].p[0]) <= half && Math.abs(infos[j + 1].p[1]) <= half) j++;
      if (j - i >= 1) addRun(infos.slice(i, j + 1), cls, oneway);
      i = j + 1;
    }
  };

  const addRun = (run: SampleInfo[], cls: RoadClass, oneway: boolean): void => {
    const m = run.length;
    const elev = new Array<number>(m).fill(0);
    let a = 0;
    while (a < m) {
      if (!run[a].river) { a++; continue; }
      let b = a;
      while (b + 1 < m && run[b + 1].river) b++;
      for (let k = a; k <= b; k++) elev[k] = BRIDGE_H;
      const ramp = 3;
      for (let k = 1; k <= ramp; k++) {
        const f = BRIDGE_H * (ramp + 1 - k) / (ramp + 1);
        if (a - k >= 0) elev[a - k] = Math.max(elev[a - k], f);
        if (b + k < m) elev[b + k] = Math.max(elev[b + k], f);
      }
      a = b + 1;
    }
    const isNode = (k: number): boolean =>
      k === 0 || k === m - 1 || k % 4 === 0 || elev[k] > 0 || (k > 0 && elev[k - 1] > 0) || (k < m - 1 && elev[k + 1] > 0);
    let prev = -1;
    let prevIdx = 0;
    for (let k = 0; k < m; k++) {
      if (!isNode(k)) continue;
      const ground = Math.max(run[k].h, run[k].river ? run[k].wl : run[k].h);
      const id = addNode(run[k].p, ground, elev[k]);
      if (prev >= 0) {
        const pts = run.slice(prevIdx, k + 1).map((s) => s.p);
        let bridge = false;
        for (let q = prevIdx; q <= k; q++) if (elev[q] > 0) bridge = true;
        edges.push({
          id: edges.length, a: prev, b: id, cls, prefab: PREFAB[cls] ?? 'road_small_2lane',
          pts, bezier: chordBezier(pts[0], pts[pts.length - 1]), oneway, bridge, tunnel: false,
        });
      }
      prev = id;
      prevIdx = k;
    }
  };

  const line = (pts: Pt[], step: number): Pt[] => {
    const out: Pt[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1];
      const [x1, z1] = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step));
      for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]);
    }
    return out;
  };

  // motorway across the map
  const mw: Pt[] = [];
  for (let x = -half - 60; x <= half + 60; x += 100) {
    mw.push([x, -300 + 450 * Math.sin(x / 2300) + 200 * Math.sin(x / 900 + 1)]);
  }
  addChain(mw, 'motorway');
  const mwAt = (x: number): Pt => [x, -300 + 450 * Math.sin(x / 2300) + 200 * Math.sin(x / 900 + 1)];

  // railway
  const rail: Pt[] = [];
  for (let x = -half - 60; x <= half + 60; x += 100) rail.push([x, 2300 + 350 * Math.sin(x / 1600)]);
  addChain(rail, 'rail');

  // primary road towards the mountain
  addChain(line([mwAt(-300), [700, 1500], [1500, 3200], [2300, 5000], [3000, half + 60]], 90), 'primary');
  // secondary road from the town to the motorway
  addChain(line([[TOWN.x + 900, TOWN.z], [-500, 100], mwAt(-300)], 80), 'secondary');
  // coastal road
  const coast: Pt[] = [];
  for (let gz = -half - 60; gz <= half + 60; gz += 100) {
    const xc = -4700 + 1300 * Math.sin(gz / 2600 + 1) + 1200 * (fbm(gz / 1500, 5, 3, 41) - 0.5);
    coast.push([xc + 520, gz]);
  }
  addChain(coast, 'tertiary');
  // lake-side service road
  const around: Pt[] = [];
  for (let a = 0; a < Math.PI * 2 + 0.2; a += 0.08) {
    around.push([LAKE.x + Math.cos(a) * LAKE.r * 1.55, LAKE.z + Math.sin(a) * LAKE.r * 1.55]);
  }
  addChain(around, 'service');

  // town street grid
  const NX = 13;
  const NY = 9;
  const SP = 160;
  const gridP: Pt[][] = [];
  for (let j = 0; j < NY; j++) {
    const row: Pt[] = [];
    for (let i = 0; i < NX; i++) {
      const jx = (fbm(i * 3.1, j * 1.7, 2, 71) - 0.5) * 30;
      const jz = (fbm(i * 1.3, j * 2.9, 2, 72) - 0.5) * 30;
      row.push([TOWN.x + (i - 6) * SP + jx, TOWN.z + (j - 4) * SP + jz]);
    }
    gridP.push(row);
  }
  const ok = (p: Pt): boolean => !info(p).wet && !info(p).river;
  const street = (p: Pt, q: Pt, cls: RoadClass): void => {
    if (!ok(p) || !ok(q)) return;
    const hp = t.sample(p[0], p[1]);
    const hq = t.sample(q[0], q[1]);
    const ia = addNode(p, hp, 0);
    const ib = addNode(q, hq, 0);
    edges.push({
      id: edges.length, a: ia, b: ib, cls, prefab: PREFAB[cls], pts: [p, q], bezier: chordBezier(p, q), oneway: false, bridge: false, tunnel: false,
    });
  };
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      if (i + 1 < NX) street(gridP[j][i], gridP[j][i + 1], j === 4 ? 'tertiary' : 'residential');
      if (j + 1 < NY) street(gridP[j][i], gridP[j + 1][i], i === 6 ? 'tertiary' : 'residential');
    }
  }
  return { nodes, edges };
}

function climate(): ClimateProfile {
  return {
    latitude: 68.35,
    longitude: 18.82,
    koppen: 'ET',
    monthlyMeanC: [-12, -11, -8, -3, 1.5, 5, SNOW_WARM_C, 4.5, 1, -4, -8, -11],
    monthlyMinC: [-17, -16, -13, -7, -2, 1.5, 3, 2, -1.5, -7, -12, -16],
    monthlyMaxC: [-7, -6, -3, 2, 6, 10, 12, 10, 5, 0, -4, -7],
    monthlyPrecipMm: [30, 25, 24, 22, 27, 45, 70, 62, 50, 45, 36, 33],
    monthlyCloud: [0.7, 0.65, 0.6, 0.6, 0.6, 0.62, 0.65, 0.68, 0.7, 0.75, 0.75, 0.72],
    theme: 'european',
  };
}

export function makeDemoResult(): BuildResult {
  const t = createTerrain();
  const PS = 512;
  const WS = 256;
  const mask = new Uint8Array(PS * PS);
  const playable = makeGrid(PS, CS2.PLAYABLE_SIZE_M, t, mask);
  const world = makeGrid(WS, CS2.WORLD_SIZE_M, t);
  const h = playable.data;
  let minH = Infinity;
  let maxH = -Infinity;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < minH) minH = h[i];
    if (h[i] > maxH) maxH = h[i];
  }
  for (let i = 0; i < world.data.length; i++) {
    const v = world.data[i];
    if (v < minH) minH = v;
    if (v > maxH) maxH = v;
  }

  // landcover aligned with the playable grid
  const cell = CS2.PLAYABLE_SIZE_M / PS;
  const lcData = new Uint8Array(PS * PS);
  const snowLine = SEA + (SNOW_WARM_C / 6.5) * 1000;
  const forestCells: number[] = [];
  for (let r = 0; r < PS; r++) {
    const gz = CS2.PLAYABLE_SIZE_M / 2 - (r + 0.5) * cell;
    for (let c = 0; c < PS; c++) {
      const x = -CS2.PLAYABLE_SIZE_M / 2 + (c + 0.5) * cell;
      const i = r * PS + c;
      const hh = h[i];
      const gx = (h[r * PS + Math.min(PS - 1, c + 1)] - h[r * PS + Math.max(0, c - 1)]) / (2 * cell);
      const gy = (h[Math.min(PS - 1, r + 1) * PS + c] - h[Math.max(0, r - 1) * PS + c]) / (2 * cell);
      const slope = Math.hypot(gx, gy);
      let lc: number = LC.Grass;
      if (mask[i]) lc = LC.Water;
      else if (hh > snowLine + 30) lc = LC.Snow;
      else if (hh > SEA + 760 || slope > 0.85) lc = LC.Bare;
      else {
        const townD = Math.hypot(x - TOWN.x, gz - TOWN.z) / (950 * (0.8 + 0.4 * fbm(x / 500, gz / 500, 2, 81)));
        const forest = fbm(x / 900, gz / 900, 3, 61);
        const crop = fbm(x / 1300 + 9, gz / 1300, 3, 62);
        if (townD < 1 && slope < 0.3) lc = LC.Built;
        else if (hh < SEA + 120 && crop > 0.56 && slope < 0.15 && hh > SEA + 5) lc = LC.Crop;
        else if (forest > 0.52 && hh < SEA + 700) { lc = LC.Tree; forestCells.push(i); }
        else if (forest > 0.46) lc = LC.Shrub;
      }
      lcData[i] = lc;
    }
  }

  const roads = makeRoads(t);

  // trees: mostly inside forest cells
  const TREES = 50_000;
  const rnd = mulberry32(1234);
  const speciesTable: TreeSpecies[] = ['pine', 'spruce', 'birch', 'oak', 'bush'];
  const xz = new Float32Array(TREES * 2);
  const species = new Uint8Array(TREES);
  const age = new Uint8Array(TREES);
  let count = 0;
  let guard = 0;
  while (count < TREES && guard++ < TREES * 40 && forestCells.length > 0) {
    let i: number;
    if (rnd() < 0.88) {
      i = forestCells[Math.floor(rnd() * forestCells.length)];
    } else {
      i = Math.floor(rnd() * PS * PS);
      const lc = lcData[i];
      if (lc !== LC.Grass && lc !== LC.Shrub) continue;
      if (rnd() > 0.06) continue;
    }
    const r = Math.floor(i / PS);
    const c = i % PS;
    const x = -CS2.PLAYABLE_SIZE_M / 2 + (c + rnd()) * cell;
    const gz = CS2.PLAYABLE_SIZE_M / 2 - (r + rnd()) * cell;
    xz[count * 2] = x;
    xz[count * 2 + 1] = gz;
    const forest = lcData[i] === LC.Tree;
    const q = rnd();
    species[count] = forest ? (q < 0.38 ? 0 : q < 0.7 ? 1 : q < 0.95 ? 2 : 4) : (q < 0.4 ? 2 : q < 0.7 ? 3 : 4);
    const a = rnd();
    age[count] = a < 0.15 ? 0 : a < 0.4 ? 1 : a < 0.8 ? 2 : a < 0.95 ? 3 : 4;
    count++;
  }

  const waterSources: WaterSource[] = [
    { kind: 'lake', p: [LAKE.x, LAKE.z], radius: LAKE.r, level: LAKE.level },
    { kind: 'river', p: [4900, 7168], radius: RIVER_HW, level: 600, rate: 0.5 },
  ];

  let wet = 0;
  for (let i = 0; i < mask.length; i++) wet += mask[i];
  const tiles = CS2.TILE_GRID;
  const tileM = CS2.PLAYABLE_SIZE_M / tiles;
  const playability: PlayabilityReport = {
    buildableFraction: 0.46,
    waterFraction: wet / mask.length,
    checks: [
      { id: 'startTile', status: 'ok', message: 'The start tile is on fairly flat ground.' },
      { id: 'roadsOutside', status: 'ok', message: 'The motorway and the railway reach the map edge.' },
      { id: 'slopes', status: 'warn', message: 'Large parts of the northeast are too steep to build on.' },
    ],
    startTile: {
      col: Math.floor((TOWN.x + CS2.PLAYABLE_SIZE_M / 2) / tileM),
      row: Math.floor((CS2.PLAYABLE_SIZE_M / 2 - TOWN.z) / tileM),
    },
    outsideConnections: [
      { kind: 'road', p: [CS2.PLAYABLE_SIZE_M / 2, 100], synthetic: false },
      { kind: 'rail', p: [CS2.PLAYABLE_SIZE_M / 2, 2300], synthetic: false },
      { kind: 'road', p: [3000, CS2.PLAYABLE_SIZE_M / 2], synthetic: true },
      { kind: 'ship', p: [-CS2.PLAYABLE_SIZE_M / 2, -1500], synthetic: false },
      { kind: 'air', p: [-CS2.PLAYABLE_SIZE_M / 2, 4200], synthetic: false },
      { kind: 'power', p: [800, -CS2.PLAYABLE_SIZE_M / 2], synthetic: false },
      { kind: 'water', p: [CS2.PLAYABLE_SIZE_M / 2, -4200], synthetic: false, manual: true },
    ],
  };

  const trees: TreeSet = { count, xz: xz.slice(0, count * 2), species: species.slice(0, count), age: age.slice(0, count), speciesTable };

  const terrain = {
      playable,
      world,
      scale: { horizontal: 1, vertical: 1 },
      seaLevel: SEA,
      heightScale: CS2.DEFAULT_HEIGHT_SCALE_M,
      waterMask: mask,
      baseElevation: 0,
      hasSea: true,
      minHeight: minH,
      maxHeight: maxH,
  };
  const landcover = { size: PS, extentM: CS2.PLAYABLE_SIZE_M, data: lcData };
  const zones = buildZones({ roads, terrain, landcover });

  return {
    selection: { ...DEFAULT_SELECTION, centerLat: 68.35, centerLon: 18.82 },
    settings: structuredClone(DEFAULT_SETTINGS),
    zones,
    terrain: {
      playable,
      world,
      scale: { horizontal: 1, vertical: 1 },
      seaLevel: SEA,
      heightScale: CS2.DEFAULT_HEIGHT_SCALE_M,
      waterMask: mask,
      baseElevation: 0,
      hasSea: true,
      minHeight: minH,
      maxHeight: maxH,
    },
    landcover: { size: PS, extentM: CS2.PLAYABLE_SIZE_M, data: lcData },
    roads,
    trees,
    waterSources,
    climate: climate(),
    playability,
  };
}

/** straight cubic Bezier between two points (control points at thirds of the chord) */
function chordBezier(a: Pt, b: Pt): [Pt, Pt, Pt, Pt] {
  const dx = (b[0] - a[0]) / 3;
  const dz = (b[1] - a[1]) / 3;
  return [a, [a[0] + dx, a[1] + dz], [b[0] - dx, b[1] - dz], b];
}
