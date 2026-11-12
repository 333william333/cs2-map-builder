/** Hard legality checks for a RoadNetwork as the CS2 importer mod will build it. */
import type { RoadEdge, RoadNetwork, RoadNode } from '../types';
import {
  BORDER_MARGIN, BRIDGE_MIN_ELEV, CLASS_INDEX, HALF, MAX_EDGE, MAX_RAIL_OUTSIDE, MAX_RAMP_GRADE,
  MAX_ROAD_OUTSIDE, MAX_TURN_DEG, MIN_EDGE, MIN_NODE_ANGLE_DEG, MIN_NODE_GAP, OUTSIDE_APPROACH_TOL_DEG,
  PREFAB_WIDTH, TUNNEL_MIN_DEPTH, VERTICAL_CLEARANCE, clearance, levelKey, levelRank, minRadius,
} from './params';
import {
  angleBetween, bezEndDir, bezLength, bezMinRadius, bezStartDir, bezTotalTurn, pointSegDist2, polyLength,
  projectSeg, segIntersect, segSegDist,
} from './geom';
import { BoxGrid, PointGrid } from './spatial';

export type ViolationKind =
  | 'structure' | 'length' | 'shape' | 'nodeGap' | 'angle' | 'clearance' | 'border' | 'outside'
  | 'elevation' | 'order';

export interface Violation {
  kind: ViolationKind;
  msg: string;
  /** indices into net.edges */
  edges: number[];
  /** indices into net.nodes */
  nodes: number[];
}

const DEG = Math.PI / 180;
const OUTSIDE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'rail']);

function edgeLevel(e: RoadEdge) {
  return { bridge: e.bridge, tunnel: e.tunnel, layer: 0 };
}

/**
 * All violations of the in-game rules. With `focus` (edge indices) only problems involving
 * those edges (and their nodes) are reported: used between repair rounds.
 */
export function findViolations(net: RoadNetwork, maxReports = 100000, focus?: Set<number>): Violation[] {
  const out: Violation[] = [];
  const add = (v: Violation) => {
    if (out.length < maxReports) out.push(v);
  };
  const { nodes, edges } = net;
  const byId = new Map<number, number>();
  nodes.forEach((n, i) => {
    if (byId.has(n.id)) add({ kind: 'structure', msg: `duplicate node id ${n.id}`, edges: [], nodes: [i] });
    byId.set(n.id, i);
  });
  const deg = new Int32Array(nodes.length);
  const inc: number[][] = nodes.map(() => []);
  const pairs = new Map<string, number>();
  const edgeIds = new Set<number>();
  const ok: boolean[] = [];
  edges.forEach((e, k) => {
    ok[k] = false;
    if (edgeIds.has(e.id)) add({ kind: 'structure', msg: `duplicate edge id ${e.id}`, edges: [k], nodes: [] });
    edgeIds.add(e.id);
    const ia = byId.get(e.a);
    const ib = byId.get(e.b);
    if (ia === undefined || ib === undefined) {
      add({ kind: 'structure', msg: `edge ${e.id} references a missing node`, edges: [k], nodes: [] });
      return;
    }
    if (ia === ib) {
      add({ kind: 'structure', msg: `edge ${e.id} starts and ends at node ${e.a}`, edges: [k], nodes: [ia] });
      return;
    }
    const A = nodes[ia].p;
    const B = nodes[ib].p;
    const bz = e.bezier;
    if (bz[0][0] !== A[0] || bz[0][1] !== A[1] || bz[3][0] !== B[0] || bz[3][1] !== B[1]) {
      add({ kind: 'structure', msg: `edge ${e.id} bezier endpoints differ from its nodes`, edges: [k], nodes: [ia, ib] });
    }
    const pl = e.pts.length;
    if (pl < 2 || e.pts[0][0] !== A[0] || e.pts[0][1] !== A[1] || e.pts[pl - 1][0] !== B[0] || e.pts[pl - 1][1] !== B[1]) {
      add({ kind: 'structure', msg: `edge ${e.id} pts endpoints differ from its nodes`, edges: [k], nodes: [ia, ib] });
    }
    for (const v of [...bz, ...e.pts]) {
      if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) {
        add({ kind: 'structure', msg: `edge ${e.id} has non-finite coordinates`, edges: [k], nodes: [] });
        return;
      }
    }
    deg[ia]++;
    deg[ib]++;
    inc[ia].push(k);
    inc[ib].push(k);
    const pk = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
    const prev = pairs.get(pk);
    if (prev !== undefined) {
      add({ kind: 'structure', msg: `edges ${edges[prev].id} and ${e.id} connect the same two nodes`, edges: [prev, k], nodes: [ia, ib] });
    } else pairs.set(pk, k);
    ok[k] = true;
    if (focus && !focus.has(k)) return;

    // length and shape
    const L = bezLength(bz, 96);
    if (L < MIN_EDGE - 1e-6 || L > MAX_EDGE + 1e-6) {
      add({ kind: 'length', msg: `edge ${e.id} (${e.cls}) length ${L.toFixed(1)} m outside ${MIN_EDGE}..${MAX_EDGE}`, edges: [k], nodes: [] });
    }
    let maxStep = 0;
    for (let i = 1; i < pl; i++) maxStep = Math.max(maxStep, Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]));
    if (maxStep > 16) add({ kind: 'shape', msg: `edge ${e.id} pts spacing ${maxStep.toFixed(1)} m > 16`, edges: [k], nodes: [] });
    const turn = bezTotalTurn(bz, 48);
    const net0 = angleBetween(bezStartDir(bz), bezEndDir(bz));
    if (turn > (MAX_TURN_DEG + 10) * DEG || net0 > MAX_TURN_DEG * DEG) {
      add({ kind: 'shape', msg: `edge ${e.id} turns ${(Math.max(turn, net0) / DEG).toFixed(0)} deg in one segment`, edges: [k], nodes: [] });
    }
    const r = bezMinRadius(bz, 48);
    if (r < minRadius(e.prefab)) {
      add({ kind: 'shape', msg: `edge ${e.id} (${e.prefab}) radius ${r.toFixed(1)} m < ${minRadius(e.prefab)}`, edges: [k], nodes: [] });
    }
    for (const p of e.pts) {
      if (Math.abs(p[0]) > HALF + 1e-6 || Math.abs(p[1]) > HALF + 1e-6) {
        add({ kind: 'border', msg: `edge ${e.id} leaves the playable area`, edges: [k], nodes: [] });
        break;
      }
    }
    if (k > 0 && CLASS_INDEX[edges[k - 1].cls] > CLASS_INDEX[e.cls]) {
      add({ kind: 'order', msg: `edge ${e.id} (${e.cls}) is ordered after ${edges[k - 1].cls}`, edges: [], nodes: [] });
    }
  });

  // node spacing
  let focusNodes: Set<number> | null = null;
  if (focus) {
    focusNodes = new Set<number>();
    for (const k of focus) {
      const e = edges[k];
      if (!e) continue;
      const ia = byId.get(e.a);
      const ib = byId.get(e.b);
      if (ia !== undefined) focusNodes.add(ia);
      if (ib !== undefined) focusNodes.add(ib);
    }
  }
  const pg = new PointGrid(32);
  nodes.forEach((n, i) => pg.add(n.p[0], n.p[1], i));
  nodes.forEach((n, i) => {
    if (focusNodes && !focusNodes.has(i)) return;
    pg.near(n.p[0], n.p[1], MIN_NODE_GAP - 1e-6, (j, d) => {
      if (j === i || (j < i && (!focusNodes || focusNodes.has(j)))) return;
      add({ kind: 'nodeGap', msg: `nodes ${n.id} and ${nodes[j].id} are ${d.toFixed(1)} m apart`, edges: [], nodes: [i, j] });
    });
    if (Math.abs(n.p[0]) > HALF + 1e-9 || Math.abs(n.p[1]) > HALF + 1e-9) {
      add({ kind: 'border', msg: `node ${n.id} lies outside the playable area`, edges: [], nodes: [i] });
    }
    if (!Number.isFinite(n.ground) || !Number.isFinite(n.elevation)) {
      add({ kind: 'structure', msg: `node ${n.id} has non-finite height`, edges: [], nodes: [i] });
    }
    if (deg[i] === 0) add({ kind: 'structure', msg: `node ${n.id} has no edges`, edges: [], nodes: [i] });
  });

  // angles at nodes
  const dirAt = (k: number, i: number) => {
    const e = edges[k];
    if (byId.get(e.a) === i) return bezStartDir(e.bezier);
    const d = bezEndDir(e.bezier);
    return [-d[0], -d[1]] as [number, number];
  };
  nodes.forEach((n, i) => {
    if (focusNodes && !focusNodes.has(i)) return;
    const list = inc[i];
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const a = angleBetween(dirAt(list[x], i), dirAt(list[y], i));
        if (a < MIN_NODE_ANGLE_DEG * DEG) {
          add({ kind: 'angle', msg: `edges ${edges[list[x]].id} and ${edges[list[y]].id} meet at ${(a / DEG).toFixed(1)} deg at node ${n.id}`, edges: [list[x], list[y]], nodes: [i] });
        }
      }
    }
  });

  // border, outside connections
  let roadOut = 0;
  let railOut = 0;
  nodes.forEach((n, i) => {
    const onX = Math.abs(n.p[0]) === HALF;
    const onZ = Math.abs(n.p[1]) === HALF;
    if (n.outside) {
      if (!onX && !onZ) add({ kind: 'outside', msg: `outside node ${n.id} is not exactly on the border`, edges: [], nodes: [i] });
      if (deg[i] !== 1) {
        add({ kind: 'outside', msg: `outside node ${n.id} has ${deg[i]} edges (expected 1)`, edges: inc[i].slice(), nodes: [i] });
        return;
      }
      const e = edges[inc[i][0]];
      if (!OUTSIDE_CLASSES.has(e.cls)) add({ kind: 'outside', msg: `outside node ${n.id} on a ${e.cls}`, edges: [inc[i][0]], nodes: [i] });
      if (e.cls === 'rail') railOut++;
      else roadOut++;
      const d = dirAt(inc[i][0], i);
      const normal: [number, number] = onX ? [-Math.sign(n.p[0]), 0] : [0, -Math.sign(n.p[1])];
      const a = angleBetween(d, normal);
      if (a > OUTSIDE_APPROACH_TOL_DEG * DEG) {
        add({ kind: 'outside', msg: `outside node ${n.id} approached at ${(a / DEG).toFixed(0)} deg from perpendicular`, edges: [inc[i][0]], nodes: [i] });
      }
    } else {
      if (onX || onZ) add({ kind: 'border', msg: `node ${n.id} lies on the border but is not an outside connection`, edges: [], nodes: [i] });
      if (deg[i] === 1) {
        const bd = HALF - Math.max(Math.abs(n.p[0]), Math.abs(n.p[1]));
        if (bd < BORDER_MARGIN - 1e-6) {
          add({ kind: 'border', msg: `dead end ${n.id} is ${bd.toFixed(1)} m from the border`, edges: inc[i].slice(), nodes: [i] });
        }
      }
    }
  });
  if (roadOut > MAX_ROAD_OUTSIDE) add({ kind: 'outside', msg: `${roadOut} road outside connections (max ${MAX_ROAD_OUTSIDE})`, edges: [], nodes: [] });
  if (railOut > MAX_RAIL_OUTSIDE) add({ kind: 'outside', msg: `${railOut} rail outside connections (max ${MAX_RAIL_OUTSIDE})`, edges: [], nodes: [] });

  // elevation
  const Y = (i: number) => nodes[i].ground + nodes[i].elevation;
  edges.forEach((e, k) => {
    if (!ok[k] || (focus && !focus.has(k))) return;
    const ia = byId.get(e.a)!;
    const ib = byId.get(e.b)!;
    for (const i of [ia, ib]) {
      if (e.bridge && nodes[i].elevation < BRIDGE_MIN_ELEV - 1e-6) {
        add({ kind: 'elevation', msg: `bridge edge ${e.id} node ${nodes[i].id} only ${nodes[i].elevation.toFixed(1)} m above ground`, edges: [k], nodes: [i] });
      }
      if (e.tunnel && nodes[i].elevation > -TUNNEL_MIN_DEPTH + 1e-6) {
        add({ kind: 'elevation', msg: `tunnel edge ${e.id} node ${nodes[i].id} only ${(-nodes[i].elevation).toFixed(1)} m deep`, edges: [k], nodes: [i] });
      }
    }
    const ea = nodes[ia].elevation;
    const eb = nodes[ib].elevation;
    if (ea === 0 && eb === 0) return;
    const L = polyLength(e.pts);
    const lim = MAX_RAMP_GRADE * L + 0.05;
    const dy = Y(ib) - Y(ia);
    let bad = false;
    if (ea !== 0 && eb !== 0) bad = Math.abs(dy) > lim && Math.abs(dy) > Math.abs(nodes[ib].ground - nodes[ia].ground) + 0.05;
    else if (ea !== 0) bad = Math.sign(ea) * -dy > lim; // elevated a must not tower above b
    else bad = Math.sign(eb) * dy > lim;
    if (bad) {
      add({ kind: 'elevation', msg: `edge ${e.id} ramp gradient ${(Math.abs(dy) / L * 100).toFixed(0)}% too steep`, edges: [k], nodes: [ia, ib] });
    }
  });

  // clearance between unconnected same-level edges; vertical clearance at grade separations
  const E = edges.length;
  const bb = new Float64Array(E * 4);
  const preCache: (Float64Array | undefined)[] = new Array(E);
  const preOf = (k: number): Float64Array => {
    let c = preCache[k];
    if (!c) {
      const p = edges[k].pts;
      c = new Float64Array(p.length);
      for (let i = 1; i < p.length; i++) c[i] = c[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      preCache[k] = c;
    }
    return c;
  };
  const idx = new BoxGrid(128);
  edges.forEach((e, k) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of e.pts) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < z0) z0 = p[1];
      if (p[1] > z1) z1 = p[1];
    }
    bb[k * 4] = x0; bb[k * 4 + 1] = z0; bb[k * 4 + 2] = x1; bb[k * 4 + 3] = z1;
    if (ok[k]) idx.add(x0, z0, x1, z1, k);
  });
  const maxNeed = 2 * Math.max(...Object.values(PREFAB_WIDTH)) / 2 + 6;
  const seen = new Int32Array(E).fill(-1);
  edges.forEach((e, k) => {
    if (!ok[k] || (focus && !focus.has(k))) return;
    const ia = byId.get(e.a)!;
    const ib = byId.get(e.b)!;
    const kindE = levelKey(edgeLevel(e));
    const prk = preOf(k);
    const Ek = prk[prk.length - 1];
    idx.query(bb[k * 4] - maxNeed, bb[k * 4 + 1] - maxNeed, bb[k * 4 + 2] + maxNeed, bb[k * 4 + 3] + maxNeed, (o) => {
      if (o === k || seen[o] === k) return;
      if (o < k && (!focus || focus.has(o))) return;
      seen[o] = k;
      const f = edges[o];
      const fa = byId.get(f.a)!;
      const fb = byId.get(f.b)!;
      if (fa === ia || fa === ib || fb === ia || fb === ib) return;
      const kindF = levelKey(edgeLevel(f));
      const same = kindE === kindF;
      const need = same ? clearance(e.prefab, f.prefab) : 0;
      if (bb[o * 4] > bb[k * 4 + 2] + need || bb[o * 4 + 2] < bb[k * 4] - need) return;
      if (bb[o * 4 + 1] > bb[k * 4 + 3] + need || bb[o * 4 + 3] < bb[k * 4 + 1] - need) return;
      const pro = preOf(o);
      const Eo = pro[pro.length - 1];
      const height = (i: number, ti: number, j: number, tj: number): [number, number] => {
        const te = (prk[i] + ti * (prk[i + 1] - prk[i])) / Ek;
        const tf = (pro[j] + tj * (pro[j + 1] - pro[j])) / Eo;
        return [Y(ia) + (Y(ib) - Y(ia)) * te, Y(fa) + (Y(fb) - Y(fa)) * tf];
      };
      for (let i = 0; i + 1 < e.pts.length; i++) {
        const [ax, az] = e.pts[i];
        const [bx, bz] = e.pts[i + 1];
        for (let j = 0; j + 1 < f.pts.length; j++) {
          const [cx, cz] = f.pts[j];
          const [dx, dz] = f.pts[j + 1];
          if (same) {
            if (Math.min(cx, dx) > Math.max(ax, bx) + need || Math.max(cx, dx) < Math.min(ax, bx) - need) continue;
            if (Math.min(cz, dz) > Math.max(az, bz) + need || Math.max(cz, dz) < Math.min(az, bz) - need) continue;
            const d = segSegDist(ax, az, bx, bz, cx, cz, dx, dz);
            if (d >= need - 1e-6) continue;
            if (kindE !== 'G') {
              // two bridges / two tunnels may be stacked: only a conflict without vertical separation
              const [ti, tj] = closestParams(ax, az, bx, bz, cx, cz, dx, dz);
              const [ye, yf] = height(i, ti, j, tj);
              if (Math.abs(ye - yf) >= VERTICAL_CLEARANCE) continue;
            }
            add({ kind: 'clearance', msg: `edges ${e.id} (${e.cls}) and ${f.id} (${f.cls}) are ${d.toFixed(1)} m apart without a junction (need ${need})`, edges: [k, o], nodes: [] });
            return;
          }
          const r = segIntersect(ax, az, bx, bz, cx, cz, dx, dz);
          if (!r) continue;
          const [ye, yf] = height(i, r[0], j, r[1]);
          const upE = levelRank(edgeLevel(e)) >= levelRank(edgeLevel(f));
          const gap = upE ? ye - yf : yf - ye;
          if (gap < VERTICAL_CLEARANCE - 1e-6) {
            add({ kind: 'elevation', msg: `edges ${e.id} and ${f.id} cross with only ${gap.toFixed(1)} m vertical clearance`, edges: [k, o], nodes: [] });
            return;
          }
        }
      }
    });
  });
  return out;
}

function closestParams(
  ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number,
): [number, number] {
  const r = segIntersect(ax, az, bx, bz, cx, cz, dx, dz);
  if (r) return r;
  const c1 = [
    [0, projectSeg(ax, az, cx, cz, dx, dz), pointSegDist2(ax, az, cx, cz, dx, dz)],
    [1, projectSeg(bx, bz, cx, cz, dx, dz), pointSegDist2(bx, bz, cx, cz, dx, dz)],
    [projectSeg(cx, cz, ax, az, bx, bz), 0, pointSegDist2(cx, cz, ax, az, bx, bz)],
    [projectSeg(dx, dz, ax, az, bx, bz), 1, pointSegDist2(dx, dz, ax, az, bx, bz)],
  ];
  c1.sort((p, q) => p[2] - q[2]);
  return [c1[0][0], c1[0][1]];
}

/** Human-readable list of violations; empty when the network is legal. */
export function validateNetwork(net: RoadNetwork): string[] {
  return findViolations(net).map((v) => v.msg);
}

export type { RoadNode };
