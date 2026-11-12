/**
 * Split chains into game segments (24..200 m) and fit one cubic Bezier per segment with
 * continuous tangents through joints.
 */
import type { NetPrefab, Pt, RoadClass } from '../types';
import {
  GEN_MAX_PIECE, GEN_MIN_PIECE, GEN_NODE_GAP, choosePrefab, clearance, maxPieceTurn, prefabIsOneway,
  targetPiece,
} from './params';
import {
  type Bez, angleBetween, bezArcSample, bezLength, cumLen, dist, fitBezier, pointAt, unit, vertexTurns,
} from './geom';
import type { Graph } from './graph';
import { PointGrid } from './spatial';

export interface WNode {
  x: number;
  z: number;
  outside: boolean;
  /** graph node id or -1 for joints */
  gid: number;
}

export interface WEdge {
  a: number;
  b: number;
  cls: RoadClass;
  prefab: NetPrefab;
  oneway: boolean;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
  name?: string;
  bezier: Bez;
  pts: Pt[];
  chain: number;
  imp: number;
  alive: boolean;
}

export interface WNet {
  nodes: WNode[];
  edges: WEdge[];
  /** chain id -> [first node, last node] (work node indices) */
  chainEnds: Map<number, [number, number]>;
}

const CORNER = 0.35; // rad, vertex turn treated as a corner (one-sided tangents)

function endMinLength(g: Graph, id: number, n: number): number {
  const c = g.chains[id];
  const node = g.nodes[n];
  if (node.ch.length < 2) return GEN_MIN_PIECE;
  const d0 = g.dirFrom(id, n, 15, c.a === c.b && n === c.b);
  const p0 = choosePrefab(c.at);
  let need = GEN_MIN_PIECE;
  for (const o of new Set(node.ch)) {
    if (o === id) continue;
    const oc = g.chains[o];
    const ang = angleBetween(d0, g.dirFrom(o, n, 15));
    if (ang >= (80 * Math.PI) / 180) continue;
    const clr = clearance(p0, choosePrefab(oc.at));
    need = Math.max(need, clr / Math.max(Math.sin(ang), 0.05) + 3);
  }
  return Math.min(GEN_MAX_PIECE, need);
}

export function segmentGraph(g: Graph): WNet {
  const nodes: WNode[] = [];
  const edges: WEdge[] = [];
  const map = new Map<number, number>();
  const pg = new PointGrid(32);
  const wnode = (gid: number): number => {
    let w = map.get(gid);
    if (w === undefined) {
      const n = g.nodes[gid];
      w = nodes.length;
      nodes.push({ x: n.x, z: n.z, outside: n.outside, gid });
      map.set(gid, w);
    }
    return w;
  };
  for (let i = 0; i < g.nodes.length; i++) {
    const n = g.nodes[i];
    if (n.alive && n.ch.length) {
      wnode(i);
      pg.add(n.x, n.z, map.get(i)!);
    }
  }
  const chainEnds = new Map<number, [number, number]>();
  const pairUsed = new Set<string>();
  const order = g.live().sort((a, b) => g.chains[b].imp - g.chains[a].imp);
  for (const id of order) {
    const c = g.chains[id];
    const pts = c.pts;
    const cum = cumLen(pts);
    const L = cum[cum.length - 1];
    const loop = c.a === c.b;
    if (L < GEN_MIN_PIECE - 2 || (loop && L < 3 * GEN_MIN_PIECE)) continue;
    const m = pts.length - 1;
    const turn = vertexTurns(pts);
    const T = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) T[i] = T[i - 1] + turn[i];
    const firstMin = endMinLength(g, id, c.a);
    const lastMin = endMinLength(g, id, c.b);
    let maxLen = Math.min(GEN_MAX_PIECE, Math.max(targetPiece(c.at.cls) * 1.25, GEN_MIN_PIECE));
    const pk = c.a < c.b ? `${c.a}:${c.b}` : `${c.b}:${c.a}`;
    if (loop) maxLen = Math.min(maxLen, L / 2.6);
    else if (pairUsed.has(pk) && L <= maxLen) maxLen = Math.max(GEN_MIN_PIECE, L / 1.6);
    const target = Math.min(targetPiece(c.at.cls), maxLen);
    const tmax = maxPieceTurn(c.at.cls);
    // vertices too close to existing nodes cannot become joints
    const bad = new Uint8Array(pts.length);
    for (let j = 1; j < m; j++) {
      pg.near(pts[j][0], pts[j][1], GEN_NODE_GAP, () => { bad[j] = 1; });
    }
    const solve = (useBad: boolean, turnLim: number, fMin: number, lMin: number): number[] | null => {
      const best = new Float64Array(pts.length).fill(Infinity);
      const prev = new Int32Array(pts.length).fill(-1);
      best[0] = 0;
      for (let j = 1; j <= m; j++) {
        if (j < m && useBad && bad[j]) continue;
        for (let i = j - 1; i >= 0; i--) {
          const len = cum[j] - cum[i];
          if (len > maxLen) break;
          if (best[i] === Infinity) continue;
          let mn = GEN_MIN_PIECE;
          if (i === 0) mn = Math.max(mn, fMin);
          if (j === m) mn = Math.max(mn, lMin);
          if (len < mn) continue;
          if (T[j - 1] - T[i] > turnLim && j - 1 > i) continue;
          if (dist(pts[i], pts[j]) < GEN_NODE_GAP) continue;
          const dev = (len - target) / target;
          let cost = 1 + 0.4 * dev * dev;
          if (j < m && turn[j] > CORNER) cost -= 0.6;
          const v = best[i] + cost;
          if (v < best[j]) {
            best[j] = v;
            prev[j] = i;
          }
        }
      }
      if (best[m] === Infinity) return null;
      const cuts: number[] = [];
      for (let j = m; j > 0; j = prev[j]) cuts.push(j);
      cuts.push(0);
      return cuts.reverse();
    };
    let cuts =
      solve(true, tmax, firstMin, lastMin) ??
      solve(true, Math.PI / 2, firstMin, lastMin) ??
      solve(false, Math.PI / 2, firstMin, lastMin) ??
      solve(false, Math.PI / 2, GEN_MIN_PIECE, GEN_MIN_PIECE) ??
      solve(false, Math.PI, GEN_MIN_PIECE, GEN_MIN_PIECE);
    if (!cuts) continue;
    if (cuts.length === 2) {
      if (pairUsed.has(pk)) continue;
      pairUsed.add(pk);
    }
    // tangents
    const tanAt = (j: number, side: -1 | 1): Pt => {
      const s = cum[j];
      if (j === 0) {
        const q = pointAt(pts, cum, Math.min(10, L / 3));
        return unit(q[0] - pts[0][0], q[1] - pts[0][1]);
      }
      if (j === m) {
        const q = pointAt(pts, cum, Math.max(L - 10, (2 * L) / 3));
        return unit(pts[m][0] - q[0], pts[m][1] - q[1]);
      }
      if (turn[j] > CORNER) {
        if (side < 0) {
          const q = pointAt(pts, cum, Math.max(cum[j] - 8, cum[j - 1]));
          return unit(pts[j][0] - q[0], pts[j][1] - q[1]);
        }
        const q = pointAt(pts, cum, Math.min(cum[j] + 8, cum[j + 1]));
        return unit(q[0] - pts[j][0], q[1] - pts[j][1]);
      }
      const q0 = pointAt(pts, cum, Math.max(0, s - 8));
      const q1 = pointAt(pts, cum, Math.min(L, s + 8));
      return unit(q1[0] - q0[0], q1[1] - q0[1]);
    };
    const prefab = choosePrefab(c.at);
    const oneway = c.at.oneway && prefabIsOneway(prefab);
    let prevNode = map.get(c.a)!;
    const first = prevNode;
    for (let k = 1; k < cuts.length; k++) {
      const i = cuts[k - 1];
      const j = cuts[k];
      let nb: number;
      if (k === cuts.length - 1) nb = map.get(c.b)!;
      else {
        nb = nodes.length;
        nodes.push({ x: pts[j][0], z: pts[j][1], outside: false, gid: -1 });
        pg.add(pts[j][0], pts[j][1], nb);
      }
      const A = nodes[prevNode];
      const B = nodes[nb];
      const piece = pts.slice(i, j + 1);
      piece[0] = [A.x, A.z];
      piece[piece.length - 1] = [B.x, B.z];
      let bez = fitBezier(piece, tanAt(i, 1), tanAt(j, -1));
      bez[0] = [A.x, A.z];
      bez[3] = [B.x, B.z];
      const bl = bezLength(bez);
      if (bl > 199 || bl < 24.5) {
        const d = dist(bez[0], bez[3]);
        const t0 = tanAt(i, 1);
        const t3 = tanAt(j, -1);
        bez = [bez[0], [bez[0][0] + t0[0] * d / 3, bez[0][1] + t0[1] * d / 3], [bez[3][0] - t3[0] * d / 3, bez[3][1] - t3[1] * d / 3], bez[3]];
      }
      edges.push({
        a: prevNode,
        b: nb,
        cls: c.at.cls,
        prefab,
        oneway,
        bridge: c.at.bridge,
        tunnel: c.at.tunnel,
        layer: c.at.layer,
        name: c.at.name,
        bezier: bez,
        pts: bezArcSample(bez, 10),
        chain: id,
        imp: c.imp,
        alive: true,
      });
      prevNode = nb;
    }
    chainEnds.set(id, [first, prevNode]);
  }
  return { nodes, edges, chainEnds };
}
