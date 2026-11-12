/**
 * CS2-like terrain colouring for the 3D preview. Pure functions, output is LINEAR rgb
 * (what three.js expects in vertex colour attributes).
 */
import { LC, type ClimateProfile } from '../../core/types';
import { fbm } from './noise';
import type { VertexGrid } from './terrainGrid';

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

type Rgb = readonly [number, number, number];

function hex(h: number): Rgb {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
}

const GRASS_A = hex(0x6c9a45);
const GRASS_B = hex(0x8fa95a);
const GRASS_HIGH = hex(0x8c8f5c);
const FOREST = hex(0x3a6532);
const SHRUB = hex(0x67804b);
const CROP_A = hex(0xb7bd5f);
const CROP_B = hex(0xc9c36a);
const BUILT = hex(0xa9a396);
const BARE = hex(0x8d7358);
const WETLAND = hex(0x6b8d64);
const MANGROVE = hex(0x4d7a4a);
const MOSS = hex(0x8f9a6a);
const SAND = hex(0xdbc891);
const ROCK_A = hex(0x6f6c66);
const ROCK_B = hex(0x8d8981);
const SNOW = hex(0xf2f5f8);
const BED_SHALLOW = hex(0x3f6a78);
const BED_DEEP = hex(0x102338);

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mix(out: number[], a: Rgb, b: Rgb, t: number): void {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

/**
 * Game height of the snow line, from the warmest monthly mean temperature
 * (0 C mean in the warmest month ~ permanent snow, lapse rate 6.5 C/km).
 * Infinity when there is no climate information.
 */
export function snowLineGame(climate: ClimateProfile | undefined, seaLevel: number, verticalScale: number): number {
  const temps = climate?.monthlyMeanC;
  if (!temps || temps.length === 0) return Infinity;
  const warm = Math.max(...temps);
  const realM = Math.max(50, (warm / 6.5) * 1000);
  return seaLevel + realM * Math.max(0.01, verticalScale);
}

const tmpA = [0, 0, 0];
const tmpB = [0, 0, 0];

/**
 * Writes the sRGB colour (0..1) of one terrain vertex into `out[o..o+2]`.
 *  h          game height, ny the unit normal's y component (1 = flat)
 *  lc         ESA landcover class (0 = unknown)
 *  noise      0..1 patchiness value, noise2 a second independent one
 *  waterDepth metres of water above the vertex (0 = dry)
 */
export function terrainColorSrgb(
  out: number[] | Float32Array,
  o: number,
  h: number,
  ny: number,
  lc: number,
  noise: number,
  noise2: number,
  waterDepth: number,
  seaLevel: number,
  snowLine: number,
): void {
  const base = tmpA;
  // ground cover
  switch (lc) {
    case LC.Tree: mix(base, FOREST, GRASS_A, noise * 0.35); break;
    case LC.Shrub: mix(base, SHRUB, GRASS_B, noise * 0.5); break;
    case LC.Crop: mix(base, CROP_A, CROP_B, noise); break;
    case LC.Built: mix(base, BUILT, GRASS_B, noise * 0.2); break;
    case LC.Bare: mix(base, BARE, ROCK_B, noise * 0.35); break;
    case LC.Wetland: mix(base, WETLAND, GRASS_A, noise * 0.4); break;
    case LC.Mangrove: mix(base, MANGROVE, WETLAND, noise * 0.4); break;
    case LC.Moss: mix(base, MOSS, GRASS_A, noise * 0.4); break;
    default: {
      mix(base, GRASS_A, GRASS_B, noise);
      // grass gets duller and more olive with altitude
      const alt = smoothstep(120, 700, h - seaLevel);
      mix(base, [base[0], base[1], base[2]], GRASS_HIGH, alt * 0.7);
    }
  }
  const c = tmpB;
  c[0] = base[0]; c[1] = base[1]; c[2] = base[2];

  // sand close to the water line
  const above = h - seaLevel;
  if (waterDepth <= 0) {
    const sandAmt = smoothstep(3.2, 0.4, above) * (lc === LC.Tree ? 0.5 : 1);
    if (sandAmt > 0) mix(c, c as unknown as Rgb, SAND, sandAmt);
  }

  // rock on steep slopes
  const rockAmt = smoothstep(0.93, 0.74, ny);
  if (rockAmt > 0) {
    const rock = tmpA;
    mix(rock, ROCK_A, ROCK_B, noise2);
    mix(c, c as unknown as Rgb, rock as unknown as Rgb, rockAmt);
  }

  // snow above the climate line, thinner on steep faces
  if (snowLine < Infinity && waterDepth <= 0) {
    const band = Math.max(40, (snowLine - seaLevel) * 0.12);
    const edge = snowLine + (noise2 - 0.5) * band * 0.6;
    const f = smoothstep(edge, edge + band, h);
    if (f > 0) {
      const snowAmt = f * (0.3 + 0.7 * smoothstep(0.55, 0.85, ny));
      mix(c, c as unknown as Rgb, SNOW, snowAmt);
    }
  }

  // sea / lake bed: darker and bluish, deeper = darker
  if (waterDepth > 0) {
    const tint = tmpA;
    mix(tint, BED_SHALLOW, BED_DEEP, 1 - Math.exp(-waterDepth / 22));
    const keep = Math.exp(-waterDepth / 6) * 0.45;
    c[0] = tint[0] + (c[0] * 0.7 - tint[0]) * keep;
    c[1] = tint[1] + (c[1] * 0.7 - tint[1]) * keep;
    c[2] = tint[2] + (c[2] * 0.7 - tint[2]) * keep;
  }

  out[o] = c[0];
  out[o + 1] = c[1];
  out[o + 2] = c[2];
}

export interface VertexColorInput {
  v: VertexGrid;
  /** 3 floats per vertex, from computeNormals */
  normals: Float32Array;
  /** landcover class per vertex (same n), optional */
  lc?: Uint8Array;
  /** water depth per vertex in metres (0 = dry), optional */
  depth?: Float32Array;
  seaLevel: number;
  snowLine: number;
  /** darken + desaturate, for the world backdrop (0 = none) */
  subdue?: number;
}

/** Computes LINEAR rgb vertex colours (3 floats per vertex). */
export function buildVertexColors(inp: VertexColorInput): Float32Array {
  const { v, normals, lc, depth, seaLevel, snowLine } = inp;
  const n = v.n;
  const d = v.extentM / (n - 1);
  const half = v.extentM / 2;
  const out = new Float32Array(n * n * 3);
  const col = [0, 0, 0];
  const sub = inp.subdue ?? 0;
  for (let r = 0; r < n; r++) {
    const z = -half + r * d;
    for (let cI = 0; cI < n; cI++) {
      const i = r * n + cI;
      const x = -half + cI * d;
      const noise = fbm(x / 420, z / 420, 3, 3) * 0.6 + fbm(x / 70, z / 70, 2, 9) * 0.4;
      const noise2 = fbm(x / 160 + 40, z / 160 - 12, 3, 5);
      terrainColorSrgb(
        col, 0, v.data[i], normals[i * 3 + 1], lc ? lc[i] : 0,
        noise, noise2, depth ? depth[i] : 0, seaLevel, snowLine,
      );
      if (sub > 0) {
        const lum = col[0] * 0.3 + col[1] * 0.59 + col[2] * 0.11;
        const k = 1 - 0.28 * sub;
        const br = 1 - 0.24 * sub;
        col[0] = (lum + (col[0] - lum) * k) * br;
        col[1] = (lum + (col[1] - lum) * k) * br;
        col[2] = (lum + (col[2] - lum) * k) * br;
      }
      const o = i * 3;
      out[o] = srgbToLinear(col[0]);
      out[o + 1] = srgbToLinear(col[1]);
      out[o + 2] = srgbToLinear(col[2]);
    }
  }
  return out;
}
