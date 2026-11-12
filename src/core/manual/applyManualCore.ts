import { analyzePlayability, type ConnectorAdded } from '../playability/analyze';
import type { BuildResult, OutsideConnection, Pt, RoadNetwork, TerrainResult } from '../types';
import { CS2 } from '../types';
import { HALF, ROAD_CORNER_MARGIN, borderPointAt, snapToBorder } from './border';

/** Same shape as `ConnectorResult` in roads/connector.ts (kept structural so tests can inject a fake). */
export interface ConnectorOutcome { net: RoadNetwork; ok: boolean; reason?: string }
export type Connector = (net: RoadNetwork, terrain: TerrainResult, kind: 'road' | 'rail', p: Pt) => ConnectorOutcome;

/** Prefix of every warning produced here, so a repeated call can replace the earlier ones. */
export const MANUAL_WARNING_PREFIX = 'Manual edit: ';

const KIND_NAME: Record<OutsideConnection['kind'], string> = {
  road: 'road connection', rail: 'rail connection', ship: 'ship connection',
  air: 'air connection', power: 'power connection', water: 'water connection',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const where = (p: Pt) => `(${Math.round(p[0])}, ${Math.round(p[1])})`;
const EMPTY: RoadNetwork = { nodes: [], edges: [] };
/** How far from the requested point a connector-built node may end up and still count as that connection. */
const MATCH_M = 300;
const AUTO_ATTEMPTS = 8;
const CANDIDATE_STEP_M = 128;
const nodeKey = (p: Pt) => `${Math.round(p[0])},${Math.round(p[1])}`;

function outsideKeys(net: RoadNetwork): Set<string> {
  const s = new Set<string>();
  for (const n of net.nodes) if (n.outside) s.add(nodeKey(n.p));
  return s;
}

/** True when a road (not only rail) leaves the map. Same rule as the playability report. */
function hasRoadOutside(net: RoadNetwork | undefined): boolean {
  if (!net) return false;
  const withRoad = new Set<number>();
  const withAny = new Set<number>();
  for (const e of net.edges) {
    withAny.add(e.a);
    withAny.add(e.b);
    if (e.cls !== 'rail' && e.cls !== 'tram' && e.cls !== 'subway') {
      withRoad.add(e.a);
      withRoad.add(e.b);
    }
  }
  return net.nodes.some((n) => n.outside && (!withAny.has(n.id) || withRoad.has(n.id)));
}

function waterAt(t: TerrainResult, p: Pt): number {
  const n = t.playable.size;
  if (!t.waterMask || t.waterMask.length !== n * n) return 0;
  const c = Math.min(n - 1, Math.max(0, Math.floor(((p[0] + HALF) / (2 * HALF)) * n)));
  const r = Math.min(n - 1, Math.max(0, Math.floor(((HALF - p[1]) / (2 * HALF)) * n)));
  return t.waterMask[r * n + c];
}

/** Land border points, best first: nearest to the start tile (steep ground penalised), one per side first. */
function autoCandidates(t: TerrainResult, start: Pt): Pt[] {
  const n = t.playable.size;
  const h = t.playable.data;
  const cell = t.playable.extentM / n;
  const slopeAt = (p: Pt): number => {
    const c = Math.min(n - 2, Math.max(1, Math.floor(((p[0] + HALF) / (2 * HALF)) * n)));
    const r = Math.min(n - 2, Math.max(1, Math.floor(((HALF - p[1]) / (2 * HALF)) * n)));
    const dx = (h[r * n + c + 1] - h[r * n + c - 1]) / (2 * cell);
    const dz = (h[(r + 1) * n + c] - h[(r - 1) * n + c]) / (2 * cell);
    return 100 * Math.hypot(dx, dz);
  };
  const steps = Math.round((8 * HALF) / CANDIDATE_STEP_M);
  const perSide = steps / 4;
  const all: { p: Pt; cost: number; side: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const p0 = borderPointAt(((i + 0.5) * (8 * HALF)) / steps);
    const p = snapToBorder(p0, ROAD_CORNER_MARGIN);
    if (Math.abs(p[0] - p0[0]) > 1 || Math.abs(p[1] - p0[1]) > 1) continue; // inside the corner margin
    // probe slightly inside so the water mask at the very edge does not mislead
    const inside: Pt = [p[0] * 0.995, p[1] * 0.995];
    if (waterAt(t, inside) !== 0) continue;
    const d = Math.hypot(p[0] - start[0], p[1] - start[1]);
    all.push({ p, cost: d + 60 * Math.max(0, slopeAt(inside) - 12), side: Math.floor(i / perSide) });
  }
  all.sort((a, b) => a.cost - b.cost);
  const bestPerSide = new Map<number, { p: Pt; cost: number }>();
  for (const a of all) if (!bestPerSide.has(a.side)) bestPerSide.set(a.side, a);
  const out: Pt[] = [...bestPerSide.values()].sort((a, b) => a.cost - b.cost).map((a) => a.p);
  for (const a of all) {
    if (out.length >= AUTO_ATTEMPTS) break;
    if (out.every((q) => Math.hypot(q[0] - a.p[0], q[1] - a.p[1]) > 1500)) out.push(a.p);
  }
  return out.slice(0, AUTO_ATTEMPTS);
}

/**
 * Applies `result.settings.manual` and guarantees a road connection. See CONTRACT.md "M5 additions".
 * The connector is injected so tests do not depend on the road module.
 */
export function applyManualWith(result: BuildResult, connector: Connector): BuildResult {
  const manual = result.settings.manual ?? { added: [] };
  const base = result.baseRoads ?? result.roads;
  let net: RoadNetwork | undefined = base;
  const mine: string[] = [];
  const added: ConnectorAdded[] = [];
  const tileCentre = (t: { col: number; row: number }): Pt => {
    const s = (2 * HALF) / CS2.TILE_GRID;
    return [-HALF + (t.col + 0.5) * s, HALF - (t.row + 0.5) * s];
  };

  const run = (kind: 'road' | 'rail', p: Pt): ConnectorOutcome => {
    try {
      return connector(net ?? EMPTY, result.terrain, kind, p);
    } catch (e) {
      return { net: net ?? EMPTY, ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  };

  /** Records which outside nodes a successful connector call created. */
  const record = (before: Set<string>, after: RoadNetwork, kind: 'road' | 'rail', p: Pt, byHand: boolean) => {
    let found = 0;
    for (const n of after.nodes) {
      if (!n.outside || before.has(nodeKey(n.p))) continue;
      added.push({ kind, p: n.p, manual: byHand, synthetic: !byHand });
      found++;
    }
    if (found > 0) return;
    // it joined an existing border node: flag the nearest one
    let best: Pt | undefined;
    let bd = MATCH_M;
    for (const n of after.nodes) {
      const d = Math.hypot(n.p[0] - p[0], n.p[1] - p[1]);
      if (n.outside && d <= bd) { bd = d; best = n.p; }
    }
    if (best) added.push({ kind, p: best, manual: byHand, synthetic: !byHand });
  };

  for (const a of manual.added) {
    if (a.kind !== 'road' && a.kind !== 'rail') continue;
    const p = snapToBorder(a.p, ROAD_CORNER_MARGIN);
    const before = outsideKeys(net ?? EMPTY);
    const r = run(a.kind, p);
    if (r.ok) {
      net = r.net;
      record(before, r.net, a.kind, p, true);
    } else {
      mine.push(`${cap(KIND_NAME[a.kind])} at ${where(p)} could not be built: ${r.reason ?? 'unknown reason'}`);
    }
  }

  // a playable map needs a road to the outside world, whatever the road settings say
  if (!hasRoadOutside(net)) {
    let start: Pt;
    if (manual.startTile) {
      start = tileCentre(manual.startTile);
    } else {
      const quick = analyzePlayability({
        terrain: result.terrain,
        settings: { ...result.settings, resources: { enabled: false } },
        roads: net,
      });
      start = tileCentre(quick.startTile);
    }
    let reason = '';
    let done = false;
    for (const p of autoCandidates(result.terrain, start)) {
      const before = outsideKeys(net ?? EMPTY);
      const r = run('road', p);
      if (r.ok) {
        net = r.net;
        record(before, r.net, 'road', p, false);
        done = true;
        break;
      }
      reason = r.reason ?? reason;
    }
    if (!done) {
      mine.push(`No road connection to the map edge could be built automatically${reason ? `: ${reason}` : '.'} Add one by hand.`);
    }
  }

  for (const a of manual.added) {
    if (a.kind === 'ship' && waterAt(result.terrain, snapToBorder(a.p, 0)) === 0) {
      mine.push(`The ship connection at ${where(snapToBorder(a.p))} is on land and only works at water.`);
    }
  }

  const playability = analyzePlayability({
    terrain: result.terrain,
    settings: result.settings,
    landcover: result.landcover,
    vectors: result.vectors,
    roads: net,
    trees: result.trees,
    connectorAdded: added,
  });

  const kept = (result.warnings ?? []).filter((w) => !w.startsWith(MANUAL_WARNING_PREFIX));
  const all = [...kept, ...mine.map((m) => MANUAL_WARNING_PREFIX + m)];
  const out: BuildResult = { ...result, playability };
  if (base !== undefined) out.baseRoads = base;
  else delete out.baseRoads;
  if (net !== undefined) out.roads = net;
  if (all.length > 0 || result.warnings) out.warnings = all;
  return out;
}
