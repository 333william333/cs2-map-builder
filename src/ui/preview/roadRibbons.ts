/**
 * Builds flat ribbons (roads, outlines, grid lines) draped on the terrain and merges any number
 * of them into one set of typed arrays. Pure, no three.js.
 *
 * Input points are GAME coordinates [gx, gz]; the output is in the scene frame (x = gx, z = -gz).
 * `heightAt(x, z)` takes SCENE coordinates.
 */
import type { NetPrefab, Pt, RoadClass } from '../../core/types';
import { PREFAB_WIDTH } from '../../core/roads/params';
import { srgbToLinear } from './terrainColor';

export interface RibbonStyle {
  /** metres */
  width: number;
  /** linear rgb */
  color: readonly [number, number, number];
  /** metres above the terrain surface */
  lift: number;
  /** if > 0, alternate `color` and `color2` in pieces of this length (rail) */
  dash?: number;
  color2?: readonly [number, number, number];
  /** surface parameters for the road shader: [halfWidthM, sidewalkM, lanes, kind] (see RoadKind) */
  params?: readonly [number, number, number, number];
}

export interface RibbonInput {
  pts: Pt[];
  style: RibbonStyle;
  /** deck heights (absolute) at the first/last point; the deck is a straight line between them */
  deck?: { y0: number; y1: number; hump?: number; exact?: boolean };
  /** last point connects back to the first (outlines) */
  closed?: boolean;
}

export interface RibbonGeometry {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  /** per vertex: across (-1 right .. +1 left) and distance along the line in metres */
  uvs: Float32Array;
  /** per vertex: the style's `params` (zeros when unset) */
  params: Float32Array;
}

class GrowF32 {
  a: Float32Array;
  len = 0;
  constructor(cap: number) { this.a = new Float32Array(Math.max(16, cap)); }
  push3(x: number, y: number, z: number): void {
    if (this.len + 3 > this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.len++] = x;
    this.a[this.len++] = y;
    this.a[this.len++] = z;
  }
  push4(x: number, y: number, z: number, w: number): void {
    if (this.len + 4 > this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.len++] = x;
    this.a[this.len++] = y;
    this.a[this.len++] = z;
    this.a[this.len++] = w;
  }
}

class GrowU32 {
  a: Uint32Array;
  len = 0;
  constructor(cap: number) { this.a = new Uint32Array(Math.max(16, cap)); }
  push6(a0: number, a1: number, a2: number, a3: number, a4: number, a5: number): void {
    if (this.len + 6 > this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    const a = this.a;
    a[this.len++] = a0; a[this.len++] = a1; a[this.len++] = a2;
    a[this.len++] = a3; a[this.len++] = a4; a[this.len++] = a5;
  }
  push3(a0: number, a1: number, a2: number): void {
    if (this.len + 3 > this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.len++] = a0; this.a[this.len++] = a1; this.a[this.len++] = a2;
  }
}

export interface RibbonOptions {
  /** max distance between draped samples along a polyline, metres */
  maxStep?: number;
}

/** Drops every `stride`-th component beyond `keep` (GrowF32 only pushes triples). */
function compact(a: Float32Array, count: number, stride: number, keep: number): Float32Array {
  const out = new Float32Array(count * keep);
  for (let i = 0; i < count; i++) for (let k = 0; k < keep; k++) out[i * keep + k] = a[i * stride + k];
  return out;
}

/** Merges all inputs into one geometry. */
export function buildRibbons(
  inputs: ReadonlyArray<RibbonInput>,
  heightAt: (x: number, z: number) => number,
  opts: RibbonOptions = {},
): RibbonGeometry {
  const maxStep = Math.max(2, opts.maxStep ?? 30);
  const pos = new GrowF32(4096);
  const col = new GrowF32(4096);
  const idx = new GrowU32(8192);
  const uv = new GrowF32(4096);
  const prm = new GrowF32(4096);
  let vcount = 0;

  // scratch for the refined polyline
  let X = new Float64Array(256);
  let Z = new Float64Array(256);
  let S = new Float64Array(256);

  const ensure = (m: number): void => {
    if (m <= X.length) return;
    const cap = Math.max(m, X.length * 2);
    // grow while keeping what is already written (ensure is called mid-polyline)
    const nx = new Float64Array(cap);
    nx.set(X);
    X = nx;
    const nz = new Float64Array(cap);
    nz.set(Z);
    Z = nz;
    const ns = new Float64Array(cap);
    ns.set(S);
    S = ns;
  };

  for (const inp of inputs) {
    const src = inp.pts;
    if (src.length < 2) continue;
    const dash = inp.style.dash && inp.style.dash > 0 ? inp.style.dash : 0;
    const step = dash > 0 ? Math.min(maxStep, dash) : maxStep;

    // refine to scene coordinates
    let m = 0;
    ensure(src.length + 2);
    X[0] = src[0][0];
    Z[0] = -src[0][1];
    S[0] = 0;
    m = 1;
    for (let i = 1; i < src.length; i++) {
      const x1 = src[i][0];
      const z1 = -src[i][1];
      const x0 = X[m - 1];
      const z0 = Z[m - 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-3) continue;
      const parts = Math.max(1, Math.ceil(len / step));
      ensure(m + parts + 2);
      for (let p = 1; p <= parts; p++) {
        const t = p / parts;
        X[m] = x0 + (x1 - x0) * t;
        Z[m] = z0 + (z1 - z0) * t;
        S[m] = S[m - 1] + len / parts;
        m++;
      }
    }
    if (m < 2) continue;
    const total = S[m - 1];
    const closed = !!inp.closed && m > 3;
    const half = inp.style.width / 2;
    const lift = inp.style.lift;
    const deck = inp.deck;
    const [r1, g1, b1] = inp.style.color;
    const [r2, g2, b2] = inp.style.color2 ?? inp.style.color;
    const P = inp.style.params ?? [half, 0, 0, 0];

    const base = vcount;
    // vertex pairs per refined sample (or per piece in dash mode)
    const emitPair = (i: number, nx: number, nz: number, miter: number, cr: number, cg: number, cb: number): void => {
      const ox = nx * half * miter;
      const oz = nz * half * miter;
      const lx = X[i] + ox;
      const lz = Z[i] + oz;
      const rx = X[i] - ox;
      const rz = Z[i] - oz;
      let yl = heightAt(lx, lz) + lift;
      let yr = heightAt(rx, rz) + lift;
      if (deck) {
        const t = total > 0 ? S[i] / total : 0;
        const dy = deck.y0 + (deck.y1 - deck.y0) * t + (deck.hump ?? 0) * Math.sin(Math.PI * t);
        if (deck.exact || dy > yl) yl = dy;
        if (deck.exact || dy > yr) yr = dy;
      }
      pos.push3(lx, yl, lz);
      pos.push3(rx, yr, rz);
      col.push3(cr, cg, cb);
      col.push3(cr, cg, cb);
      uv.push3(1, S[i], 0);
      uv.push3(-1, S[i], 0);
      prm.push4(P[0], P[1], P[2], P[3]);
      prm.push4(P[0], P[1], P[2], P[3]);
      vcount += 2;
    };

    // per-sample tangent / normal
    const normalAt = (i: number, out: number[]): void => {
      let ax: number, az: number, bx: number, bz: number;
      if (i === 0) {
        if (closed) {
          ax = X[m - 1] - X[m - 2]; az = Z[m - 1] - Z[m - 2];
        } else {
          ax = X[1] - X[0]; az = Z[1] - Z[0];
        }
        bx = X[1] - X[0]; bz = Z[1] - Z[0];
      } else if (i === m - 1) {
        ax = X[i] - X[i - 1]; az = Z[i] - Z[i - 1];
        if (closed) {
          bx = X[1] - X[0]; bz = Z[1] - Z[0];
        } else {
          bx = ax; bz = az;
        }
      } else {
        ax = X[i] - X[i - 1]; az = Z[i] - Z[i - 1];
        bx = X[i + 1] - X[i]; bz = Z[i + 1] - Z[i];
      }
      const la = Math.hypot(ax, az) || 1;
      const lb = Math.hypot(bx, bz) || 1;
      ax /= la; az /= la; bx /= lb; bz /= lb;
      let tx = ax + bx;
      let tz = az + bz;
      const lt = Math.hypot(tx, tz);
      if (lt < 1e-6) { tx = bx; tz = bz; } else { tx /= lt; tz /= lt; }
      const nx = -tz;
      const nz = tx;
      // miter: 1 / cos(half the turning angle), limited
      const dotN = nx * -az + nz * ax;
      out[0] = nx;
      out[1] = nz;
      out[2] = 1 / Math.max(0.55, dotN);
    };

    const nn = [0, 0, 1];
    if (dash > 0) {
      // separate quads per dash piece so colours do not blend
      for (let i = 0; i < m - 1; i++) {
        const mid = (S[i] + S[i + 1]) / 2;
        const odd = Math.floor(mid / dash) % 2 === 1;
        const cr = odd ? r2 : r1;
        const cg = odd ? g2 : g1;
        const cb = odd ? b2 : b1;
        const v0 = vcount;
        normalAt(i, nn);
        emitPair(i, nn[0], nn[1], nn[2], cr, cg, cb);
        normalAt(i + 1, nn);
        emitPair(i + 1, nn[0], nn[1], nn[2], cr, cg, cb);
        // (L0, L1, R0) (R0, L1, R1) with L=v0, R=v0+1, next pair v0+2, v0+3
        idx.push6(v0, v0 + 2, v0 + 1, v0 + 1, v0 + 2, v0 + 3);
      }
    } else {
      for (let i = 0; i < m; i++) {
        normalAt(i, nn);
        emitPair(i, nn[0], nn[1], nn[2], r1, g1, b1);
      }
      for (let i = 0; i < m - 1; i++) {
        const v0 = base + i * 2;
        idx.push6(v0, v0 + 2, v0 + 1, v0 + 1, v0 + 2, v0 + 3);
      }
    }
  }

  return {
    positions: pos.a.slice(0, pos.len),
    colors: col.a.slice(0, col.len),
    indices: idx.a.slice(0, idx.len),
    vertexCount: vcount,
    triangleCount: idx.len / 3,
    uvs: compact(uv.a, vcount, 3, 2),
    params: prm.a.slice(0, vcount * 4),
  };
}

// ---------------------------------------------------------------- road styling

/** Surface kinds understood by the road shader. */
export const RoadKind = {
  street: 0, oneway: 1, highway: 2, gravel: 3, path: 4, railDouble: 5, railSingle: 6, tram: 7,
} as const;

export interface RoadProfile {
  /** full width in game metres (curb to curb including sidewalks) */
  width: number;
  /** sidewalk width on each side, metres */
  sidewalk: number;
  /** driving lanes in total */
  lanes: number;
  kind: number;
}

const PROFILE_SHAPE: Record<NetPrefab, Omit<RoadProfile, 'width'>> = {
  highway_1lane_oneway: { sidewalk: 0, lanes: 1, kind: RoadKind.highway },
  highway_2lane_oneway: { sidewalk: 0, lanes: 2, kind: RoadKind.highway },
  highway_3lane_oneway: { sidewalk: 0, lanes: 3, kind: RoadKind.highway },
  highway_4lane_oneway: { sidewalk: 0, lanes: 4, kind: RoadKind.highway },
  highway_twoway_2lane: { sidewalk: 0, lanes: 4, kind: RoadKind.highway },
  highway_twoway_3lane: { sidewalk: 0, lanes: 6, kind: RoadKind.highway },
  road_large_6lane: { sidewalk: 4, lanes: 6, kind: RoadKind.street },
  road_large_oneway: { sidewalk: 3.5, lanes: 4, kind: RoadKind.oneway },
  road_medium_4lane: { sidewalk: 3.5, lanes: 4, kind: RoadKind.street },
  road_medium_oneway: { sidewalk: 3, lanes: 3, kind: RoadKind.oneway },
  road_small_2lane: { sidewalk: 3.5, lanes: 2, kind: RoadKind.street },
  road_small_oneway: { sidewalk: 2.5, lanes: 2, kind: RoadKind.oneway },
  road_gravel: { sidewalk: 0, lanes: 2, kind: RoadKind.gravel },
  road_alley: { sidewalk: 0, lanes: 1, kind: RoadKind.street },
  path_pedestrian: { sidewalk: 0, lanes: 0, kind: RoadKind.path },
  rail_double: { sidewalk: 0, lanes: 2, kind: RoadKind.railDouble },
  rail_single: { sidewalk: 0, lanes: 1, kind: RoadKind.railSingle },
  tram_double: { sidewalk: 0, lanes: 2, kind: RoadKind.tram },
  subway_double: { sidewalk: 0, lanes: 2, kind: RoadKind.railDouble },
};

/**
 * True game widths per prefab, the same table the road builder and the zoning grid use, so the
 * preview roads touch the zone cells exactly. For highways `sidewalk` holds the shoulder width.
 */
export const ROAD_PROFILES: Record<NetPrefab, RoadProfile> = Object.fromEntries(
  (Object.keys(PROFILE_SHAPE) as NetPrefab[]).map((k) => {
    const shape = PROFILE_SHAPE[k];
    const width = PREFAB_WIDTH[k];
    const sidewalk = shape.kind === RoadKind.highway ? Math.max(0.8, (width - shape.lanes * 3.75) / 2) : shape.sidewalk;
    return [k, { width, ...shape, sidewalk }];
  }),
) as Record<NetPrefab, RoadProfile>;

/** Prefab used when only the OSM class is known (raw ways without a processed network). */
export const CLASS_PREFAB: Record<RoadClass, NetPrefab> = {
  motorway: 'highway_2lane_oneway',
  trunk: 'road_large_6lane',
  primary: 'road_medium_4lane',
  secondary: 'road_medium_4lane',
  tertiary: 'road_small_2lane',
  residential: 'road_small_2lane',
  service: 'road_alley',
  pedestrian: 'path_pedestrian',
  rail: 'rail_double',
  tram: 'tram_double',
  subway: 'subway_double',
};

/** Base surface colours (sRGB hex) per kind, used where the shader is not available. */
const KIND_HEX: Record<number, number> = {
  [RoadKind.street]: 0x55585b,
  [RoadKind.oneway]: 0x55585b,
  [RoadKind.highway]: 0x5b5d5f,
  [RoadKind.gravel]: 0x9a8c74,
  [RoadKind.path]: 0xb3aa98,
  [RoadKind.railDouble]: 0x7a7266,
  [RoadKind.railSingle]: 0x7a7266,
  [RoadKind.tram]: 0x67686a,
};

/** Draw order priority: bigger value = drawn on top (uses a tiny lift). */
export const ROAD_LIFT: Record<RoadClass, number> = {
  motorway: 0.9, trunk: 0.85, primary: 0.8, secondary: 0.75, tertiary: 0.7,
  residential: 0.65, service: 0.6, pedestrian: 0.55, rail: 0.6, tram: 0.62, subway: 0.6,
};

export function hexToLinear(hex: number): [number, number, number] {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  ];
}

/** Ribbon style for a road at its true game width. */
export function roadRibbonStyle(cls: RoadClass, prefab?: NetPrefab): RibbonStyle {
  const pf = ROAD_PROFILES[prefab ?? CLASS_PREFAB[cls]] ?? ROAD_PROFILES.road_small_2lane;
  return {
    width: pf.width,
    color: hexToLinear(KIND_HEX[pf.kind] ?? 0x55585b),
    lift: ROAD_LIFT[cls] ?? 0.6,
    params: [pf.width / 2, pf.sidewalk, pf.lanes, pf.kind],
  };
}
