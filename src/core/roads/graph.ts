/**
 * Planar chain graph: nodes are junctions / dead ends / attribute joints, chains are the
 * polylines between them. Built from ways with exact shared coordinates plus computed
 * same-level crossings.
 */
import type { Pt } from '../types';
import { type Attr, attrKey, levelKey } from './params';
import { cumLen, dist, pointAt, polyLength, segAt, segIntersect, unit } from './geom';
import { PointGrid, SegGrid } from './spatial';
import { type PWay, ptKey } from './prepare';

export interface GNode {
  x: number;
  z: number;
  alive: boolean;
  outside: boolean;
  ch: number[];
}

export interface Chain {
  a: number;
  b: number;
  pts: Pt[];
  at: Attr;
  alive: boolean;
  imp: number;
  /** cached polyline length; -1 = stale */
  L: number;
}

function removeOnce(arr: number[], v: number) {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
}

export class Graph {
  nodes: GNode[] = [];
  chains: Chain[] = [];

  addNode(x: number, z: number, outside = false): number {
    this.nodes.push({ x, z, alive: true, outside, ch: [] });
    return this.nodes.length - 1;
  }

  addChain(a: number, b: number, pts: Pt[], at: Attr, imp = 0): number {
    const id = this.chains.length;
    const na = this.nodes[a];
    const nb = this.nodes[b];
    pts = pts.slice();
    pts[0] = [na.x, na.z];
    pts[pts.length - 1] = [nb.x, nb.z];
    this.chains.push({ a, b, pts, at, alive: true, imp, L: -1 });
    na.ch.push(id);
    nb.ch.push(id);
    return id;
  }

  removeChain(id: number) {
    const c = this.chains[id];
    if (!c.alive) return;
    c.alive = false;
    removeOnce(this.nodes[c.a].ch, id);
    removeOnce(this.nodes[c.b].ch, id);
    if (!this.nodes[c.a].ch.length) this.nodes[c.a].alive = false;
    if (!this.nodes[c.b].ch.length) this.nodes[c.b].alive = false;
  }

  deg(n: number) {
    return this.nodes[n].ch.length;
  }

  len(id: number) {
    const c = this.chains[id];
    if (c.L < 0) c.L = polyLength(c.pts);
    return c.L;
  }

  setPts(id: number, pts: Pt[]) {
    this.chains[id].pts = pts;
    this.chains[id].L = -1;
  }

  live(): number[] {
    const r: number[] = [];
    for (let i = 0; i < this.chains.length; i++) if (this.chains[i].alive) r.push(i);
    return r;
  }

  /** chain points ordered starting at node n (for loops: forward) */
  ptsFrom(id: number, n: number): Pt[] {
    const c = this.chains[id];
    return c.a === n ? c.pts : c.pts.slice().reverse();
  }

  /** unit direction leaving n along the chain, measured over distance d */
  dirFrom(id: number, n: number, d = 20, fromEnd = false): Pt {
    const c = this.chains[id];
    const p = c.pts;
    const rev = !(c.a === n && !fromEnd);
    const m = p.length;
    const at = (i: number) => (rev ? p[m - 1 - i] : p[i]);
    const target = Math.min(d, this.len(id) * 0.5);
    const p0 = at(0);
    let acc = 0;
    for (let i = 1; i < m; i++) {
      const q0 = at(i - 1);
      const q1 = at(i);
      const sl = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
      if (acc + sl >= target) {
        const t = sl > 0 ? (target - acc) / sl : 0;
        const x = q0[0] + (q1[0] - q0[0]) * t;
        const z = q0[1] + (q1[1] - q0[1]) * t;
        return unit(x - p0[0], z - p0[1]);
      }
      acc += sl;
    }
    const q = at(m - 1);
    return unit(q[0] - p0[0], q[1] - p0[1]);
  }

  /** split a chain at arc position s; returns the new node and the two chain ids */
  splitChain(id: number, s: number): { node: number; left: number; right: number } {
    const c = this.chains[id];
    const cum = cumLen(c.pts);
    const i = segAt(cum, s);
    let p: Pt;
    let left: Pt[];
    let right: Pt[];
    if (s - cum[i] < 0.3 && i > 0) {
      p = c.pts[i];
      left = c.pts.slice(0, i + 1);
      right = c.pts.slice(i);
    } else if (cum[i + 1] - s < 0.3 && i + 1 < c.pts.length - 1) {
      p = c.pts[i + 1];
      left = c.pts.slice(0, i + 2);
      right = c.pts.slice(i + 1);
    } else {
      p = pointAt(c.pts, cum, s);
      left = [...c.pts.slice(0, i + 1), p];
      right = [p, ...c.pts.slice(i + 1)];
    }
    const node = this.addNode(p[0], p[1]);
    const { a, b, at, imp } = c;
    this.removeChain(id);
    this.nodes[a].alive = true;
    this.nodes[b].alive = true;
    const l = this.addChain(a, node, left, { ...at }, imp);
    const r = this.addChain(node, b, right, { ...at }, imp);
    return { node, left: l, right: r };
  }

  private trimEnd(pts: Pt[], atStart: boolean, oldP: Pt, newP: Pt) {
    const r = dist(oldP, newP);
    if (atStart) {
      while (pts.length > 2 && dist(pts[1], newP) <= r) pts.splice(1, 1);
      pts[0] = [newP[0], newP[1]];
    } else {
      while (pts.length > 2 && dist(pts[pts.length - 2], newP) <= r) pts.splice(pts.length - 2, 1);
      pts[pts.length - 1] = [newP[0], newP[1]];
    }
  }

  /** move a node, dragging (and trimming) the ends of its chains */
  setNodePos(n: number, x: number, z: number) {
    const node = this.nodes[n];
    const oldP: Pt = [node.x, node.z];
    node.x = x;
    node.z = z;
    const seen = new Set<number>();
    for (const id of node.ch) {
      if (seen.has(id)) continue;
      seen.add(id);
      const c = this.chains[id];
      if (c.a === n) this.trimEnd(c.pts, true, oldP, [x, z]);
      if (c.b === n) this.trimEnd(c.pts, false, oldP, [x, z]);
      c.L = -1;
    }
  }

  /** merge node `drop` into node `keep` (keep's position wins) */
  mergeNodes(keep: number, drop: number) {
    if (keep === drop) return;
    const k = this.nodes[keep];
    const d = this.nodes[drop];
    const oldP: Pt = [d.x, d.z];
    const seen = new Set<number>();
    for (const id of d.ch) {
      if (seen.has(id)) continue;
      seen.add(id);
      const c = this.chains[id];
      if (c.a === drop) {
        c.a = keep;
        this.trimEnd(c.pts, true, oldP, [k.x, k.z]);
      }
      if (c.b === drop) {
        c.b = keep;
        this.trimEnd(c.pts, false, oldP, [k.x, k.z]);
      }
      c.L = -1;
    }
    for (const id of d.ch) k.ch.push(id);
    d.ch = [];
    d.alive = false;
    k.alive = true;
    if (d.outside) k.outside = true;
  }

  /** join the two chains at a degree-2 node when their attributes match */
  dissolve(n: number): boolean {
    const node = this.nodes[n];
    if (!node.alive || node.outside || node.ch.length !== 2) return false;
    const [i1, i2] = node.ch;
    if (i1 === i2) return false;
    const c1 = this.chains[i1];
    const c2 = this.chains[i2];
    if (attrKey(c1.at) !== attrKey(c2.at)) return false;
    let first: Pt[] | null = null;
    let second: Pt[] | null = null;
    let from = -1;
    let to = -1;
    const ow = c1.at.oneway;
    if (c1.b === n && c2.a === n) {
      first = c1.pts; second = c2.pts; from = c1.a; to = c2.b;
    } else if (c2.b === n && c1.a === n) {
      first = c2.pts; second = c1.pts; from = c2.a; to = c1.b;
    } else if (!ow) {
      const p1 = c1.b === n ? c1.pts : c1.pts.slice().reverse();
      const p2 = c2.a === n ? c2.pts : c2.pts.slice().reverse();
      first = p1; second = p2;
      from = c1.b === n ? c1.a : c1.b;
      to = c2.a === n ? c2.b : c2.a;
    }
    if (!first || !second) return false;
    const l1 = this.len(i1);
    const l2 = this.len(i2);
    const main = l1 >= l2 ? c1 : c2;
    const other = (main === c1 ? c2 : c1).at;
    const at: Attr = { ...main.at, name: main.at.name ?? other.name, ref: main.at.ref ?? other.ref };
    const pts = [...first, ...second.slice(1)];
    const imp = Math.max(c1.imp, c2.imp);
    this.removeChain(i1);
    this.removeChain(i2);
    this.nodes[from].alive = true;
    this.nodes[to].alive = true;
    this.addChain(from, to, pts, at, imp);
    node.alive = false;
    return true;
  }

  dissolveAll() {
    for (let n = 0; n < this.nodes.length; n++) {
      if (this.nodes[n].alive && this.nodes[n].ch.length === 2) this.dissolve(n);
    }
  }

  /** segment index over all live chains (owner = chain id, aux = segment index) */
  segIndex(cell = 32): SegGrid {
    const g = new SegGrid(cell);
    for (const id of this.live()) this.indexChain(g, id);
    return g;
  }
  indexChain(g: SegGrid, id: number) {
    const p = this.chains[id].pts;
    for (let i = 0; i + 1 < p.length; i++) g.add(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], id, i);
  }
}

// ---------------------------------------------------------------- construction

/** ends of the same road closer than this are joined (vector tile seams) */
const SEAM_SNAP = 3;

export function buildGraph(ways: PWay[]): Graph {
  // 1. snap endpoints onto other ways' vertices closer than 1 m (vector tile cuts)
  const pg = new PointGrid(4);
  const refW: number[] = [];
  const refI: number[] = [];
  ways.forEach((w, wi) => w.pts.forEach((p, i) => {
    pg.add(p[0], p[1], refW.length);
    refW.push(wi);
    refI.push(i);
  }));
  ways.forEach((w, wi) => {
    for (const end of [0, w.pts.length - 1]) {
      if ((end === 0 && w.outsideStart) || (end > 0 && w.outsideEnd)) continue;
      const p = w.pts[end];
      let bestScore = Infinity;
      let best = -1;
      let exact = false;
      pg.near(p[0], p[1], SEAM_SNAP, (id, d) => {
        if (refW[id] === wi) return;
        if (d < 1e-6) {
          exact = true;
          return;
        }
        const o = ways[refW[id]];
        const ow = o.pts;
        const oStart = refI[id] === 0;
        const isEnd = oStart || refI[id] === ow.length - 1;
        if (d > 1.0) {
          // tile seams: only ends of the same kind of road, continuing in the same direction
          if (!isEnd || o.at.cls !== w.at.cls || levelKey(o.at) !== levelKey(w.at)) return;
          if (w.at.oneway && o.at.oneway && (end === 0) === oStart) return;
        }
        const score = d - (isEnd ? 0.3 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = id;
        }
      });
      if (!exact && best >= 0) {
        const q = ways[refW[best]].pts[refI[best]];
        w.pts[end] = [q[0], q[1]];
      }
    }
  });

  // 2. same-level crossings
  const cell = 64;
  const sg = new SegGrid(cell);
  const lk = ways.map((w) => levelKey(w.at));
  ways.forEach((w, wi) => {
    for (let i = 0; i + 1 < w.pts.length; i++) sg.add(w.pts[i][0], w.pts[i][1], w.pts[i + 1][0], w.pts[i + 1][1], wi, i);
  });
  const ins: { seg: number; t: number; p: Pt }[][] = ways.map(() => []);
  const OFF = 1 << 15;
  for (const [key, bucket] of sg.buckets) {
    if (bucket.length < 2) continue;
    const cx = Math.floor(key / 65536) - OFF;
    const cz = (key % 65536) - OFF;
    for (let x = 0; x < bucket.length; x++) {
      const i = bucket[x];
      const wi = sg.owner(i);
      const [ax, az, bx, bz] = sg.get(i);
      for (let y = x + 1; y < bucket.length; y++) {
        const j = bucket[y];
        const wj = sg.owner(j);
        if (wi === wj) continue;
        if (lk[wi] !== lk[wj]) continue;
        const [cx2, cz2, dx2, dz2] = sg.get(j);
        // quick bbox reject
        if (Math.max(ax, bx) < Math.min(cx2, dx2) || Math.max(cx2, dx2) < Math.min(ax, bx)) continue;
        if (Math.max(az, bz) < Math.min(cz2, dz2) || Math.max(cz2, dz2) < Math.min(az, bz)) continue;
        const r = segIntersect(ax, az, bx, bz, cx2, cz2, dx2, dz2);
        if (!r) continue;
        let [t, u] = r;
        let p: Pt;
        const E = 1e-7;
        if (t < E) { t = 0; p = [ax, az]; }
        else if (t > 1 - E) { t = 1; p = [bx, bz]; }
        else if (u < E) { u = 0; p = [cx2, cz2]; }
        else if (u > 1 - E) { u = 1; p = [dx2, dz2]; }
        else p = [ax + (bx - ax) * t, az + (bz - az) * t];
        if (Math.floor(p[0] / cell) !== cx || Math.floor(p[1] / cell) !== cz) continue;
        const kp = ptKey(p[0], p[1]);
        const endA = (t === 0 || t === 1) && ptKey(t === 0 ? ax : bx, t === 0 ? az : bz) === kp;
        const endB = (u === 0 || u === 1) && ptKey(u === 0 ? cx2 : dx2, u === 0 ? cz2 : dz2) === kp;
        if (endA && endB) continue; // shared vertex already
        if (!endA) ins[wi].push({ seg: sg.aux(i), t, p });
        if (!endB) ins[wj].push({ seg: sg.aux(j), t: u, p });
      }
    }
  }
  ways.forEach((w, wi) => {
    const list = ins[wi];
    if (!list.length) return;
    list.sort((a, b) => a.seg - b.seg || a.t - b.t);
    const out: Pt[] = [];
    let li = 0;
    for (let i = 0; i < w.pts.length; i++) {
      out.push(w.pts[i]);
      while (li < list.length && list[li].seg === i) {
        const q = list[li++].p;
        const last = out[out.length - 1];
        if (ptKey(last[0], last[1]) === ptKey(q[0], q[1])) continue;
        if (i + 1 < w.pts.length && ptKey(w.pts[i + 1][0], w.pts[i + 1][1]) === ptKey(q[0], q[1])) continue;
        out.push([q[0], q[1]]);
      }
    }
    w.pts = out;
  });

  // 3. nodes and chains. Shared coordinates connect, except interior vertices of different
  // levels that merely coincide (a bridge vertex right above a road vertex).
  const hasEnd = new Set<number>();
  for (const w of ways) {
    if (w.pts.length < 2) continue;
    hasEnd.add(ptKey(w.pts[0][0], w.pts[0][1]));
    hasEnd.add(ptKey(w.pts[w.pts.length - 1][0], w.pts[w.pts.length - 1][1]));
  }
  const lookup = (p: Pt, lvl: string): string => {
    const k = ptKey(p[0], p[1]);
    return hasEnd.has(k) ? String(k) : k + '|' + lvl;
  };
  const count = new Map<string, number>();
  ways.forEach((w, wi) => {
    for (const p of w.pts) {
      const k = lookup(p, lk[wi]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  });
  const g = new Graph();
  const nodeOf = new Map<string, number>();
  const nodeAt = (p: Pt, lvl: string): number => {
    const k = lookup(p, lvl);
    let n = nodeOf.get(k);
    if (n === undefined) {
      n = g.addNode(p[0], p[1]);
      nodeOf.set(k, n);
    }
    return n;
  };
  for (let wi = 0; wi < ways.length; wi++) {
    const w = ways[wi];
    const lvl = lk[wi];
    if (w.pts.length < 2) continue;
    let start = nodeAt(w.pts[0], lvl);
    if (w.outsideStart) g.nodes[start].outside = true;
    let cur: Pt[] = [w.pts[0]];
    for (let i = 1; i < w.pts.length; i++) {
      const p = w.pts[i];
      const last = cur[cur.length - 1];
      if (ptKey(p[0], p[1]) === ptKey(last[0], last[1])) continue;
      cur.push(p);
      const isNode = i === w.pts.length - 1 || (count.get(lookup(p, lvl)) ?? 0) > 1;
      if (!isNode) continue;
      const end = nodeAt(p, lvl);
      if (i === w.pts.length - 1 && w.outsideEnd) g.nodes[end].outside = true;
      if (!(end === start && polyLength(cur) < 1)) g.addChain(start, end, cur, { ...w.at });
      start = end;
      cur = [p];
    }
  }
  for (const n of g.nodes) if (!n.ch.length) n.alive = false;
  return g;
}
