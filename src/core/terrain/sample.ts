import type { ElevationSampler } from '../types';
import type { Frame } from '../geo/frame';

/** Lattice points between two exact frame.gameToGeo evaluations (bilinear in between). */
const GEO_STEP = 16;
/** Target real-metre spacing of the elevation lattice before smooth upsampling. */
const LATTICE_SPACING_REAL_M = 20;
const LATTICE_MAX = 2048;
const LATTICE_MIN = 256;
/** Real elevation limits; anything outside (nodata, NaN) is replaced by 0. */
const ELEV_MIN = -11500;
const ELEV_MAX = 9000;

function wrapLon(d: number): number {
  let x = d;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

/**
 * Samples real elevation (metres) on an L x L lattice covering a centred square of extentM game metres,
 * using the Grid convention of types.ts (sample centres). Lat/lon come from exact projections every
 * GEO_STEP lattice points and bilinear interpolation in between (error is far below a millimetre).
 */
export function sampleLattice(
  frame: Frame,
  sampler: ElevationSampler,
  extentM: number,
  L: number,
): Float32Array {
  const M = Math.max(2, Math.ceil((L - 1) / GEO_STEP) + 1);
  const lat = new Float64Array(M * M);
  const lon = new Float64Array(M * M);
  const lon0 = frame.sel.centerLon;
  const half = extentM / 2;
  const cell = extentM / L;
  const span = Math.max(1, L - 1);
  for (let k = 0; k < M; k++) {
    const pi = (k * span) / (M - 1);
    const gz = half - (pi + 0.5) * cell;
    for (let l = 0; l < M; l++) {
      const pj = (l * span) / (M - 1);
      const gx = -half + (pj + 0.5) * cell;
      const [la, lo] = frame.gameToGeo(gx, gz);
      lat[k * M + l] = la;
      lon[k * M + l] = lon0 + wrapLon(lo - lon0);
    }
  }
  // per-column interpolation indices
  const l0 = new Int32Array(L);
  const tl = new Float64Array(L);
  for (let j = 0; j < L; j++) {
    const f = (j * (M - 1)) / span;
    const a = Math.min(M - 2, Math.floor(f));
    l0[j] = a;
    tl[j] = f - a;
  }
  const out = new Float32Array(L * L);
  for (let i = 0; i < L; i++) {
    const f = (i * (M - 1)) / span;
    const k0 = Math.min(M - 2, Math.floor(f));
    const tk = f - k0;
    const r0 = k0 * M;
    const r1 = r0 + M;
    for (let j = 0; j < L; j++) {
      const a = l0[j];
      const t = tl[j];
      const la0 = lat[r0 + a] + (lat[r0 + a + 1] - lat[r0 + a]) * t;
      const la1 = lat[r1 + a] + (lat[r1 + a + 1] - lat[r1 + a]) * t;
      const lo0 = lon[r0 + a] + (lon[r0 + a + 1] - lon[r0 + a]) * t;
      const lo1 = lon[r1 + a] + (lon[r1 + a + 1] - lon[r1 + a]) * t;
      let lo = lo0 + (lo1 - lo0) * tk;
      if (lo > 180) lo -= 360;
      else if (lo < -180) lo += 360;
      const v = sampler.sample(la0 + (la1 - la0) * tk, lo);
      out[i * L + j] = v >= ELEV_MIN && v <= ELEV_MAX ? v : 0;
    }
  }
  return out;
}

function catmullRomTaps(L: number, N: number): { idx: Int32Array; w: Float32Array } {
  const idx = new Int32Array(4 * N);
  const w = new Float32Array(4 * N);
  for (let c = 0; c < N; c++) {
    const u = ((c + 0.5) * L) / N - 0.5;
    const i0 = Math.floor(u);
    const t = u - i0;
    const t2 = t * t;
    const t3 = t2 * t;
    w[4 * c] = 0.5 * (-t3 + 2 * t2 - t);
    w[4 * c + 1] = 0.5 * (3 * t3 - 5 * t2 + 2);
    w[4 * c + 2] = 0.5 * (-3 * t3 + 4 * t2 + t);
    w[4 * c + 3] = 0.5 * (t3 - t2);
    for (let k = 0; k < 4; k++) idx[4 * c + k] = Math.min(L - 1, Math.max(0, i0 - 1 + k));
  }
  return { idx, w };
}

/** Separable Catmull-Rom (bicubic) resampling of an L x L grid to N x N (same extent, cell-centred). */
export function resampleBicubic(src: Float32Array, L: number, N: number): Float32Array {
  if (L === N) return src;
  const { idx, w } = catmullRomTaps(L, N);
  const tmp = new Float32Array(L * N);
  for (let r = 0; r < L; r++) {
    const so = r * L;
    const to = r * N;
    for (let c = 0; c < N; c++) {
      const q = 4 * c;
      tmp[to + c] =
        w[q] * src[so + idx[q]] +
        w[q + 1] * src[so + idx[q + 1]] +
        w[q + 2] * src[so + idx[q + 2]] +
        w[q + 3] * src[so + idx[q + 3]];
    }
  }
  const out = new Float32Array(N * N);
  for (let r = 0; r < N; r++) {
    const q = 4 * r;
    const a = idx[q] * N, b = idx[q + 1] * N, cc = idx[q + 2] * N, d = idx[q + 3] * N;
    const wa = w[q], wb = w[q + 1], wc = w[q + 2], wd = w[q + 3];
    const o = r * N;
    for (let c = 0; c < N; c++) {
      out[o + c] = wa * tmp[a + c] + wb * tmp[b + c] + wc * tmp[cc + c] + wd * tmp[d + c];
    }
  }
  return out;
}

/** Lattice size used to sample a grid of N cells covering extentM game metres. */
export function latticeSize(N: number, extentM: number, scaleH: number): number {
  const extentReal = extentM / scaleH;
  const want = Math.ceil(extentReal / LATTICE_SPACING_REAL_M);
  return Math.max(Math.min(N, LATTICE_MIN), Math.min(N, LATTICE_MAX, want));
}

/**
 * Real elevation (metres) for an N x N grid. Samples the DEM on a lattice near the source resolution
 * and upsamples bicubically, so coarse DEMs give smooth terrain instead of facets.
 */
export function sampleElevationGrid(
  frame: Frame,
  sampler: ElevationSampler,
  extentM: number,
  N: number,
): Float32Array {
  const L = latticeSize(N, extentM, frame.scale);
  const lattice = sampleLattice(frame, sampler, extentM, L);
  return resampleBicubic(lattice, L, N);
}
