/**
 * Turns a RoadNetwork into drawable pieces that join cleanly:
 *  - edge ribbons, trimmed back at junctions so they do not overlap
 *  - one junction surface per node (asphalt, with sidewalk corners between the arms)
 *  - decks for elevated edges (straight between the node elevations, like the game)
 *  - underground stretches (tunnels, subway) as dashed guide lines plus portal positions
 * Pure. Input points are game coordinates [gx, gz]; outputs are in the scene frame
 * (x = gx, z = -gz) where noted. `heightAt(x, z)` takes scene coordinates.
 */
import type { Pt, RoadClass, RoadEdge, RoadNetwork, RoadNode } from '../../core/types';
import type { BridgeInput } from './instances';
import { RoadKind, roadRibbonStyle, type RibbonInput } from './roadRibbons';

export const ROAD_SURFACE_LIFT = 0.45;
/** kind id of junction surfaces in the road shader */
export const JUNCTION_KIND = 8;

export interface JunctionGeometry {
  positions: Float32Array;
  /** per vertex: distance to the kerb line in metres (large in the mouth of an arm), 0 */
  uvs: Float32Array;
  /** per vertex: [0, sidewalk, 0, JUNCTION_KIND] */
  params: Float32Array;
  vertexCount: number;
}

export interface Portal {
  /** scene position of the portal (road surface level) */
  x: number;
  y: number;
  z: number;
  /** scene direction into the tunnel */
  dx: number;
  dz: number;
  width: number;
}

export interface RoadScene {
  ribbons: RibbonInput[];
  bridges: BridgeInput[];
  junctions: JunctionGeometry;
  /** underground centre lines (game coordinates) for dashed guides */
  underground: { pts: Pt[]; width: number }[];
  portals: Portal[];
  /** counts for the info line */
  segments: number;
  tunnels: number;
  bridgeCount: number;
}

function isRail(e: RoadEdge): boolean {
  return e.cls === 'rail' || e.cls === 'tram' || e.cls === 'subway';
}

/** true for edges that run below ground for their whole length */
function isUnderground(e: RoadEdge, a: RoadNode | undefined, b: RoadNode | undefined): boolean {
  if (e.cls === 'subway' || e.prefab === 'subway_double') return true;
  if (e.tunnel) {
    const ea = a?.elevation ?? -1;
    const eb = b?.elevation ?? -1;
    // a tunnel edge that ends at a ground node is the ramp into the portal; still underground
    return ea <= 0.5 && eb <= 0.5;
  }
  return (a?.elevation ?? 0) < -1 && (b?.elevation ?? 0) < -1;
}

function polyLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Cuts `d0` metres off the start and `d1` off the end of a polyline. */
export function trimPolyline(pts: Pt[], d0: number, d1: number): Pt[] {
  const L = polyLength(pts);
  if (d0 + d1 >= L - 0.5) {
    const mid = pointAt(pts, (d0 / Math.max(d0 + d1, 1e-6)) * L);
    return [mid, mid];
  }
  const out: Pt[] = [pointAt(pts, d0)];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc > d0 + 1e-6 && acc < L - d1 - 1e-6) out.push(pts[i]);
  }
  out.push(pointAt(pts, L - d1));
  return out;
}

export function pointAt(pts: Pt[], d: number): Pt {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + l >= d || i === pts.length - 1) {
      const t = l > 0 ? Math.max(0, Math.min(1, (d - acc) / l)) : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    acc += l;
  }
  return pts[pts.length - 1];
}

interface Arm {
  edge: RoadEdge;
  atStart: boolean;
  hw: number;
  sw: number;
  /** trimmed end point and unit direction away from the node (game coords) */
  end: Pt;
  dir: Pt;
  angle: number;
}

class Grow {
  a: Float32Array;
  len = 0;
  constructor(n: number) { this.a = new Float32Array(Math.max(16, n)); }
  push(...v: number[]): void {
    if (this.len + v.length > this.a.length) {
      const b = new Float32Array(Math.max(this.a.length * 2, this.len + v.length));
      b.set(this.a);
      this.a = b;
    }
    for (const x of v) this.a[this.len++] = x;
  }
  out(): Float32Array { return this.a.slice(0, this.len); }
}

export interface RoadSceneOptions {
  /** drop edges whose midpoint is outside (scene coords) */
  keep?: (x: number, z: number) => boolean;
}

export function buildRoadScene(net: RoadNetwork, heightAt: (x: number, z: number) => number, opts: RoadSceneOptions = {}): RoadScene {
  const nodes = new Map<number, RoadNode>();
  for (const n of net.nodes) nodes.set(n.id, n);
  const visible: RoadEdge[] = [];
  const underground: { pts: Pt[]; width: number }[] = [];
  const portals: Portal[] = [];
  const surfaceDeg = new Map<number, number>();
  const undergroundAt = new Map<number, RoadEdge[]>();
  let tunnels = 0;
  for (const e of net.edges) {
    if (e.pts.length < 2) continue;
    if (opts.keep) {
      const m = e.pts[Math.floor(e.pts.length / 2)];
      if (!opts.keep(m[0], -m[1])) continue;
    }
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    if (isUnderground(e, a, b)) {
      tunnels++;
      underground.push({ pts: e.pts, width: roadRibbonStyle(e.cls, e.prefab).width });
      for (const id of [e.a, e.b]) {
        const l = undergroundAt.get(id) ?? [];
        l.push(e);
        undergroundAt.set(id, l);
      }
      continue;
    }
    visible.push(e);
    surfaceDeg.set(e.a, (surfaceDeg.get(e.a) ?? 0) + 1);
    surfaceDeg.set(e.b, (surfaceDeg.get(e.b) ?? 0) + 1);
  }

  // portals: a node where the surface network meets an underground edge
  for (const [id, list] of undergroundAt) {
    if (!surfaceDeg.get(id)) continue;
    const nd = nodes.get(id);
    if (!nd) continue;
    for (const e of list) {
      if (e.cls === 'subway' || e.prefab === 'subway_double') continue;
      const atStart = e.a === id;
      const p0 = atStart ? e.pts[0] : e.pts[e.pts.length - 1];
      const p1 = pointAt(atStart ? e.pts : [...e.pts].reverse(), 12);
      const dx = p1[0] - p0[0];
      const dz = -(p1[1] - p0[1]);
      const l = Math.hypot(dx, dz) || 1;
      const x = p0[0];
      const z = -p0[1];
      portals.push({ x, y: Math.max(nd.ground, heightAt(x, z)) + Math.max(0, nd.elevation), z, dx: dx / l, dz: dz / l, width: roadRibbonStyle(e.cls, e.prefab).width });
    }
  }

  // arms per node (only roads take part in junction surfaces; rail just passes through)
  const arms = new Map<number, Arm[]>();
  const style = new Map<RoadEdge, { hw: number; sw: number }>();
  for (const e of visible) {
    const st = roadRibbonStyle(e.cls, e.prefab);
    const p = st.params!;
    const kind = p[3];
    const sw = kind === RoadKind.highway ? 0 : p[1];
    style.set(e, { hw: st.width / 2, sw });
    if (isRail(e)) continue;
    for (const atStart of [true, false]) {
      const id = atStart ? e.a : e.b;
      const l = arms.get(id) ?? [];
      l.push({ edge: e, atStart, hw: st.width / 2, sw, end: [0, 0], dir: [1, 0], angle: 0 });
      arms.set(id, l);
    }
  }
  // trim distance per node
  const trim = new Map<number, number>();
  for (const [id, list] of arms) {
    if (list.length < 3) continue;
    let r = 0;
    for (const a of list) r = Math.max(r, a.hw);
    trim.set(id, r * 1.05 + 1);
  }

  const elevY = (nd: RoadNode | undefined, gx: number, gz: number): number =>
    nd ? nd.ground + nd.elevation : heightAt(gx, -gz);

  const ribbons: RibbonInput[] = [];
  const bridges: BridgeInput[] = [];
  let bridgeCount = 0;
  for (const e of visible) {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    const L = polyLength(e.pts);
    let d0 = trim.get(e.a) ?? 0;
    let d1 = trim.get(e.b) ?? 0;
    if (d0 + d1 > L * 0.8) {
      const k = (L * 0.8) / (d0 + d1);
      d0 *= k;
      d1 *= k;
    }
    const pts = d0 > 0 || d1 > 0 ? trimPolyline(e.pts, d0, d1) : e.pts;
    const st = roadRibbonStyle(e.cls, e.prefab);
    st.lift = ROAD_SURFACE_LIFT;
    const input: RibbonInput = { pts, style: st };
    const ea = a?.elevation ?? 0;
    const eb = b?.elevation ?? 0;
    if (Math.abs(ea) > 0.3 || Math.abs(eb) > 0.3 || e.bridge) {
      const yA = elevY(a, e.pts[0][0], e.pts[0][1]);
      const last = e.pts[e.pts.length - 1];
      const yB = elevY(b, last[0], last[1]);
      const y0 = yA + ((yB - yA) * d0) / Math.max(L, 1e-6);
      const y1 = yA + ((yB - yA) * (L - d1)) / Math.max(L, 1e-6);
      input.deck = { y0: y0 + ROAD_SURFACE_LIFT, y1: y1 + ROAD_SURFACE_LIFT, exact: ea < -0.3 || eb < -0.3 };
      if (ea > 0.3 || eb > 0.3) {
        bridges.push({ pts, y0: y0 + ROAD_SURFACE_LIFT, y1: y1 + ROAD_SURFACE_LIFT, hump: 0, width: st.width });
        if (ea > 0.3 && eb > 0.3) bridgeCount++;
      }
      if (ea < -0.3 || eb < -0.3) {
        // ramp into the ground: portal where the deck dives under the terrain
        const n = 24;
        for (let k = 1; k <= n; k++) {
          const s = (k / n) * L;
          const p = pointAt(e.pts, s);
          const y = yA + ((yB - yA) * s) / L;
          const g = heightAt(p[0], -p[1]);
          if (y < g - 1.5) {
            const q = pointAt(e.pts, Math.max(0, s - L / n));
            const dir = ea < eb ? -1 : 1;
            const dx = (p[0] - q[0]) * dir;
            const dz = -(p[1] - q[1]) * dir;
            const l = Math.hypot(dx, dz) || 1;
            portals.push({ x: p[0], y: y + ROAD_SURFACE_LIFT, z: -p[1], dx: dx / l, dz: dz / l, width: st.width });
            break;
          }
        }
      }
    }
    ribbons.push(input);
    // record arm end points
    for (const arm of arms.get(e.a) ?? []) if (arm.edge === e && arm.atStart) setArm(arm, pts, true);
    for (const arm of arms.get(e.b) ?? []) if (arm.edge === e && !arm.atStart) setArm(arm, pts, false);
  }

  // junction surfaces
  const pos = new Grow(4096);
  const uv = new Grow(4096);
  const prm = new Grow(4096);
  for (const [id, list] of arms) {
    if (list.length < 2) continue;
    const nd = nodes.get(id);
    if (!nd || nd.elevation < -0.3) continue;
    list.sort((p, q) => p.angle - q.angle);
    const elevated = nd.elevation > 0.3;
    const yOf = (gx: number, gz: number): number =>
      (elevated ? nd.ground + nd.elevation : heightAt(gx, -gz)) + ROAD_SURFACE_LIFT;
    const C: Pt = nd.p;
    const vert = (p: Pt, kerb: number, sw: number): void => {
      pos.push(p[0], yOf(p[0], p[1]), -p[1]);
      uv.push(kerb, 0);
      prm.push(0, sw, 0, JUNCTION_KIND);
    };
    const m = list.length;
    for (let k = 0; k < m; k++) {
      const A = list[k];
      const B = list[(k + 1) % m];
      const nA: Pt = [-A.dir[1], A.dir[0]];
      const nB: Pt = [-B.dir[1], B.dir[0]];
      const rA: Pt = [A.end[0] - nA[0] * A.hw, A.end[1] - nA[1] * A.hw];
      const lA: Pt = [A.end[0] + nA[0] * A.hw, A.end[1] + nA[1] * A.hw];
      const rB: Pt = [B.end[0] - nB[0] * B.hw, B.end[1] - nB[1] * B.hw];
      // mouth of arm A (CCW: right corner, left corner)
      tri(C, rA, lA, 1e3, 1e3, 1e3, 0);
      // wedge between A's left corner and B's right corner
      if (m < 2) continue;
      const ex = rB[0] - lA[0];
      const ez = rB[1] - lA[1];
      const el = Math.hypot(ex, ez);
      if (el < 0.05) continue;
      // signed distance of C to the kerb line lA -> rB, positive when C lies inside (to its left)
      const dist = (ex * (C[1] - lA[1]) - ez * (C[0] - lA[0])) / el;
      if (dist < 0.5) continue;
      tri(C, lA, rB, dist, 0, 0, Math.min(A.sw, B.sw));
    }

    function tri(p0: Pt, p1: Pt, p2: Pt, k0: number, k1: number, k2: number, sw: number): void {
      // counter-clockwise in game coordinates faces up in the scene frame
      vert(p0, k0, sw);
      vert(p1, k1, sw);
      vert(p2, k2, sw);
    }
  }

  return {
    ribbons,
    bridges,
    junctions: { positions: pos.out(), uvs: uv.out(), params: prm.out(), vertexCount: pos.len / 3 },
    underground,
    portals,
    segments: net.edges.length,
    tunnels,
    bridgeCount,
  };
}

function setArm(arm: Arm, pts: Pt[], atStart: boolean): void {
  const p0 = atStart ? pts[0] : pts[pts.length - 1];
  const p1 = atStart ? pts[Math.min(1, pts.length - 1)] : pts[Math.max(0, pts.length - 2)];
  let dx = p1[0] - p0[0];
  let dz = p1[1] - p0[1];
  const l = Math.hypot(dx, dz);
  if (l < 1e-6) { dx = 1; dz = 0; } else { dx /= l; dz /= l; }
  arm.end = p0;
  arm.dir = [dx, dz];
  arm.angle = Math.atan2(dz, dx);
}

/** Importance for label placement and drawing order: higher first. */
export const CLASS_RANK: Record<RoadClass, number> = {
  motorway: 10, trunk: 9, primary: 8, secondary: 7, tertiary: 6, residential: 4, service: 2,
  pedestrian: 1, rail: 3, tram: 3, subway: 0,
};

