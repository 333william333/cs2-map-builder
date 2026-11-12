/**
 * Hand-placed (or synthesised) outside connections: build a highway or double track from a
 * border point into the map and join it to the existing network, keeping the graph legal.
 */
import type { NetPrefab, Pt, RoadClass, RoadEdge, RoadNetwork, RoadNode, TerrainResult } from '../types';
import {
  CLASS_INDEX, GEN_BRIDGE_ELEV, GEN_RAMP_GRADE, HALF, MAX_RAIL_OUTSIDE, MAX_ROAD_OUTSIDE, family,
} from './params';
import {
  type Bez, angleBetween, bezArcSample, bezLength, bezPoint, cumLen, dist, fitBezier, pointAt, segIntersect, unit,
  vertexTurns,
} from './geom';
import { sampleHeight } from './elevation';
import { SegGrid } from './spatial';
import { findViolations } from './validate';

export interface ConnectorResult {
  net: RoadNetwork;
  ok: boolean;
  reason?: string;
}

const CORNER_GAP = 300;
const MIN_OUTSIDE_GAP = 400;
const APPROACH = 100;
const MAX_PIECE = 140;
const MIN_PIECE = 30;
const STUB = 300;
const MAX_TARGETS = 24;
const ROAD_RANK: Partial<Record<RoadClass, number>> = {
  motorway: 0, trunk: 0, primary: 1, secondary: 2, tertiary: 3, residential: 4, service: 6,
};

interface Crossing {
  s: number;
  edge: number;
  p: Pt;
  attach: boolean;
}

interface Plan {
  /** route polyline from the border point, ~5 m spacing */
  route: Pt[];
  /** existing node the route ends at, or -1 */
  endNode: number;
  /** crossings that become nodes (the last one is the attachment when endNode < 0 and attach) */
  cuts: Crossing[];
}

function waterFn(terrain: TerrainResult) {
  const N = terrain.playable.size;
  const ext = terrain.playable.extentM;
  const cell = ext / N;
  const mask = terrain.waterMask;
  return (x: number, z: number): number => {
    if (!mask || mask.length !== N * N) return 0;
    const c = Math.min(N - 1, Math.max(0, Math.floor((x + ext / 2) / cell)));
    const r = Math.min(N - 1, Math.max(0, Math.floor((ext / 2 - z) / cell)));
    return mask[r * N + c];
  };
}

/** snap to the nearest border edge, at least CORNER_GAP from the corners */
function snapToBorder(p: Pt): { b: Pt; n: Pt } {
  const lim = HALF - CORNER_GAP;
  const clamp = (v: number) => Math.max(-lim, Math.min(lim, v));
  const dx = HALF - Math.abs(p[0]);
  const dz = HALF - Math.abs(p[1]);
  if (dx <= dz) {
    const sx = p[0] >= 0 ? 1 : -1;
    return { b: [sx * HALF, clamp(p[1])], n: [-sx, 0] };
  }
  const sz = p[1] >= 0 ? 1 : -1;
  return { b: [clamp(p[0]), sz * HALF], n: [0, -sz] };
}

function hermite(p0: Pt, m0: Pt, p1: Pt, m1: Pt, step: number): Pt[] {
  const D = dist(p0, p1);
  const n = Math.max(2, Math.ceil((D * 1.2) / step));
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    out.push([
      h00 * p0[0] + h10 * m0[0] + h01 * p1[0] + h11 * m1[0],
      h00 * p0[1] + h10 * m0[1] + h01 * p1[1] + h11 * m1[1],
    ]);
  }
  out[out.length - 1] = [p1[0], p1[1]];
  return out;
}

function line(a: Pt, b: Pt, step: number): Pt[] {
  const n = Math.max(1, Math.ceil(dist(a, b) / step));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  return out;
}

/** split a cubic at t (de Casteljau) */
function splitBez(b: Bez, t: number): [Bez, Bez] {
  const lerp = (p: Pt, q: Pt): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const a1 = lerp(b[0], b[1]);
  const a2 = lerp(b[1], b[2]);
  const a3 = lerp(b[2], b[3]);
  const c1 = lerp(a1, a2);
  const c2 = lerp(a2, a3);
  const m = lerp(c1, c2);
  return [[b[0], a1, c1, m], [m, c2, a3, b[3]]];
}

function nearestT(b: Bez, p: Pt): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i <= 400; i++) {
    const q = bezPoint(b, i / 400);
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bd) {
      bd = d;
      best = i / 400;
    }
  }
  return best;
}

export function addOutsideConnection(
  net: RoadNetwork,
  terrain: TerrainResult,
  kind: 'road' | 'rail',
  p: Pt,
): ConnectorResult {
  const fail = (reason: string): ConnectorResult => ({ net, ok: false, reason });
  if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return fail('Invalid point.');
  const { b: B, n: N } = snapToBorder(p);
  const cls: RoadClass = kind === 'rail' ? 'rail' : 'motorway';
  const prefab: NetPrefab = kind === 'rail' ? 'rail_double' : 'highway_twoway_2lane';
  const water = waterFn(terrain);
  const ground = (q: Pt) => sampleHeight(terrain.playable, q[0], q[1]);

  // ---- existing network indices
  const idxOf = new Map<number, number>();
  net.nodes.forEach((n, i) => idxOf.set(n.id, i));
  const inc: number[][] = net.nodes.map(() => []);
  net.edges.forEach((e, k) => {
    const a = idxOf.get(e.a);
    const b = idxOf.get(e.b);
    if (a !== undefined) inc[a].push(k);
    if (b !== undefined) inc[b].push(k);
  });
  const isRailEdge = (e: RoadEdge) => e.cls === 'rail';
  let roadOut = 0;
  let railOut = 0;
  for (let i = 0; i < net.nodes.length; i++) {
    const n = net.nodes[i];
    if (!n.outside || !inc[i].length) continue;
    const rail = isRailEdge(net.edges[inc[i][0]]);
    if (rail) railOut++;
    else roadOut++;
    if ((kind === 'rail') === rail && dist(n.p, B) < MIN_OUTSIDE_GAP) {
      return fail(`Too close to an existing ${kind === 'rail' ? 'rail connection' : 'road connection'} (at least ${MIN_OUTSIDE_GAP} m).`);
    }
  }
  if (kind === 'road' && roadOut >= MAX_ROAD_OUTSIDE) return fail(`The map already has ${MAX_ROAD_OUTSIDE} road connections, which is the maximum.`);
  if (kind === 'rail' && railOut >= MAX_RAIL_OUTSIDE) return fail(`The map already has ${MAX_RAIL_OUTSIDE} rail connections, which is the maximum.`);

  let maxNode = -1;
  for (const n of net.nodes) maxNode = Math.max(maxNode, n.id);
  let maxEdge = -1;
  for (const e of net.edges) maxEdge = Math.max(maxEdge, e.id);

  const grid = new SegGrid(64);
  const ebb = new Float64Array(net.edges.length * 4);
  net.edges.forEach((e, k) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < e.pts.length; i++) {
      const q = e.pts[i];
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]);
      z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]);
      if (i) grid.add(e.pts[i - 1][0], e.pts[i - 1][1], q[0], q[1], k);
    }
    ebb[k * 4] = x0; ebb[k * 4 + 1] = z0; ebb[k * 4 + 2] = x1; ebb[k * 4 + 3] = z1;
  });

  /** same-family edges attach; other ground edges become level crossings; structures are passed */
  const sameFamily = (e: RoadEdge) =>
    kind === 'rail' ? e.cls === 'rail' : family(e.cls) === 'road' && e.cls !== 'pedestrian' && e.cls !== 'service';

  const suitableNode = (i: number): boolean => {
    const n = net.nodes[i];
    if (n.outside || n.elevation !== 0 || !inc[i].length || inc[i].length >= 4) return false;
    for (const k of inc[i]) {
      const e = net.edges[k];
      if (e.bridge || e.tunnel || !sameFamily(e)) return false;
    }
    return true;
  };

  // ---- candidate targets
  const P0: Pt = [B[0] + N[0] * APPROACH, B[1] + N[1] * APPROACH];
  const slopeCost = (a: Pt, b: Pt): { wet: number; climb: number } => {
    const L = dist(a, b);
    const n = Math.max(2, Math.ceil(L / 50));
    let wet = 0;
    let climb = 0;
    let prev = ground(a);
    for (let i = 1; i <= n; i++) {
      const q: Pt = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
      if (water(q[0], q[1])) wet += L / n;
      const h = ground(q);
      const grade = Math.abs(h - prev) / (L / n);
      if (grade > 0.08) climb += (grade - 0.08) * (L / n);
      prev = h;
    }
    return { wet, climb };
  };
  const cands: { i: number; score: number }[] = [];
  net.nodes.forEach((n, i) => {
    if (!suitableNode(i)) return;
    const d = dist(P0, n.p);
    if (d > 9000 || d < 40) return;
    const dir = unit(n.p[0] - P0[0], n.p[1] - P0[1]);
    if (angleBetween(dir, N) > (70 * Math.PI) / 180) return;
    let rank = 0;
    if (kind === 'road') {
      for (const k of inc[i]) rank = Math.max(rank, 6 - (ROAD_RANK[net.edges[k].cls] ?? 6));
      rank = 6 - rank;
    }
    const deg = inc[i].length;
    cands.push({ i, score: d + 250 * rank + (deg === 3 ? 150 : 0) + angleBetween(dir, N) * 300 });
  });
  cands.sort((a, b) => a.score - b.score);
  const shortlist = cands.slice(0, MAX_TARGETS * 2).map((c) => {
    const { wet, climb } = slopeCost(P0, net.nodes[c.i].p);
    return { i: c.i, score: c.score + wet * 3 + climb * 30 };
  }).sort((a, b) => a.score - b.score).slice(0, MAX_TARGETS);

  const edgeIndexOf = new Map<RoadEdge, number>();
  net.edges.forEach((e, k) => edgeIndexOf.set(e, k));

  // ---- route building
  const crossingsOf = (route: Pt[], skipEdges: Set<number>): Crossing[] => {
    const out: Crossing[] = [];
    let acc = 0;
    for (let i = 0; i + 1 < route.length; i++) {
      const [ax, az] = route[i];
      const [bx, bz] = route[i + 1];
      const sl = Math.hypot(bx - ax, bz - az);
      const hits: Crossing[] = [];
      grid.query(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (sid) => {
        const k = grid.owner(sid);
        if (skipEdges.has(k)) return;
        const e = net.edges[k];
        if (e.bridge || e.tunnel) return;
        const [cx, cz, dx, dz] = grid.get(sid);
        const r = segIntersect(ax, az, bx, bz, cx, cz, dx, dz);
        if (!r) return;
        hits.push({ s: acc + r[0] * sl, edge: k, p: [ax + (bx - ax) * r[0], az + (bz - az) * r[0]], attach: sameFamily(e) });
      });
      hits.sort((x, y) => x.s - y.s);
      for (const h of hits) {
        if (out.some((o) => o.edge === h.edge && Math.abs(o.s - h.s) < 1)) continue;
        out.push(h);
      }
      acc += sl;
    }
    return out;
  };

  const planTo = (T: Pt, endNode: number): Plan | null => {
    const head = line(B, P0, 5);
    const D = dist(P0, T);
    const tail = D < 1 ? [] : hermite(P0, [N[0] * D, N[1] * D], T, (() => {
      const u = unit(T[0] - P0[0], T[1] - P0[1]);
      return [u[0] * D, u[1] * D] as Pt;
    })(), 5);
    let route = [...head, ...tail];
    const skip = new Set<number>(endNode >= 0 ? inc[endNode] : []);
    const cr = crossingsOf(route, skip);
    const cuts: Crossing[] = [];
    let end = endNode;
    for (const c of cr) {
      if (c.s < APPROACH + 20) return null;
      cuts.push(c);
      if (c.attach) {
        // stop at the first road (or track) of our own kind
        const cum = cumLen(route);
        const k = Math.max(1, cum.findIndex((v) => v >= c.s));
        route = [...route.slice(0, k), c.p];
        end = -1;
        break;
      }
    }
    if (new Set(cuts.map((c) => c.edge)).size !== cuts.length) return null;
    return { route, endNode: end, cuts };
  };

  // ---- assemble a candidate network from a plan
  const build = (plan: Plan, stub: boolean): { out: RoadNetwork; check: () => boolean; problem?: string } | null => {
    const route = plan.route;
    const cum = cumLen(route);
    const L = cum[cum.length - 1];
    // fixed cut positions
    const fixed: number[] = [0, APPROACH];
    for (const c of plan.cuts) fixed.push(c.s);
    if (!plan.cuts.length || !plan.cuts[plan.cuts.length - 1].attach || plan.endNode >= 0) {
      if (Math.abs(fixed[fixed.length - 1] - L) > 0.01) fixed.push(L);
    }
    fixed[fixed.length - 1] = L;
    for (let i = 1; i < fixed.length; i++) if (fixed[i] - fixed[i - 1] < MIN_PIECE) return null;
    const turns = vertexTurns(route);
    const T = new Float64Array(route.length);
    for (let i = 1; i < route.length; i++) T[i] = T[i - 1] + turns[i];
    const cutPos: number[] = [0];
    for (let f = 1; f < fixed.length; f++) {
      const a = fixed[f - 1];
      const b = fixed[f];
      const len = b - a;
      let n = Math.max(1, Math.ceil(len / MAX_PIECE));
      for (; n <= Math.floor(len / MIN_PIECE); n++) {
        let okTurn = true;
        for (let k = 0; k < n; k++) {
          const s0 = a + (len * k) / n;
          const s1 = a + (len * (k + 1)) / n;
          const i0 = cum.findIndex((v) => v >= s0);
          const i1 = cum.findIndex((v) => v >= s1 - 1e-6);
          if (i1 > i0 + 1 && T[i1 - 1] - T[Math.max(0, i0)] > (60 * Math.PI) / 180) okTurn = false;
        }
        if (okTurn) break;
      }
      if (n > Math.floor(len / MIN_PIECE)) return null;
      for (let k = 1; k <= n; k++) cutPos.push(a + (len * k) / n);
    }
    // nodes
    const newNodes: RoadNode[] = [];
    let nid = maxNode;
    let eid = maxEdge;
    const nodeAtCut: (number)[] = []; // node id per cut position
    const isFixedCross = (s: number) => plan.cuts.find((c) => Math.abs(c.s - s) < 0.5);
    const replaced = new Map<number, RoadEdge[]>(); // existing edge index -> pieces
    const splitNodes: RoadNode[] = [];
    for (let k = 0; k < cutPos.length; k++) {
      const s = cutPos[k];
      if (k === cutPos.length - 1 && plan.endNode >= 0) {
        nodeAtCut.push(net.nodes[plan.endNode].id);
        continue;
      }
      const c = isFixedCross(s);
      let q = pointAt(route, cum, s);
      if (c) {
        // split the crossed edge exactly at the crossing
        const e = net.edges[c.edge];
        const ia = idxOf.get(e.a)!;
        const ib = idxOf.get(e.b)!;
        if (net.nodes[ia].elevation !== 0 || net.nodes[ib].elevation !== 0) return null;
        const t = nearestT(e.bezier, c.p);
        const [b1, b2] = splitBez(e.bezier, t);
        if (bezLength(b1) < MIN_PIECE || bezLength(b2) < MIN_PIECE) return null;
        q = [b1[3][0], b1[3][1]];
        b2[0] = q;
        const node: RoadNode = { id: ++nid, p: q, ground: Math.round(ground(q) * 100) / 100, elevation: 0, outside: false };
        splitNodes.push(node);
        const mk = (bz: Bez, id: number, a: number, b: number): RoadEdge => {
          const r: RoadEdge = { ...e, id, a, b, bezier: bz, pts: bezArcSample(bz, 10) };
          return r;
        };
        replaced.set(c.edge, [mk(b1, e.id, e.a, node.id), mk(b2, ++eid, node.id, e.b)]);
        nodeAtCut.push(node.id);
        continue;
      }
      const node: RoadNode = {
        id: ++nid,
        p: k === 0 ? [B[0], B[1]] : q,
        ground: Math.round(ground(k === 0 ? B : q) * 100) / 100,
        elevation: 0,
        outside: k === 0,
      };
      newNodes.push(node);
      nodeAtCut.push(node.id);
    }
    const allNew = new Map<number, RoadNode>();
    for (const n of [...newNodes, ...splitNodes]) allNew.set(n.id, n);
    const nodeById = (id: number): RoadNode => allNew.get(id) ?? net.nodes[idxOf.get(id)!];
    // route vertices snapped to node positions
    const tanAt = (s: number, first: boolean, last: boolean): Pt => {
      if (first) return [N[0], N[1]];
      if (last) {
        const q = pointAt(route, cum, Math.max(0, L - 10));
        return unit(route[route.length - 1][0] - q[0], route[route.length - 1][1] - q[1]);
      }
      const q0 = pointAt(route, cum, Math.max(0, s - 8));
      const q1 = pointAt(route, cum, Math.min(L, s + 8));
      return unit(q1[0] - q0[0], q1[1] - q0[1]);
    };
    const newEdges: RoadEdge[] = [];
    const wet: boolean[] = [];
    for (let k = 1; k < cutPos.length; k++) {
      const s0 = cutPos[k - 1];
      const s1 = cutPos[k];
      const A = nodeById(nodeAtCut[k - 1]);
      const Bn = nodeById(nodeAtCut[k]);
      const piece: Pt[] = [A.p];
      for (let i = 0; i < route.length; i++) if (cum[i] > s0 + 1e-6 && cum[i] < s1 - 1e-6) piece.push(route[i]);
      piece.push(Bn.p);
      let w = false;
      for (let s = s0; s <= s1; s += 4) {
        const q = pointAt(route, cum, s);
        if (water(q[0], q[1])) w = true;
      }
      const t0 = k === 1 ? ([N[0], N[1]] as Pt) : tanAt(s0, false, false);
      const t3 = k === 1 ? ([N[0], N[1]] as Pt) : tanAt(s1, false, k === cutPos.length - 1);
      const bz = fitBezier(piece, t0, t3);
      bz[0] = A.p;
      bz[3] = Bn.p;
      newEdges.push({
        id: ++eid, a: A.id, b: Bn.id, cls, prefab, pts: bezArcSample(bz, 10), bezier: bz,
        oneway: false, bridge: w, tunnel: false,
      });
      wet.push(w);
    }
    // elevations along the connector (bridge lift + ramps), existing nodes must stay at 0
    const ids = nodeAtCut;
    const g = ids.map((id) => nodeById(id).ground);
    const req = ids.map(() => -Infinity);
    for (let k = 0; k < wet.length; k++) {
      if (!wet[k]) continue;
      // bridge run reference: lowest bank of the run
      let r0 = k;
      let r1 = k;
      while (r0 > 0 && wet[r0 - 1]) r0--;
      while (r1 + 1 < wet.length && wet[r1 + 1]) r1++;
      let ref = Math.min(g[r0], g[r1 + 1]);
      const q = nodeById(ids[k]).p;
      if (water(q[0], q[1]) === 1 && terrain.hasSea) ref = Math.max(ref, terrain.seaLevel);
      for (const j of [k, k + 1]) req[j] = Math.max(req[j], Math.max(g[j], ref) + GEN_BRIDGE_ELEV);
    }
    const Y = req.slice();
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 1; k < Y.length; k++) Y[k] = Math.max(Y[k], Y[k - 1] - GEN_RAMP_GRADE * (cutPos[k] - cutPos[k - 1]));
      for (let k = Y.length - 2; k >= 0; k--) Y[k] = Math.max(Y[k], Y[k + 1] - GEN_RAMP_GRADE * (cutPos[k + 1] - cutPos[k]));
    }
    for (let k = 0; k < ids.length; k++) {
      const e = Number.isFinite(Y[k]) ? Math.max(0, Y[k] - g[k]) : 0;
      const n = allNew.get(ids[k]);
      if (n) n.elevation = Math.round(e * 100) / 100;
      else if (e > 0.005) return null; // would lift an existing node
      if (e > 0.005 && splitNodes.some((s) => s.id === ids[k])) return null;
    }
    // assemble
    const insertAfter = CLASS_INDEX[cls];
    const edges: RoadEdge[] = [];
    let inserted = false;
    for (let k = 0; k < net.edges.length; k++) {
      const e = net.edges[k];
      if (!inserted && CLASS_INDEX[e.cls] > insertAfter) {
        edges.push(...newEdges);
        inserted = true;
      }
      const rep = replaced.get(k);
      if (rep) edges.push(...rep);
      else edges.push(e);
    }
    if (!inserted) edges.push(...newEdges);
    const out: RoadNetwork = { nodes: [...net.nodes, ...newNodes, ...splitNodes], edges };

    const check = (): boolean => {
      // validate locally: changed edges plus everything near them
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const e of [...newEdges, ...[...replaced.values()].flat()]) {
        for (const q of e.pts) {
          x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]);
          z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]);
        }
      }
      const M = 150;
      const changedIds = new Set<number>([...newEdges, ...[...replaced.values()].flat()].map((e) => e.id));
      const subEdges = edges.filter((e) => {
        if (changedIds.has(e.id) && !edgeIndexOf.has(e)) return true;
        const j = edgeIndexOf.get(e)!;
        return !(ebb[j * 4] > x1 + M || ebb[j * 4 + 2] < x0 - M || ebb[j * 4 + 1] > z1 + M || ebb[j * 4 + 3] < z0 - M);
      });
      const used = new Set<number>();
      for (const e of subEdges) { used.add(e.a); used.add(e.b); }
      const subNodes = out.nodes.filter((n) => used.has(n.id));
      const sub: RoadNetwork = { nodes: subNodes, edges: subEdges };
      const newNodeIds = new Set<number>(allNew.keys());
      const v = findViolations(sub).filter((x) =>
        x.edges.some((k) => changedIds.has(subEdges[k].id)) || x.nodes.some((k) => newNodeIds.has(subNodes[k].id)),
      );
      return v.length === 0;
    };
    void stub;
    return { out, check };
  };


  // ---- try targets
  const tried = new Set<number>();
  const queue = shortlist.map((c) => c.i);
  let attempts = 0;
  while (queue.length && attempts < MAX_TARGETS + 8) {
    const i = queue.shift()!;
    if (tried.has(i)) continue;
    tried.add(i);
    attempts++;
    const plan = planTo(net.nodes[i].p, i);
    if (!plan) continue;
    const last = plan.cuts[plan.cuts.length - 1];
    if (last && last.attach) {
      // attaching near an existing node: prefer that node instead of a short split
      const e = net.edges[last.edge];
      for (const id of [e.a, e.b]) {
        const j = idxOf.get(id)!;
        if (dist(net.nodes[j].p, last.p) < 40 && suitableNode(j) && !tried.has(j)) queue.unshift(j);
      }
    }
    const r = build(plan, false);
    if (r && r.check()) return { net: r.out, ok: true };
  }

  // ---- unconnected stub straight into the map
  const firstLand = (() => {
    for (let s = 0; s <= 600; s += 10) {
      const q: Pt = [B[0] + N[0] * s, B[1] + N[1] * s];
      if (!water(q[0], q[1])) return s;
    }
    return -1;
  })();
  if (firstLand < 0) return fail('The point is in open water with no land within reach.');
  for (const extra of [0, 100, 200, 300]) {
    let len = Math.max(STUB, firstLand + 200) + extra;
    if (len > 900) break;
    const endP: Pt = [B[0] + N[0] * len, B[1] + N[1] * len];
    if (water(endP[0], endP[1])) continue;
    len = Math.round(len);
    const route = line(B, endP, 5);
    const cr = crossingsOf(route, new Set());
    if (cr.length) continue;
    const r = build({ route, endNode: -1, cuts: [] }, true);
    if (r && r.check()) {
      return {
        net: r.out,
        ok: true,
        reason: kind === 'rail'
          ? 'The rail connection could not be linked to any track network, so a track stub was added.'
          : 'The road connection could not be linked to the road network, so a highway stub was added.',
      };
    }
  }
  return fail('No valid connection could be built from this point.');
}
