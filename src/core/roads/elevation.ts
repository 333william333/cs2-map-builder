/**
 * Node ground heights and elevations: bridges lifted, tunnels lowered, with ramps that
 * propagate through neighbouring nodes at a bounded gradient, and vertical clearance at
 * grade-separated crossings.
 */
import type { HeightGrid, Pt, TerrainResult } from '../types';
import {
  GEN_BRIDGE_ELEV, GEN_RAMP_GRADE, GEN_TUNNEL_DEPTH, GEN_VERTICAL_CLEARANCE, levelKey, levelRank,
} from './params';
import { polyLength, segIntersect } from './geom';
import { BoxGrid } from './spatial';
import type { WNet } from './segment';

export function sampleHeight(grid: HeightGrid, x: number, z: number): number {
  const N = grid.size;
  const cell = grid.extentM / N;
  let fc = (x + grid.extentM / 2) / cell - 0.5;
  let fr = (grid.extentM / 2 - z) / cell - 0.5;
  fc = Math.max(0, Math.min(N - 1, fc));
  fr = Math.max(0, Math.min(N - 1, fr));
  const c0 = Math.floor(fc);
  const r0 = Math.floor(fr);
  const c1 = Math.min(N - 1, c0 + 1);
  const r1 = Math.min(N - 1, r0 + 1);
  const tx = fc - c0;
  const tz = fr - r0;
  const d = grid.data;
  const a = d[r0 * N + c0] * (1 - tx) + d[r0 * N + c1] * tx;
  const b = d[r1 * N + c0] * (1 - tx) + d[r1 * N + c1] * tx;
  return a * (1 - tz) + b * tz;
}

function waterAt(terrain: TerrainResult, x: number, z: number): number {
  const N = terrain.playable.size;
  const ext = terrain.playable.extentM;
  const cell = ext / N;
  const c = Math.floor((x + ext / 2) / cell);
  const r = Math.floor((ext / 2 - z) / cell);
  if (c < 0 || r < 0 || c >= N || r >= N || !terrain.waterMask) return 0;
  return terrain.waterMask[r * N + c] ?? 0;
}

/** binary heap keyed by value (max-heap when sign = 1, min-heap when sign = -1) */
class Heap {
  ids: number[] = [];
  vs: number[] = [];
  constructor(private sign: number) {}
  push(id: number, v: number) {
    this.ids.push(id);
    this.vs.push(v * this.sign);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.vs[p] >= this.vs[i]) break;
      [this.vs[p], this.vs[i]] = [this.vs[i], this.vs[p]];
      [this.ids[p], this.ids[i]] = [this.ids[i], this.ids[p]];
      i = p;
    }
  }
  pop(): [number, number] | null {
    if (!this.ids.length) return null;
    const id = this.ids[0];
    const v = this.vs[0] * this.sign;
    const li = this.ids.pop()!;
    const lv = this.vs.pop()!;
    if (this.ids.length) {
      this.ids[0] = li;
      this.vs[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.vs.length && this.vs[l] > this.vs[m]) m = l;
        if (r < this.vs.length && this.vs[r] > this.vs[m]) m = r;
        if (m === i) break;
        [this.vs[m], this.vs[i]] = [this.vs[i], this.vs[m]];
        [this.ids[m], this.ids[i]] = [this.ids[i], this.ids[m]];
        i = m;
      }
    }
    return [id, v];
  }
}

/**
 * Returns [ground, elevation] per work node.
 */
export function assignElevations(net: WNet, terrain: TerrainResult): { ground: Float64Array; elev: Float64Array } {
  const nN = net.nodes.length;
  const ground = new Float64Array(nN);
  for (let i = 0; i < nN; i++) ground[i] = sampleHeight(terrain.playable, net.nodes[i].x, net.nodes[i].z);
  const adj: number[][] = net.nodes.map(() => []);
  const elen: number[] = [];
  net.edges.forEach((e, k) => {
    elen[k] = polyLength(e.pts);
    if (!e.alive) return;
    adj[e.a].push(k);
    adj[e.b].push(k);
  });
  const propagate = (bound: Float64Array, sign: 1 | -1): Float64Array => {
    const Y = Float64Array.from(bound);
    const h = new Heap(sign);
    for (let i = 0; i < nN; i++) if (Number.isFinite(Y[i])) h.push(i, Y[i]);
    for (;;) {
      const top = h.pop();
      if (!top) break;
      const [n, v] = top;
      if (v !== Y[n]) continue;
      for (const k of adj[n]) {
        const e = net.edges[k];
        const m = e.a === n ? e.b : e.a;
        const cand = v - sign * GEN_RAMP_GRADE * elen[k];
        // stop once the ramp has reached the terrain
        if (sign > 0 ? cand <= ground[m] : cand >= ground[m]) continue;
        // outside a structure a ramp only runs out: it never climbs a hillside into the street network
        // (embankments may keep their height down a slope, up to the structure requirement)
        if (!e.bridge && !e.tunnel && !Number.isFinite(bound[m]) &&
          Math.abs(cand - ground[m]) > Math.max(Math.abs(v - ground[n]), GEN_TUNNEL_DEPTH) + 1e-6) continue;
        if (sign > 0 ? cand > Y[m] : cand < Y[m]) {
          Y[m] = cand;
          h.push(m, cand);
        }
      }
    }
    return Y;
  };

  // lower bounds for bridges, upper bounds for tunnels (absolute heights); portals move out while
  // the road beyond them would still be deep under the terrain (or high above it)
  let lowB = new Float64Array(nN);
  let upT = new Float64Array(nN);
  let YB: Float64Array = new Float64Array(nN);
  let YT: Float64Array = new Float64Array(nN);
  const chainRef = new Map<number, number>();
  for (const [cid, [a, b]] of net.chainEnds) chainRef.set(cid, Math.min(ground[a], ground[b]));
  for (let pass = 0; pass < 8; pass++) {
  lowB = new Float64Array(nN).fill(-Infinity);
  upT = new Float64Array(nN).fill(Infinity);
  net.edges.forEach((e) => {
    if (!e.alive) return;
    if (e.bridge) {
      const ref = chainRef.get(e.chain) ?? -Infinity;
      for (const n of [e.a, e.b]) {
        let base = Math.max(ground[n], ref);
        if (waterAt(terrain, net.nodes[n].x, net.nodes[n].z) === 1 && terrain.hasSea) base = Math.max(base, terrain.seaLevel);
        lowB[n] = Math.max(lowB[n], base + GEN_BRIDGE_ELEV + 9 * (e.stack ?? 0));
      }
    }
    if (e.tunnel) {
      for (const n of [e.a, e.b]) upT[n] = Math.min(upT[n], ground[n] - GEN_TUNNEL_DEPTH - 9 * (e.stack ?? 0));
    }
  });

  YB = propagate(lowB, 1);
  YT = propagate(upT, -1);
  let extended = false;
  net.edges.forEach((e, k) => {
    if (!e.alive || e.bridge || e.tunnel) return;
    if (adj[e.a].length > 2 || adj[e.b].length > 2) return;
    for (const [n, m] of [[e.a, e.b], [e.b, e.a]]) {
      if (Number.isFinite(upT[n]) && !Number.isFinite(lowB[m]) && ground[m] - (YT[n] + GEN_RAMP_GRADE * elen[k]) >= 8) {
        e.tunnel = true;
        extended = true;
        return;
      }
      if (Number.isFinite(lowB[n]) && !Number.isFinite(upT[m]) && YB[n] - GEN_RAMP_GRADE * elen[k] - ground[m] >= 8) {
        e.bridge = true;
        extended = true;
        return;
      }
    }
  });
  if (!extended) break;
  }
  const elevOf = (i: number) => {
    let e = 0;
    if (Number.isFinite(YB[i]) && YB[i] > ground[i]) e += YB[i] - ground[i];
    if (Number.isFinite(YT[i]) && YT[i] < ground[i]) e += YT[i] - ground[i];
    return e;
  };

  // vertical clearance at grade-separated crossings
  // only crossings that involve a bridge or tunnel need vertical clearance
  const box = (e: { pts: Pt[] }) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const q of e.pts) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < z0) z0 = q[1];
      if (q[1] > z1) z1 = q[1];
    }
    return [x0, z0, x1, z1];
  };
  const sgrid = new BoxGrid(128);
  let structures = 0;
  net.edges.forEach((e, k) => {
    if (!e.alive || (!e.bridge && !e.tunnel)) return;
    const [x0, z0, x1, z1] = box(e);
    sgrid.add(x0, z0, x1, z1, k);
    structures++;
  });
  const crossings: { up: number; lo: number; fu: number; fl: number }[] = [];
  const cum = (e: { pts: Pt[] }) => {
    const c = [0];
    for (let i = 1; i < e.pts.length; i++) c.push(c[i - 1] + Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]));
    return c;
  };
  if (structures) net.edges.forEach((e, k) => {
    if (!e.alive) return;
    const [x0, z0, x1, z1] = box(e);
    sgrid.query(x0, z0, x1, z1, (o) => {
      if (o === k) return;
      const f = net.edges[o];
      // each pair once: a structure pair is seen from both sides
      if ((e.bridge || e.tunnel) && o < k) return;
      if (levelKey(e) === levelKey(f)) return;
      if (f.a === e.a || f.a === e.b || f.b === e.a || f.b === e.b) return;
      const ce = cum(e);
      const cf = cum(f);
      for (let i = 0; i + 1 < e.pts.length; i++) {
        const [ax, az] = e.pts[i];
        const [bx, bz] = e.pts[i + 1];
        for (let j = 0; j + 1 < f.pts.length; j++) {
          const [cx, cz] = f.pts[j];
          const [dx, dz] = f.pts[j + 1];
          const r = segIntersect(ax, az, bx, bz, cx, cz, dx, dz);
          if (!r) continue;
          const fe = (ce[i] + r[0] * (ce[i + 1] - ce[i])) / elen[k];
          const ff = (cf[j] + r[1] * (cf[j + 1] - cf[j])) / elen[o];
          if (levelRank(e) >= levelRank(f)) crossings.push({ up: k, lo: o, fu: fe, fl: ff });
          else crossings.push({ up: o, lo: k, fu: ff, fl: fe });
        }
      }
    });
  });
  for (let iter = 0; iter < 4 && crossings.length; iter++) {
    let changed = false;
    const Yat = (k: number, f: number) => {
      const e = net.edges[k];
      const ya = ground[e.a] + elevOf(e.a);
      const yb = ground[e.b] + elevOf(e.b);
      return ya + (yb - ya) * f;
    };
    for (const c of crossings) {
      const deficit = Yat(c.lo, c.fl) + GEN_VERTICAL_CLEARANCE - Yat(c.up, c.fu);
      if (deficit <= 0.01) continue;
      const up = net.edges[c.up];
      const lo = net.edges[c.lo];
      if (up.bridge || !lo.tunnel) {
        for (const n of [up.a, up.b]) {
          const y = ground[n] + elevOf(n) + deficit + 0.5;
          if (y > lowB[n]) {
            lowB[n] = y;
            changed = true;
          }
        }
      } else {
        for (const n of [lo.a, lo.b]) {
          const y = ground[n] + elevOf(n) - deficit - 0.5;
          if (y < upT[n]) {
            upT[n] = y;
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
    YB = propagate(lowB, 1);
    YT = propagate(upT, -1);
  }
  const elev = new Float64Array(nN);
  for (let i = 0; i < nN; i++) elev[i] = elevOf(i);
  // ramps that still come out steeper than the terrain allows: pull the near-ground end along,
  // spreading only as far as needed (structure nodes keep their own height)
  const fixedNode = new Uint8Array(nN);
  for (let i = 0; i < nN; i++) if (Number.isFinite(lowB[i]) || Number.isFinite(upT[i])) fixedNode[i] = 1;
  for (let it = 0; it < 40; it++) {
    let moved = false;
    net.edges.forEach((e, k) => {
      if (!e.alive || (elev[e.a] === 0 && elev[e.b] === 0)) return;
      const ya = ground[e.a] + elev[e.a];
      const yb = ground[e.b] + elev[e.b];
      const lim = Math.max(GEN_RAMP_GRADE * 1.15 * elen[k], Math.abs(ground[e.b] - ground[e.a]));
      const dy = yb - ya;
      if (Math.abs(dy) <= lim + 0.02) return;
      // move the end closer to the ground (or the one that is not a structure node)
      let m = Math.abs(elev[e.a]) <= Math.abs(elev[e.b]) ? e.a : e.b;
      if (fixedNode[m]) m = m === e.a ? e.b : e.a;
      if (fixedNode[m]) return;
      const other = m === e.a ? yb : ya;
      const target = other + (m === e.a ? -1 : 1) * Math.sign(dy) * -lim * -1;
      const ym = m === e.a ? other - Math.sign(dy) * lim : other + Math.sign(dy) * lim;
      void target;
      elev[m] = ym - ground[m];
      moved = true;
    });
    if (!moved) break;
  }
  for (let i = 0; i < nN; i++) elev[i] = Math.round(elev[i] * 100) / 100;
  return { ground, elev };
}
