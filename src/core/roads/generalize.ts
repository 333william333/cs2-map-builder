/** Graph-level generalisation: water bridges, snapping, roundabouts, contraction, thinning, smoothing. */
import type { NetPrefab, Pt, RoadClass, TerrainResult } from '../types';
import {
  APPROACH_LEN, type Attr, HALF, IMPORTANCE, MIN_CHAIN, choosePrefab, clearance, family, levelKey,
  smoothSigma,
} from './params';
import {
  angleBetween, cumLen, dist, pointAt, pointPolyDist, pointSegDist2, polyLength, projectSeg, resample,
  smoothGaussian, unit, vertexTurns,
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

export interface RoundaboutStats {
  found: number;
  detected: number;
  kept: number;
  enlarged: number;
  collapsed: number;
}

/** smallest ring radius (m) that can be built from segments of >= 32 m turning <= 70 deg */
function minRingRadius(arms: number): number {
  return Math.max(28, (34 * arms) / (2 * Math.PI) + 2);
}

/**
 * Vector tiles carry no roundabout flag: mark small, round, smooth directed loops of one-way
 * chains as roundabouts.
 */
function detectRings(g: Graph, maxPerim: number): number {
  let found = 0;
  const marked = new Set<number>();
  for (const id of g.live()) {
    const c0 = g.chains[id];
    if (!c0.at.oneway || c0.at.roundabout || c0.at.link || marked.has(id) || family(c0.at.cls) !== 'road') continue;
    // follow the smoothest one-way continuation until we return to the start
    const path = [id];
    let len = g.len(id);
    let cur = id;
    let ok = c0.a === c0.b;
    for (let step = 0; step < 10 && len <= maxPerim && !ok; step++) {
      const c = g.chains[cur];
      const dIn = g.dirFrom(cur, c.b, 8, true);
      const din: Pt = [-dIn[0], -dIn[1]];
      let next = -1;
      let best = Infinity;
      for (const o of g.nodes[c.b].ch) {
        const oc = g.chains[o];
        if (o === cur || !oc.alive || !oc.at.oneway || oc.a !== c.b || oc.at.cls !== c0.at.cls || path.includes(o)) continue;
        const dev = angleBetween(din, g.dirFrom(o, c.b, 8));
        if (dev < best) {
          best = dev;
          next = o;
        }
      }
      if (next < 0 || best > Math.PI / 2) break;
      path.push(next);
      len += g.len(next);
      cur = next;
      if (g.chains[next].b === c0.a) ok = true;
    }
    if (!ok || len > maxPerim || len < 20) continue;
    // round and smooth: radius spread small, no sharp corners
    const pts: Pt[] = [];
    for (const k of path) for (const q of g.chains[k].pts) pts.push(q);
    const rs = resample(pts, Math.max(2, len / 48));
    let cx = 0;
    let cz = 0;
    for (const q of rs) {
      cx += q[0];
      cz += q[1];
    }
    cx /= rs.length;
    cz /= rs.length;
    const rad = rs.map((q) => Math.hypot(q[0] - cx, q[1] - cz));
    const mean = rad.reduce((x, y) => x + y, 0) / rad.length;
    const sd = Math.sqrt(rad.reduce((x, y) => x + (y - mean) ** 2, 0) / rad.length);
    const turns = vertexTurns(rs);
    let maxTurn = 0;
    for (let i = 1; i + 1 < rs.length; i++) maxTurn = Math.max(maxTurn, turns[i]);
    if (mean <= 0 || sd / mean > 0.25 || maxTurn > (50 * Math.PI) / 180) continue;
    for (const k of path) {
      marked.add(k);
      g.chains[k].at = { ...g.chains[k].at, roundabout: true };
    }
    found++;
  }
  return found;
}

/**
 * Keep every roundabout that can be built as a ring of one-way segments; enlarge a too small
 * ring to the minimum buildable radius when its arms leave room; collapse it to one junction
 * only when even that cannot fit.
 */
export function roundabouts(g: Graph, scale = 1): RoundaboutStats {
  const stats: RoundaboutStats = { found: 0, detected: 0, kept: 0, enlarged: 0, collapsed: 0 };
  stats.detected = detectRings(g, Math.max(160, 350 * scale));
  const seen = new Set<number>();
  for (const id of g.live()) {
    const c0 = g.chains[id];
    if (!c0.alive || !c0.at.roundabout || seen.has(id)) continue;
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
    for (const k of group) {
      const p = g.chains[k].pts;
      perim += g.len(k);
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
    if (!closed) continue; // partial ring data: leave it as ordinary one-way roads
    stats.found++;
    const cx = sx / sw;
    const cz = sz / sw;
    let outside = false;
    for (const n of nodes) if (g.nodes[n].outside) outside = true;
    if (outside) {
      stats.kept++;
      continue;
    }
    const ringSet = new Set(group);
    const armNodes = [...nodes].filter((n) => g.nodes[n].ch.some((o) => !ringSet.has(o)));
    const R = perim / (2 * Math.PI);
    const Rmin = minRingRadius(armNodes.length);
    if (R >= Rmin) {
      stats.kept++;
      continue;
    }
    // does a ring of radius Rmin fit? arms must reach beyond it and nothing else may be inside
    let fits = armNodes.length >= 2 && Rmin / Math.max(R, 1) <= 4;
    for (const n of armNodes) {
      for (const o of g.nodes[n].ch) {
        if (ringSet.has(o)) continue;
        const oc = g.chains[o];
        const far = oc.a === n ? oc.b : oc.a;
        if (nodes.has(far) || Math.hypot(g.nodes[far].x - cx, g.nodes[far].z - cz) < Rmin + 8) fits = false;
      }
    }
    for (let n = 0; n < g.nodes.length && fits; n++) {
      const N = g.nodes[n];
      if (!N.alive || nodes.has(n) || !N.ch.length) continue;
      if (Math.hypot(N.x - cx, N.z - cz) < Rmin + 2) fits = false;
    }
    // travel direction of the ring (signed area along chain direction)
    let area = 0;
    for (const k of group) {
      const p = g.chains[k].pts;
      for (let i = 0; i + 1 < p.length; i++) area += (p[i][0] - cx) * (p[i + 1][1] - cz) - (p[i + 1][0] - cx) * (p[i][1] - cz);
    }
    const ccw = area > 0;
    const at = { ...g.chains[group[0]].at };
    for (const k of group) g.removeChain(k);
    if (fits) {
      // move arm junctions radially onto the new circle and rebuild the ring as arcs
      const placed = armNodes
        .map((n) => ({ n, a: Math.atan2(g.nodes[n].z - cz, g.nodes[n].x - cx) }))
        .sort((p, q) => p.a - q.a);
      // merge arm junctions that would be closer than one segment along the ring
      const merged: { n: number; a: number }[] = [];
      for (const p of placed) {
        const last = merged[merged.length - 1];
        g.nodes[p.n].alive = true;
        if (last && (p.a - last.a) * Rmin < 34) g.mergeNodes(last.n, p.n);
        else merged.push(p);
      }
      if (merged.length > 2 && (merged[0].a + 2 * Math.PI - merged[merged.length - 1].a) * Rmin < 34) {
        const last = merged.pop()!;
        g.mergeNodes(merged[0].n, last.n);
      }
      for (const p of merged) g.setNodePos(p.n, cx + Rmin * Math.cos(p.a), cz + Rmin * Math.sin(p.a));
      const m = merged.length;
      for (let i = 0; i < m; i++) {
        const A = merged[i];
        const B = merged[(i + 1) % m];
        let span = B.a - A.a;
        if (span <= 0) span += 2 * Math.PI;
        if (m === 1) span = 2 * Math.PI;
        const steps = Math.max(2, Math.ceil((span * Rmin) / 4));
        const arc: Pt[] = [];
        for (let s = 0; s <= steps; s++) {
          const t = A.a + (span * s) / steps;
          arc.push([cx + Rmin * Math.cos(t), cz + Rmin * Math.sin(t)]);
        }
        // arcs run counter-clockwise (increasing angle); flip for clockwise rings
        if (ccw) g.addChain(A.n, B.n, arc, { ...at });
        else g.addChain(B.n, A.n, arc.reverse(), { ...at });
      }
      stats.enlarged++;
      continue;
    }
    const center = g.addNode(cx, cz);
    for (const n of nodes) {
      g.nodes[n].alive = true;
      g.mergeNodes(center, n);
    }
    if (!g.nodes[center].ch.length) g.nodes[center].alive = false;
    stats.collapsed++;
  }
  return stats;
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

/** merge the two end nodes of a chain (the chain disappears, its routes stay connected) */
export function contractChain(g: Graph, id: number) {
  const c = g.chains[id];
  if (!c.alive) return;
  if (c.a === c.b) {
    g.removeChain(id);
    return;
  }
  const A = g.nodes[c.a];
  const B = g.nodes[c.b];
  if (A.outside && B.outside) {
    g.removeChain(id);
    return;
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
}

/** contract chains too short to become a segment, delete short loops and short parallel duplicates */
export function contractShort(g: Graph, fromChain = 0) {
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    const ids = g.live().filter((id) => id >= fromChain || pass > 0).sort((a, b) => g.len(a) - g.len(b));
    for (const id of ids) {
      const c = g.chains[id];
      if (!c.alive) continue;
      const L = g.len(id);
      if (c.a === c.b) {
        if (L < 3 * 28) {
          g.removeChain(id);
          changed = true;
        }
        continue;
      }
      const pa = widestPrefab(g, c.a);
      const pb = widestPrefab(g, c.b);
      const need = Math.max(MIN_CHAIN, clearance(pa, pb) + 4);
      if (L >= need) continue;
      contractChain(g, id);
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

/** classes that may lose whole dead-end stubs or tiny fragments */
export function isMinorClass(c: RoadClass): boolean {
  return c === 'tertiary' || c === 'residential' || c === 'service' || c === 'pedestrian' || c === 'tram';
}

const THIN_EXEMPT = new Set(['motorway', 'trunk', 'primary', 'secondary', 'rail', 'subway']);

/** drop minor chains that crowd better ones closer than `spacing`; keep connectivity */
export function thin(g: Graph, detail: number) {
  // spacing below which a minor street crowds a better one: 75 m at detail 0, 30 m at 1
  const S = 75 - 45 * detail;
  // detail 1 = everything that fits: crowding is resolved by merging, not by thinning
  if (detail >= 0.95) return;
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
  const Lstub = 60 - 30 * detail;
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
      if (other.ch.length >= 3 && g.len(id) < Lstub && isMinorClass(c.at.cls)) {
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
    if (total < minLen && [...chains].every((id) => isMinorClass(g.chains[id].at.cls))) {
      for (const id of chains) g.removeChain(id);
    }
    nc++;
  }
}

// ---------------------------------------------------------------- smoothing

/** target minimum radius (m) of the polyline before segmentation */
function curveRadius(c: RoadClass): number {
  switch (c) {
    case 'motorway': case 'trunk': return 60;
    case 'rail': case 'subway': return 70;
    case 'primary': return 30;
    case 'secondary': case 'tram': return 20;
    default: return 14;
  }
}

/**
 * Round off corners tighter than radius R by local Laplacian smoothing (ends fixed).
 * Mountain switchbacks move a few tens of metres; that is accepted.
 */
export function limitCurvature(p: Pt[], R: number, h: number): Pt[] {
  const n = p.length;
  if (n < 3) return p;
  const maxTurn = Math.min(1.2, h / R);
  let q = p.map((v) => [v[0], v[1]] as Pt);
  for (let it = 0; it < 40; it++) {
    const t = vertexTurns(q);
    let any = false;
    const next = q.map((v) => [v[0], v[1]] as Pt);
    for (let i = 1; i < n - 1; i++) {
      if (t[i] <= maxTurn) continue;
      any = true;
      for (let k = Math.max(1, i - 2); k <= Math.min(n - 2, i + 2); k++) {
        next[k] = [
          (q[k - 1][0] + 2 * q[k][0] + q[k + 1][0]) / 4,
          (q[k - 1][1] + 2 * q[k][1] + q[k + 1][1]) / 4,
        ];
      }
    }
    q = next;
    if (!any) break;
  }
  return q;
}

export function smoothChains(g: Graph) {
  const h = 6;
  for (const id of g.live()) {
    const c = g.chains[id];
    let p = resample(c.pts, h);
    const sig = smoothSigma(c.at.cls) / h;
    if (p.length >= 3 && sig > 0.3) p = smoothGaussian(p, sig);
    g.setPts(id, limitCurvature(p, curveRadius(c.at.cls), h));
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
export function fixAcute(g: Graph, fromChain = 0) {
  for (let iter = 0; iter < 6; iter++) {
    let changed = false;
    let nodes: number[];
    if (fromChain > 0) {
      const set = new Set<number>();
      for (let id = fromChain; id < g.chains.length; id++) {
        const c = g.chains[id];
        if (c.alive) { set.add(c.a); set.add(c.b); }
      }
      nodes = [...set];
    } else nodes = g.nodes.map((_, i) => i);
    for (const n of nodes) {
      const node = g.nodes[n];
      if (!node.alive || node.ch.length < 2) continue;
      const ids = [...new Set(node.ch)].filter((id) => g.chains[id].a !== g.chains[id].b);
      let done = false;
      for (let i = 0; i < ids.length && !done; i++) {
        for (let j = i + 1; j < ids.length && !done; j++) {
          const ci = g.chains[ids[i]];
          const cj = g.chains[ids[j]];
          if (levelKey(ci.at) !== levelKey(cj.at) || family(ci.at.cls) !== family(cj.at.cls)) continue;
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

export function reroute(g: Graph, n: number, minor: number, major: number) {
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
    // the minor runs inside the major's corridor all the way: its far end joins the major
    g.removeChain(minor);
    g.nodes[far].alive = true;
    if (g.nodes[far].outside) {
      g.addChain(c1.a, c1.b, c1.pts, at, imp);
      return;
    }
    let best = -1;
    let bs = 0;
    let bd = Infinity;
    for (const id of [...new Set(g.nodes[n].ch)]) {
      const c = g.chains[id];
      if (!c.alive || family(c.at.cls) !== family(at.cls)) continue;
      const r = pointPolyDist(g.nodes[far].x, g.nodes[far].z, c.pts);
      if (r.d < bd) { bd = r.d; best = id; bs = r.s; }
    }
    if (best < 0) {
      g.addChain(c1.a, c1.b, c1.pts, at, imp);
      return;
    }
    const L = g.len(best);
    const bc = g.chains[best];
    let target: number;
    if (bs < 10) target = bc.a;
    else if (bs > L - 10) target = bc.b;
    else target = g.splitChain(best, bs).node;
    if (target !== far && !g.nodes[target].outside) g.mergeNodes(target, far);
    else if (target !== far) g.addChain(c1.a, c1.b, c1.pts, at, imp);
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
    // the minor already ends on the major: drop only the duplicated stretch, keep the junction
    g.removeChain(minor);
    g.nodes[far].alive = true;
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
