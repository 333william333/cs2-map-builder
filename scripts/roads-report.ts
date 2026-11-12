/**
 * Road builder report on real data.
 *
 *   npx tsx scripts/roads-report.ts <file.json> [--scale 0.5] [--detail 0.7] [--all-classes] [--out net.json]
 *
 * The JSON file holds either `{ "vectors": VectorData, "scale": number, "settings"?: Partial<RoadSettings> }`
 * or a bare VectorData object (with an optional top-level "scale"). The terrain is flat (no water
 * mask), so water bridges are not exercised here.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readTerrain } from './terrainFile';
import { buildRoads, buildRoadsTraced, lastBuildRoadsStats, validateNetwork } from '../src/core/roads/buildRoads';
import { checkContinuity } from '../src/core/roads/continuity';
import { CLASS_ORDER } from '../src/core/roads/params';
import {
  ALL_ROAD_CLASSES, DEFAULT_SETTINGS, type RoadClass, type RoadSettings, type TerrainResult, type VectorData,
} from '../src/core/types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('usage: npx tsx scripts/roads-report.ts <file.json> [--scale s] [--detail d] [--all-classes] [--out net.json]');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(file, 'utf8'));
const vectors: VectorData = raw.vectors ?? raw;
vectors.waterPolygons ??= [];
vectors.waterways ??= [];
vectors.areas ??= [];
vectors.treePoints ??= [];
vectors.powerLines ??= [];
const scale = Number(arg('--scale') ?? raw.scale ?? 1);
const settings: RoadSettings = {
  ...DEFAULT_SETTINGS.roads,
  ...(raw.settings ?? {}),
  classes: { ...DEFAULT_SETTINGS.roads.classes, ...(raw.settings?.classes ?? {}) },
};
if (arg('--detail') !== undefined) settings.detail = Number(arg('--detail'));
if (process.argv.includes('--all-classes')) {
  for (const c of ALL_ROAD_CLASSES) settings.classes[c] = true;
}

// real terrain when cached by scripts/area-terrain.ts (exports/<name>-terrain.bin), else flat
const terrainFile = file.replace(/-vectors\.json$/, '-terrain.bin');
const size = 64;
const flat: TerrainResult = {
  playable: { size, extentM: 14336, data: new Float32Array(size * size).fill(100) },
  world: { size: 4, extentM: 57344, data: new Float32Array(16).fill(100) },
  scale: { horizontal: scale, vertical: 1 },
  seaLevel: 64,
  heightScale: 4096,
  waterMask: new Uint8Array(size * size),
  baseElevation: 0,
  hasSea: false,
  minHeight: 100,
  maxHeight: 100,
};
const terrain: TerrainResult = terrainFile !== file && existsSync(terrainFile) ? readTerrain(terrainFile) : flat;
console.log(`terrain: ${terrain === flat ? 'flat (no water mask)' : terrainFile}`);

const H = 7168;
const lenOf = (pts: [number, number][]) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
};
const inCount = new Map<RoadClass, { n: number; km: number }>();
let points = 0;
for (const w of vectors.ways) {
  const e = inCount.get(w.cls) ?? { n: 0, km: 0 };
  e.n++;
  e.km += lenOf(w.pts) / 1000;
  inCount.set(w.cls, e);
  points += w.pts.length;
}

const t0 = Date.now();
const net = buildRoads(vectors, terrain, settings);
const ms = Date.now() - t0;
const t1 = Date.now();
const violations = validateNetwork(net);
const msVal = Date.now() - t1;

const outCount = new Map<RoadClass, { n: number; km: number }>();
for (const e of net.edges) {
  const x = outCount.get(e.cls) ?? { n: 0, km: 0 };
  x.n++;
  x.km += lenOf(e.pts) / 1000;
  outCount.set(e.cls, x);
}
const deg = new Int32Array(net.nodes.length);
for (const e of net.edges) {
  deg[e.a]++;
  deg[e.b]++;
}
let dead = 0;
let junctions = 0;
net.nodes.forEach((n, i) => {
  if (deg[i] === 1 && !n.outside) dead++;
  if (deg[i] >= 3) junctions++;
});
const parent = new Int32Array(net.nodes.length).map((_, i) => i);
const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
for (const e of net.edges) parent[find(e.a)] = find(e.b);
const comps = new Set(net.nodes.map((_, i) => find(i))).size;
const outside = net.nodes.filter((n) => n.outside);
const outRail = outside.filter((n) => net.edges.some((e) => (e.a === n.id || e.b === n.id) && e.cls === 'rail')).length;

console.log(`input: ${vectors.ways.length} ways, ${points} points, scale ${scale}, detail ${settings.detail}`);
console.log('\nclass          in ways    in km   out edges   out km');
for (const c of CLASS_ORDER) {
  const a = inCount.get(c);
  const b = outCount.get(c);
  if (!a && !b) continue;
  console.log(
    `${c.padEnd(12)} ${String(a?.n ?? 0).padStart(9)} ${(a?.km ?? 0).toFixed(1).padStart(8)} ${String(b?.n ?? 0).padStart(11)} ${(b?.km ?? 0).toFixed(1).padStart(8)}${settings.classes[c] ? '' : '  (disabled)'}`,
  );
}
console.log(`\nnodes ${net.nodes.length}, edges ${net.edges.length}, junctions ${junctions}, dead ends ${dead}, components ${comps}`);
console.log(`outside connections: ${outside.length} (road ${outside.length - outRail}, rail ${outRail})`);
for (const n of outside) console.log(`  ${n.p[0].toFixed(0)}, ${n.p[1].toFixed(0)}${Math.abs(n.p[0]) === H || Math.abs(n.p[1]) === H ? '' : '  NOT ON BORDER'}`);
console.log(`bridges ${net.edges.filter((e) => e.bridge).length}, tunnels ${net.edges.filter((e) => e.tunnel).length}, one-way ${net.edges.filter((e) => e.oneway).length}`);
const prefabs = new Map<string, number>();
for (const e of net.edges) prefabs.set(e.prefab, (prefabs.get(e.prefab) ?? 0) + 1);
console.log('prefabs: ' + [...prefabs.entries()].map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`\nbuild ${ms} ms, validate ${msVal} ms; stages ${JSON.stringify(lastBuildRoadsStats()?.stages)}`);
console.log(`repair: ${lastBuildRoadsStats()?.droppedEdges} edges dropped in ${lastBuildRoadsStats()?.resolverIterations} resolver iterations ${JSON.stringify(lastBuildRoadsStats()?.droppedByClass)}`);
console.log(`\nviolations: ${violations.length}`);
for (const v of violations.slice(0, 50)) console.log('  ' + v);
if (violations.length > 50) console.log(`  ... ${violations.length - 50} more`);

// continuity (traced second run for stage attribution)
const traced = buildRoadsTraced(vectors, terrain, settings);
const ringDiscs = (lastBuildRoadsStats()?.roundabouts?.rings ?? []).map((g) => ({ cx: g.cx, cz: g.cz, r: Math.max(g.builtR, g.realR * terrain.scale.horizontal) }));
const cont = checkContinuity(vectors, traced.net, settings, traced.snapshots, ringDiscs);
console.log('\ncontinuity    in km  expect km   out km  missing km  breaks  named in/out km');
for (const [c, v] of Object.entries(cont.classes)) {
  if (!v) continue;
  console.log(`${c.padEnd(12)} ${v.inKm.toFixed(1).padStart(6)} ${v.expectedKm.toFixed(1).padStart(10)} ${v.outKm.toFixed(1).padStart(8)} ${v.missingKm.toFixed(2).padStart(11)} ${String(v.breaks).padStart(7)}   ${v.namedInKm.toFixed(1)}/${v.namedOutKm.toFixed(1)}`);
}
for (const k of ['bridge', 'tunnel'] as const) {
  const x = cont.structures[k];
  console.log(`${k}s: expected ${x.expectedKm.toFixed(2)} km, kept as ${k} ${x.keptKm.toFixed(2)} km (${((100 * x.keptKm) / Math.max(1e-9, x.expectedKm)).toFixed(0)}%), output ${x.outKm.toFixed(2)} km`);
}
console.log('structure loss by stage (km): ' + Object.entries(cont.structureLoss).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', '));
console.log(`components in ${cont.inComponents} out ${cont.outComponents}; dead ends in ${cont.inDeadEnds} out ${cont.outDeadEnds}; named share in ${(cont.namedInShare * 100).toFixed(1)}% out ${(cont.namedOutShare * 100).toFixed(1)}%`);
const byStage = new Map<string, number>();
for (const b of cont.breaks) {
  const k = `${b.cls}/${b.kind}/${b.stage ?? '?'}`;
  byStage.set(k, (byStage.get(k) ?? 0) + 1);
}
console.log('breaks by class/kind/stage: ' + [...byStage.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
const st = lastBuildRoadsStats();
const rb = st?.roundabouts;
if (rb) {
  const big = rb.rings.filter((r) => r.realR >= 12);
  const bigKept = big.filter((r) => r.outcome !== 'collapsed').length;
  console.log(`roundabouts: ${st?.detectedRings ?? '?'} detected, ${rb.found} closed in the graph: kept ${rb.kept}, enlarged ${rb.enlarged}, collapsed ${rb.collapsed} ${JSON.stringify(rb.reasons)}; radius >= 12 real m: ${bigKept}/${big.length} kept`);
}
const insideKm = (pts: [number, number][]) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1])) <= H) s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s / 1000;
};
const kept = (w: { cls: RoadClass }) => settings.classes[w.cls];
const sIn = { bridge: [0, 0], tunnel: [0, 0] };
for (const w of vectors.ways) {
  if (!kept(w)) continue;
  const k = insideKm(w.pts);
  if (k <= 0) continue;
  if (w.bridge) { sIn.bridge[0]++; sIn.bridge[1] += k; }
  if (w.tunnel) { sIn.tunnel[0]++; sIn.tunnel[1] += k; }
}
const sOut = { bridge: 0, tunnel: 0 };
for (const e of traced.net.edges) {
  if (e.bridge) sOut.bridge += lenOf(e.pts) / 1000;
  if (e.tunnel) sOut.tunnel += lenOf(e.pts) / 1000;
}
console.log(`bridges in ${sIn.bridge[0]} ways ${sIn.bridge[1].toFixed(2)} km, out ${sOut.bridge.toFixed(2)} km; tunnels in ${sIn.tunnel[0]} ways ${sIn.tunnel[1].toFixed(2)} km, out ${sOut.tunnel.toFixed(2)} km; structure transitions fixed ${st?.structureFixes ?? 0}`);
const log = st?.repairLog ?? [];
const kinds = new Map<string, number>();
for (const l of log) { const k = l.split(' @')[0]; kinds.set(k, (kinds.get(k) ?? 0) + 1); }
console.log('repair actions: ' + [...kinds.entries()].map(([k, v]) => `${k} ${v}`).join(', '));
const major = new Set(['motorway', 'trunk', 'primary', 'secondary', 'rail']);
for (const b of cont.breaks.filter((x) => major.has(x.cls)).slice(0, Number(arg('--show') ?? 25))) {
  console.log(`  ${b.cls} ${b.kind} at ${b.p[0].toFixed(0)},${b.p[1].toFixed(0)} len ${b.len.toFixed(0)} stage ${b.stage ?? '?'}${b.name ? ' ' + b.name : ''}`);
}

const out = arg('--out');
if (out) {
  writeFileSync(out, JSON.stringify(net));
  console.log(`\nwrote ${out}`);
}
