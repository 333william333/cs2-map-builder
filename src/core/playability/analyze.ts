import type {
  BuildSettings, CheckStatus, LandcoverGrid, OutsideConnection, PlayabilityReport, Pt, RoadClass,
  RoadNetwork, TerrainResult, TreeSet, VectorData,
} from '../types';
import { CS2 } from '../types';
import { snapToBorder } from '../manual/border';
import { gxOf, gzOf, resample } from './grid';
import { computeResources } from './resources';

export interface PlayabilityInput {
  terrain: TerrainResult;
  settings: BuildSettings;
  landcover?: LandcoverGrid;
  vectors?: VectorData;
  roads?: RoadNetwork;
  trees?: TreeSet;
  /**
   * Outside nodes in `roads` that a connector built (by hand or automatically). They are flagged
   * `manual` / `synthetic` in the report. Positions are matched within 2 m.
   */
  connectorAdded?: ConnectorAdded[];
}

export interface ConnectorAdded {
  kind: 'road' | 'rail';
  p: Pt;
  manual: boolean;
  synthetic: boolean;
}

export const PLAY = {
  /** slope (percent) up to which land counts as buildable */
  buildableSlope: 12,
  steepSlope: 25,
  analysisSize: 512,
  freshWaterRangeM: 2000,
  treeSoftLimit: 500_000,
  heightScaleMin: 200,
  heightScaleMax: 10000,
  seaLevelMax: 2000,
  /** mean land slope (percent) above which the map counts as very steep */
  verySteepMean: 30,
  mostlyWater: 0.6,
  /** a hand-made ship/air/power/water point within this distance replaces the automatic one */
  replaceRadiusM: 1500,
  /** a start tile with more water than this share is flagged */
  startTileWater: 0.5,
  startTileSteep: 0.4,
  startTileBuildable: 0.25,
};

const MAJOR: RoadClass[] = ['motorway', 'trunk', 'primary'];
const RAIL: RoadClass[] = ['rail', 'tram', 'subway'];
const ROAD_RANK: RoadClass[] = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'pedestrian'];

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function analyzePlayability(input: PlayabilityInput): PlayabilityReport {
  const { terrain, settings, roads, trees } = input;
  const C = resample(terrain, PLAY.analysisSize);
  const { m, ext, cell } = C;
  const N = m * m;
  const T = CS2.TILE_GRID;
  const tileSize = ext / T;
  const half = ext / 2;

  // ---- land statistics and per-tile aggregates
  const tTotal = new Float32Array(T * T);
  const tBuild = new Float32Array(T * T);
  const tWater = new Float32Array(T * T);
  const tSteep = new Float32Array(T * T);
  const tFresh = new Float32Array(T * T);
  let landCells = 0, buildCells = 0, waterCells = 0, slopeSum = 0;
  for (let r = 0; r < m; r++) {
    const tr = Math.min(T - 1, Math.floor(((r + 0.5) * T) / m));
    for (let c = 0; c < m; c++) {
      const tc = Math.min(T - 1, Math.floor(((c + 0.5) * T) / m));
      const i = r * m + c, ti = tr * T + tc;
      tTotal[ti]++;
      const w = C.water[i];
      if (w !== 0) {
        waterCells++;
        tWater[ti]++;
        if (w >= 2) tFresh[ti]++;
      } else {
        landCells++;
        slopeSum += C.slope[i];
        if (C.slope[i] <= PLAY.buildableSlope) { buildCells++; tBuild[ti]++; }
        if (C.slope[i] > PLAY.steepSlope) tSteep[ti]++;
      }
    }
  }
  const buildableFraction = landCells > 0 ? buildCells / landCells : 0;
  const waterFraction = waterCells / N;
  const meanSlope = landCells > 0 ? slopeSum / landCells : 0;

  // ---- roads per tile
  const tileOf = (p: Pt): number => {
    const c = Math.min(T - 1, Math.max(0, Math.floor((p[0] + half) / tileSize)));
    const r = Math.min(T - 1, Math.max(0, Math.floor((half - p[1]) / tileSize)));
    return r * T + c;
  };
  const roadMajor = new Uint8Array(T * T), roadAny = new Uint8Array(T * T);
  let anyRoad = false;
  if (roads) {
    for (const e of roads.edges) {
      if (RAIL.includes(e.cls)) continue;
      const pts = e.pts && e.pts.length > 1 ? e.pts : e.bezier;
      const major = MAJOR.includes(e.cls);
      for (const p of pts) {
        const ti = tileOf(p);
        roadAny[ti] = 1;
        if (major) roadMajor[ti] = 1;
        anyRoad = true;
      }
    }
  }

  // ---- start tile
  const tileB = (ti: number) => (tTotal[ti] > 0 ? tBuild[ti] / tTotal[ti] : 0);
  const freshTiles: number[] = [];
  for (let ti = 0; ti < T * T; ti++) if (tFresh[ti] > 0) freshTiles.push(ti);
  const freshNear = (col: number, row: number): boolean => {
    for (const ft of freshTiles) {
      const fc = ft % T, fr = (ft / T) | 0;
      if (Math.hypot(fc - col, fr - row) * tileSize <= PLAY.freshWaterRangeM) return true;
    }
    return false;
  };
  const evalTile = (col: number, row: number) => {
    const ti = row * T + col;
    let nb = 0;
    let roadScore = roadMajor[ti] ? 1.5 : roadAny[ti] ? 1.0 : 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = row + dr, cc = col + dc;
        if (rr < 0 || cc < 0 || rr >= T || cc >= T) continue;
        const nj = rr * T + cc;
        nb += tileB(nj);
        const rs = roadMajor[nj] ? 0.8 : roadAny[nj] ? 0.5 : 0;
        if (rs > roadScore) roadScore = rs;
      }
    }
    const fresh = tFresh[ti] > 0 || freshNear(col, row);
    const tw = tTotal[ti] > 0 ? tWater[ti] / tTotal[ti] : 0;
    const ts = tTotal[ti] > 0 ? tSteep[ti] / tTotal[ti] : 0;
    return { ti, nb, roadScore, fresh, tw, ts };
  };

  let best = { col: Math.floor(T / 2), row: Math.floor(T / 2) };
  let bestScore = -Infinity;
  let bestRoadNear = false, bestFresh = false;
  const manualTile = settings.manual?.startTile;
  const isManualStart = !!manualTile && Number.isFinite(manualTile.col) && Number.isFinite(manualTile.row);
  if (isManualStart) {
    best = {
      col: Math.min(T - 1, Math.max(0, Math.round(manualTile!.col))),
      row: Math.min(T - 1, Math.max(0, Math.round(manualTile!.row))),
    };
    const e = evalTile(best.col, best.row);
    bestRoadNear = e.roadScore > 0;
    bestFresh = e.fresh;
  } else {
    for (let row = 2; row < T - 2; row++) {
      for (let col = 2; col < T - 2; col++) {
        const { ti, nb, roadScore, fresh, tw, ts } = evalTile(col, row);
        const centreDist = Math.hypot(col - (T - 1) / 2, row - (T - 1) / 2);
        const score = 4 * tileB(ti) + 2 * (nb / 8) + roadScore + (fresh ? 1 : 0) - 2 * tw - 2 * ts - 0.0005 * centreDist;
        if (score > bestScore + 1e-9) {
          bestScore = score;
          best = { col, row };
          bestRoadNear = roadScore > 0;
          bestFresh = fresh;
        }
      }
    }
  }
  const startTile = best;
  const startCentre: Pt = [-half + (best.col + 0.5) * tileSize, half - (best.row + 0.5) * tileSize];

  // ---- outside connections
  const connections: OutsideConnection[] = [];
  const borderPoint = (side: 0 | 1 | 2 | 3, idx: number): Pt => {
    // 0 top (r = 0), 1 right (c = m-1), 2 bottom (r = m-1), 3 left (c = 0); idx = cell along the side
    if (side === 0) return [gxOf(C, idx), half];
    if (side === 2) return [gxOf(C, idx), -half];
    if (side === 1) return [half, gzOf(C, idx)];
    return [-half, gzOf(C, idx)];
  };

  type RoadConn = { p: Pt; rank: number; kind: 'road' | 'rail'; manual: boolean; synthetic: boolean };
  const flagOf = (p: Pt, kind: 'road' | 'rail') => {
    const f = input.connectorAdded?.find((a) => a.kind === kind && Math.hypot(a.p[0] - p[0], a.p[1] - p[1]) < 2);
    return { manual: !!f?.manual, synthetic: !!f?.synthetic };
  };
  const roadConns: RoadConn[] = [];
  if (roads) {
    const attached = new Map<number, RoadClass[]>();
    for (const e of roads.edges) {
      for (const id of [e.a, e.b]) {
        const l = attached.get(id);
        if (l) l.push(e.cls); else attached.set(id, [e.cls]);
      }
    }
    for (const nd of roads.nodes) {
      if (!nd.outside) continue;
      const cls = attached.get(nd.id) ?? [];
      const roadCls = cls.filter((k) => !RAIL.includes(k));
      if (roadCls.length > 0 || cls.length === 0) {
        const rank = roadCls.length ? Math.min(...roadCls.map((k) => ROAD_RANK.indexOf(k))) : ROAD_RANK.length;
        roadConns.push({ p: nd.p, rank, kind: 'road', ...flagOf(nd.p, 'road') });
      }
      if (cls.some((k) => k === 'rail')) roadConns.push({ p: nd.p, rank: 0, kind: 'rail', ...flagOf(nd.p, 'rail') });
    }
  }
  const realRoads = roadConns.filter((c) => c.kind === 'road').sort((a, b) => a.rank - b.rank);
  const rails = roadConns.filter((c) => c.kind === 'rail');
  const asConn = (c: RoadConn): OutsideConnection =>
    c.manual ? { kind: c.kind, p: c.p, synthetic: false, manual: true } : { kind: c.kind, p: c.p, synthetic: c.synthetic };
  for (const c of realRoads) connections.push(asConn(c));
  for (const c of rails) connections.push(asConn(c));

  // perimeter helper (clockwise from the top-left cell)
  const perim: { side: 0 | 1 | 2 | 3; idx: number; cell: number }[] = [];
  for (let c = 0; c < m; c++) perim.push({ side: 0, idx: c, cell: c });
  for (let r = 1; r < m; r++) perim.push({ side: 1, idx: r, cell: r * m + (m - 1) });
  for (let c = m - 2; c >= 0; c--) perim.push({ side: 2, idx: c, cell: (m - 1) * m + c });
  for (let r = m - 2; r >= 1; r--) perim.push({ side: 3, idx: r, cell: r * m });

  // synthetic road when none exists
  let syntheticRoad = false;
  if (realRoads.length === 0) {
    let bestD = Infinity, bestP: Pt | null = null;
    for (const pass of [0, 1]) {
      for (const q of perim) {
        const i = q.cell;
        if (C.water[i] !== 0) continue;
        if (pass === 0 && C.slope[i] > PLAY.buildableSlope) continue;
        const p = borderPoint(q.side, q.idx);
        const d = Math.hypot(p[0] - startCentre[0], p[1] - startCentre[1]);
        if (d < bestD) { bestD = d; bestP = p; }
      }
      if (bestP) break;
    }
    if (bestP) {
      connections.push({ kind: 'road', p: bestP, synthetic: true });
      syntheticRoad = true;
    }
  }

  // ship
  if (terrain.hasSea) {
    const flags = perim.map((q) => C.water[q.cell] === 1);
    if (flags.some((f) => f)) {
      const L = flags.length;
      let s0 = flags.indexOf(false);
      if (s0 < 0) s0 = 0;
      let bestLen = 0, bestStart = -1, run = 0, runStart = -1;
      for (let k = 0; k <= L; k++) {
        const f = k < L ? flags[(s0 + k) % L] : false;
        if (f) { if (run === 0) runStart = k; run++; }
        else { if (run > bestLen) { bestLen = run; bestStart = runStart; } run = 0; }
      }
      if (bestStart >= 0) {
        const q = perim[(s0 + bestStart + (bestLen >> 1)) % L];
        connections.push({ kind: 'ship', p: borderPoint(q.side, q.idx), synthetic: false });
      }
    }
  }

  // air: border midpoint on flat land
  {
    const mid = (m / 2) | 0;
    const sides: { p: Pt; cell: number }[] = [
      { p: [0, half], cell: mid },
      { p: [half, 0], cell: mid * m + (m - 1) },
      { p: [0, -half], cell: (m - 1) * m + mid },
      { p: [-half, 0], cell: mid * m },
    ];
    const pick = sides.find((s) => C.water[s.cell] === 0 && C.slope[s.cell] <= PLAY.buildableSlope)
      ?? sides.find((s) => C.water[s.cell] === 0) ?? sides[0];
    connections.push({ kind: 'air', p: pick.p, synthetic: false });
  }

  // power and water next to the most important road connection
  const mainRoad = connections.find((c) => c.kind === 'road');
  if (mainRoad) {
    const onVertical = Math.abs(Math.abs(mainRoad.p[0]) - half) < 1;
    const lim = half - 30;
    const shift = (d: number): Pt => onVertical
      ? [mainRoad.p[0], Math.max(-lim, Math.min(lim, mainRoad.p[1] + d))]
      : [Math.max(-lim, Math.min(lim, mainRoad.p[0] + d)), mainRoad.p[1]];
    connections.push({ kind: 'power', p: shift(30), synthetic: mainRoad.synthetic });
    connections.push({ kind: 'water', p: shift(-30), synthetic: mainRoad.synthetic });
  }

  // hand-made ship / air / power / water points replace a nearby automatic one of the same kind
  for (const a of settings.manual?.added ?? []) {
    if (a.kind === 'road' || a.kind === 'rail') continue;
    const p = snapToBorder(a.p, 48);
    for (let i = connections.length - 1; i >= 0; i--) {
      const c = connections[i];
      if (c.kind === a.kind && !c.manual && Math.hypot(c.p[0] - p[0], c.p[1] - p[1]) <= PLAY.replaceRadiusM) connections.splice(i, 1);
    }
    connections.push({ kind: a.kind, p, synthetic: false, manual: true });
  }

  // ---- checks
  const checks: PlayabilityReport['checks'] = [];
  const add = (id: string, status: CheckStatus, message: string) => checks.push({ id, status, message });

  add('buildable',
    buildableFraction > 0.35 ? 'ok' : buildableFraction >= 0.15 ? 'warn' : 'fail',
    buildableFraction > 0.35
      ? `${pct(buildableFraction)} of the land is buildable.`
      : buildableFraction >= 0.15
        ? `Only ${pct(buildableFraction)} of the land is buildable. The map will feel cramped.`
        : `Only ${pct(buildableFraction)} of the land is buildable. Pick a flatter area or reduce the height exaggeration.`);

  if (realRoads.length > 0) {
    const byHand = realRoads.filter((c) => c.manual).length;
    const auto = realRoads.filter((c) => c.synthetic && !c.manual).length;
    if (auto > 0 && auto === realRoads.length) {
      add('roadConnection', 'warn', 'No road crosses the map edge. A road was built automatically from the edge to the nearest road.');
    } else {
      add('roadConnection', 'ok',
        `${realRoads.length} road ${realRoads.length === 1 ? 'connection' : 'connections'} to the outside world${byHand > 0 ? `, ${byHand} added by hand` : ''}.`);
    }
  } else if (syntheticRoad) add('roadConnection', 'warn', 'No road crosses the map edge. A synthetic connection is added near the start tile.');
  else add('roadConnection', 'fail', 'No road connection to the outside world and no flat ground at the edge to place one on.');

  {
    const ev = evalTile(best.col, best.row);
    const tb = tileB(ev.ti);
    const where = `The start tile (column ${best.col + 1}, row ${best.row + 1})`;
    if (ev.tw >= PLAY.startTileWater) {
      add('startTile', 'warn', `${where} is mostly water (${pct(ev.tw)}). Pick a tile with more land.`);
    } else if (ev.ts >= PLAY.startTileSteep) {
      add('startTile', 'warn', `${where} is very steep (${pct(ev.ts)} of the land). It will be hard to build there.`);
    } else if (tb < PLAY.startTileBuildable) {
      add('startTile', 'warn', `${where} has little buildable land (${pct(tb)}).`);
    } else {
      add('startTile', 'ok', `${where} has ${pct(tb)} buildable land${isManualStart ? ' (chosen by hand)' : ''}.`);
    }
  }
  add('startRoad', bestRoadNear ? 'ok' : 'warn',
    bestRoadNear ? 'The start tile has a road on or next to it.' : 'There is no road near the start tile.');
  add('freshWater', bestFresh ? 'ok' : 'warn',
    bestFresh ? 'Fresh water is within 2 km of the start tile.' : 'No fresh water (lake or river) within 2 km of the start tile.');

  const hs = terrain.heightScale;
  add('heightRange', terrain.maxHeight <= hs && terrain.minHeight >= 0 ? 'ok' : 'fail',
    terrain.maxHeight <= hs && terrain.minHeight >= 0
      ? `The elevations (${Math.round(terrain.minHeight)} to ${Math.round(terrain.maxHeight)} m) fit within the height scale of ${Math.round(hs)} m.`
      : `The elevations (${Math.round(terrain.minHeight)} to ${Math.round(terrain.maxHeight)} m) do not fit within the height scale of ${Math.round(hs)} m.`);
  add('heightScale', hs >= PLAY.heightScaleMin && hs <= PLAY.heightScaleMax ? 'ok' : 'fail',
    hs >= PLAY.heightScaleMin && hs <= PLAY.heightScaleMax
      ? `The height scale of ${Math.round(hs)} m is within the game's limits (200 to 10,000 m).`
      : `The height scale of ${Math.round(hs)} m is outside the game's limits (200 to 10,000 m).`);
  add('seaLevel', terrain.seaLevel >= 0 && terrain.seaLevel <= PLAY.seaLevelMax ? 'ok' : 'fail',
    terrain.seaLevel >= 0 && terrain.seaLevel <= PLAY.seaLevelMax
      ? `The sea level of ${Math.round(terrain.seaLevel)} m is valid.`
      : `The sea level of ${Math.round(terrain.seaLevel)} m is outside the game's limit (0 to 2,000 m).`);

  const treeCount = trees?.count ?? 0;
  add('treeCount', treeCount > PLAY.treeSoftLimit ? 'warn' : 'ok',
    treeCount > PLAY.treeSoftLimit
      ? `${treeCount.toLocaleString('en-US')} trees exceed the soft limit of 500,000 and may cause a low frame rate.`
      : `${treeCount.toLocaleString('en-US')} trees, under the soft limit of 500,000.`);

  add('steepMap', meanSlope > PLAY.verySteepMean ? 'warn' : 'ok',
    meanSlope > PLAY.verySteepMean
      ? `The map is very steep (mean slope ${Math.round(meanSlope)}%).`
      : `The mean slope of ${Math.round(meanSlope)}% is reasonable.`);
  add('waterDominant', waterFraction > PLAY.mostlyWater ? 'warn' : 'ok',
    waterFraction > PLAY.mostlyWater
      ? `The map is mostly water (${pct(waterFraction)}).`
      : `Water covers ${pct(waterFraction)} of the map.`);

  if (settings.quality === 'draft') {
    add('draft', 'warn', 'This is a low-resolution draft. Build at full quality before exporting to the game.');
  }

  const report: PlayabilityReport = {
    buildableFraction, waterFraction, checks, startTile, outsideConnections: connections,
  };
  if (settings.resources.enabled) {
    report.resources = computeResources({ terrain, landcover: input.landcover, vectors: input.vectors, trees });
  }
  return report;
}
