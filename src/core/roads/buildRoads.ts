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
import type { RoadEdge, RoadNetwork, RoadNode, RoadSettings, TerrainResult, VectorData } from '../types';
import { CLASS_INDEX } from './params';
import { collapseParallel, flattenShortStructures, prepareWays } from './prepare';
import { clipToPlayable } from './clip';
import { buildGraph } from './graph';
import {
  bridgeWater, computeImportance, contractShort, fixAcute, pruneStubs, removeFragments, roundabouts,
  smoothChains, snapDangles, straightenApproaches, thin,
} from './generalize';
import { segmentGraph, type WNet } from './segment';
import { assignElevations } from './elevation';
import { findViolations } from './validate';

export { validateNetwork, findViolations } from './validate';

export interface BuildRoadsStats {
  stages: Record<string, number>;
  resolverIterations: number;
  droppedEdges: number;
}

let lastStats: BuildRoadsStats | null = null;
/** timing / repair statistics of the most recent buildRoads call (for reports) */
export function lastBuildRoadsStats(): BuildRoadsStats | null {
  return lastStats;
}

export function buildRoads(vectors: VectorData, terrain: TerrainResult, settings: RoadSettings): RoadNetwork {
  const stages: Record<string, number> = {};
  let t = Date.now();
  const lap = (k: string) => {
    const now = Date.now();
    stages[k] = now - t;
    t = now;
  };
  lastStats = { stages, resolverIterations: 0, droppedEdges: 0 };
  if (!settings.enabled || !vectors?.ways?.length) return { nodes: [], edges: [] };
  const detail = Math.max(0, Math.min(1, Number.isFinite(settings.detail) ? settings.detail : 0.7));
  const s = { ...settings, detail };

  let ways = prepareWays(vectors.ways, s);
  flattenShortStructures(ways);
  lap('prepare');
  ways = collapseParallel(ways);
  lap('collapse');
  ways = clipToPlayable(ways);
  lap('clip');
  const g = buildGraph(ways);
  lap('graph');
  bridgeWater(g, terrain);
  g.dissolveAll();
  snapDangles(g);
  roundabouts(g);
  contractShort(g);
  g.dissolveAll();
  lap('topology');
  computeImportance(g);
  thin(g, detail);
  g.dissolveAll();
  contractShort(g);
  pruneStubs(g, detail);
  lap('thin');
  smoothChains(g);
  straightenApproaches(g);
  fixAcute(g);
  contractShort(g);
  g.dissolveAll();
  removeFragments(g, 120);
  computeImportance(g);
  lap('shape');
  const w = segmentGraph(g);
  lap('segment');
  const { ground, elev } = assignElevations(w, terrain);
  lap('elevation');
  const res = resolve(w, ground, elev);
  lap('resolve');
  lastStats.resolverIterations = res.iterations;
  lastStats.droppedEdges = res.dropped;
  return res.net;
}

// ---------------------------------------------------------------- output + repair

function emit(w: WNet, ground: Float64Array, elev: Float64Array): { net: RoadNetwork; eMap: number[]; nMap: number[] } {
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
      pts: e.pts.map((p) => [p[0], p[1]] as [number, number]),
      bezier: e.bezier.map((p) => [p[0], p[1]]) as RoadEdge['bezier'],
      oneway: e.oneway,
      bridge: e.bridge,
      tunnel: e.tunnel,
    };
    if (e.name) edge.name = e.name;
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
  const killChain = (k: number) => {
    for (const x of byChain.get(w.edges[k].chain) ?? [k]) kill(x);
  };
  let iterations = 0;
  for (let iter = 0; iter < 40; iter++) {
    const { net, eMap, nMap } = emit(w, ground, elev);
    const viol = findViolations(net);
    iterations = iter;
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
    const imp = (k: number) => w.edges[eMap[k]].imp;
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
