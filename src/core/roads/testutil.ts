/** Synthetic inputs for the road builder tests (no network). */
import type { Pt, RawWay, RoadClass, RoadSettings, TerrainResult, VectorData } from '../types';
import { DEFAULT_SETTINGS } from '../types';

let nextId = 1;

export function way(cls: RoadClass, pts: Pt[], extra: Partial<RawWay> = {}): RawWay {
  return {
    id: nextId++,
    cls,
    pts,
    oneway: false,
    bridge: false,
    tunnel: false,
    layer: 0,
    roundabout: false,
    link: false,
    ...extra,
  };
}

export function vectors(ways: RawWay[]): VectorData {
  return { ways, waterPolygons: [], waterways: [], areas: [], treePoints: [], powerLines: [] };
}

export function terrain(opts: {
  scale?: number;
  size?: number;
  height?: (x: number, z: number) => number;
  water?: (x: number, z: number) => boolean;
} = {}): TerrainResult {
  const size = opts.size ?? 256;
  const ext = 14336;
  const data = new Float32Array(size * size);
  const mask = new Uint8Array(size * size);
  const h = opts.height ?? (() => 100);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const x = -ext / 2 + ((c + 0.5) * ext) / size;
      const z = ext / 2 - ((r + 0.5) * ext) / size;
      data[r * size + c] = h(x, z);
      if (opts.water?.(x, z)) mask[r * size + c] = 3;
    }
  }
  return {
    playable: { size, extentM: ext, data },
    world: { size: 4, extentM: 57344, data: new Float32Array(16).fill(100) },
    scale: { horizontal: opts.scale ?? 1, vertical: 1 },
    seaLevel: 64,
    heightScale: 4096,
    waterMask: mask,
    baseElevation: 0,
    hasSea: false,
    minHeight: 0,
    maxHeight: 1000,
  };
}

export function settings(patch: Partial<RoadSettings> = {}): RoadSettings {
  return {
    ...DEFAULT_SETTINGS.roads,
    classes: { ...DEFAULT_SETTINGS.roads.classes, service: true, pedestrian: true, tram: true, subway: true },
    ...patch,
  };
}

/** deterministic PRNG */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function line(x0: number, z0: number, x1: number, z1: number, step = 50): Pt[] {
  const L = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(L / step));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push([x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]);
  return out;
}
