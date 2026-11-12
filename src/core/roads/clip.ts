/**
 * Clipping to the playable square and choice of outside connections.
 * Chosen major ways end exactly on the border; everything else stops GEN_BORDER_MARGIN inside.
 */
import type { Pt } from '../types';
import {
  GEN_BORDER_MARGIN, HALF, IMPORTANCE, MAX_RAIL_OUTSIDE, MAX_ROAD_OUTSIDE,
} from './params';
import { cumLen, polyLength, subPolyline } from './geom';
import type { PWay } from './prepare';

/** arc intervals of a polyline inside the square [-h, h]^2 */
function insideIntervals(p: Pt[], cum: Float64Array, h: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < p.length; i++) {
    const [x0, z0] = p[i];
    const [x1, z1] = p[i + 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    let t0 = 0;
    let t1 = 1;
    const clipT = (pp: number, q: number): boolean => {
      if (Math.abs(pp) < 1e-15) return q >= 0;
      const r = q / pp;
      if (pp < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    };
    if (!clipT(-dx, x0 + h) || !clipT(dx, h - x0) || !clipT(-dz, z0 + h) || !clipT(dz, h - z0)) continue;
    if (t1 < t0) continue;
    const sl = cum[i + 1] - cum[i];
    const a = cum[i] + t0 * sl;
    const b = cum[i] + t1 * sl;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - a) < 1e-6) last[1] = b;
    else out.push([a, b]);
  }
  return out.filter((iv) => iv[1] - iv[0] > 1e-3);
}

function onBorder(p: Pt, h: number): boolean {
  return Math.abs(Math.abs(p[0]) - h) < 1e-3 || Math.abs(Math.abs(p[1]) - h) < 1e-3;
}

/** force a border point exactly onto the border line */
function snapBorder(p: Pt): Pt {
  const dx = HALF - Math.abs(p[0]);
  const dz = HALF - Math.abs(p[1]);
  if (dx <= dz) return [Math.sign(p[0]) * HALF || HALF, Math.max(-HALF, Math.min(HALF, p[1]))];
  return [Math.max(-HALF, Math.min(HALF, p[0])), Math.sign(p[1]) * HALF || HALF];
}

interface Cand {
  piece: number;
  end: 0 | 1;
  p: Pt;
  rail: boolean;
  score: number;
}

export function clipToPlayable(ways: PWay[]): PWay[] {
  // 1. outer clip
  const pieces: { w: PWay; pts: Pt[]; bStart: boolean; bEnd: boolean }[] = [];
  for (const w of ways) {
    const cum = cumLen(w.pts);
    const L = cum[cum.length - 1];
    for (const [a, b] of insideIntervals(w.pts, cum, HALF)) {
      if (b - a < 0.5) continue;
      const pts = subPolyline(w.pts, cum, a, b);
      const bStart = a > 1e-6 || onBorder(pts[0], HALF);
      const bEnd = b < L - 1e-6 || onBorder(pts[pts.length - 1], HALF);
      pieces.push({ w, pts, bStart, bEnd });
    }
  }

  // 2. outside connection candidates
  const cands: Cand[] = [];
  pieces.forEach((pc, i) => {
    const c = pc.w.at.cls;
    const eligible = !pc.w.at.link && (c === 'motorway' || c === 'trunk' || c === 'primary' || c === 'rail');
    if (!eligible || pc.w.at.tunnel) return;
    const len = polyLength(pc.pts);
    if (len < 300) return;
    const rail = c === 'rail';
    const score = IMPORTANCE[c] + Math.min(15, Math.log2(1 + len / 100) * 3) + (pc.w.at.merged ? 3 : 0);
    for (const end of [0, 1] as const) {
      if (!(end === 0 ? pc.bStart : pc.bEnd)) continue;
      const p = snapBorder(end === 0 ? pc.pts[0] : pc.pts[pc.pts.length - 1]);
      // avoid corners
      if (Math.abs(p[0]) > HALF - 200 && Math.abs(p[1]) > HALF - 200) continue;
      cands.push({ piece: i, end, p, rail, score });
    }
  });
  cands.sort((a, b) => b.score - a.score);
  const accepted = new Set<string>();
  for (const rail of [false, true]) {
    const cap = rail ? MAX_RAIL_OUTSIDE : MAX_ROAD_OUTSIDE;
    const chosen: Pt[] = [];
    for (const spread of [rail ? 2500 : 1800, 400]) {
      for (const c of cands) {
        if (c.rail !== rail || chosen.length >= cap) continue;
        const key = c.piece + ':' + c.end;
        if (accepted.has(key)) continue;
        if (chosen.some((q) => Math.hypot(q[0] - c.p[0], q[1] - c.p[1]) < spread)) continue;
        chosen.push(c.p);
        accepted.add(key);
      }
    }
  }

  // 3. inner clip, extending accepted ends out to the border
  const inner = HALF - GEN_BORDER_MARGIN;
  const out: PWay[] = [];
  pieces.forEach((pc, i) => {
    const accS = accepted.has(i + ':0');
    const accE = accepted.has(i + ':1');
    const cum = cumLen(pc.pts);
    const L = cum[cum.length - 1];
    const ivs = insideIntervals(pc.pts, cum, inner);
    if (!ivs.length) return;
    if (accS) ivs[0][0] = 0;
    if (accE) ivs[ivs.length - 1][1] = L;
    for (let k = 0; k < ivs.length; k++) {
      const [a, b] = ivs[k];
      if (b - a < 0.5) continue;
      const pts = subPolyline(pc.pts, cum, a, b);
      const oS = accS && k === 0;
      const oE = accE && k === ivs.length - 1;
      if (oS) pts[0] = snapBorder(pts[0]);
      if (oE) pts[pts.length - 1] = snapBorder(pts[pts.length - 1]);
      out.push({ at: pc.w.at, pts, outsideStart: oS, outsideEnd: oE });
    }
  });
  return out;
}
