/**
 * Continuity checker: does every kept input route survive as a continuous, connected path?
 * Samples each input way inside the playable area and looks for a nearby, roughly parallel
 * output edge of the same family; consecutive samples must land on connected output edges.
 */
import type { Pt, RoadClass, RoadNetwork, RoadSettings, VectorData } from '../types';
import { CLASS_ORDER, HALF, family } from './params';
import { cumLen, pointAt, pointSegDist2, projectSeg, unit } from './geom';
import { SegGrid } from './spatial';
import { classKept } from './prepare';
import type { StageSnapshot } from './buildRoads';

export interface RouteBreak {
  cls: RoadClass;
  /** game coordinates where the input route stops being continuous in the output */
  p: Pt;
  /** length (m) of input route without output, 0 for a pure disconnection */
  len: number;
  kind: 'missing' | 'disconnected';
  /** first pipeline stage at which the route was broken (when snapshots are given) */
  stage?: string;
  name?: string;
  /** middle of a missing stretch */
  mid?: Pt;
}

export interface ClassContinuity {
  inKm: number;
  /** input length expected after merging carriageways (paired one-ways count half) */
  expectedKm: number;
  outKm: number;
  /** input length (km) with no output nearby */
  missingKm: number;
  breaks: number;
  namedInKm: number;
  namedOutKm: number;
}

export interface ContinuityReport {
  classes: Partial<Record<RoadClass, ClassContinuity>>;
  breaks: RouteBreak[];
  inComponents: number;
  outComponents: number;
  inDeadEnds: number;
  outDeadEnds: number;
  namedInShare: number;
  namedOutShare: number;
  /** input structure length (paired carriageways counted half), the part kept as the same structure, output total */
  structures: Record<'bridge' | 'tunnel', { expectedKm: number; keptKm: number; outKm: number }>;
  /** lost structure km by the stage that lost it */
  structureLoss: Record<string, number>;
}

/** routes are judged inside this square; the band outside it is where ways are cut back */
const INNER = HALF - 100;
const STEP = 15;

function tolFor(cls: RoadClass): number {
  switch (cls) {
    case 'motorway': case 'trunk': return 42;
    case 'rail': return 40;
    case 'primary': case 'secondary': return 32;
    default: return 30;
  }
}

/** pieces of a polyline inside the inner square */
function insidePieces(pts: Pt[]): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  const inside = (p: Pt) => Math.abs(p[0]) <= INNER && Math.abs(p[1]) <= INNER;
  const cum = cumLen(pts);
  const L = cum[cum.length - 1];
  const n = Math.max(1, Math.ceil(L / 5));
  for (let i = 0; i <= n; i++) {
    const p = pointAt(pts, cum, (L * i) / n);
    if (inside(p)) cur.push(p);
    else if (cur.length) {
      if (cur.length >= 2) out.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

interface Lines {
  grid: SegGrid;
  cls: RoadClass[];
  comp: number[];
  lvl: number[];
}

function indexLines(lines: { pts: Pt[]; cls: RoadClass; comp: number; lvl?: number }[]): Lines {
  const grid = new SegGrid(48);
  lines.forEach((l, k) => {
    for (let i = 0; i + 1 < l.pts.length; i++) grid.add(l.pts[i][0], l.pts[i][1], l.pts[i + 1][0], l.pts[i + 1][1], k);
  });
  return { grid, cls: lines.map((l) => l.cls), comp: lines.map((l) => l.comp), lvl: lines.map((l) => l.lvl ?? -9) };
}

/** nearest roughly parallel line of the same family within tol: [line index, distance] */
function nearest(L: Lines, p: Pt, t: Pt, cls: RoadClass, tol: number, lvl = -9): number {
  let best = -1;
  let bs = Infinity;
  const fam = family(cls);
  L.grid.query(p[0] - tol, p[1] - tol, p[0] + tol, p[1] + tol, (sid) => {
    const k = L.grid.owner(sid);
    if (family(L.cls[k]) !== fam) return;
    const [ax, az, bx, bz] = L.grid.get(sid);
    const d = Math.sqrt(pointSegDist2(p[0], p[1], ax, az, bx, bz));
    if (d > tol) return;
    const u = unit(bx - ax, bz - az);
    const dot = Math.abs(u[0] * t[0] + u[1] * t[1]);
    if (dot < 0.5) return;
    // prefer the same class and level, and parallel lines (crossing ramps are worse matches)
    const score = d + (L.cls[k] === cls ? 0 : 12) + (lvl !== -9 && L.lvl[k] !== -9 && L.lvl[k] !== lvl ? 20 : 0) + (1 - dot) * 30;
    if (score < bs) {
      bs = score;
      best = k;
    }
  });
  return best;
}

export function checkContinuity(
  input: VectorData,
  net: RoadNetwork,
  settings: RoadSettings,
  snapshots?: StageSnapshot[],
  /** roundabouts rebuilt as circles: their discs replace the real geometry and are not judged */
  rings?: { cx: number; cz: number; r: number }[],
): ContinuityReport {
  // the ring and its re-attached approaches (arm junctions move out with an enlarged ring)
  const inRing = (p: Pt) => !!rings?.some((g) => Math.hypot(p[0] - g.cx, p[1] - g.cz) < g.r + 45);
  const ways = input.ways.filter((w) => classKept(w.cls, settings) && w.pts.length >= 2);
  const classes: Partial<Record<RoadClass, ClassContinuity>> = {};
  const C = (c: RoadClass) =>
    (classes[c] ??= { inKm: 0, expectedKm: 0, outKm: 0, missingKm: 0, breaks: 0, namedInKm: 0, namedOutKm: 0 });

  // output graph
  const idOf = new Map<number, number>();
  net.nodes.forEach((n, i) => idOf.set(n.id, i));
  const parent = new Int32Array(net.nodes.length).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const deg = new Int32Array(net.nodes.length);
  const adj: number[][] = net.nodes.map(() => []);
  net.edges.forEach((e, k) => {
    const a = idOf.get(e.a)!;
    const b = idOf.get(e.b)!;
    parent[find(a)] = find(b);
    deg[a]++;
    deg[b]++;
    adj[a].push(k);
    adj[b].push(k);
  });
  const elen = net.edges.map((e) => {
    let s = 0;
    for (let i = 1; i < e.pts.length; i++) s += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
    return s;
  });
  const out = indexLines(net.edges.map((e) => ({ pts: e.pts, cls: e.cls, comp: find(idOf.get(e.a)!), lvl: e.bridge ? 1 : e.tunnel ? -1 : 0 })));
  let namedOut = 0;
  let totalOut = 0;
  net.edges.forEach((e, k) => {
    const c = C(e.cls);
    c.outKm += elen[k] / 1000;
    if (e.name) {
      c.namedOutKm += elen[k] / 1000;
      namedOut += elen[k];
    }
    totalOut += elen[k];
  });

  /** edges e1 and e2 joined by a short path in the output graph */
  const linked = (e1: number, e2: number, maxLen: number): boolean => {
    if (e1 === e2) return true;
    const A = net.edges[e1];
    const B = net.edges[e2];
    const targets = new Set([idOf.get(B.a)!, idOf.get(B.b)!]);
    const distm = new Map<number, number>();
    const queue: [number, number][] = [[idOf.get(A.a)!, 0], [idOf.get(A.b)!, 0]];
    for (const [n] of queue) distm.set(n, 0);
    let guard = 0;
    while (queue.length && guard++ < 400) {
      queue.sort((x, y) => x[1] - y[1]);
      const [n, d] = queue.shift()!;
      if (targets.has(n)) return true;
      for (const k of adj[n]) {
        const e = net.edges[k];
        const m = idOf.get(e.a) === n ? idOf.get(e.b)! : idOf.get(e.a)!;
        const nd = d + elen[k];
        if (nd > maxLen) continue;
        if ((distm.get(m) ?? Infinity) <= nd) continue;
        distm.set(m, nd);
        queue.push([m, nd]);
      }
    }
    return false;
  };

  // paired one-ways (carriageways) count half towards the expectation
  const owGrid = new SegGrid(48);
  const pairable = (w: (typeof ways)[number]) => w.cls === 'rail' || (w.oneway && !w.link && !w.roundabout);
  ways.forEach((w, k) => {
    if (!pairable(w)) return;
    for (let i = 0; i + 1 < w.pts.length; i++) owGrid.add(w.pts[i][0], w.pts[i][1], w.pts[i + 1][0], w.pts[i + 1][1], k);
  });
  const snapIdx = (snapshots ?? []).map((s) => ({ stage: s.stage, L: indexLines(s.lines) }));

  const structures = { bridge: { expectedKm: 0, keptKm: 0, outKm: 0 }, tunnel: { expectedKm: 0, keptKm: 0, outKm: 0 } };
  net.edges.forEach((e, k) => {
    if (e.bridge) structures.bridge.outKm += elen[k] / 1000;
    if (e.tunnel) structures.tunnel.outKm += elen[k] / 1000;
  });
  const structureLoss: Record<string, number> = {};
  const breaks: RouteBreak[] = [];
  let namedIn = 0;
  let totalIn = 0;
  for (const [wi, w] of ways.entries()) {
    const c = C(w.cls);
    const tol = tolFor(w.cls);
    for (const piece of insidePieces(w.pts)) {
      const cum = cumLen(piece);
      const L = cum[cum.length - 1];
      if (L < 1) continue;
      c.inKm += L / 1000;
      totalIn += L;
      if (w.name || w.ref) {
        c.namedInKm += L / 1000;
        namedIn += L;
      }
      const n = Math.max(1, Math.round(L / STEP));
      let prevEdge = -1;
      let missRun = 0;
      let missStart: Pt | null = null;
      let missS = 0;
      let paired = 0;
      const flush = () => {
        if (missRun >= 2 * STEP - 1 && missStart) {
          const at = pointAt(piece, cum, Math.min(L, missS + missRun / 2));
          breaks.push({ cls: w.cls, p: missStart, len: missRun, kind: 'missing', name: w.name ?? w.ref, mid: at } as RouteBreak);
        }
        missRun = 0;
        missStart = null;
      };
      for (let i = 0; i <= n; i++) {
        const s = (L * i) / n;
        const p = pointAt(piece, cum, s);
        const q0 = pointAt(piece, cum, Math.max(0, s - 3));
        const q1 = pointAt(piece, cum, Math.min(L, s + 3));
        const t = unit(q1[0] - q0[0], q1[1] - q0[1]);
        let pairedHere = false;
        if (pairable(w)) {
          let hit = false;
          const rail = w.cls === 'rail';
          owGrid.query(p[0] - 40, p[1] - 40, p[0] + 40, p[1] + 40, (sid) => {
            const o = owGrid.owner(sid);
            if (hit || o === wi || (ways[o].cls === 'rail') !== rail) return;
            const [ax, az, bx, bz] = owGrid.get(sid);
            if (pointSegDist2(p[0], p[1], ax, az, bx, bz) > (rail ? 900 : 1600)) return;
            const u = unit(bx - ax, bz - az);
            const dot = u[0] * t[0] + u[1] * t[1];
            if (rail ? Math.abs(dot) > 0.8 && o > wi : dot < -0.8) hit = true;
          });
          if (hit) paired++;
          pairedHere = hit;
        }
        if (inRing(p)) {
          flush();
          prevEdge = -1;
          continue;
        }
        const e = nearest(out, p, t, w.cls, tol, w.bridge ? 1 : w.tunnel ? -1 : 0);
        if ((w.bridge || w.tunnel) && i > 0) {
          const sk = w.bridge ? structures.bridge : structures.tunnel;
          const wgt = ((L / n) * (pairedHere ? 0.5 : 1)) / 1000;
          sk.expectedKm += wgt;
          if (e >= 0 && (w.bridge ? net.edges[e].bridge : net.edges[e].tunnel)) sk.keptKm += wgt;
          else if (snapIdx.length) {
            // first stage where this stretch stopped being the same structure
            const want = w.bridge ? 1 : -1;
            let stage = '?';
            for (const { stage: st, L: SL } of snapIdx) {
              const m = nearest(SL, p, t, w.cls, tol, want);
              if (m < 0 || SL.lvl[m] !== want) {
                stage = st;
                break;
              }
            }
            const key = (w.bridge ? 'bridge/' : 'tunnel/') + stage;
            structureLoss[key] = (structureLoss[key] ?? 0) + wgt;
          }
        }
        const seg = L / n;
        if (e < 0) {
          if (!missStart) {
            missStart = p;
            missS = s;
          }
          missRun += seg;
          if (i > 0) c.missingKm += seg / 1000;
          prevEdge = -1;
          continue;
        }
        flush();
        if (prevEdge >= 0 && !linked(prevEdge, e, 3 * STEP + 250)) {
          breaks.push({ cls: w.cls, p, len: 0, kind: 'disconnected', name: w.name ?? w.ref });
        }
        prevEdge = e;
      }
      flush();
      c.expectedKm += (L * (1 - (0.5 * paired) / (n + 1))) / 1000;
    }
  }

  // attribute breaks to the first stage that lost them
  for (const b of breaks) {
    const tol = tolFor(b.cls);
    for (const { stage, L } of snapIdx) {
      if (b.kind === 'missing') {
        // direction unknown here: accept any family line nearby the middle of the gap
        const q = b.mid ?? b.p;
        if (nearest(L, q, [0, 1], b.cls, tol) < 0 && nearest(L, q, [1, 0], b.cls, tol) < 0 && nearest(L, q, [0.7, 0.7], b.cls, tol) < 0 && nearest(L, q, [0.7, -0.7], b.cls, tol) < 0) {
          b.stage = stage;
          break;
        }
      } else {
        b.stage = snapIdx[snapIdx.length - 1]?.stage;
      }
    }
    C(b.cls).breaks++;
  }

  // components and dead ends: output vs the input graph built from the same ways
  const comps = new Set<number>();
  let outDead = 0;
  net.nodes.forEach((nd, i) => {
    if (deg[i]) comps.add(find(i));
    if (deg[i] === 1 && !nd.outside) outDead++;
  });
  let inComponents = 0;
  let inDead = 0;
  const graphSnap = snapshots?.find((s) => s.stage === 'graph');
  if (graphSnap) {
    inComponents = new Set(graphSnap.lines.map((l) => l.comp)).size;
    const endCount = new Map<string, number>();
    for (const l of graphSnap.lines) {
      for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) {
        const k = `${p[0]},${p[1]}`;
        endCount.set(k, (endCount.get(k) ?? 0) + 1);
      }
    }
    for (const [k, v] of endCount) {
      if (v !== 1) continue;
      const [x, z] = k.split(',').map(Number);
      if (Math.abs(x) < HALF - 1 && Math.abs(z) < HALF - 1) inDead++;
    }
  }
  const sorted: Partial<Record<RoadClass, ClassContinuity>> = {};
  for (const c of CLASS_ORDER) if (classes[c]) sorted[c] = classes[c];
  return {
    classes: sorted,
    breaks,
    inComponents,
    outComponents: comps.size,
    inDeadEnds: inDead,
    outDeadEnds: outDead,
    namedInShare: totalIn ? namedIn / totalIn : 0,
    namedOutShare: totalOut ? namedOut / totalOut : 0,
    structures,
    structureLoss,
  };
}

void projectSeg;
