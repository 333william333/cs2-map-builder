/**
 * Pure instance data for the example houses and bridge structures. Scene frame: x = gx, y = up,
 * z = -gz. `groundAt(x, z)` takes SCENE coordinates.
 */
import type { ZonePreview } from '../../core/types';
import { srgbToLinear } from './terrainColor';

export function hash01(i: number): number {
  let h = Math.imul(i + 1, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

type Rgb = [number, number, number];
function lin(hex: number): Rgb {
  return [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)];
}

/** Restrained palettes per lot kind (0 low res, 1 dense res, 2 commercial, 3 industrial). */
const WALLS: Rgb[][] = [
  [0xe9e4d8, 0xd8c9a8, 0xb85c45, 0xcfd3cf, 0xe3d39c, 0x8d6f58, 0xf0eee8].map(lin),
  [0xcfc6b5, 0xb9a891, 0xa27058, 0xd9d6cf, 0x9ea3a3, 0xc8b79a].map(lin),
  [0xb8c2c8, 0xd7d9d6, 0x8e9aa4, 0xc9bfae, 0x7f8c95].map(lin),
  [0xa9adaf, 0x8f9aa1, 0xb8b2a4, 0x7d8a90, 0xc2c4c0].map(lin),
];
const ROOFS: Rgb[][] = [
  [0x4a4442, 0x7c3b2e, 0x3d4247, 0x5b5f61, 0x8a4a36].map(lin),
  [0x6e6e6b, 0x5d5f60, 0x7a766e].map(lin),
  [0x6a6d6e, 0x8a8c8b, 0x5b6063].map(lin),
  [0x9fa3a3, 0x8c9092, 0xb3b5b2].map(lin),
];

export interface HouseInstances {
  /** bodies: 16 floats per instance (column-major matrix of a unit box with its base at y = 0) */
  body: Float32Array;
  bodyColor: Float32Array;
  /** colour of flat roofs (top faces) */
  bodyRoof: Float32Array;
  bodyCount: number;
  /** pitched roofs: unit prism with base at y = 0, ridge at y = 1 along local x */
  roof: Float32Array;
  roofColor: Float32Array;
  roofCount: number;
}

function writeMatrix(m: Float32Array, o: number, dx: number, dz: number, sx: number, sy: number, sz: number, x: number, y: number, z: number): void {
  // local x along (dx, dz) in scene, local z perpendicular (-dz, dx)
  m[o] = dx * sx; m[o + 1] = 0; m[o + 2] = dz * sx; m[o + 3] = 0;
  m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
  m[o + 8] = -dz * sz; m[o + 9] = 0; m[o + 10] = dx * sz; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
}

/**
 * Turns `zones.lots` into instanced boxes and roofs. Low residential lots get pitched roofs; the
 * body is sunk to the lowest footprint corner so houses on slopes do not float.
 * `keep(x, z)` can drop lots (e.g. outside the render view).
 */
export function houseInstances(
  zones: ZonePreview,
  groundAt: (x: number, z: number) => number,
  keep?: (x: number, z: number) => boolean,
): HouseInstances {
  const n = zones.lotCount;
  const body = new Float32Array(n * 16);
  const bodyColor = new Float32Array(n * 3);
  const bodyRoof = new Float32Array(n * 3);
  const roof = new Float32Array(n * 16);
  const roofColor = new Float32Array(n * 3);
  let bc = 0;
  let rc = 0;
  const L = zones.lots;
  for (let i = 0; i < n; i++) {
    const o = i * 7;
    const gx = L[o], gz = L[o + 1];
    let dx = L[o + 2], dzG = L[o + 3];
    const w = Math.max(2, L[o + 4]), d = Math.max(2, L[o + 5]), h = Math.max(2.5, L[o + 6]);
    const x = gx, z = -gz;
    if (keep && !keep(x, z)) continue;
    // scene direction: z flips
    const len = Math.hypot(dx, dzG) || 1;
    dx /= len;
    const dz = -dzG / len;
    const hx = (dx * w) / 2, hz = (dz * w) / 2;
    const px = (-dz * d) / 2, pz = (dx * d) / 2;
    const g0 = groundAt(x + hx + px, z + hz + pz);
    const g1 = groundAt(x + hx - px, z + hz - pz);
    const g2 = groundAt(x - hx + px, z - hz + pz);
    const g3 = groundAt(x - hx - px, z - hz - pz);
    const gc = groundAt(x, z);
    const base = Math.min(g0, g1, g2, g3, gc) - 0.6;
    const top = Math.max(gc, (g0 + g1 + g2 + g3) / 4) + h;
    const kind = Math.min(3, zones.lotKind[i] ?? 0);
    const r1 = hash01(i * 3 + 1), r2 = hash01(i * 3 + 2);
    const walls = WALLS[kind];
    const roofs = ROOFS[kind];
    const wc = walls[Math.floor(r1 * walls.length)];
    const rcol = roofs[Math.floor(r2 * roofs.length)];
    const vary = 0.92 + 0.16 * hash01(i * 7 + 5);
    writeMatrix(body, bc * 16, dx, dz, w, top - base, d, x, base, z);
    bodyColor[bc * 3] = wc[0] * vary; bodyColor[bc * 3 + 1] = wc[1] * vary; bodyColor[bc * 3 + 2] = wc[2] * vary;
    bodyRoof[bc * 3] = rcol[0]; bodyRoof[bc * 3 + 1] = rcol[1]; bodyRoof[bc * 3 + 2] = rcol[2];
    bc++;
    if (kind === 0) {
      // ridge parallel to the longer side
      const along = w >= d;
      const rdx = along ? dx : -dz, rdz = along ? dz : dx;
      const rw = (along ? w : d) + 0.8, rd = (along ? d : w) + 0.8;
      const rh = Math.min(6, 0.38 * Math.min(w, d));
      writeMatrix(roof, rc * 16, rdx, rdz, rw, rh, rd, x, top, z);
      roofColor[rc * 3] = rcol[0]; roofColor[rc * 3 + 1] = rcol[1]; roofColor[rc * 3 + 2] = rcol[2];
      rc++;
    }
  }
  return {
    body: body.subarray(0, bc * 16), bodyColor: bodyColor.subarray(0, bc * 3), bodyRoof: bodyRoof.subarray(0, bc * 3), bodyCount: bc,
    roof: roof.subarray(0, rc * 16), roofColor: roofColor.subarray(0, rc * 3), roofCount: rc,
  };
}

// ---------------------------------------------------------------- bridges

export interface BridgeInput {
  /** game coordinates */
  pts: [number, number][];
  /** deck top at start/end (absolute) and the hump */
  y0: number;
  y1: number;
  hump: number;
  width: number;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Girders (side faces and soffit under the deck) and piers down to the ground for bridge edges.
 * Piers every `pierEvery` metres where the deck is more than 3 m above the ground.
 */
export function bridgeStructures(inputs: BridgeInput[], groundAt: (x: number, z: number) => number, pierEvery = 42): MeshData {
  const P: number[] = [];
  const N: number[] = [];
  const I: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]): void => {
    const v = P.length / 3;
    P.push(...a, ...b, ...c, ...d);
    for (let k = 0; k < 4; k++) N.push(...n);
    I.push(v, v + 1, v + 2, v, v + 2, v + 3);
  };
  const box = (cx: number, cz: number, yb: number, yt: number, hx: number, hz: number, ax: number, az: number): void => {
    // axis-aligned in the local frame (ax, az) = along
    const bx = -az, bz = ax;
    const c = (sa: number, sb: number, y: number): number[] => [cx + ax * hx * sa + bx * hz * sb, y, cz + az * hx * sa + bz * hz * sb];
    quad(c(-1, 1, yb), c(1, 1, yb), c(1, 1, yt), c(-1, 1, yt), [bx, 0, bz]);
    quad(c(1, -1, yb), c(-1, -1, yb), c(-1, -1, yt), c(1, -1, yt), [-bx, 0, -bz]);
    quad(c(1, 1, yb), c(1, -1, yb), c(1, -1, yt), c(1, 1, yt), [ax, 0, az]);
    quad(c(-1, -1, yb), c(-1, 1, yb), c(-1, 1, yt), c(-1, -1, yt), [-ax, 0, -az]);
  };
  for (const inp of inputs) {
    const pts = inp.pts.map(([gx, gz]) => [gx, -gz]);
    if (pts.length < 2) continue;
    const S = [0];
    for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = S[S.length - 1];
    if (total < 1) continue;
    const deckAt = (s: number): number => inp.y0 + (inp.y1 - inp.y0) * (s / total) + inp.hump * Math.sin(Math.PI * (s / total));
    const hw = inp.width / 2;
    const depth = 1.6;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[i + 1];
      const len = S[i + 1] - S[i];
      if (len < 1e-3) continue;
      const tx = (x1 - x0) / len, tz = (z1 - z0) / len;
      const nx = -tz, nz = tx;
      const ya = deckAt(S[i]) - 0.15, yb = deckAt(S[i + 1]) - 0.15;
      // left / right fascia
      quad([x0 + nx * hw, ya - depth, z0 + nz * hw], [x1 + nx * hw, yb - depth, z1 + nz * hw], [x1 + nx * hw, yb, z1 + nz * hw], [x0 + nx * hw, ya, z0 + nz * hw], [nx, 0, nz]);
      quad([x1 - nx * hw, yb - depth, z1 - nz * hw], [x0 - nx * hw, ya - depth, z0 - nz * hw], [x0 - nx * hw, ya, z0 - nz * hw], [x1 - nx * hw, yb, z1 - nz * hw], [-nx, 0, -nz]);
      // soffit
      quad([x0 - nx * hw, ya - depth, z0 - nz * hw], [x1 - nx * hw, yb - depth, z1 - nz * hw], [x1 + nx * hw, yb - depth, z1 + nz * hw], [x0 + nx * hw, ya - depth, z0 + nz * hw], [0, -1, 0]);
    }
    // piers
    const count = Math.max(0, Math.floor(total / pierEvery));
    for (let k = 1; k <= count; k++) {
      const s = (k * total) / (count + 1);
      let j = 0;
      while (j < S.length - 2 && S[j + 1] < s) j++;
      const f = (s - S[j]) / Math.max(1e-6, S[j + 1] - S[j]);
      const x = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f;
      const z = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f;
      const len = S[j + 1] - S[j] || 1;
      const ax = (pts[j + 1][0] - pts[j][0]) / len, az = (pts[j + 1][1] - pts[j][1]) / len;
      const top = deckAt(s) - 0.15 - depth;
      const g = groundAt(x, z);
      if (top - g < 3) continue;
      box(x, z, g - 3, top, 1.2, Math.max(1.2, hw * 0.55), ax, az);
    }
  }
  return { positions: new Float32Array(P), normals: new Float32Array(N), indices: new Uint32Array(I) };
}
