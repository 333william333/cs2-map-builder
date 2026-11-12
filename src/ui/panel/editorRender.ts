import type { BuildResult, RoadClass } from '../../core/types';
import { LC } from '../../core/types';

/** Background of the hand editor: hillshade + hypsometric tint, water, land cover. Pure, no DOM. */

type Rgb = [number, number, number];

const RAMP: [number, Rgb][] = [
  [0.0, [96, 142, 92]],
  [0.35, [168, 178, 108]],
  [0.6, [182, 158, 120]],
  [0.85, [156, 154, 152]],
  [1.0, [242, 242, 242]],
];

const WATER: Record<number, Rgb> = { 1: [42, 92, 140], 2: [58, 120, 168], 3: [74, 139, 192] };

const COVER: Record<number, Rgb> = {
  [LC.Tree]: [40, 98, 54],
  [LC.Shrub]: [104, 132, 70],
  [LC.Grass]: [128, 168, 90],
  [LC.Crop]: [206, 186, 96],
  [LC.Built]: [176, 160, 164],
  [LC.Bare]: [186, 168, 138],
  [LC.Snow]: [240, 244, 248],
  [LC.Wetland]: [92, 140, 128],
  [LC.Mangrove]: [64, 120, 92],
  [LC.Moss]: [138, 160, 122],
};

function ramp(t: number): Rgb {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i];
    if (x <= t1) {
      const [t0, c0] = RAMP[i - 1];
      const f = (x - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/** How strongly land cover colours the tint (0 = none). */
const COVER_MIX = 0.35;

/**
 * Renders the playable area to `size` x `size` RGBA pixels, row 0 = north. The heights are sampled
 * (nearest) to the target size, so a 4096 grid is cheap to draw.
 */
export function renderBackdrop(result: Pick<BuildResult, 'terrain' | 'landcover'>, size: number): Uint8ClampedArray {
  const { terrain, landcover } = result;
  const g = terrain.playable;
  const n = g.size;
  const out = new Uint8ClampedArray(size * size * 4);
  const h = new Float32Array(size * size);
  const water = new Uint8Array(size * size);
  const hasMask = terrain.waterMask && terrain.waterMask.length === n * n;
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < size; y++) {
    const r = Math.min(n - 1, Math.floor(((y + 0.5) * n) / size));
    for (let x = 0; x < size; x++) {
      const c = Math.min(n - 1, Math.floor(((x + 0.5) * n) / size));
      const i = y * size + x;
      const v = g.data[r * n + c];
      h[i] = v;
      const w = hasMask ? terrain.waterMask[r * n + c] : 0;
      water[i] = w;
      if (w === 0) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (!(hi > lo)) { lo = Number.isFinite(lo) ? lo : 0; hi = lo + 20; }
  const range = Math.max(hi - lo, 20);
  const cellM = g.extentM / size;
  // vertical exaggeration so gentle terrain still shows relief
  const exag = 2.5;
  // light from the north-west, 45 degrees up
  const lx = -0.5, ly = 0.5, lz = 0.7071;
  const lc = landcover && landcover.data.length === landcover.size * landcover.size ? landcover : undefined;

  for (let y = 0; y < size; y++) {
    const ya = Math.max(0, y - 1), yb = Math.min(size - 1, y + 1);
    for (let x = 0; x < size; x++) {
      const xa = Math.max(0, x - 1), xb = Math.min(size - 1, x + 1);
      const i = y * size + x;
      const o = i * 4;
      const dx = ((h[y * size + xb] - h[y * size + xa]) * exag) / ((xb - xa) * cellM);
      const dz = ((h[yb * size + x] - h[ya * size + x]) * exag) / ((yb - ya) * cellM);
      // surface normal (-dx, +dz in z-up north coordinates); row index grows southwards
      const nx = -dx, ny = dz, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const shade = Math.min(1.25, Math.max(0.55, 0.35 + 0.9 * Math.max(0, (nx * lx + ny * ly + nz * lz) * inv)));
      const w = water[i];
      let rgb: Rgb;
      if (w !== 0) {
        rgb = WATER[w] ?? WATER[2];
        const s = 0.92 + 0.08 * shade;
        out[o] = rgb[0] * s; out[o + 1] = rgb[1] * s; out[o + 2] = rgb[2] * s; out[o + 3] = 255;
        continue;
      }
      rgb = ramp((h[i] - lo) / range);
      if (lc) {
        const cr = Math.min(lc.size - 1, Math.floor(((y + 0.5) * lc.size) / size));
        const cc = Math.min(lc.size - 1, Math.floor(((x + 0.5) * lc.size) / size));
        const tint = COVER[lc.data[cr * lc.size + cc]];
        if (tint) rgb = [rgb[0] + (tint[0] - rgb[0]) * COVER_MIX, rgb[1] + (tint[1] - rgb[1]) * COVER_MIX, rgb[2] + (tint[2] - rgb[2]) * COVER_MIX];
      }
      out[o] = rgb[0] * shade; out[o + 1] = rgb[1] * shade; out[o + 2] = rgb[2] * shade; out[o + 3] = 255;
    }
  }
  return out;
}

export interface RoadStyle { color: string; width: number; casing: boolean; dash?: number[] }

export const ROAD_STYLE: Record<RoadClass, RoadStyle> = {
  motorway: { color: '#f2a65a', width: 3, casing: true },
  trunk: { color: '#f2c36b', width: 2.6, casing: true },
  primary: { color: '#f6e08a', width: 2.2, casing: true },
  secondary: { color: '#ffffff', width: 1.8, casing: true },
  tertiary: { color: '#e6edf3', width: 1.4, casing: true },
  residential: { color: '#d3dbe2', width: 1.1, casing: false },
  service: { color: '#b4bec7', width: 0.8, casing: false },
  pedestrian: { color: '#8b98a5', width: 0.6, casing: false },
  rail: { color: '#cbb8ff', width: 1.6, casing: true, dash: [6, 4] },
  tram: { color: '#b29cf0', width: 1, casing: false, dash: [4, 3] },
  subway: { color: '#9a86d8', width: 1, casing: false, dash: [2, 3] },
};

/** Draw order: smallest first so the big roads end up on top. */
export const ROAD_DRAW_ORDER: RoadClass[] = [
  'pedestrian', 'service', 'subway', 'tram', 'residential', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway', 'rail',
];
