/**
 * Bridges and tunnels that cannot be built as tagged are reshaped, never removed:
 *  - a bridge and a tunnel too close to each other (viaduct straight into a tunnel) get room for
 *    their ramps by turning the facing ends into surface road;
 *  - a structure that still cannot be built becomes a surface road with real junctions where it
 *    crosses other surface roads.
 */
import type { Pt } from '../types';
import { GEN_BRIDGE_ELEV, GEN_RAMP_GRADE, GEN_TUNNEL_DEPTH, levelKey } from './params';
import { segIntersect } from './geom';
import type { Graph } from './graph';

const isStruct = (g: Graph, id: number) => g.chains[id].at.bridge || g.chains[id].at.tunnel;

/** turn a structure chain into a surface road and node it with the surface roads it crosses */
export function flattenChain(g: Graph, id: number): void {
  const c = g.chains[id];
  if (!c.alive || (!c.at.bridge && !c.at.tunnel)) return;
  c.at = { ...c.at, bridge: false, tunnel: false, layer: 0 };
  // crossings with surface chains: split both at the crossing and join them
  type X = { s: number; other: number; t: number; p: Pt };
  const xs: X[] = [];
  const p = c.pts;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const q of p) {
    x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]);
    z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]);
  }
  const cand = g.live().filter((o) => {
    if (o === id) return false;
    for (const q of g.chains[o].pts) if (q[0] >= x0 && q[0] <= x1 && q[1] >= z0 && q[1] <= z1) return true;
    return false;
  });
  let acc = 0;
  for (let i = 0; i + 1 < p.length; i++) {
    const sl = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    for (const o of cand) {
      const oc = g.chains[o];
      if (levelKey(oc.at) !== 'G' || oc.a === c.a || oc.a === c.b || oc.b === c.a || oc.b === c.b) continue;
      let accO = 0;
      for (let j = 0; j + 1 < oc.pts.length; j++) {
        const q0 = oc.pts[j];
        const q1 = oc.pts[j + 1];
        const so = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
        const r = segIntersect(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], q0[0], q0[1], q1[0], q1[1]);
        if (r) xs.push({ s: acc + r[0] * sl, other: o, t: accO + r[1] * so, p: [p[i][0] + (p[i + 1][0] - p[i][0]) * r[0], p[i][1] + (p[i + 1][1] - p[i][1]) * r[0]] });
        accO += so;
      }
    }
    acc += sl;
  }
  if (!xs.length) return;
  xs.sort((a, b) => b.s - a.s);
  let cur = id;
  const L = g.len(id);
  for (const x of xs) {
    if (x.s < 1 || x.s > L - 1 || !g.chains[x.other].alive) continue;
    const r = g.splitChain(cur, x.s);
    cur = r.left;
    const oL = g.len(x.other);
    if (x.t < 1 || x.t > oL - 1) {
      const oc = g.chains[x.other];
      g.mergeNodes(x.t < 1 ? oc.a : oc.b, r.node);
      continue;
    }
    const ro = g.splitChain(x.other, x.t);
    g.mergeNodes(r.node, ro.node);
  }
}

/**
 * A road crossing a railway at a level crossing too acute to build: lift the road over the
 * railway as a short bridge and remove the shared node. The road stays continuous.
 */
export function gradeSeparate(g: Graph, n: number, road: number[]): boolean {
  const N = g.nodes[n];
  if (!N.alive || N.outside || road.length !== 2) return false;
  const [r1, r2] = road;
  const span = 55;
  for (const r of road) if (!g.chains[r]?.alive || g.chains[r].at.bridge || g.chains[r].at.tunnel || g.len(r) < span + 40) return false;
  // detach the road from the crossing node onto its own node
  const m = g.addNode(N.x, N.z);
  for (const r of road) {
    const c = g.chains[r];
    if (c.a === n) c.a = m;
    if (c.b === n) c.b = m;
    N.ch.splice(N.ch.indexOf(r), 1);
    g.nodes[m].ch.push(r);
  }
  // the stretch around the crossing becomes a bridge
  for (const r of [r1, r2]) {
    const c = g.chains[r];
    const L = g.len(r);
    const s = c.a === m ? span : L - span;
    const sp = g.splitChain(r, s);
    const near = c.a === m ? sp.left : sp.right;
    g.chains[near].at = { ...g.chains[near].at, bridge: true, tunnel: false, layer: 1 };
  }
  if (!g.dissolve(m)) g.mergeNodes(n, m);
  return true;
}

/** convert the first `len` metres of chain id from node n into surface road */
function trimEnd(g: Graph, id: number, n: number, len: number): void {
  const c = g.chains[id];
  const L = g.len(id);
  if (len >= L - 40) {
    flattenChain(g, id);
    return;
  }
  const s = c.a === n ? len : L - len;
  const r = g.splitChain(id, s);
  const near = c.a === n ? r.left : r.right;
  flattenChain(g, near);
}

/**
 * Give opposite structures (bridge vs tunnel) enough surface road between them for both ramps.
 * Returns the number of structures shortened or flattened.
 */
export function fixStructureTransitions(g: Graph): number {
  const need = (GEN_BRIDGE_ELEV + GEN_TUNNEL_DEPTH) / GEN_RAMP_GRADE + 20;
  let changed = 0;
  for (const id of g.live()) {
    const c = g.chains[id];
    if (!c.alive || !c.at.bridge) continue;
    for (const n of [c.a, c.b]) {
      if (!g.chains[id].alive) break;
      // shortest surface path from n to a tunnel end, within `need`
      const dist = new Map<number, number>([[n, 0]]);
      const queue: number[] = [n];
      let hit: { t: number; m: number; d: number } | null = null;
      while (queue.length) {
        queue.sort((x, y) => dist.get(x)! - dist.get(y)!);
        const u = queue.shift()!;
        const du = dist.get(u)!;
        for (const o of g.nodes[u].ch) {
          const oc = g.chains[o];
          if (!oc.alive || o === id) continue;
          if (oc.at.tunnel) {
            if (!hit || du < hit.d) hit = { t: o, m: u, d: du };
            continue;
          }
          if (isStruct(g, o)) continue;
          const v = oc.a === u ? oc.b : oc.a;
          const dv = du + g.len(o);
          if (dv >= need || (dist.get(v) ?? Infinity) <= dv) continue;
          dist.set(v, dv);
          queue.push(v);
        }
      }
      if (!hit) continue;
      // shorten the shorter structure first, then the other
      let missing = need - hit.d;
      const lb = g.len(id);
      const lt = g.len(hit.t);
      const first = lb <= lt ? { s: id, at: n, L: lb } : { s: hit.t, at: hit.m, L: lt };
      const second = first.s === id ? { s: hit.t, at: hit.m, L: lt } : { s: id, at: n, L: lb };
      const take1 = Math.min(missing / 2 + Math.max(0, missing / 2 - (second.L - 40)), first.L);
      trimEnd(g, first.s, first.at, take1);
      missing -= take1;
      if (missing > 0 && g.chains[second.s].alive) trimEnd(g, second.s, second.at, missing);
      changed++;
      break;
    }
  }
  return changed;
}
