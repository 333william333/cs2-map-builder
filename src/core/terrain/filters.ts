/** Grid filters on square row-major Float32 grids. No allocations in hot loops. */

/** Horizontal box blur of radius r with edge clamping. */
export function boxBlurH(src: Float32Array, dst: Float32Array, N: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  const last = N - 1;
  for (let row = 0; row < N; row++) {
    const o = row * N;
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[o + (k < 0 ? 0 : k > last ? last : k)];
    for (let c = 0; c < N; c++) {
      dst[o + c] = s * inv;
      const add = c + r + 1;
      const sub = c - r;
      s += src[o + (add > last ? last : add)] - src[o + (sub < 0 ? 0 : sub)];
    }
  }
}

/** Vertical box blur of radius r with edge clamping (row-vector accumulation, cache friendly). */
export function boxBlurV(src: Float32Array, dst: Float32Array, N: number, r: number, acc: Float64Array): void {
  const inv = 1 / (2 * r + 1);
  const last = N - 1;
  acc.fill(0, 0, N);
  for (let k = -r; k <= r; k++) {
    const o = (k < 0 ? 0 : k > last ? last : k) * N;
    for (let c = 0; c < N; c++) acc[c] += src[o + c];
  }
  for (let row = 0; row < N; row++) {
    const o = row * N;
    for (let c = 0; c < N; c++) dst[o + c] = acc[c] * inv;
    const add = row + r + 1;
    const sub = row - r;
    const ao = (add > last ? last : add) * N;
    const so = (sub < 0 ? 0 : sub) * N;
    for (let c = 0; c < N; c++) acc[c] += src[ao + c] - src[so + c];
  }
}

/** Three box passes ~ Gaussian blur. Result in `out`; `tmp` is scratch. src is untouched. */
export function gaussLikeBlur(src: Float32Array, out: Float32Array, tmp: Float32Array, N: number, r: number): void {
  const acc = new Float64Array(N);
  boxBlurH(src, tmp, N, r);
  boxBlurV(tmp, out, N, r, acc);
  boxBlurH(out, tmp, N, r);
  boxBlurV(tmp, out, N, r, acc);
  boxBlurH(out, tmp, N, r);
  boxBlurV(tmp, out, N, r, acc);
}

/**
 * Edge-preserving smoothing: blend toward a wide blur only where the blur stays close to the
 * original (flat land, uniform slopes, DEM noise, integer-metre terraces). Ridges, valleys and
 * cliffs, where the blur deviates by more than ~tau, are kept. In place on H.
 */
export function edgeAwareSmooth(
  H: Float32Array,
  N: number,
  radiusCells: number,
  tau: number,
  strength: number,
  blur: Float32Array,
  tmp: Float32Array,
): void {
  gaussLikeBlur(H, blur, tmp, N, radiusCells);
  const inv = 1 / (tau * tau);
  const n = N * N;
  for (let i = 0; i < n; i++) {
    const d = blur[i] - H[i];
    H[i] += strength * Math.exp(-d * d * inv) * d;
  }
}

function slideMin1D(
  src: Float32Array, sBase: number, sStride: number,
  dst: Float32Array, dBase: number, dStride: number,
  N: number, r: number, dq: Int32Array,
): void {
  let head = 0;
  let tail = 0;
  for (let j = 0; j < N + r; j++) {
    if (j < N) {
      const v = src[sBase + j * sStride];
      while (tail > head && src[sBase + dq[tail - 1] * sStride] >= v) tail--;
      dq[tail++] = j;
    }
    const i = j - r;
    if (i >= 0) {
      while (dq[head] < i - r) head++;
      dst[dBase + i * dStride] = src[sBase + dq[head] * sStride];
    }
  }
}

/** Square min filter (grey erosion) of radius r: rows src->tmp, columns tmp->dst. */
export function minFilter(src: Float32Array, dst: Float32Array, tmp: Float32Array, N: number, r: number): void {
  const dq = new Int32Array(N + 1);
  for (let row = 0; row < N; row++) slideMin1D(src, row * N, 1, tmp, row * N, 1, N, r, dq);
  for (let c = 0; c < N; c++) slideMin1D(tmp, c, N, dst, c, N, N, r, dq);
}

/**
 * Two-pass chamfer distance (game metres, weights cell and cell*sqrt2): for every cell with
 * mask != 0, distance to the nearest cell with mask == 0. Outside the grid counts as "inside".
 */
export function chamferDistance(mask: Uint8Array, N: number, cell: number, out: Float32Array): void {
  const a = cell;
  const b = cell * Math.SQRT2;
  const INF = 1e30;
  const n = N * N;
  for (let i = 0; i < n; i++) out[i] = mask[i] !== 0 ? INF : 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      let d = out[i];
      if (d === 0) continue;
      if (c > 0 && out[i - 1] + a < d) d = out[i - 1] + a;
      if (r > 0) {
        if (out[i - N] + a < d) d = out[i - N] + a;
        if (c > 0 && out[i - N - 1] + b < d) d = out[i - N - 1] + b;
        if (c < N - 1 && out[i - N + 1] + b < d) d = out[i - N + 1] + b;
      }
      out[i] = d;
    }
  }
  for (let r = N - 1; r >= 0; r--) {
    for (let c = N - 1; c >= 0; c--) {
      const i = r * N + c;
      let d = out[i];
      if (d === 0) continue;
      if (c < N - 1 && out[i + 1] + a < d) d = out[i + 1] + a;
      if (r < N - 1) {
        if (out[i + N] + a < d) d = out[i + N] + a;
        if (c < N - 1 && out[i + N + 1] + b < d) d = out[i + N + 1] + b;
        if (c > 0 && out[i + N - 1] + b < d) d = out[i + N - 1] + b;
      }
      out[i] = d;
    }
  }
}

/** Bilinear sample at fractional grid coords (x = col, y = row), clamped to the grid. */
export function sampleBilinear(H: Float32Array, N: number, x: number, y: number): number {
  const last = N - 1;
  const cx = x < 0 ? 0 : x > last ? last : x;
  const cy = y < 0 ? 0 : y > last ? last : y;
  const x0 = Math.min(last - 1 < 0 ? 0 : last - 1, Math.floor(cx));
  const y0 = Math.min(last - 1 < 0 ? 0 : last - 1, Math.floor(cy));
  const x1 = Math.min(last, x0 + 1);
  const y1 = Math.min(last, y0 + 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const a = H[y0 * N + x0] + (H[y0 * N + x1] - H[y0 * N + x0]) * tx;
  const b = H[y1 * N + x0] + (H[y1 * N + x1] - H[y1 * N + x0]) * tx;
  return a + (b - a) * ty;
}

/** Area-weighted separable downsample of an S x S grid to D x D (same extent). */
export function downsampleArea(src: Float32Array, S: number, D: number): Float32Array {
  // per destination index: range of source indices with fractional overlap weights
  const k = S / D;
  const starts = new Int32Array(D);
  const counts = new Int32Array(D);
  const wList: number[] = [];
  const offs = new Int32Array(D + 1);
  for (let i = 0; i < D; i++) {
    const a = i * k;
    const b = (i + 1) * k;
    const s0 = Math.floor(a);
    const s1 = Math.min(S - 1, Math.ceil(b) - 1);
    starts[i] = s0;
    counts[i] = s1 - s0 + 1;
    offs[i] = wList.length;
    for (let s = s0; s <= s1; s++) {
      const ov = Math.min(b, s + 1) - Math.max(a, s);
      wList.push(ov / k);
    }
  }
  offs[D] = wList.length;
  const w = Float64Array.from(wList);
  const tmp = new Float32Array(S * D);
  for (let r = 0; r < S; r++) {
    const so = r * S;
    const to = r * D;
    for (let i = 0; i < D; i++) {
      let s = 0;
      const o = offs[i];
      const st = starts[i];
      for (let q = 0; q < counts[i]; q++) s += w[o + q] * src[so + st + q];
      tmp[to + i] = s;
    }
  }
  const out = new Float32Array(D * D);
  for (let i = 0; i < D; i++) {
    const o = offs[i];
    const st = starts[i];
    const dOff = i * D;
    for (let q = 0; q < counts[i]; q++) {
      const ww = w[o + q];
      const so = (st + q) * D;
      for (let c = 0; c < D; c++) out[dOff + c] += ww * tmp[so + c];
    }
  }
  return out;
}
