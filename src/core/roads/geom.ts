/** Polyline and cubic Bezier helpers (game metres). */
import type { Pt } from '../types';

export type Bez = [Pt, Pt, Pt, Pt];

export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function polyLength(p: Pt[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return s;
}

export function cumLen(p: Pt[]): Float64Array {
  const c = new Float64Array(p.length);
  for (let i = 1; i < p.length; i++) c[i] = c[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return c;
}

/** index i with cum[i] <= s < cum[i+1] (clamped) */
export function segAt(cum: Float64Array, s: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  if (s <= 0) return 0;
  if (s >= cum[hi]) return Math.max(0, hi - 1);
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= s) lo = m;
    else hi = m;
  }
  return lo;
}

export function pointAt(p: Pt[], cum: Float64Array, s: number): Pt {
  if (s <= 0) return [p[0][0], p[0][1]];
  const L = cum[cum.length - 1];
  if (s >= L) return [p[p.length - 1][0], p[p.length - 1][1]];
  const i = segAt(cum, s);
  const d = cum[i + 1] - cum[i];
  const t = d > 0 ? (s - cum[i]) / d : 0;
  return [p[i][0] + (p[i + 1][0] - p[i][0]) * t, p[i][1] + (p[i + 1][1] - p[i][1]) * t];
}

/** sub-polyline between arc positions s0 < s1, keeping original interior vertices */
export function subPolyline(p: Pt[], cum: Float64Array, s0: number, s1: number): Pt[] {
  const L = cum[cum.length - 1];
  s0 = Math.max(0, s0);
  s1 = Math.min(L, s1);
  const out: Pt[] = [pointAt(p, cum, s0)];
  for (let i = 0; i < p.length; i++) {
    if (cum[i] > s0 + 1e-9 && cum[i] < s1 - 1e-9) out.push([p[i][0], p[i][1]]);
  }
  out.push(pointAt(p, cum, s1));
  if (out.length === 2 && dist(out[0], out[1]) < 1e-9) return out;
  return out;
}

/** resample at an even arc step, endpoints exact */
export function resample(p: Pt[], step: number): Pt[] {
  const cum = cumLen(p);
  const L = cum[cum.length - 1];
  const n = Math.max(1, Math.round(L / step));
  const out: Pt[] = [[p[0][0], p[0][1]]];
  for (let k = 1; k < n; k++) out.push(pointAt(p, cum, (L * k) / n));
  out.push([p[p.length - 1][0], p[p.length - 1][1]]);
  return out;
}

/** Douglas-Peucker, endpoints kept */
export function simplifyDP(p: Pt[], tol: number): Pt[] {
  if (p.length <= 2) return p.slice();
  const keep = new Uint8Array(p.length);
  keep[0] = 1;
  keep[p.length - 1] = 1;
  const stack: number[] = [0, p.length - 1];
  const t2 = tol * tol;
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    let best = -1;
    let bd = t2;
    for (let i = a + 1; i < b; i++) {
      const d = pointSegDist2(p[i][0], p[i][1], p[a][0], p[a][1], p[b][0], p[b][1]);
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push(a, best, best, b);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < p.length; i++) if (keep[i]) out.push(p[i]);
  return out;
}

/** Gaussian smoothing of an evenly resampled polyline; endpoints fixed, window shrinks near ends */
export function smoothGaussian(p: Pt[], sigmaPts: number): Pt[] {
  const n = p.length;
  if (n < 3 || sigmaPts < 0.3) return p;
  const R = Math.ceil(sigmaPts * 2.5);
  const w = new Float64Array(R + 1);
  for (let k = 0; k <= R; k++) w[k] = Math.exp(-(k * k) / (2 * sigmaPts * sigmaPts));
  const out: Pt[] = new Array(n);
  out[0] = p[0];
  out[n - 1] = p[n - 1];
  for (let i = 1; i < n - 1; i++) {
    const r = Math.min(R, i, n - 1 - i);
    let sx = 0;
    let sz = 0;
    let sw = 0;
    for (let k = -r; k <= r; k++) {
      const ww = w[Math.abs(k)];
      sx += p[i + k][0] * ww;
      sz += p[i + k][1] * ww;
      sw += ww;
    }
    out[i] = [sx / sw, sz / sw];
  }
  return out;
}

export function pointSegDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}

export function projectSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** proper or touching intersection; returns params on both segments */
export function segIntersect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): [number, number] | null {
  const rx = bx - ax;
  const rz = bz - az;
  const sx = dx - cx;
  const sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax;
  const qz = cz - az;
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return [Math.min(1, Math.max(0, t)), Math.min(1, Math.max(0, u))];
}

export function segSegDist(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): number {
  if (segIntersect(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  return Math.sqrt(Math.min(
    pointSegDist2(ax, az, cx, cz, dx, dz),
    pointSegDist2(bx, bz, cx, cz, dx, dz),
    pointSegDist2(cx, cz, ax, az, bx, bz),
    pointSegDist2(dx, dz, ax, az, bx, bz),
  ));
}

/** distance from a point to a polyline, with the arc position of the nearest point */
export function pointPolyDist(px: number, pz: number, p: Pt[], cum?: Float64Array): { d: number; s: number } {
  let best = Infinity;
  let bs = 0;
  let acc = 0;
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i];
    const b = p[i + 1];
    const d2 = pointSegDist2(px, pz, a[0], a[1], b[0], b[1]);
    const sl = cum ? cum[i + 1] - cum[i] : Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d2 < best) {
      best = d2;
      bs = acc + projectSeg(px, pz, a[0], a[1], b[0], b[1]) * sl;
    }
    acc += sl;
  }
  return { d: Math.sqrt(best), s: bs };
}

export function unit(x: number, z: number): Pt {
  const l = Math.hypot(x, z);
  return l > 1e-12 ? [x / l, z / l] : [1, 0];
}

export function angleBetween(a: Pt, b: Pt): number {
  const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]));
  return Math.acos(d);
}

/** heading change at interior vertices (radians, absolute), turn[0] = turn[n-1] = 0 */
export function vertexTurns(p: Pt[]): Float64Array {
  const t = new Float64Array(p.length);
  for (let i = 1; i + 1 < p.length; i++) {
    const a = Math.atan2(p[i][1] - p[i - 1][1], p[i][0] - p[i - 1][0]);
    const b = Math.atan2(p[i + 1][1] - p[i][1], p[i + 1][0] - p[i][0]);
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    t[i] = Math.abs(d);
  }
  return t;
}

// ---------------------------------------------------------------- Bezier

export function bezPoint(b: Bez, t: number): Pt {
  const u = 1 - t;
  const a0 = u * u * u;
  const a1 = 3 * u * u * t;
  const a2 = 3 * u * t * t;
  const a3 = t * t * t;
  return [
    a0 * b[0][0] + a1 * b[1][0] + a2 * b[2][0] + a3 * b[3][0],
    a0 * b[0][1] + a1 * b[1][1] + a2 * b[2][1] + a3 * b[3][1],
  ];
}

export function bezDeriv(b: Bez, t: number): Pt {
  const u = 1 - t;
  const k0 = 3 * u * u;
  const k1 = 6 * u * t;
  const k2 = 3 * t * t;
  return [
    k0 * (b[1][0] - b[0][0]) + k1 * (b[2][0] - b[1][0]) + k2 * (b[3][0] - b[2][0]),
    k0 * (b[1][1] - b[0][1]) + k1 * (b[2][1] - b[1][1]) + k2 * (b[3][1] - b[2][1]),
  ];
}

export function bezSecond(b: Bez, t: number): Pt {
  const u = 1 - t;
  return [
    6 * u * (b[2][0] - 2 * b[1][0] + b[0][0]) + 6 * t * (b[3][0] - 2 * b[2][0] + b[1][0]),
    6 * u * (b[2][1] - 2 * b[1][1] + b[0][1]) + 6 * t * (b[3][1] - 2 * b[2][1] + b[1][1]),
  ];
}

/** start tangent direction (falls back to the chord when the handle is degenerate) */
export function bezStartDir(b: Bez): Pt {
  const d = bezDeriv(b, 0);
  if (Math.hypot(d[0], d[1]) > 1e-9) return unit(d[0], d[1]);
  const e = bezDeriv(b, 0.01);
  return unit(e[0], e[1]);
}
export function bezEndDir(b: Bez): Pt {
  const d = bezDeriv(b, 1);
  if (Math.hypot(d[0], d[1]) > 1e-9) return unit(d[0], d[1]);
  const e = bezDeriv(b, 0.99);
  return unit(e[0], e[1]);
}

export function bezFine(b: Bez, n = 64): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push(bezPoint(b, i / n));
  out[0] = [b[0][0], b[0][1]];
  out[n] = [b[3][0], b[3][1]];
  return out;
}

export function bezLength(b: Bez, n = 64): number {
  return polyLength(bezFine(b, n));
}

/** points along the curve at ~step arc spacing, endpoints exact */
export function bezArcSample(b: Bez, step: number): Pt[] {
  const fine = bezFine(b, 96);
  const cum = cumLen(fine);
  const L = cum[cum.length - 1];
  const n = Math.max(1, Math.ceil(L / step));
  const out: Pt[] = [b[0]];
  for (let k = 1; k < n; k++) out.push(pointAt(fine, cum, (L * k) / n));
  out.push(b[3]);
  return out;
}

/** smallest curvature radius along the curve */
export function bezMinRadius(b: Bez, n = 32): number {
  let r = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const d = bezDeriv(b, t);
    const s = bezSecond(b, t);
    const sp = Math.hypot(d[0], d[1]);
    if (sp < 1e-6) continue;
    const k = Math.abs(d[0] * s[1] - d[1] * s[0]) / (sp * sp * sp);
    if (k > 1e-12) r = Math.min(r, 1 / k);
  }
  return r;
}

/** total absolute turning along the curve (radians) */
export function bezTotalTurn(b: Bez, n = 32): number {
  let tot = 0;
  let prev: number | null = null;
  for (let i = 0; i <= n; i++) {
    const d = bezDeriv(b, i / n);
    if (Math.hypot(d[0], d[1]) < 1e-9) continue;
    const a = Math.atan2(d[1], d[0]);
    if (prev !== null) {
      let x = a - prev;
      while (x > Math.PI) x -= 2 * Math.PI;
      while (x < -Math.PI) x += 2 * Math.PI;
      tot += Math.abs(x);
    }
    prev = a;
  }
  return tot;
}

/**
 * Least-squares cubic through polyline `p` with fixed end tangent directions
 * (t0 leaves p[0], t3 arrives at p[last]).
 */
export function fitBezier(p: Pt[], t0: Pt, t3: Pt): Bez {
  const P0 = p[0];
  const P3 = p[p.length - 1];
  const d = dist(P0, P3);
  let a1 = d / 3;
  let a2 = d / 3;
  if (p.length >= 4 && d > 1e-6) {
    const cum = cumLen(p);
    const L = cum[cum.length - 1];
    let c11 = 0;
    let c12 = 0;
    let c22 = 0;
    let x1 = 0;
    let x2 = 0;
    for (let i = 1; i < p.length - 1; i++) {
      const u = cum[i] / L;
      const v = 1 - u;
      const b0 = v * v * v;
      const b1 = 3 * v * v * u;
      const b2 = 3 * v * u * u;
      const b3 = u * u * u;
      const A1x = t0[0] * b1;
      const A1z = t0[1] * b1;
      const A2x = -t3[0] * b2;
      const A2z = -t3[1] * b2;
      const rx = p[i][0] - (P0[0] * (b0 + b1) + P3[0] * (b2 + b3));
      const rz = p[i][1] - (P0[1] * (b0 + b1) + P3[1] * (b2 + b3));
      c11 += A1x * A1x + A1z * A1z;
      c12 += A1x * A2x + A1z * A2z;
      c22 += A2x * A2x + A2z * A2z;
      x1 += A1x * rx + A1z * rz;
      x2 += A2x * rx + A2z * rz;
    }
    const det = c11 * c22 - c12 * c12;
    if (Math.abs(det) > 1e-12) {
      const s1 = (x1 * c22 - x2 * c12) / det;
      const s2 = (c11 * x2 - c12 * x1) / det;
      if (Number.isFinite(s1) && Number.isFinite(s2)) {
        a1 = s1;
        a2 = s2;
      }
    }
  }
  const lo = 0.12 * d;
  const hi = 0.5 * d;
  a1 = Math.min(hi, Math.max(lo, a1));
  a2 = Math.min(hi, Math.max(lo, a2));
  return [
    [P0[0], P0[1]],
    [P0[0] + t0[0] * a1, P0[1] + t0[1] * a1],
    [P3[0] - t3[0] * a2, P3[1] - t3[1] * a2],
    [P3[0], P3[1]],
  ];
}
