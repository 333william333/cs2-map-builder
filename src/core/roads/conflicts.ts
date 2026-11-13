/**
 * Chain-level conflict resolution without deleting routes.
 *
 * Two same-level chains closer than their clearance are fixed by geometry:
 *  - same family (road/road, rail/rail): the minor chain's run inside the major's corridor is
 *    absorbed into the major (the minor joins the major with real junctions at both ends of the
 *    run, so the route stays continuous; it simply shares the major's alignment there);
 *  - different families (road beside rail): the minor chain is displaced sideways.
 */
import type { Pt } from '../types';
import { type Attr, choosePrefab, family, levelClearance, levelKey, ROAD_RANK } from './params';
import { cumLen, dist, pointAt, pointSegDist2, projectSeg, unit } from './geom';
import type { Graph } from './graph';
import { SegGrid } from './spatial';

interface Hit {
  o: number;
  d: number;
  /** nearest point on o */
  q: Pt;
  need: number;
}

const prefabOf = (a: Attr) => choosePrefab(a);

/** major wins ties by importance, then length, then id */
function isMajor(g: Graph, o: number, c: number): boolean {
  const io = g.chains[o].imp;
  const ic = g.chains[c].imp;
  if (io !== ic) return io > ic;
  const lo = g.len(o);
  const lc = g.len(c);
  if (lo !== lc) return lo > lc;
  return o < c;
}

/** attach node n onto the nearest of `set` chains (split or merge into an end node) */
function attachTo(g: Graph, n: number, set: Set<number>): number {
  const N = g.nodes[n];
  let best = -1;
  let bs = 0;
  let bd = Infinity;
  for (const id of set) {
    const c = g.chains[id];
    if (!c.alive) {
      set.delete(id);
      continue;
    }
    const cum = cumLen(c.pts);
    for (let i = 0; i + 1 < c.pts.length; i++) {
      const [ax, az] = c.pts[i];
      const [bx, bz] = c.pts[i + 1];
      const d = pointSegDist2(N.x, N.z, ax, az, bx, bz);
      if (d < bd) {
        bd = d;
        best = id;
        bs = cum[i] + projectSeg(N.x, N.z, ax, az, bx, bz) * (cum[i + 1] - cum[i]);
      }
    }
  }
  if (best < 0) return n;
  const c = g.chains[best];
  const L = g.len(best);
  let target: number;
  const endOk = (m: number) => !g.nodes[m].outside && m !== n;
  if (bs < 10 && endOk(c.a)) target = c.a;
  else if (bs > L - 10 && endOk(c.b)) target = c.b;
  else {
    const s = Math.min(Math.max(bs, 1), L - 1);
    const r = g.splitChain(best, s);
    set.delete(best);
    set.add(r.left);
    set.add(r.right);
    target = r.node;
  }
  if (target !== n) g.mergeNodes(target, n);
  return target;
}

/** chains of `set` forming the path between nodes x and y (BFS restricted to the set) */
function pathBetween(g: Graph, x: number, y: number, set: Set<number>): number[] {
  const prev = new Map<number, number>();
  const seen = new Set<number>([x]);
  const queue = [x];
  while (queue.length) {
    const n = queue.shift()!;
    if (n === y) break;
    for (const id of g.nodes[n].ch) {
      if (!set.has(id) || !g.chains[id].alive) continue;
      const m = g.chains[id].a === n ? g.chains[id].b : g.chains[id].a;
      if (seen.has(m)) continue;
      seen.add(m);
      prev.set(m, id);
      queue.push(m);
    }
  }
  if (!seen.has(y)) return [];
  const out: number[] = [];
  for (let n = y; n !== x;) {
    const id = prev.get(n)!;
    out.push(id);
    const c = g.chains[id];
    n = c.a === n ? c.b : c.a;
  }
  return out;
}

/** absorb the run [s0, s1] of chain c into chain o; returns true when the graph changed */
function absorb(g: Graph, c: number, o: number, s0: number, s1: number): boolean {
  const C = g.chains[c];
  const O = g.chains[o];
  const L = g.len(c);
  const atStart = s0 < 12;
  const atEnd = s1 > L - 12;
  const oSet = new Set<number>([o]);
  const minor = { ...C.at };
  const major = O.at;
  // ends of the run that are existing nodes may be outside connections: never move those
  if (atStart && g.nodes[C.a].outside) return false;
  if (atEnd && g.nodes[C.b].outside) return false;
  let mid = c;
  let x1 = C.b;
  let x0 = C.a;
  if (!atEnd) {
    const r = g.splitChain(mid, s1);
    mid = r.left;
    x1 = r.node;
  }
  if (!atStart) {
    const r = g.splitChain(mid, s0);
    mid = r.right;
    x0 = r.node;
  }
  const midChain = g.chains[mid];
  const sharedA = g.nodes[x0].ch.some((id) => id !== mid && (g.chains[id].a === O.a || g.chains[id].b === O.a));
  void sharedA;
  // attach both run ends onto the major (skip ends that already lie on it)
  const onMajor = (n: number) => g.nodes[n].ch.some((id) => oSet.has(id));
  g.removeChain(mid);
  void midChain;
  g.nodes[x0].alive = true;
  g.nodes[x1].alive = true;
  const q0 = onMajor(x0) ? x0 : attachTo(g, x0, oSet);
  const q1 = onMajor(x1) ? x1 : attachTo(g, x1, oSet);
  if (!g.nodes[q0].ch.length) g.nodes[q0].alive = false;
  if (!g.nodes[q1].ch.length) g.nodes[q1].alive = false;
  // carriageway-like minors running against a one-way major make that stretch two-way
  const close = family(minor.cls) === family(major.cls) &&
    (family(minor.cls) !== 'road' || Math.abs(ROAD_RANK[minor.cls] - ROAD_RANK[major.cls]) <= 1);
  if (q0 !== q1 && major.oneway && close) {
    for (const id of pathBetween(g, q0, q1, oSet)) {
      const ch = g.chains[id];
      if (!ch.at.oneway) continue;
      ch.at = {
        ...ch.at,
        oneway: false,
        merged: true,
        lanes: ch.at.lanes !== undefined && minor.lanes !== undefined ? ch.at.lanes + minor.lanes : undefined,
        name: ch.at.name ?? minor.name,
        ref: ch.at.ref ?? minor.ref,
      };
    }
  } else if (q0 !== q1) {
    for (const id of pathBetween(g, q0, q1, oSet)) {
      const ch = g.chains[id];
      if (!ch.at.name && minor.name) ch.at = { ...ch.at, name: minor.name };
      if (!ch.at.ref && minor.ref) ch.at = { ...ch.at, ref: minor.ref };
    }
  }
  return true;
}

/** push the run of chain c away from the line it crowds */
function displace(g: Graph, c: number, hits: (Hit | null)[], i0: number, i1: number, share = 1, margin = 7) {
  const C = g.chains[c];
  const p = C.pts;
  const n = p.length;
  // every crowding vertex pushes itself away; neighbours follow with a linear taper (~40 m)
  const T = 7;
  const off: Pt[] = p.map(() => [0, 0]);
  const mag = new Float64Array(n);
  for (let j = Math.max(0, i0); j <= Math.min(n - 1, i1); j++) {
    const h = hits[j];
    if (!h) continue;
    const away = unit(p[j][0] - h.q[0], p[j][1] - h.q[1]);
    const m = (h.need - h.d) * share + margin;
    for (let i = Math.max(1, j - T); i <= Math.min(n - 2, j + T); i++) {
      const w = 1 - Math.abs(i - j) / (T + 1);
      if (m * w > mag[i]) {
        mag[i] = m * w;
        off[i] = [away[0] * m * w, away[1] * m * w];
      }
    }
  }
  const res: Pt[] = p.map((q, i) => [q[0] + off[i][0], q[1] + off[i][1]]);
  res[0] = p[0];
  res[n - 1] = p[n - 1];
  g.setPts(c, res);
}

/**
 * Fix one reported conflict between chains c1 and c2 (no junction exemption): absorb the
 * minor's crowding run into the major, or displace it when the families differ.
 */
export function fixPair(g: Graph, c1: number, c2: number, extra = 0): boolean {
  if (c1 === c2 || !g.chains[c1]?.alive || !g.chains[c2]?.alive) return false;
  const [minor, major] = isMajor(g, c1, c2) ? [c2, c1] : [c1, c2];
  const C = g.chains[minor];
  const O = g.chains[major];
  if (C.at.fixed || O.at.fixed || levelKey(C.at) !== levelKey(O.at)) return false;
  const need = levelClearance(prefabOf(C.at), prefabOf(O.at), C.at.tunnel && O.at.tunnel) + 3 + extra;
  const p = C.pts;
  const hits: (Hit | null)[] = new Array(p.length).fill(null);
  for (let i = 0; i < p.length; i++) {
    let bd = need * need;
    let q: Pt | null = null;
    for (let k = 0; k + 1 < O.pts.length; k++) {
      const [ax, az] = O.pts[k];
      const [bx, bz] = O.pts[k + 1];
      const d2 = pointSegDist2(p[i][0], p[i][1], ax, az, bx, bz);
      if (d2 < bd) {
        bd = d2;
        const t = projectSeg(p[i][0], p[i][1], ax, az, bx, bz);
        q = [ax + (bx - ax) * t, az + (bz - az) * t];
      }
    }
    if (q) hits[i] = { o: major, d: Math.sqrt(bd), q, need };
  }
  let bi0 = -1;
  let bi1 = -1;
  for (let i = 0; i < p.length; i++) {
    if (!hits[i]) continue;
    let j = i;
    while (j + 1 < p.length && (hits[j + 1] || hits[j + 2])) j++;
    if (bi0 < 0 || j - i > bi1 - bi0) {
      bi0 = i;
      bi1 = j;
    }
    i = j;
  }
  if (bi0 < 0) return false;
  if (family(C.at.cls) === family(O.at.cls)) {
    const cum = cumLen(p);
    return absorb(g, minor, major, cum[bi0], cum[bi1]);
  }
  displace(g, minor, hits, 0, p.length - 1);
  return true;
}

/** vertices of chain c closer than `need` to chain o */
function hitsAgainst(g: Graph, c: number, o: number, need: number): (Hit | null)[] {
  const p = g.chains[c].pts;
  const O = g.chains[o];
  const hits: (Hit | null)[] = new Array(p.length).fill(null);
  for (let i = 0; i < p.length; i++) {
    let bd = need * need;
    let q: Pt | null = null;
    for (let k = 0; k + 1 < O.pts.length; k++) {
      const [ax, az] = O.pts[k];
      const [bx, bz] = O.pts[k + 1];
      const d2 = pointSegDist2(p[i][0], p[i][1], ax, az, bx, bz);
      if (d2 < bd) {
        bd = d2;
        const t = projectSeg(p[i][0], p[i][1], ax, az, bx, bz);
        q = [ax + (bx - ax) * t, az + (bz - az) * t];
      }
    }
    if (q) hits[i] = { o, d: Math.sqrt(bd), q, need };
  }
  return hits;
}

/**
 * Two important roads a little too close over a stretch: move both apart by half the deficit
 * each (plus a margin), keeping their ends. Returns false when they do not crowd each other.
 */
export function offsetPair(g: Graph, c1: number, c2: number): boolean {
  if (c1 === c2 || !g.chains[c1]?.alive || !g.chains[c2]?.alive) return false;
  const A = g.chains[c1];
  const B = g.chains[c2];
  if (A.at.fixed && B.at.fixed) return false;
  if (levelKey(A.at) !== levelKey(B.at)) return false;
  const need = levelClearance(prefabOf(A.at), prefabOf(B.at), A.at.tunnel && B.at.tunnel) + 2;
  const h1 = hitsAgainst(g, c1, c2, need);
  const h2 = hitsAgainst(g, c2, c1, need);
  if (!h1.some(Boolean) && !h2.some(Boolean)) return false;
  // a ring keeps its circle: the other road takes the whole offset
  const s1 = A.at.fixed ? 0 : B.at.fixed ? 1 : 0.5;
  const s2 = 1 - s1;
  if (s1 > 0) displace(g, c1, h1, 0, h1.length - 1, s1, 2.5);
  if (s2 > 0) displace(g, c2, h2, 0, h2.length - 1, s2, 2.5);
  return true;
}

export interface ConflictStats {
  absorbed: number;
  displaced: number;
  passes: number;
}

/** resolve parallel conflicts between same-level chains; never removes a route */
export function resolveChainConflicts(g: Graph, maxPasses = 6): ConflictStats {
  const stats: ConflictStats = { absorbed: 0, displaced: 0, passes: 0 };
  const attempts = new Map<string, number>();
  let pending: Set<number> | null = null;
  for (let pass = 0; pass < maxPasses; pass++) {
    const firstNew = g.chains.length;
    const nextPending = new Set<number>();
    stats.passes = pass + 1;
    const grid = g.segIndex(48);
    const live = g.live();
    const lvl = new Map<number, string>();
    const pf = new Map<number, ReturnType<typeof prefabOf>>();
    for (const id of live) {
      lvl.set(id, levelKey(g.chains[id].at));
      pf.set(id, prefabOf(g.chains[id].at));
    }
    const order = live.slice().sort((x, y) => g.chains[x].imp - g.chains[y].imp || g.len(x) - g.len(y));
    const done = new Set<number>();
    let changed = false;
    for (const c of order) {
      const C = g.chains[c];
      if (!C.alive || C.at.fixed) continue;
      if (pending && !pending.has(c)) continue;
      if (done.has(c)) {
        nextPending.add(c);
        continue;
      }
      const p = C.pts;
      const hits: (Hit | null)[] = new Array(p.length).fill(null);
      const lv = lvl.get(c);
      const pc = pf.get(c)!;
      // every second vertex is enough to find runs (6 m spacing); copy hits to the skipped ones
      for (let i = 0; i < p.length; i++) {
        if (i % 2 === 1 && i + 1 < p.length) continue;
        const [x, z] = p[i];
        let best: Hit | null = null;
        grid.query(x - 44, z - 44, x + 44, z + 44, (sid) => {
          const o = grid.owner(sid);
          if (o === c) return;
          if (done.has(o)) {
            nextPending.add(c);
            return;
          }
          const O = g.chains[o];
          if (!O.alive || O.at.fixed || lvl.get(o) !== lv) return;
          const si = grid.aux(sid);
          if (si + 1 >= O.pts.length) return;
          const [ax, az, bx, bz] = grid.get(sid);
          if (O.pts[si][0] !== ax || O.pts[si][1] !== az) return; // stale
          const need = levelClearance(pc, pf.get(o) ?? prefabOf(O.at), C.at.tunnel && O.at.tunnel) + 2;
          const d2 = pointSegDist2(x, z, ax, az, bx, bz);
          if (d2 >= need * need) return;
          // junction vicinity of a shared node is handled by acute / first-piece rules
          for (const sn of [C.a, C.b]) {
            if (sn !== O.a && sn !== O.b) continue;
            const N = g.nodes[sn];
            if (Math.hypot(x - N.x, z - N.z) < need * 1.6) return;
          }
          if (!isMajor(g, o, c)) return;
          const d = Math.sqrt(d2);
          if (!best || d < best.d) {
            const t = projectSeg(x, z, ax, az, bx, bz);
            best = { o, d, q: [ax + (bx - ax) * t, az + (bz - az) * t], need };
          }
        });
        hits[i] = best;
        if (i > 0 && i % 2 === 0 && !hits[i - 1]) hits[i - 1] = best ?? hits[i - 2] ?? null;
      }
      // the longest run against one major
      let bi0 = -1;
      let bi1 = -1;
      let bo = -1;
      for (let i = 0; i < p.length; i++) {
        const h = hits[i];
        if (!h) continue;
        let j = i;
        while (j + 1 < p.length && (hits[j + 1]?.o === h.o || (!hits[j + 1] && hits[j + 2]?.o === h.o))) j++;
        if (bi0 < 0 || j - i > bi1 - bi0) {
          bi0 = i;
          bi1 = j;
          bo = h.o;
        }
        i = j;
      }
      if (bo < 0) continue;
      const key = `${c}:${bo}`;
      const tries = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, tries);
      if (tries > 3) continue;
      const O = g.chains[bo];
      const cum = cumLen(p);
      const same = family(C.at.cls) === family(O.at.cls);
      done.add(c);
      done.add(bo);
      if (same) {
        if (absorb(g, c, bo, cum[bi0], cum[bi1])) {
          stats.absorbed++;
          changed = true;
        }
      } else {
        displace(g, c, hits, bi0, bi1);
        nextPending.add(c);
        stats.displaced++;
        changed = true;
      }
    }
    if (!changed) break;
    g.dissolveAll();
    for (let id = firstNew; id < g.chains.length; id++) if (g.chains[id].alive) nextPending.add(id);
    // chains near anything that changed are rechecked too
    const near = new Set<number>();
    for (const id of nextPending) {
      const ch = g.chains[id];
      if (!ch?.alive) continue;
      for (const n of [ch.a, ch.b]) for (const o of g.nodes[n].ch) near.add(o);
    }
    for (const id of near) nextPending.add(id);
    pending = nextPending;
  }
  return stats;
}

void dist;
void pointAt;
