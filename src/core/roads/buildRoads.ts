/**
 * OSM ways (game coordinates) -> clean CS2 road / rail graph.
 *
 * Pipeline: filter + de-jitter -> flatten tiny structures -> collapse dual carriageways and
 * parallel tracks -> clip + choose outside connections -> planar graph (shared vertices and
 * same-level crossings) -> water bridges -> dangle snapping -> roundabouts -> contraction of
 * short pieces -> density thinning (keeps connectivity) -> stub / fragment pruning -> smoothing
 * -> straight outside approaches -> acute junction repair -> segmentation + Bezier fit ->
 * elevations -> validate / repair loop.
 */
import type { Pt, RoadClass, RoadEdge, RoadNetwork, RoadNode, RoadSettings, TerrainResult, VectorData } from '../types';
import { CLASS_INDEX } from './params';
import { type PWay, collapseParallel, flattenShortStructures, prepareWays } from './prepare';
import { clipToPlayable } from './clip';
import { type Graph, buildGraph } from './graph';
import {
  type RoundaboutStats, bridgeWater, computeImportance, contractShort, fixAcute, pruneStubs, removeFragments, roundabouts,
  smoothChains, snapDangles, straightenApproaches, thin,
} from './generalize';
import { type SegCache, segmentGraph, type WNet } from './segment';
import { isMinorClass } from './generalize';
import { type ConflictStats, resolveChainConflicts } from './conflicts';
import { newRepairContext, repairRound } from './repair';
import { fixStructureTransitions } from './structures';

const MAX_REPAIR_ROUNDS = 8;
import { assignElevations } from './elevation';
import { findViolations } from './validate';

export { validateNetwork, findViolations } from './validate';

export interface BuildRoadsStats {
  stages: Record<string, number>;
  resolverIterations: number;
  droppedEdges: number;
  /** violation kinds seen by the repair loop, per iteration */
  violations: Record<string, number>[];
  conflicts?: ConflictStats;
  structureFixes?: number;
  roundabouts?: RoundaboutStats;
  repairActions?: number[];
  roundViolations?: Record<string, number>[];
  lastViolations?: string[];
  roundTimes?: Record<string, number>;
  repairLog?: string[];
}

let lastStats: BuildRoadsStats | null = null;
/** timing / repair statistics of the most recent buildRoads call (for reports) */
export function lastBuildRoadsStats(): BuildRoadsStats | null {
  return lastStats;
}

/** geometry after one pipeline stage, for continuity attribution */
export interface StageSnapshot {
  stage: string;
  lines: { pts: Pt[]; cls: RoadClass; comp: number; name?: string }[];
}

let trace: StageSnapshot[] | null = null;

function snapWays(stage: string, ways: PWay[]) {
  if (!trace) return;
  trace.push({ stage, lines: ways.map((w) => ({ pts: w.pts.map((p) => [p[0], p[1]] as Pt), cls: w.at.cls, comp: -1, name: w.at.name })) });
}

function snapGraph(stage: string, g: Graph) {
  if (!trace) return;
  const parent = new Int32Array(g.nodes.length).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const live = g.live();
  for (const id of live) parent[find(g.chains[id].a)] = find(g.chains[id].b);
  trace.push({
    stage,
    lines: live.map((id) => ({ pts: g.chains[id].pts.map((p) => [p[0], p[1]] as Pt), cls: g.chains[id].at.cls, comp: find(g.chains[id].a), name: g.chains[id].at.name })),
  });
}

function snapWork(stage: string, w: WNet) {
  if (!trace) return;
  const parent = new Int32Array(w.nodes.length).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const alive = w.edges.filter((e) => e.alive);
  for (const e of alive) parent[find(e.a)] = find(e.b);
  trace.push({ stage, lines: alive.map((e) => ({ pts: e.pts, cls: e.cls, comp: find(e.a), name: e.name })) });
}

/** buildRoads plus the geometry after every stage (slower; for reports and tests) */
export function buildRoadsTraced(
  vectors: VectorData, terrain: TerrainResult, settings: RoadSettings,
): { net: RoadNetwork; snapshots: StageSnapshot[] } {
  trace = [];
  try {
    const net = buildRoads(vectors, terrain, settings);
    return { net, snapshots: trace };
  } finally {
    trace = null;
  }
}

export function buildRoads(vectors: VectorData, terrain: TerrainResult, settings: RoadSettings): RoadNetwork {
  const stages: Record<string, number> = {};
  let t = Date.now();
  const lap = (k: string) => {
    const now = Date.now();
    stages[k] = now - t;
    t = now;
  };
  lastStats = { stages, resolverIterations: 0, droppedEdges: 0, violations: [] };
  if (!settings.enabled || !vectors?.ways?.length) return { nodes: [], edges: [] };
  const detail = Math.max(0, Math.min(1, Number.isFinite(settings.detail) ? settings.detail : 0.7));
  const s = { ...settings, detail };

  let ways = prepareWays(vectors.ways, s);
  flattenShortStructures(ways);
  lap('prepare');
  snapWays('prepare', ways);
  ways = collapseParallel(ways);
  lap('collapse');
  snapWays('collapse', ways);
  ways = clipToPlayable(ways);
  lap('clip');
  snapWays('clip', ways);
  const g = buildGraph(ways);
  lap('graph');
  snapGraph('graph', g);
  bridgeWater(g, terrain);
  g.dissolveAll();
  snapGraph('water', g);
  snapDangles(g);
  snapGraph('snap', g);
  lastStats.roundabouts = roundabouts(g, terrain.scale?.horizontal ?? 1);
  contractShort(g);
  g.dissolveAll();
  lap('topology');
  snapGraph('contract', g);
  computeImportance(g);
  thin(g, detail);
  g.dissolveAll();
  contractShort(g);
  snapGraph('thin', g);
  pruneStubs(g, detail);
  lap('thin');
  snapGraph('prune', g);
  smoothChains(g);
  straightenApproaches(g);
  snapGraph('smooth', g);
  computeImportance(g);
  const cs = resolveChainConflicts(g);
  lastStats.conflicts = cs;
  snapGraph('conflicts', g);
  fixAcute(g);
  snapGraph('acute', g);
  lastStats.structureFixes = fixStructureTransitions(g);
  contractShort(g);
  g.dissolveAll();
  removeFragments(g, 120);
  computeImportance(g);
  lap('shape');
  snapGraph('shape', g);
  // segment, validate and repair geometry until legal (no deletions)
  const ctx = newRepairContext();
  const segCache: SegCache = new WeakMap();
  let w = segmentGraph(g, ctx.avoid, segCache);
  let ground: Float64Array = new Float64Array(0);
  let elev: Float64Array = new Float64Array(0);
  lastStats.repairActions = [];
  lastStats.repairLog = ctx.log;
  const rt: Record<string, number> = {};
  const tick = (k: string, t0: number) => { rt[k] = (rt[k] ?? 0) + Date.now() - t0; return Date.now(); };
  lastStats.roundTimes = rt;
  let openChains = new Set<number>();
  for (let round = 0; ; round++) {
    let t0 = Date.now();
    const el = assignElevations(w, terrain);
    t0 = tick('elev', t0);
    ground = el.ground;
    elev = el.elev;
    if (round >= MAX_REPAIR_ROUNDS) break;
    const em = emit(w, ground, elev, false);
    t0 = tick('emit', t0);
    // after the first round only geometry that changed can carry new problems
    let focus: Set<number> | undefined;
    if (round > 0) {
      focus = new Set<number>();
      em.eMap.forEach((wk, k) => { if (w.edges[wk].fresh || openChains.has(w.edges[wk].chain)) focus!.add(k); });
    }
    const viol = findViolations(em.net, 100000, focus);
    openChains = new Set<number>();
    for (const v of viol) for (const k of v.edges) openChains.add(w.edges[em.eMap[k]].chain);
    t0 = tick('validate', t0);
    if (!viol.length) break;
    const kinds: Record<string, number> = {};
    for (const v of viol) {
      const k = v.kind + ':' + v.msg.replace(/[0-9.-]+/g, '#').replace(/edges? #|node #|nodes # and #/g, '').slice(0, 50);
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    lastStats.roundViolations = [...(lastStats.roundViolations ?? []), kinds];
    lastStats.lastViolations = viol.map((v) => {
      const e = v.edges.map((k) => em.net.edges[k]);
      const where = e.length ? e[0].pts[e[0].pts.length >> 1] : v.nodes.length ? em.net.nodes[v.nodes[0]].p : [0, 0];
      return `${v.msg} @ ${where[0].toFixed(0)},${where[1].toFixed(0)} chains ${v.edges.map((k) => w.edges[em.eMap[k]].chain).join('/')}`;
    });
    const firstNew = g.chains.length;
    const n = repairRound(g, w, em.net, em.eMap, em.nMap, viol, ctx);
    lastStats.repairActions.push(n);
    if (!n) break;
    t0 = tick('repair', t0);
    g.dissolveAll();
    contractShort(g, firstNew);
    fixAcute(g, firstNew);
    contractShort(g, firstNew);
    g.dissolveAll();
    computeImportance(g);
    t0 = tick('cleanup', t0);
    w = segmentGraph(g, ctx.avoid, segCache);
    t0 = tick('segment', t0);
  }
  lap('segment');
  snapWork('segment', w);
  const res = resolve(w, ground, elev);
  lap('resolve');
  snapWork('resolve', w);
  lastStats.resolverIterations = res.iterations;
  lastStats.droppedEdges = res.dropped;
  return res.net;
}

// ---------------------------------------------------------------- output + repair

function emit(w: WNet, ground: Float64Array, elev: Float64Array, copy = true): { net: RoadNetwork; eMap: number[]; nMap: number[] } {
  const order = w.edges
    .map((e, k) => k)
    .filter((k) => w.edges[k].alive)
    .sort((a, b) => CLASS_INDEX[w.edges[a].cls] - CLASS_INDEX[w.edges[b].cls] || w.edges[b].imp - w.edges[a].imp || a - b);
  const nodeId = new Int32Array(w.nodes.length).fill(-1);
  const nodes: RoadNode[] = [];
  const nMap: number[] = [];
  const useNode = (i: number) => {
    if (nodeId[i] < 0) {
      nodeId[i] = nodes.length;
      const n = w.nodes[i];
      nodes.push({
        id: nodes.length,
        p: [n.x, n.z],
        ground: Math.round(ground[i] * 100) / 100,
        elevation: elev[i],
        outside: n.outside,
      });
      nMap.push(i);
    }
    return nodeId[i];
  };
  const edges: RoadEdge[] = [];
  const eMap: number[] = [];
  for (const k of order) {
    const e = w.edges[k];
    const a = useNode(e.a);
    const b = useNode(e.b);
    const edge: RoadEdge = {
      id: edges.length,
      a,
      b,
      cls: e.cls,
      prefab: e.prefab,
      pts: copy ? e.pts.map((p) => [p[0], p[1]] as [number, number]) : e.pts,
      bezier: copy ? (e.bezier.map((p) => [p[0], p[1]]) as RoadEdge['bezier']) : e.bezier,
      oneway: e.oneway,
      bridge: e.bridge,
      tunnel: e.tunnel,
    };
    if (e.name) edge.name = e.name;
    if (e.ref) edge.ref = e.ref;
    edges.push(edge);
    eMap.push(k);
  }
  // outside flag only for real dead-end border nodes
  const deg = new Int32Array(nodes.length);
  for (const e of edges) {
    deg[e.a]++;
    deg[e.b]++;
  }
  nodes.forEach((n, i) => {
    if (n.outside && deg[i] !== 1) n.outside = false;
  });
  return { net: { nodes, edges }, eMap, nMap };
}

function resolve(w: WNet, ground: Float64Array, elev: Float64Array): { net: RoadNetwork; iterations: number; dropped: number } {
  let dropped = 0;
  const byChain = new Map<number, number[]>();
  w.edges.forEach((e, k) => {
    const arr = byChain.get(e.chain);
    if (arr) arr.push(k);
    else byChain.set(e.chain, [k]);
  });
  const kill = (k: number) => {
    if (w.edges[k].alive) {
      w.edges[k].alive = false;
      dropped++;
    }
  };
  // last resort only: a major route loses at most the single offending segment
  const killChain = (k: number) => {
    if (!isMinorClass(w.edges[k].cls)) {
      kill(k);
      return;
    }
    for (const x of byChain.get(w.edges[k].chain) ?? [k]) kill(x);
  };
  let iterations = 0;
  for (let iter = 0; iter < 40; iter++) {
    const { net, eMap, nMap } = emit(w, ground, elev);
    const viol = findViolations(net);
    iterations = iter;
    if (lastStats) {
      const kinds: Record<string, number> = {};
      for (const v of viol) {
        const k = v.kind + ':' + v.msg.replace(/[0-9.-]+/g, '#').slice(0, 60);
        kinds[k] = (kinds[k] ?? 0) + 1;
      }
      lastStats.violations.push(kinds);
    }
    if (!viol.length) return { net, iterations, dropped };
    const hard = iter >= 15;
    const deg = new Int32Array(net.nodes.length);
    const inc: number[][] = net.nodes.map(() => []);
    net.edges.forEach((e, k) => {
      deg[e.a]++;
      deg[e.b]++;
      inc[e.a].push(k);
      inc[e.b].push(k);
    });
    const imp = (k: number) => w.edges[eMap[k]].imp + (isMinorClass(w.edges[eMap[k]].cls) ? 0 : 1000);
    const terminal = (k: number) => {
      const e = net.edges[k];
      return (deg[e.a] === 1 && !net.nodes[e.a].outside) || (deg[e.b] === 1 && !net.nodes[e.b].outside);
    };
    const weaker = (a: number, b: number) => (imp(a) < imp(b) || (imp(a) === imp(b) && a > b) ? a : b);
    for (const v of viol) {
      if (hard) {
        for (const k of v.edges) kill(eMap[k]);
        for (const n of v.nodes) for (const k of inc[n]) kill(eMap[k]);
        continue;
      }
      switch (v.kind) {
        case 'clearance':
        case 'angle': {
          if (v.edges.length < 2) break;
          const vic = weaker(v.edges[0], v.edges[1]);
          if (terminal(vic) || w.edges[eMap[v.edges[0]]].chain === w.edges[eMap[v.edges[1]]].chain) kill(eMap[vic]);
          else killChain(eMap[vic]);
          break;
        }
        case 'nodeGap': {
          const cand = [...inc[v.nodes[0]], ...inc[v.nodes[1]]];
          if (!cand.length) break;
          let vic = cand[0];
          for (const k of cand) vic = weaker(vic, k);
          if (terminal(vic)) kill(eMap[vic]);
          else killChain(eMap[vic]);
          break;
        }
        case 'elevation': {
          if (v.edges.length === 2) killChain(eMap[weaker(v.edges[0], v.edges[1])]);
          else for (const k of v.edges) kill(eMap[k]);
          break;
        }
        default: {
          for (const k of v.edges) kill(eMap[k]);
          if (!v.edges.length) for (const n of v.nodes) for (const k of inc[n]) kill(eMap[k]);
        }
      }
    }
    void nMap;
  }
  const { net } = emit(w, ground, elev);
  return { net, iterations, dropped };
}
