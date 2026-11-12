import type { BuildResult, HeightGrid, Pt, RoadClass, RoadEdge, RoadNetwork, RoadNode, TerrainResult } from '../types';
import { DEFAULT_SETTINGS } from '../types';

/**
 * Small synthetic terrain for tests. Layout (game metres, row 0 = top):
 *  - flat land around 30 m, a gentle ripple so values are not tied
 *  - a mountain in the north-east (centre 4500, 4000)
 *  - a coast along the south (gz < -6000 is sea)
 *  - a lake at (-2500, -500), radius 600
 *  - a river entering from the top border at gx = -3000 and running down to the lake
 */
export interface SynthOptions {
  size?: number;
  mountain?: boolean;
  lake?: boolean;
  river?: boolean;
  sea?: boolean;
  /** extra height multiplier on everything above 30 (steepness) */
  relief?: number;
}

export const SYNTH = {
  ext: 14336,
  lakeCentre: [-2500, -500] as Pt,
  lakeRadius: 600,
  riverX: -3000,
  base: 30,
  lakeBed: 24,
  riverBed: 27,
  rim: 30.4,
  seaLevel: 10,
};

export function makeSynthTerrain(opts: SynthOptions = {}): TerrainResult {
  const n = opts.size ?? 128;
  const ext = SYNTH.ext;
  const cell = ext / n;
  const relief = opts.relief ?? 1;
  const data = new Float32Array(n * n);
  const mask = new Uint8Array(n * n);
  const gx = (c: number) => -ext / 2 + (c + 0.5) * cell;
  const gz = (r: number) => ext / 2 - (r + 0.5) * cell;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = gx(c), z = gz(r);
      const i = r * n + c;
      let h = SYNTH.base + 0.5 * Math.sin(x / 700) * Math.cos(z / 900);
      if (opts.mountain !== false) {
        const d2 = (x - 4500) ** 2 + (z - 4000) ** 2;
        h += 900 * relief * Math.exp(-d2 / (2 * 1500 * 1500));
      }
      if (opts.sea !== false && z < -6000) {
        h = 2;
        mask[i] = 1;
      }
      if (opts.lake !== false) {
        const d = Math.hypot(x - SYNTH.lakeCentre[0], z - SYNTH.lakeCentre[1]);
        if (d <= SYNTH.lakeRadius) { h = SYNTH.lakeBed + 3 * (d / SYNTH.lakeRadius); mask[i] = 2; }
        else if (d <= SYNTH.lakeRadius + 1.5 * cell) h = Math.max(h, SYNTH.rim);
      }
      if (opts.river !== false && Math.abs(x - SYNTH.riverX) <= cell * 0.9 && z > SYNTH.lakeCentre[1] + SYNTH.lakeRadius * 0.5) {
        if (mask[i] === 0) {
          const t = (z - SYNTH.lakeCentre[1]) / (ext / 2 - SYNTH.lakeCentre[1]);
          h = SYNTH.riverBed + 2 * t;
          mask[i] = 3;
        }
      }
      data[i] = h;
    }
  }
  const world: HeightGrid = { size: n, extentM: 57344, data: new Float32Array(n * n).fill(SYNTH.seaLevel) };
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) { if (data[i] < min) min = data[i]; if (data[i] > max) max = data[i]; }
  return {
    playable: { size: n, extentM: ext, data },
    world,
    scale: { horizontal: 1, vertical: 1 },
    seaLevel: SYNTH.seaLevel,
    heightScale: 4096,
    waterMask: mask,
    baseElevation: 0,
    hasSea: opts.sea !== false,
    minHeight: min,
    maxHeight: max,
  };
}

/** A straight road (as one-edge-per-segment chain) through the given points. First node can be on the border. */
export function makeSynthRoads(pts: Pt[], cls: RoadClass = 'primary', segLen = 150): RoadNetwork {
  const nodes: RoadNode[] = [];
  const edges: RoadEdge[] = [];
  const ext = SYNTH.ext;
  const all: Pt[] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const [a, b] = [pts[k], pts[k + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.round(len / segLen));
    for (let s = 0; s < steps; s++) all.push([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]);
  }
  all.push(pts[pts.length - 1]);
  all.forEach((p, i) => {
    nodes.push({ id: i, p, ground: SYNTH.base, elevation: 0, outside: Math.abs(p[0]) >= ext / 2 - 0.01 || Math.abs(p[1]) >= ext / 2 - 0.01 });
  });
  for (let i = 0; i + 1 < all.length; i++) {
    const a = all[i], b = all[i + 1];
    const c1: Pt = [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3];
    const c2: Pt = [a[0] + ((b[0] - a[0]) * 2) / 3, a[1] + ((b[1] - a[1]) * 2) / 3];
    edges.push({
      id: i, a: i, b: i + 1, cls, prefab: cls === 'rail' ? 'rail_double' : 'road_medium_4lane',
      pts: [a, b], bezier: [a, c1, c2, b], oneway: false, bridge: false, tunnel: false,
    });
  }
  return { nodes, edges };
}

export function makeSynthResult(terrain: TerrainResult, quality: 'draft' | 'full' = 'full'): BuildResult {
  return {
    selection: { centerLat: 59.8, centerLon: 17.6, sizeMeters: 14336, rotationDeg: 0 },
    settings: { ...DEFAULT_SETTINGS, quality },
    terrain,
    waterSources: [],
  };
}
