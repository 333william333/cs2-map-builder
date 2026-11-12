/**
 * Way-level preprocessing: filtering, jitter removal, flattening of tiny structures and
 * collapsing of dual carriageways / parallel tracks into one centre line.
 */
import type { Pt, RawWay, RoadClass, RoadSettings } from '../types';
import {
  type Attr, HALF, ROAD_RANK, choosePrefab, clearance, defaultLanes, family, isRailFamily, levelKey,
} from './params';
import { cumLen, pointAt, pointSegDist2, polyLength, simplifyDP, subPolyline, unit } from './geom';
import { SegGrid } from './spatial';

export interface PWay {
  at: Attr;
  pts: Pt[];
  outsideStart?: boolean;
  outsideEnd?: boolean;
}

const Q = 100;
const QOFF = 1 << 20;
export const ptKey = (x: number, z: number) =>
  (Math.round(x * Q) + QOFF) * 2097152 + (Math.round(z * Q) + QOFF);

/** highest road rank allowed at a detail level (rail family handled separately) */
export function rankCutoff(detail: number): number {
  if (detail < 0.25) return 1;
  if (detail < 0.45) return 2;
  if (detail < 0.6) return 3;
  if (detail < 0.85) return 4;
  return 5;
}

/** whether a class survives the class switches and the detail cut-off */
export function classKept(cls: RoadClass, settings: RoadSettings): boolean {
  if (!settings.classes[cls]) return false;
  const fam = family(cls);
  if (fam === 'road' && ROAD_RANK[cls] > rankCutoff(settings.detail)) return false;
  if (fam === 'tram' && settings.detail < 0.3) return false;
  return true;
}

export function prepareWays(ways: RawWay[], settings: RoadSettings): PWay[] {
  const lim = HALF + 600;
  const pre: { w: RawWay; pts: Pt[] }[] = [];
  for (const w of ways) {
    if (!classKept(w.cls, settings)) continue;
    const pts: Pt[] = [];
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const p of w.pts) {
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      const last = pts[pts.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.2) continue;
      pts.push([p[0], p[1]]);
      if (p[0] < minx) minx = p[0];
      if (p[0] > maxx) maxx = p[0];
      if (p[1] < minz) minz = p[1];
      if (p[1] > maxz) maxz = p[1];
    }
    if (pts.length < 2) continue;
    if (maxx < -lim || minx > lim || maxz < -lim || minz > lim) continue;
    pre.push({ w, pts });
  }

  // vertices shared between ways (or repeated) are protected from simplification
  const count = new Map<number, number>();
  for (const { pts } of pre) {
    for (const p of pts) {
      const k = ptKey(p[0], p[1]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const out: PWay[] = [];
  for (const { w, pts } of pre) {
    const simp: Pt[] = [pts[0]];
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      const prot = i === pts.length - 1 || (count.get(ptKey(pts[i][0], pts[i][1])) ?? 0) > 1;
      if (!prot) continue;
      const piece = simplifyDP(pts.slice(start, i + 1), 0.6);
      for (let k = 1; k < piece.length; k++) simp.push(piece[k]);
      start = i;
    }
    const at: Attr = {
      cls: w.cls,
      link: !!w.link,
      oneway: !!w.oneway,
      bridge: !!w.bridge,
      tunnel: !!w.tunnel && !w.bridge,
      layer: Number.isFinite(w.layer) ? Math.round(w.layer) : 0,
      roundabout: !!w.roundabout,
      merged: false,
      src: w.id,
    };
    if (at.roundabout) at.oneway = true;
    if (w.lanes && w.lanes > 0) at.lanes = w.lanes;
    if (settings.names && w.name) at.name = w.name;
    if (settings.names && w.ref) at.ref = w.ref;
    if (w.unpaved) at.unpaved = true;
    out.push({ at, pts: simp });
  }
  return out;
}

/** bridges / tunnels too short to build become ground ways (and get normal intersections) */
export function flattenShortStructures(ways: PWay[], minLen = 30): void {
  const parent = ways.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const byKey = new Map<string, number>();
  ways.forEach((w, i) => {
    if (!w.at.bridge && !w.at.tunnel) return;
    for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) {
      const k = levelKey(w.at) + ':' + ptKey(p[0], p[1]);
      const o = byKey.get(k);
      if (o === undefined) byKey.set(k, i);
      else parent[find(i)] = find(o);
    }
  });
  const len = new Map<number, number>();
  ways.forEach((w, i) => {
    if (!w.at.bridge && !w.at.tunnel) return;
    const r = find(i);
    len.set(r, (len.get(r) ?? 0) + polyLength(w.pts));
  });
  ways.forEach((w, i) => {
    if (!w.at.bridge && !w.at.tunnel) return;
    if ((len.get(find(i)) ?? 0) < minLen) {
      w.at = { ...w.at, bridge: false, tunnel: false, layer: 0 };
    }
  });
}

// ---------------------------------------------------------------- parallel collapse

const STEP = 8;

type PairKind = 0 | 1 | 2; // 0 none, 1 merge (carriageways / tracks), 2 duplicate

function pairKind(a: Attr, b: Attr): PairKind {
  if (levelKey(a) !== levelKey(b)) return 0;
  const fa = family(a.cls);
  const fb = family(b.cls);
  if (fa !== fb) return 0;
  if (fa !== 'road') return a.cls === b.cls ? 1 : 0;
  if (a.roundabout || b.roundabout) return 0;
  if (a.oneway && b.oneway && !a.link && !b.link) {
    const ra = ROAD_RANK[a.cls];
    const rb = ROAD_RANK[b.cls];
    if (Math.abs(ra - rb) <= 1) return 1;
  }
  return 2;
}

function mergeDist(a: Attr, b: Attr): number {
  return clearance(choosePrefab(a), choosePrefab(b)) + 3;
}

function higherClass(a: RoadClass, b: RoadClass): RoadClass {
  return ROAD_RANK[a] <= ROAD_RANK[b] ? a : b;
}

/**
 * Collapse two-carriageway roads (opposite one-ways closer than the clearance) and parallel
 * tracks into one centre line; drop exact duplicates. Unpaired parts keep their geometry.
 */
export function collapseParallel(ways: PWay[]): PWay[] {
  const grid = new SegGrid(32);
  const cums = ways.map((w) => cumLen(w.pts));
  ways.forEach((w, wi) => {
    for (let i = 0; i + 1 < w.pts.length; i++) {
      grid.add(w.pts[i][0], w.pts[i][1], w.pts[i + 1][0], w.pts[i + 1][1], wi, i);
    }
  });
  /** cheap test whether a plain way might duplicate another: probe 3 interior points */
  const probeDuplicate = (w: PWay, cum: Float64Array, L: number, wi: number): boolean => {
    for (const f of [0.25, 0.5, 0.75]) {
      const p = pointAt(w.pts, cum, L * f);
      let hit = false;
      grid.query(p[0] - 3, p[1] - 3, p[0] + 3, p[1] + 3, (id) => {
        if (hit || grid.owner(id) === wi) return;
        if (pairKind(w.at, ways[grid.owner(id)].at) === 0) return;
        const [ax, az, bx, bz] = grid.get(id);
        if (pointSegDist2(p[0], p[1], ax, az, bx, bz) <= 9) hit = true;
      });
      if (hit) return true;
    }
    return false;
  };
  const out: PWay[] = [];
  for (let wi = 0; wi < ways.length; wi++) {
    const w = ways[wi];
    const cum = cums[wi];
    const L = cum[cum.length - 1];
    const canMerge = isRailFamily(w.at.cls) || (w.at.oneway && !w.at.link && !w.at.roundabout);
    const maxD = canMerge ? 50 : 3;
    if (L < STEP * 2) {
      out.push(w);
      continue;
    }
    if (!canMerge && !probeDuplicate(w, cum, L, wi)) {
      out.push(w);
      continue;
    }
    const n = Math.max(2, Math.round(L / STEP) + 1);
    const ss = new Float64Array(n);
    const partner = new Int32Array(n).fill(-1);
    const kind = new Uint8Array(n);
    const qx = new Float64Array(n);
    const qz = new Float64Array(n);
    let any = false;
    for (let k = 0; k < n; k++) {
      const s = (L * k) / (n - 1);
      ss[k] = s;
      const p = pointAt(w.pts, cum, s);
      const pa = pointAt(w.pts, cum, Math.max(0, s - 2));
      const pb = pointAt(w.pts, cum, Math.min(L, s + 2));
      const t = unit(pb[0] - pa[0], pb[1] - pa[1]);
      let best = Infinity;
      grid.query(p[0] - maxD, p[1] - maxD, p[0] + maxD, p[1] + maxD, (id) => {
        const vi = grid.owner(id);
        if (vi === wi) return;
        const v = ways[vi];
        const kd = pairKind(w.at, v.at);
        if (kd === 0) return;
        const [ax, az, bx, bz] = grid.get(id);
        const dx = bx - ax;
        const dz = bz - az;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1e-9) return;
        let tt = ((p[0] - ax) * dx + (p[1] - az) * dz) / l2;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const cx = ax + dx * tt;
        const cz = az + dz * tt;
        const d = Math.hypot(cx - p[0], cz - p[1]);
        const u = unit(dx, dz);
        const dot = u[0] * t[0] + u[1] * t[1];
        let ok: PairKind = 0;
        if (kd === 1 && d <= mergeDist(w.at, v.at)) {
          if (family(w.at.cls) !== 'road') ok = Math.abs(dot) > 0.85 ? 1 : 0;
          else ok = dot < -0.85 ? 1 : 0;
        }
        if (!ok && d <= 3 && Math.abs(dot) > 0.95 && (w.at.oneway === v.at.oneway || !w.at.oneway)) ok = 2;
        if (!ok) return;
        // the partner must lie beside the sample, not ahead of it (continuations)
        if (d > 1) {
          const side = Math.abs(((cx - p[0]) * t[0] + (cz - p[1]) * t[1]) / d);
          if (side > 0.5) return;
        } else if (tt <= 0 || tt >= 1) {
          return;
        }
        if (d < best) {
          best = d;
          partner[k] = vi;
          kind[k] = ok;
          qx[k] = cx;
          qz[k] = cz;
        }
      });
      if (partner[k] >= 0) any = true;
    }
    if (!any) {
      out.push(w);
      continue;
    }
    // runs of paired samples; too short runs are ignored
    const state = new Int8Array(n); // 0 free, 1 keep (midline), 2 drop, 3 keep own geometry
    let k = 0;
    while (k < n) {
      if (partner[k] < 0) {
        k++;
        continue;
      }
      let e = k;
      while (e + 1 < n && partner[e + 1] >= 0) e++;
      const runLen = ss[e] - ss[k];
      const minRun = kind[(k + e) >> 1] === 2 ? 16 : 40;
      if (runLen >= minRun) {
        for (let i = k; i <= e; i++) {
          const v = ways[partner[i]];
          const leader = w.at.src < v.at.src || (w.at.src === v.at.src && wi < partner[i]);
          state[i] = leader ? (kind[i] === 1 ? 1 : 3) : 2;
        }
      }
      k = e + 1;
    }
    // emit pieces
    let i = 0;
    const pushFree = (s0: number, s1: number) => {
      if (s1 - s0 < 0.5) return;
      out.push({ at: w.at, pts: subPolyline(w.pts, cum, s0, s1), outsideStart: false, outsideEnd: false });
    };
    while (i < n) {
      let e = i;
      const st = state[i] === 3 ? 0 : state[i];
      while (e + 1 < n && (state[e + 1] === 3 ? 0 : state[e + 1]) === st) e++;
      const s0 = ss[i];
      const s1 = ss[e];
      if (st === 0) {
        const a = i === 0 ? 0 : ss[i - 1];
        const b = e === n - 1 ? L : ss[e + 1];
        pushFree(a, b);
      } else if (st === 1) {
        const pts: Pt[] = [];
        for (let j = i; j <= e; j++) {
          const p = pointAt(w.pts, cum, ss[j]);
          const wgt = Math.min(1, Math.min(ss[j] - s0, s1 - ss[j]) / 24);
          const mx = (p[0] + qx[j]) / 2;
          const mz = (p[1] + qz[j]) / 2;
          pts.push([p[0] + (mx - p[0]) * wgt, p[1] + (mz - p[1]) * wgt]);
        }
        const v = ways[partner[(i + e) >> 1]].at;
        if (pts.length >= 2 && polyLength(pts) > 1) {
          const fam = family(w.at.cls);
          const at: Attr = {
            ...w.at,
            cls: fam === 'road' ? higherClass(w.at.cls, v.cls) : w.at.cls,
            oneway: false,
            merged: true,
            name: w.at.name ?? v.name,
            ref: w.at.ref ?? v.ref,
            lanes: fam === 'road'
              ? (w.at.lanes ?? defaultLanes(w.at.cls, true)) + (v.lanes ?? defaultLanes(v.cls, true))
              : undefined,
          };
          out.push({ at, pts });
        }
      }
      // st === 2: dropped
      i = e + 1;
    }
  }
  return out.filter((w) => w.pts.length >= 2 && polyLength(w.pts) >= 0.5);
}
