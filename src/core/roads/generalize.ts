/** Graph-level generalisation: water bridges, snapping, roundabouts, contraction, thinning, smoothing. */
import type { NetPrefab, Pt, TerrainResult } from '../types';
import {
  APPROACH_LEN, type Attr, HALF, IMPORTANCE, MIN_CHAIN, choosePrefab, clearance, family, levelKey,
  smoothSigma,
} from './params';
import {
  angleBetween, cumLen, dist, pointAt, pointPolyDist, pointSegDist2, polyLength, projectSeg, resample,
  smoothGaussian, unit,
} from './geom';
import { type Graph } from './graph';
import { PointGrid, SegGrid } from './spatial';

const prefabOf = (at: Attr): NetPrefab => choosePrefab(at);

function compatible(a: Attr, b: Attr): boolean {
  return family(a.cls) === family(b.cls) && levelKey(a) === levelKey(b);
}

// ---------------------------------------------------------------- water

/** carry ground chains over water cells as bridges; trim dead ends that run into water */
export function bridgeWater(g: Graph, terrain: TerrainResult) {
  const mask = terrain.waterMask;
  const N = terrain.playable.size;
  if (!mask || mask.length !== N * N) return;
  const ext = terrain.playable.extentM;
  const cell = ext / N;
  const wet = (x: number, z: number) => {
    const c = Math.floor((x + ext / 2) / cell);
    const r = Math.floor((ext / 2 - z) / cell);
    if (c < 0 || r < 0 || c >= N || r >= N) return false;
    return mask[r * N + c] !== 0;
  };
  const step = Math.min(4, cell / 2);
  for (const id of g.live()) {
    const c = g.chains[id];
    if (!c.alive || c.at.bridge || c.at.tunnel) continue;
    const cum = cumLen(c.pts);
    const L = cum[cum.length - 1];
    const n = Math.max(2, Math.ceil(L / step) + 1);
    const runs: [number, number][] = [];
    let rs = -1;
    for (let k = 0; k < n; k++) {
      const s = (L * k) / (n - 1);
      const p = pointAt(c.pts, cum, s);
      const w = wet(p[0], p[1]);
      if (w && rs < 0) rs = s;
      if (!w && rs >= 0) {
        runs.push([rs, s]);
        rs = -1;
      }
    }
    if (rs >= 0) runs.push([rs, L]);
    if (!runs.length) continue;
    // merge close runs
    const merged: [number, number][] = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && r[0] - last[1] < 40) last[1] = r[1];
      else merged.push([r[0], r[1]]);
    }
    let lo = 0;
    let hi = L;
    const deadA = g.deg(c.a) === 1 && !g.nodes[c.a].outside;
    const deadB = g.deg(c.b) === 1 && !g.nodes[c.b].outside;
    const ivs: [number, number][] = [];
    for (const [s0, s1] of merged) {
      if (s0 <= step && deadA) {
        lo = Math.max(lo, s1 + 10);
        continue;
      }
      if (s1 >= L - step && deadB) {
        hi = Math.min(hi, s0 - 10);
        continue;
      }
      let b0 = s0 - 12;
      let b1 = s1 + 12;
      if (b1 - b0 < 40) {
        const m = (b0 + b1) / 2;
        b0 = m - 20;
        b1 = m + 20;
      }
      ivs.push([b0, b1]);
    }
    if (hi - lo < 10) {
      g.removeChain(id);
      continue;
    }
    const iv2: [number, number][] = [];
    for (const [a0, a1] of ivs) {
      let a = Math.max(a0, lo);
      let b = Math.min(a1, hi);
      if (a - lo < 30) a = lo;
      if (hi - b < 30) b = hi;
      if (b - a < 5) continue;
      const last = iv2[iv2.length - 1];
      if (last && a <= last[1] + 30) last[1] = Math.max(last[1], b);
      else iv2.push([a, b]);
    }
    const cuts = new Set<number>();
    if (lo > 0.5) cuts.add(lo);
    if (hi < L - 0.5) cuts.add(hi);
    for (const [a, b] of iv2) {
      if (a > lo + 0.5) cuts.add(a);
      if (b < hi - 0.5) cuts.add(b);
    }
    const sorted = [...cuts].sort((x, y) => y - x);
    const pieces: { id: number; s0: number }[] = [];
    let cur = id;
    for (const s of sorted) {
      const r = g.splitChain(cur, s);
      pieces.unshift({ id: r.right, s0: s });
      cur = r.left;
    }
    pieces.unshift({ id: cur, s0: 0 });
    for (let k = 0; k < pieces.length; k++) {
      const a = pieces[k].s0;
      const b = k + 1 < pieces.length ? pieces[k + 1].s0 : L;
      const m = (a + b) / 2;
      if (m < lo || m > hi) {
        g.removeChain(pieces[k].id);
        continue;
      }
      if (iv2.some(([x, y]) => m > x && m < y)) {
        const ch = g.chains[pieces[k].id];
        ch.at = { ...ch.at, bridge: true, tunnel: false };
      }
    }
  }
}

// ---------------------------------------------------------------- dangles

/** connect dead ends that stop within clearance of another chain or node */
export function snapDangles(g: Graph) {
  const idx = g.segIndex(32);
  const pg = new PointGrid(32);
  g.nodes.forEach((n, i) => { if (n.alive) pg.add(n.x, n.z, i); });
  for (let n = 0; n < g.nodes.length; n++) {
    const node = g.nodes[n];
    if (!node.alive || node.outside || node.ch.length !== 1) continue;
    const cid = node.ch[0];
    const c = g.chains[cid];
    if (c.a === c.b) continue;
    const far = c.a === n ? c.b : c.a;
    const pc = prefabOf(c.at);
    const R = 46;
    let bestD = Infinity;
    let bestNode = -1;
    pg.near(node.x, node.z, R, (m, d) => {
      if (m === n || m === far || !g.nodes[m].alive) return;
      let need = 0;
      for (const o of g.nodes[m].ch) {
        const oc = g.chains[o];
        if (o === cid || !oc.alive || !compatible(c.at, oc.at)) continue;
        need = Math.max(need, clearance(pc, prefabOf(oc.at)) + 1);
      }
      if (need > 0 && d <= need && d < bestD) {
        bestD = d;
        bestNode = m;
      }
    });
    let bestSeg = -1;
    let bestSegD = Infinity;
    idx.query(node.x - R, node.z - R, node.x + R, node.z + R, (sid) => {
      const o = idx.owner(sid);
      if (o === cid) return;
      const oc = g.chains[o];
      if (!oc.alive || !compatible(c.at, oc.at)) return;
      const [ax, az, bx, bz] = idx.get(sid);
      const d = Math.sqrt(pointSegDist2(node.x, node.z, ax, az, bx, bz));
      if (d <= clearance(pc, prefabOf(oc.at)) + 1 && d < bestSegD) {
        bestSegD = d;
        bestSeg = sid;
      }
    });
    if (bestNode >= 0 && bestNode !== n && bestD <= bestSegD + 6) {
      g.mergeNodes(bestNode, n);
    } else if (bestSeg >= 0) {
      const o = idx.owner(bestSeg);
      const oc = g.chains[o];
      const si = idx.aux(bestSeg);
      const [ax, az, bx, bz] = idx.get(bestSeg);
      // the segment may be stale if the chain was rebuilt: verify
      if (!oc.alive || si + 1 >= oc.pts.length || oc.pts[si][0] !== ax || oc.pts[si][1] !== az) continue;
      const cum = cumLen(oc.pts);
      const t = projectSeg(node.x, node.z, ax, az, bx, bz);
      const s = cum[si] + t * (cum[si + 1] - cum[si]);
      const L = cum[cum.length - 1];
      let target: number;
      if (s < 10 && oc.a !== n) target = oc.a;
      else if (s > L - 10 && oc.b !== n) target = oc.b;
      else {
        const r = g.splitChain(o, s);
        g.indexChain(idx, r.left);
        g.indexChain(idx, r.right);
        target = r.node;
        pg.add(g.nodes[target].x, g.nodes[target].z, target);
      }
      if (target === n) continue;
      g.mergeNodes(target, n);
    }
    // drop a dangling chain that collapsed
    if (g.chains[cid].alive && g.len(cid) < 1) g.removeChain(cid);
  }
}

// ---------------------------------------------------------------- roundabouts

export function roundabouts(g: Graph) {
  const seen = new Set<number>();
  for (const id of g.live()) {
    const c0 = g.chains[id];
    if (!c0.at.roundabout || seen.has(id)) continue;
    const group: number[] = [];
    const nodes = new Set<number>();
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const k = stack.pop()!;
      group.push(k);
      const c = g.chains[k];
      for (const n of [c.a, c.b]) {
        nodes.add(n);
        for (const o of g.nodes[n].ch) {
          if (!seen.has(o) && g.chains[o].alive && g.chains[o].at.roundabout) {
            seen.add(o);
            stack.push(o);
          }
        }
      }
    }
    let perim = 0;
    let sx = 0;
    let sz = 0;
    let sw = 0;
    let minLen = Infinity;
    for (const k of group) {
      const p = g.chains[k].pts;
      const l = polyLength(p);
      perim += l;
      minLen = Math.min(minLen, l);
      for (let i = 0; i + 1 < p.length; i++) {
        const w = dist(p[i], p[i + 1]);
        sx += (p[i][0] + p[i + 1][0]) * 0.5 * w;
        sz += (p[i][1] + p[i + 1][1]) * 0.5 * w;
        sw += w;
      }
    }
    if (sw <= 0) continue;
    let closed = true;
    for (const n of nodes) {
      let k = 0;
      for (const o of g.nodes[n].ch) if (g.chains[o].at.roundabout) k++;
      if (k !== 2) closed = false;
    }
    const keep = closed && perim >= 160 && minLen >= 40 && (group.length >= 3 || (group.length === 1 && perim >= 160));
    if (keep) continue;
    if (!closed && perim >= 160) continue;
    const cx = sx / sw;
    const cz = sz / sw;
    let outside = false;
    for (const n of nodes) if (g.nodes[n].outside) outside = true;
    if (outside) continue;
    for (const k of group) g.removeChain(k);
    const center = g.addNode(cx, cz);
    for (const n of nodes) {
      g.nodes[n].alive = true;
      g.mergeNodes(center, n);
    }
    if (!g.nodes[center].ch.length) g.nodes[center].alive = false;
  }
}

// ---------------------------------------------------------------- contraction

function widestPrefab(g: Graph, n: number): NetPrefab {
  let best: NetPrefab = 'road_small_2lane';
  let bw = 0;
  for (const o of g.nodes[n].ch) {
    const p = prefabOf(g.chains[o].at);
    const w = clearance(p, p);
    if (w > bw) {
      bw = w;
      best = p;
    }
  }
  return best;
}

/** contract chains too short to become a segment, delete short loops and short parallel duplicates */
export function contractShort(g: Graph) {
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    const ids = g.live().sort((a, b) => g.len(a) - g.len(b));
    for (const id of ids) {
      const c = g.chains[id];
      if (!c.alive) continue;
      const L = g.len(id);
      if (c.a === c.b) {
        if (L < 110) {
          g.removeChain(id);
          changed = true;
        }
        continue;
      }
      const pa = widestPrefab(g, c.a);
      const pb = widestPrefab(g, c.b);
      const need = Math.max(MIN_CHAIN, clearance(pa, pb) + 4);
      if (L >= need) continue;
      const A = g.nodes[c.a];
      const B = g.nodes[c.b];
      if (A.outside && B.outside) {
        g.removeChain(id);
        changed = true;
        continue;
      }
      const da = g.deg(c.a) - 1;
      const db = g.deg(c.b) - 1;
      let keep: number;
      let drop: number;
      let px: number;
      let pz: number;
      if (A.outside || (db === 0 && !B.outside)) {
        keep = c.a; drop = c.b; px = A.x; pz = A.z;
      } else if (B.outside || da === 0) {
        keep = c.b; drop = c.a; px = B.x; pz = B.z;
      } else {
        keep = da >= db ? c.a : c.b;
        drop = keep === c.a ? c.b : c.a;
        px = (A.x * da + B.x * db) / (da + db);
        pz = (A.z * da + B.z * db) / (da + db);
      }
      g.removeChain(id);
      g.nodes[keep].alive = true;
      g.nodes[drop].alive = true;
      g.setNodePos(keep, px, pz);
      g.mergeNodes(keep, drop);
      if (!g.nodes[keep].ch.length) g.nodes[keep].alive = false;
      // chains that collapsed to nothing
      for (const o of g.nodes[keep].ch.slice()) {
        if (g.chains[o].alive && g.len(o) < 0.5) g.removeChain(o);
      }
      changed = true;
    }
    // short multi-edges
    const pair = new Map<string, number[]>();
    for (const id of g.live()) {
      const c = g.chains[id];
      if (c.a === c.b) continue;
      const k = c.a < c.b ? `${c.a}:${c.b}` : `${c.b}:${c.a}`;
      const arr = pair.get(k);
      if (arr) arr.push(id);
      else pair.set(k, [id]);
    }
    for (const arr of pair.values()) {
      if (arr.length < 2) continue;
      arr.sort((x, y) => IMPORTANCE[g.chains[y].at.cls] - IMPORTANCE[g.chains[x].at.cls] || g.len(x) - g.len(y));
      let singles = 0;
      for (const id of arr) {
        if (g.len(id) < 72) {
          singles++;
          if (singles > 1) {
            g.removeChain(id);
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
}

// ---------------------------------------------------------------- importance / strokes

export function computeImportance(g: Graph) {
  const live = g.live();
  const parent = new Map<number, number>();
  for (const id of live) parent.set(id, id);
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let x = i;
    while (parent.get(x) !== r) {
      const nx = parent.get(x)!;
      parent.set(x, r);
      x = nx;
    }
    return r;
  };
  for (let n = 0; n < g.nodes.length; n++) {
    const node = g.nodes[n];
    if (!node.alive || node.ch.length < 2) continue;
    const ends: { id: number; d: Pt }[] = [];
    const seen = new Set<number>();
    for (const id of node.ch) {
      if (seen.has(id)) continue;
      seen.add(id);
      ends.push({ id, d: g.dirFrom(id, n, 30) });
    }
    const cand: { i: number; j: number; s: number }[] = [];
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const ci = g.chains[ends[i].id];
        const cj = g.chains[ends[j].id];
        if (family(ci.at.cls) !== family(cj.at.cls)) continue;
        const dev = Math.PI - angleBetween(ends[i].d, ends[j].d);
        if (dev > Math.PI / 4) continue;
        let s = dev;
        if (ci.at.name && ci.at.name === cj.at.name) s -= 0.5;
        if (ci.at.cls === cj.at.cls) s -= 0.2;
        cand.push({ i, j, s });
      }
    }
    cand.sort((a, b) => a.s - b.s);
    const used = new Set<number>();
    for (const c of cand) {
      if (used.has(c.i) || used.has(c.j)) continue;
      used.add(c.i);
      used.add(c.j);
      const a = find(ends[c.i].id);
      const b = find(ends[c.j].id);
      if (a !== b) parent.set(a, b);
    }
  }
  const strokeLen = new Map<number, number>();
  for (const id of live) {
    const r = find(id);
    strokeLen.set(r, (strokeLen.get(r) ?? 0) + g.len(id));
  }
  for (const id of live) {
    const c = g.chains[id];
    c.imp = IMPORTANCE[c.at.cls] - (c.at.link ? 8 : 0) + Math.min(7, (strokeLen.get(find(id)) ?? 0) / 500);
  }
}

// ---------------------------------------------------------------- thinning

const THIN_EXEMPT = new Set(['motorway', 'trunk', 'primary', 'rail', 'subway']);

/** drop minor chains that crowd better ones closer than `spacing`; keep connectivity */
export function thin(g: Graph, detail: number) {
  const S = 80 - 20 * detail;
  const live = g.live();
  const exempt = (id: number) => {
    const c = g.chains[id];
    return THIN_EXEMPT.has(c.at.cls) || c.at.roundabout || g.nodes[c.a].outside || g.nodes[c.b].outside;
  };
  const idx = new SegGrid(Math.max(32, S));
  const accepted = new Set<number>();
  for (const id of live) {
    if (exempt(id)) {
      accepted.add(id);
      g.indexChain(idx, id);
    }
  }
  const cands = live.filter((id) => !accepted.has(id)).sort((a, b) => g.chains[b].imp - g.chains[a].imp);
  const rejected: number[] = [];
  for (const id of cands) {
    const c = g.chains[id];
    const cum = cumLen(c.pts);
    const L = cum[cum.length - 1];
    const s0 = Math.min(S * 0.6, L / 2);
    const s1 = Math.max(L - S * 0.6, L / 2);
    let total = 0;
    let crowded = 0;
    for (let s = s0; s <= s1 + 1e-6; s += 8) {
      total++;
      const p = pointAt(c.pts, cum, s);
      const q = pointAt(c.pts, cum, Math.min(L, s + 2));
      const r = pointAt(c.pts, cum, Math.max(0, s - 2));
      const t = unit(q[0] - r[0], q[1] - r[1]);
      let hit = false;
      idx.query(p[0] - S, p[1] - S, p[0] + S, p[1] + S, (sid) => {
        if (hit) return;
        const o = idx.owner(sid);
        if (o === id) return;
        const [ax, az, bx, bz] = idx.get(sid);
        const u = unit(bx - ax, bz - az);
        if (Math.abs(u[0] * t[0] + u[1] * t[1]) < 0.8) return;
        const d2 = pointSegDist2(p[0], p[1], ax, az, bx, bz);
        if (d2 >= S * S) return;
        // beside, not a collinear continuation ahead or behind
        const tt = projectSeg(p[0], p[1], ax, az, bx, bz);
        const qx = ax + (bx - ax) * tt - p[0];
        const qz = az + (bz - az) * tt - p[1];
        const d = Math.sqrt(d2);
        if (d > 1 && Math.abs((qx * t[0] + qz * t[1]) / d) > 0.7) return;
        hit = true;
      });
      if (hit) crowded++;
    }
    if (total > 0 && crowded / total > 0.5) {
      rejected.push(id);
    } else {
      accepted.add(id);
      g.indexChain(idx, id);
    }
  }
  if (!rejected.length) return;
  // connectivity restore: Kruskal with accepted chains free, prune dangling additions
  const parent = new Int32Array(g.nodes.length).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const id of accepted) {
    const c = g.chains[id];
    parent[find(c.a)] = find(c.b);
  }
  const restored = new Set<number>();
  const byCost = rejected.slice().sort((a, b) => g.len(a) / g.chains[a].imp - g.len(b) / g.chains[b].imp);
  for (const id of byCost) {
    const c = g.chains[id];
    const ra = find(c.a);
    const rb = find(c.b);
    if (ra !== rb) {
      parent[ra] = rb;
      restored.add(id);
    }
  }
  const deg = new Map<number, number>();
  const bump = (n: number, d: number) => deg.set(n, (deg.get(n) ?? 0) + d);
  for (const id of accepted) { bump(g.chains[id].a, 1); bump(g.chains[id].b, 1); }
  for (const id of restored) { bump(g.chains[id].a, 1); bump(g.chains[id].b, 1); }
  let again = true;
  while (again) {
    again = false;
    for (const id of restored) {
      const c = g.chains[id];
      if ((deg.get(c.a) ?? 0) <= 1 || (deg.get(c.b) ?? 0) <= 1) {
        restored.delete(id);
        bump(c.a, -1);
        bump(c.b, -1);
        again = true;
      }
    }
  }
  for (const id of rejected) if (!restored.has(id)) g.removeChain(id);
}

/** remove short dead-end stubs and tiny isolated fragments */
export function pruneStubs(g: Graph, detail: number) {
  const Lstub = 60 - 20 * detail;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const id of g.live()) {
      const c = g.chains[id];
      if (c.a === c.b) continue;
      const A = g.nodes[c.a];
      const B = g.nodes[c.b];
      const deadA = A.ch.length === 1 && !A.outside;
      const deadB = B.ch.length === 1 && !B.outside;
      if (deadA === deadB) continue;
      const other = deadA ? B : A;
      if (other.ch.length >= 3 && g.len(id) < Lstub) {
        g.removeChain(id);
        changed = true;
      }
    }
    g.dissolveAll();
    if (!changed) break;
  }
  removeFragments(g, 200 + 200 * (1 - detail));
}

export function removeFragments(g: Graph, minLen: number) {
  const comp = new Int32Array(g.nodes.length).fill(-1);
  let nc = 0;
  for (let s = 0; s < g.nodes.length; s++) {
    if (!g.nodes[s].alive || comp[s] >= 0 || !g.nodes[s].ch.length) continue;
    const stack = [s];
    comp[s] = nc;
    const chains = new Set<number>();
    let total = 0;
    while (stack.length) {
      const n = stack.pop()!;
      for (const id of g.nodes[n].ch) {
        if (chains.has(id)) continue;
        chains.add(id);
        total += g.len(id);
        const c = g.chains[id];
        for (const m of [c.a, c.b]) if (comp[m] < 0) {
          comp[m] = nc;
          stack.push(m);
        }
      }
    }
    if (total < minLen) for (const id of chains) g.removeChain(id);
    nc++;
  }
}

// ---------------------------------------------------------------- smoothing

export function smoothChains(g: Graph) {
  const h = 6;
  for (const id of g.live()) {
    const c = g.chains[id];
    let p = resample(c.pts, h);
    const sig = smoothSigma(c.at.cls) / h;
    if (p.length >= 3 && sig > 0.3) p = smoothGaussian(p, sig);
    g.setPts(id, p);
  }
}

// ---------------------------------------------------------------- outside approaches

export function straightenApproaches(g: Graph) {
  for (let n = 0; n < g.nodes.length; n++) {
    const node = g.nodes[n];
    if (!node.alive || !node.outside) continue;
    if (node.ch.length !== 1) continue;
    const id = node.ch[0];
    const c = g.chains[id];
    const fwd = c.a === n;
    const p = fwd ? c.pts : c.pts.slice().reverse();
    const xSide = Math.abs(Math.abs(node.x) - HALF) < 1e-6;
    const borderDist = (q: Pt) => (xSide ? HALF - Math.abs(q[0]) : HALF - Math.abs(q[1]));
    let k = -1;
    for (let i = 1; i < p.length; i++) {
      if (borderDist(p[i]) >= APPROACH_LEN) {
        k = i;
        break;
      }
    }
    if (k < 0) continue;
    const P = p[k];
    const lim = HALF - 150;
    const B: Pt = xSide
      ? [Math.sign(node.x) * HALF, Math.max(-lim, Math.min(lim, P[1]))]
      : [Math.max(-lim, Math.min(lim, P[0])), Math.sign(node.z) * HALF];
    const seg: Pt[] = [B];
    const dd = dist(B, P);
    const m = Math.max(1, Math.round(dd / 6));
    for (let i = 1; i < m; i++) seg.push([B[0] + ((P[0] - B[0]) * i) / m, B[1] + ((P[1] - B[1]) * i) / m]);
    const np = [...seg, ...p.slice(k)];
    node.x = B[0];
    node.z = B[1];
    g.setPts(id, fwd ? np : np.reverse());
  }
}

// ---------------------------------------------------------------- acute junctions

const ACUTE = (25 * Math.PI) / 180;

/** turn razor-thin merges into clean junctions where the minor branch has separated */
export function fixAcute(g: Graph) {
  for (let iter = 0; iter < 6; iter++) {
    let changed = false;
    for (let n = 0; n < g.nodes.length; n++) {
      const node = g.nodes[n];
      if (!node.alive || node.ch.length < 2) continue;
      const ids = [...new Set(node.ch)].filter((id) => g.chains[id].a !== g.chains[id].b);
      let done = false;
      for (let i = 0; i < ids.length && !done; i++) {
        for (let j = i + 1; j < ids.length && !done; j++) {
          const ci = g.chains[ids[i]];
          const cj = g.chains[ids[j]];
          if (levelKey(ci.at) !== levelKey(cj.at)) continue;
          const ang = angleBetween(g.dirFrom(ids[i], n, 20), g.dirFrom(ids[j], n, 20));
          if (ang >= ACUTE) continue;
          const minor = ci.imp < cj.imp || (ci.imp === cj.imp && g.len(ids[i]) < g.len(ids[j])) ? ids[i] : ids[j];
          const major = minor === ids[i] ? ids[j] : ids[i];
          reroute(g, n, minor, major);
          changed = true;
          done = true;
        }
      }
    }
    if (!changed) break;
  }
}

function reroute(g: Graph, n: number, minor: number, major: number) {
  const c1 = g.chains[minor];
  const c2 = g.chains[major];
  const P1 = g.ptsFrom(minor, n);
  const P2 = g.ptsFrom(major, n);
  const cum2 = cumLen(P2);
  const L2 = cum2[cum2.length - 1];
  const clr = clearance(prefabOf(c1.at), prefabOf(c2.at)) + 2;
  let k = -1;
  for (let i = 1; i < P1.length; i++) {
    if (pointPolyDist(P1[i][0], P1[i][1], P2, cum2).d >= clr) {
      k = i;
      break;
    }
  }
  const far = c1.a === n ? c1.b : c1.a;
  const towardN = c1.b === n; // travel direction of the minor chain
  const at = c1.at;
  const imp = c1.imp;
  if (k < 0) {
    g.removeChain(minor);
    return;
  }
  const P = P1[k];
  const t = pointPolyDist(P[0], P[1], P2, cum2).s;
  const majorFar = c2.a === n ? c2.b : c2.a;
  let Q: number;
  const gap = 34;
  if (t < gap + 12) {
    Q = n;
  } else {
    const tq = Math.max(gap, t - clr);
    if (tq > L2 - gap) {
      Q = majorFar;
    } else {
      const s = c2.a === n ? tq : L2 - tq;
      Q = g.splitChain(major, s).node;
    }
  }
  if (Q === far) {
    g.removeChain(minor);
    return;
  }
  const rest = P1.slice(k);
  const qn = g.nodes[Q];
  const pts: Pt[] = [[qn.x, qn.z], ...rest];
  g.removeChain(minor);
  g.nodes[Q].alive = true;
  g.nodes[far].alive = true;
  if (towardN) g.addChain(far, Q, pts.slice().reverse(), at, imp);
  else g.addChain(Q, far, pts, at, imp);
}
