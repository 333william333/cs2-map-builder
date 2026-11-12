/**
 * Geometric repair of validator findings at chain level. Every action keeps routes continuous:
 * absorb / displace parallel conflicts, reroute acute junctions, contract over-short chains,
 * relax tight curves, slide attribute joints, merge crowded nodes into a junction.
 */
import type { Pt, RoadNetwork } from '../types';
import { choosePrefab, family, levelKey } from './params';
import { attrKey } from './params';
import { dist } from './geom';
import type { Graph } from './graph';
import { contractChain, isMinorClass, reroute } from './generalize';
import { fixPair } from './conflicts';
import { flattenChain, gradeSeparate } from './structures';
import type { Violation } from './validate';
import type { WNet } from './segment';

export interface RepairContext {
  /** per chain: how often its curve was relaxed already */
  relaxed: Map<number, number>;
  /** points the segmentation must keep joints away from */
  avoid: Pt[];
  /** action log (kind @ x,z) for diagnostics */
  log: string[];
  /** repeated attempts per location (rounded 20 m) */
  tries: Map<string, number>;
}

export function newRepairContext(): RepairContext {
  return { relaxed: new Map(), avoid: [], log: [], tries: new Map() };
}

/** local Laplacian smoothing around P (ends fixed); stronger on every repeat */
function relaxCurve(g: Graph, c: number, P: Pt, ctx: RepairContext) {
  const C = g.chains[c];
  if (!C.alive) return;
  const k = (ctx.relaxed.get(c) ?? 0) + 1;
  ctx.relaxed.set(c, k);
  const p = C.pts.map((q) => [q[0], q[1]] as Pt);
  const n = p.length;
  if (n < 3) return;
  let ci = 0;
  let bd = Infinity;
  for (let i = 0; i < n; i++) {
    const d = dist(p[i], P);
    if (d < bd) {
      bd = d;
      ci = i;
    }
  }
  const W = 6 + 4 * k;
  const i0 = Math.max(1, ci - W);
  const i1 = Math.min(n - 2, ci + W);
  for (let it = 0; it < 3 + 3 * k; it++) {
    for (let i = i0; i <= i1; i++) {
      const w = 0.5 * (1 - Math.abs(i - ci) / (W + 1));
      p[i] = [
        p[i][0] + w * ((p[i - 1][0] + p[i + 1][0]) / 2 - p[i][0]),
        p[i][1] + w * ((p[i - 1][1] + p[i + 1][1]) / 2 - p[i][1]),
      ];
    }
  }
  g.setPts(c, p);
}

/** move an attribute joint (degree-2 graph node between differing chains) along its longer chain */
function slideJoint(g: Graph, n: number, away: Pt, by: number): boolean {
  const N = g.nodes[n];
  if (N.outside || N.ch.length !== 2) return false;
  const [i1, i2] = N.ch;
  if (i1 === i2) return false;
  // slide into the chain that leads away from `away`
  const cand = [i1, i2].filter((id) => g.len(id) > by + 40);
  if (!cand.length) return false;
  let best = cand[0];
  let bestScore = -Infinity;
  for (const id of cand) {
    const d = g.dirFrom(id, n, Math.min(by, 30));
    const v: Pt = [N.x - away[0], N.z - away[1]];
    const score = d[0] * v[0] + d[1] * v[1];
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  const other = best === i1 ? i2 : i1;
  const c = g.chains[best];
  const s = c.a === n ? by : g.len(best) - by;
  const r = g.splitChain(best, s);
  // the piece next to n takes the attributes of the other chain, then n dissolves
  const piece = g.chains[c.a === n ? r.left : r.right];
  piece.at = { ...g.chains[other].at };
  if (!g.dissolve(n)) return true;
  return true;
}

/**
 * A chain that doubles back on itself near P (hairpin, turning loop): join the two close points
 * into one junction. The through route stays, the loop tip becomes a small loop or vanishes.
 */
function pinch(g: Graph, c: number, P: Pt, need: number): boolean {
  const C = g.chains[c];
  if (!C.alive) return false;
  const p = C.pts;
  const cum: number[] = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + dist(p[i - 1], p[i]));
  let best: [number, number] | null = null;
  let bd = Infinity;
  for (let i = 1; i < p.length - 1; i++) {
    if (dist(p[i], P) > 80) continue;
    for (let j = i + 1; j < p.length - 1; j++) {
      if (cum[j] - cum[i] < 2.5 * need) continue;
      const d = dist(p[i], p[j]);
      if (d < need && cum[j] - cum[i] - d < bd + 1e9 && d < bd) {
        bd = d;
        best = [i, j];
      }
    }
  }
  if (!best) return false;
  const [i, j] = best;
  const L = cum[cum.length - 1];
  const sj = cum[j];
  const si = cum[i];
  const r1 = g.splitChain(c, sj);
  const r2 = g.splitChain(r1.left, si);
  const a = g.nodes[r2.node];
  const b = g.nodes[r1.node];
  g.setNodePos(r2.node, (a.x + b.x) / 2, (a.z + b.z) / 2);
  g.mergeNodes(r2.node, r1.node);
  void L;
  return true;
}

/**
 * A minor chain ending in a dead end whose last stretch cannot be built (turning loop, U-turn):
 * cut the chain back to where the bad segment starts. Only the dead-end tip goes.
 */
function trimDeadEndTip(g: Graph, c: number, edgePts: Pt[]): boolean {
  const C = g.chains[c];
  if (!C.alive || !isMinorClass(C.at.cls) || C.a === C.b) return false;
  const deadA = g.nodes[C.a].ch.length === 1 && !g.nodes[C.a].outside;
  const deadB = g.nodes[C.b].ch.length === 1 && !g.nodes[C.b].outside;
  if (!deadA && !deadB) return false;
  const cum = [0];
  for (let i = 1; i < C.pts.length; i++) cum.push(cum[i - 1] + dist(C.pts[i - 1], C.pts[i]));
  const L = cum[cum.length - 1];
  // arc positions of the bad edge's ends on the chain
  const at = (q: Pt) => {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < C.pts.length; i++) {
      const d = dist(C.pts[i], q);
      if (d < bd) { bd = d; bi = i; }
    }
    return cum[bi];
  };
  const s0 = Math.min(at(edgePts[0]), at(edgePts[edgePts.length - 1]));
  const s1 = Math.max(at(edgePts[0]), at(edgePts[edgePts.length - 1]));
  if (deadB && L - s0 < 160 && s0 > 34) {
    const r = g.splitChain(c, s0);
    g.removeChain(r.right);
    return true;
  }
  if (deadA && s1 < 160 && L - s1 > 34) {
    const r = g.splitChain(c, s1);
    g.removeChain(r.left);
    return true;
  }
  if ((deadA && s1 < 160) || (deadB && L - s0 < 160)) {
    // the whole short stub is the problem
    if (L < 160) {
      g.removeChain(c);
      return true;
    }
  }
  return false;
}

/** apply one round of fixes; returns the number of actions */
export function repairRound(
  g: Graph, w: WNet, net: RoadNetwork, eMap: number[], nMap: number[], viol: Violation[], ctx: RepairContext,
): number {
  const chainOf = (k: number) => w.edges[eMap[k]].chain;
  const gidOf = (i: number) => w.nodes[nMap[i]].gid;
  const touched = new Set<number>();
  let actions = 0;
  const mid = (k: number): Pt => {
    const p = net.edges[k].pts;
    return p[p.length >> 1];
  };
  const sharedNode = (c1: number, c2: number): number => {
    const A = g.chains[c1];
    const B = g.chains[c2];
    if (!A?.alive || !B?.alive) return -1;
    for (const n of [A.a, A.b]) if (n === B.a || n === B.b) return n;
    return -1;
  };
  const minorMajor = (c1: number, c2: number): [number, number] =>
    g.chains[c1].imp < g.chains[c2].imp || (g.chains[c1].imp === g.chains[c2].imp && g.len(c1) < g.len(c2)) ? [c1, c2] : [c2, c1];
  for (const v of viol) {
    const cs = v.edges.map(chainOf);
    const where = v.edges.length ? mid(v.edges[0]) : v.nodes.length ? net.nodes[v.nodes[0]].p : [0, 0];
    const note = (what: string) => ctx.log.push(`${what} ${v.kind} @ ${where[0].toFixed(0)},${where[1].toFixed(0)}`);
    if (cs.some((c) => touched.has(c))) continue;
    switch (v.kind) {
      case 'clearance':
      case 'angle': {
        if (cs.length < 2) break;
        const [c1, c2] = cs;
        if (!g.chains[c1]?.alive || !g.chains[c2]?.alive) break;
        if (c1 === c2) {
          const at = v.nodes.length ? net.nodes[v.nodes[0]].p : mid(v.edges[0]);
          if (!pinch(g, c1, at, 26)) relaxCurve(g, c1, at, ctx);
        } else {
          const sn = sharedNode(c1, c2);
          if (sn >= 0 && levelKey(g.chains[c1].at) === levelKey(g.chains[c2].at) &&
            family(g.chains[c1].at.cls) === family(g.chains[c2].at.cls)) {
            const [mi, ma] = minorMajor(c1, c2);
            // escalate when the same junction keeps coming back: reroute, then merge, then contract
            const key = `${Math.round(where[0] / 20)},${Math.round(where[1] / 20)}`;
            const n = (ctx.tries.get(key) ?? 0) + 1;
            ctx.tries.set(key, n);
            if (n <= 2) {
              note('reroute');
              reroute(g, sn, mi, ma);
            } else if (n <= 4 && fixPair(g, mi, ma, 4)) {
              note('merge-branch');
            } else if (g.len(mi) < 90) {
              note('contract-branch');
              contractChain(g, mi);
            } else {
              note('reroute');
              reroute(g, sn, mi, ma);
            }
          } else if (sn >= 0 && family(g.chains[c1].at.cls) !== family(g.chains[c2].at.cls) &&
            levelKey(g.chains[c1].at) === 'G' && levelKey(g.chains[c2].at) === 'G' &&
            gradeSeparate(g, sn, [...new Set(g.nodes[sn].ch)].filter((o) => family(g.chains[o].at.cls) === 'road'))) {
            note('grade-separate');
          } else if (fixPair(g, c1, c2) || fixPair(g, c1, c2, 6)) {
            note('pair');
          } else {
            break;
          }
        }
        cs.forEach((c) => touched.add(c));
        actions++;
        break;
      }
      case 'shape':
      case 'length': {
        const c = cs[0];
        if (c === undefined || !g.chains[c]?.alive) break;
        const L = g.len(c);
        const tries = ctx.relaxed.get(c) ?? 0;
        // short chains whose curve cannot fit: merge their end junctions (moves them < 30 m)
        const tip = trimDeadEndTip(g, c, net.edges[v.edges[0]].pts);
        if (tip) note('trim');
        else if (pinch(g, c, mid(v.edges[0]), 26)) note('pinch');
        else if (L < 60 && (tries >= 2 || L < 40)) { note('contract'); contractChain(g, c); }
        else { note('relax'); relaxCurve(g, c, mid(v.edges[0]), ctx); }
        touched.add(c);
        actions++;
        break;
      }
      case 'nodeGap': {
        const [n1, n2] = v.nodes;
        const g1 = gidOf(n1);
        const g2 = gidOf(n2);
        const p1 = net.nodes[n1].p;
        const p2 = net.nodes[n2].p;
        const d = dist(p1, p2);
        if (g1 >= 0 && g2 >= 0) {
          const A = g.nodes[g1];
          const B = g.nodes[g2];
          if (!A.alive || !B.alive || A.outside || B.outside) break;
          const joint = (n: number) => g.nodes[n].ch.length === 2 && new Set(g.nodes[n].ch).size === 2 &&
            attrKey(g.chains[g.nodes[n].ch[0]].at) !== attrKey(g.chains[g.nodes[n].ch[1]].at);
          if (joint(g2) && slideJoint(g, g2, p1, 32 - d)) { actions++; break; }
          if (joint(g1) && slideJoint(g, g1, p2, 32 - d)) { actions++; break; }
          const keep = A.ch.length >= B.ch.length ? g1 : g2;
          note('merge');
          g.mergeNodes(keep, keep === g1 ? g2 : g1);
          actions++;
        } else {
          // joints of one chain on a hairpin: open the curve up
          const chainsAt = (i: number) => net.edges.map((e, k) => (e.a === i || e.b === i ? chainOf(k) : -1)).filter((c) => c >= 0);
          const c1 = chainsAt(n1);
          const c2 = chainsAt(n2);
          const same = c1.find((c) => c2.includes(c));
          if (same !== undefined && g.chains[same]?.alive && (g1 < 0 || g2 < 0)) {
            if (pinch(g, same, p1, 26)) { touched.add(same); actions++; break; }
            relaxCurve(g, same, [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2], ctx);
            touched.add(same);
            actions++;
            break;
          }
          // a joint placed too close: keep later joints away from the other node
          ctx.avoid.push(g1 < 0 ? p2 : p1);
          if (g1 < 0 && g2 < 0) ctx.avoid.push(p1);
          actions++;
        }
        break;
      }
      case 'elevation': {
        // a structure that cannot be built here becomes surface road (never a gap)
        const cand = new Set<number>();
        for (const c of cs) {
          const ch = g.chains[c];
          if (!ch?.alive) continue;
          if (ch.at.bridge || ch.at.tunnel) cand.add(c);
          for (const n of [ch.a, ch.b]) for (const o of g.nodes[n].ch) {
            const oc = g.chains[o];
            if (oc.alive && (oc.at.bridge || oc.at.tunnel)) cand.add(o);
          }
        }
        let best = -1;
        for (const c of cand) if (best < 0 || g.len(c) < g.len(best)) best = c;
        if (best < 0 || touched.has(best)) break;
        note(g.chains[best].at.tunnel ? 'surface-tunnel' : 'surface-bridge');
        flattenChain(g, best);
        touched.add(best);
        cs.forEach((c) => touched.add(c));
        actions++;
        break;
      }
      default:
        break;
    }
  }
  void choosePrefab;
  return actions;
}
