import type { Frame } from '../geo/frame';
import {
  CS2,
  type AreaKind,
  type AreaPolygon,
  type BuildSettings,
  type FetchBytes,
  type Progress,
  type Pt,
  type RawWay,
  type RoadClass,
  type VectorData,
  type WaterPolygon,
  type Waterway,
} from '../types';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const OVERPASS_MIRROR = 'https://overpass.kumi.systems/api/interpreter';

/** bbox margin around the playable area */
const MARGIN = 0.05;

// ------------------------------------------------------------------ query building

/** highway tag values fetched per road class */
const HIGHWAY_VALUES: Partial<Record<RoadClass, string[]>> = {
  motorway: ['motorway', 'motorway_link'],
  trunk: ['trunk', 'trunk_link'],
  primary: ['primary', 'primary_link'],
  secondary: ['secondary', 'secondary_link'],
  tertiary: ['tertiary', 'tertiary_link'],
  residential: ['residential', 'living_street', 'unclassified'],
  service: ['service'],
  pedestrian: ['pedestrian', 'footway', 'path', 'cycleway'],
};

const RAILWAY_VALUES: Partial<Record<RoadClass, string[]>> = {
  rail: ['rail'],
  tram: ['tram', 'light_rail'],
  subway: ['subway'],
};

/** Road classes that are actually requested, given settings and map scale. */
export function activeRoadClasses(frame: Frame, settings: BuildSettings): Set<RoadClass> {
  const out = new Set<RoadClass>();
  if (!settings.roads.enabled) return out;
  for (const [cls, on] of Object.entries(settings.roads.classes) as [RoadClass, boolean][]) {
    if (!on) continue;
    if (frame.scale < 0.4 && (cls === 'residential' || cls === 'service' || cls === 'pedestrian')) continue;
    if (frame.scale < 0.2 && cls === 'tertiary') continue;
    out.add(cls);
  }
  return out;
}

export function buildOverpassQuery(frame: Frame, settings: BuildSettings): string {
  const [s, w, n, e] = frame.bbox(CS2.PLAYABLE_SIZE_M * (1 + MARGIN));
  const bb = `(${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)})`;
  const stmts: string[] = [];
  const re = (vals: string[]) => `~"^(${vals.join('|')})$"`;

  const classes = activeRoadClasses(frame, settings);
  const hw: string[] = [];
  const rw: string[] = [];
  for (const cls of classes) {
    const h = HIGHWAY_VALUES[cls];
    if (h) hw.push(...h);
    const r = RAILWAY_VALUES[cls];
    if (r) rw.push(...r);
  }
  if (hw.length) stmts.push(`way["highway"${re(hw)}]${bb};`);
  if (rw.length) stmts.push(`way["railway"${re(rw)}]${bb};`);

  const waterways = frame.scale >= 0.4 ? ['river', 'stream', 'canal'] : ['river', 'canal'];
  stmts.push(`way["waterway"${re(waterways)}]${bb};`);
  stmts.push(`way["natural"="water"]${bb};`);
  stmts.push(`way["waterway"="riverbank"]${bb};`);
  stmts.push(`relation["natural"="water"]["type"="multipolygon"]${bb};`);
  stmts.push(`relation["waterway"="riverbank"]${bb};`);

  const areaTags: [string, string[]][] = [
    ['landuse', ['forest', 'farmland', 'meadow', 'residential', 'industrial', 'commercial', 'quarry', 'harbour']],
    ['natural', ['wood', 'beach', 'bare_rock', 'wetland']],
    ['leisure', ['park']],
    ['aeroway', ['aerodrome']],
    ['industrial', ['port']],
  ];
  for (const [k, v] of areaTags) {
    const sel = v.length === 1 ? `["${k}"="${v[0]}"]` : `["${k}"${re(v)}]`;
    stmts.push(`way${sel}${bb};`);
    stmts.push(`relation${sel}["type"="multipolygon"]${bb};`);
  }

  if (frame.scale >= 0.8) stmts.push(`node["natural"="tree"]${bb};`);
  stmts.push(`way["power"="line"]${bb};`);

  return `[out:json][timeout:120][maxsize:1073741824];\n(\n  ${stmts.join('\n  ')}\n);\nout geom;`;
}

// ------------------------------------------------------------------ Overpass JSON types

interface LL { lat: number; lon: number }
interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: (LL | null)[];
  members?: { type: string; ref: number; role?: string; geometry?: (LL | null)[] }[];
}

// ------------------------------------------------------------------ geometry helpers

function cleanGeom(g: (LL | null)[] | undefined): LL[] {
  return g ? (g.filter((p) => p && typeof p.lat === 'number' && typeof p.lon === 'number') as LL[]) : [];
}

const key = (p: LL) => `${p.lat},${p.lon}`;

/** Joins open/closed segments end to end into closed rings. Unclosable leftovers are dropped. */
export function joinRings(segments: LL[][]): LL[][] {
  const rings: LL[][] = [];
  const open: LL[][] = [];
  for (const seg of segments) {
    if (seg.length < 2) continue;
    if (key(seg[0]) === key(seg[seg.length - 1])) {
      if (seg.length >= 4) rings.push(seg);
    } else open.push(seg.slice());
  }
  const byEnd = new Map<string, number[]>();
  const used = new Array<boolean>(open.length).fill(false);
  const add = (k: string, i: number) => {
    const a = byEnd.get(k);
    if (a) a.push(i);
    else byEnd.set(k, [i]);
  };
  open.forEach((s, i) => {
    add(key(s[0]), i);
    add(key(s[s.length - 1]), i);
  });
  const take = (k: string): number => {
    const a = byEnd.get(k);
    if (!a) return -1;
    for (const i of a) if (!used[i]) return i;
    return -1;
  };

  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = open[i].slice();
    const startKey = key(chain[0]);
    for (;;) {
      const endKey = key(chain[chain.length - 1]);
      if (endKey === startKey && chain.length >= 4) {
        rings.push(chain);
        break;
      }
      const j = take(endKey);
      if (j < 0) break; // cannot close
      used[j] = true;
      const seg = open[j];
      const next = key(seg[0]) === endKey ? seg.slice(1) : seg.slice(0, -1).reverse();
      chain = chain.concat(next);
    }
  }
  return rings;
}

function pointInRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Group rings of a multipolygon into polygons: one entry per outer ring, holes attached. */
function assemblePolygons(outers: Pt[][], inners: Pt[][]): Pt[][][] {
  const polys = outers.map((o) => [o]);
  for (const hole of inners) {
    const [hx, hy] = hole[0];
    for (let i = 0; i < outers.length; i++) {
      if (pointInRing(hx, hy, outers[i])) {
        polys[i].push(hole);
        break;
      }
    }
  }
  return polys;
}

// ------------------------------------------------------------------ tag mapping

function highwayClass(v: string | undefined): { cls: RoadClass; link: boolean } | null {
  if (!v) return null;
  const link = v.endsWith('_link');
  const base = link ? v.slice(0, -5) : v;
  switch (base) {
    case 'motorway': case 'trunk': case 'primary': case 'secondary': case 'tertiary': case 'service':
      return { cls: base, link };
    case 'residential': case 'living_street': case 'unclassified':
      return { cls: 'residential', link };
    case 'pedestrian': case 'footway': case 'path': case 'cycleway':
      return { cls: 'pedestrian', link };
    default:
      return null;
  }
}

function railwayClass(v: string | undefined): RoadClass | null {
  switch (v) {
    case 'rail': return 'rail';
    case 'tram': case 'light_rail': return 'tram';
    case 'subway': return 'subway';
    default: return null;
  }
}

const isYes = (v: string | undefined) => v !== undefined && v !== 'no' && v !== 'false' && v !== '0';

function areaKind(t: Record<string, string>): AreaKind | null {
  switch (t.landuse) {
    case 'forest': return 'forest';
    case 'farmland': case 'meadow': return 'farmland';
    case 'residential': return 'residential';
    case 'industrial': return 'industrial';
    case 'commercial': return 'commercial';
    case 'quarry': return 'quarry';
    case 'harbour': return 'harbour';
  }
  switch (t.natural) {
    case 'wood': return 'forest';
    case 'beach': return 'beach';
    case 'bare_rock': return 'rock';
    case 'wetland': return 'wetland';
  }
  if (t.leisure === 'park') return 'park';
  if (t.aeroway === 'aerodrome') return 'airport';
  if (t.industrial === 'port') return 'harbour';
  return null;
}

function isWater(t: Record<string, string>): boolean {
  return t.natural === 'water' || t.waterway === 'riverbank';
}

function waterKind(t: Record<string, string>): WaterPolygon['kind'] {
  if (t.water === 'river' || t.waterway === 'riverbank') return 'river';
  if (t.water === 'reservoir' || t.landuse === 'reservoir') return 'reservoir';
  return 'lake';
}

function leafType(t: Record<string, string>): AreaPolygon['leafType'] | undefined {
  const v = t.leaf_type;
  if (v === 'broadleaved' || v === 'needleleaved' || v === 'mixed') return v;
  return undefined;
}

function parseWidth(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ------------------------------------------------------------------ parsing

export function parseOverpass(json: { elements?: OsmElement[] }, frame: Frame, settings: BuildSettings): VectorData {
  const out: VectorData = { ways: [], waterPolygons: [], waterways: [], areas: [], treePoints: [], powerLines: [] };
  const classes = activeRoadClasses(frame, settings);
  const lim = (CS2.PLAYABLE_SIZE_M / 2) * (1 + MARGIN);
  const toGame = (g: LL[]): Pt[] => g.map((p) => frame.geoToGame(p.lat, p.lon));
  const intersects = (pts: Pt[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return maxX >= -lim && minX <= lim && maxY >= -lim && minY <= lim;
  };
  const inside = (p: Pt) => p[0] >= -lim && p[0] <= lim && p[1] >= -lim && p[1] <= lim;

  const pushArea = (t: Record<string, string>, polys: Pt[][][]) => {
    const water = isWater(t);
    const kind = areaKind(t);
    for (const rings of polys) {
      if (!intersects(rings[0])) continue;
      if (water) out.waterPolygons.push({ kind: waterKind(t), rings });
      else if (kind) {
        const a: AreaPolygon = { kind, rings };
        const lt = leafType(t);
        if (lt) a.leafType = lt;
        out.areas.push(a);
      }
    }
  };

  for (const el of json.elements ?? []) {
    const t = el.tags ?? {};

    if (el.type === 'node') {
      if (t.natural === 'tree' && typeof el.lat === 'number' && typeof el.lon === 'number') {
        const p = frame.geoToGame(el.lat, el.lon);
        if (inside(p)) out.treePoints.push(p);
      }
      continue;
    }

    if (el.type === 'way') {
      const g = cleanGeom(el.geometry);
      if (g.length < 2) continue;
      const closed = g.length >= 4 && key(g[0]) === key(g[g.length - 1]);

      if (t.highway || t.railway) {
        if (t.area === 'yes' || t.construction || t.proposed) continue;
        let cls: RoadClass | null = null;
        let link = false;
        if (t.highway) {
          const h = highwayClass(t.highway);
          if (h) {
            cls = h.cls;
            link = h.link;
          }
        } else {
          cls = railwayClass(t.railway);
          if (
            cls === 'rail' && frame.scale < 0.8 &&
            (t.service === 'yard' || t.service === 'siding' || t.service === 'spur')
          ) continue;
        }
        if (!cls || !classes.has(cls)) continue;
        let pts = toGame(g);
        if (!intersects(pts)) continue;
        const roundabout = t.junction === 'roundabout' || t.junction === 'circular';
        let oneway = cls === 'motorway' || roundabout;
        const ow = t.oneway;
        if (ow === 'yes' || ow === 'true' || ow === '1') oneway = true;
        else if (ow === '-1' || ow === 'reverse') {
          oneway = true;
          pts = pts.reverse();
        } else if (ow === 'no' || ow === 'false' || ow === '0') oneway = false;
        const lanes = t.lanes ? parseInt(t.lanes, 10) : NaN;
        const layer = t.layer ? parseInt(t.layer, 10) : 0;
        const way: RawWay = {
          id: el.id,
          cls,
          pts,
          oneway,
          bridge: isYes(t.bridge),
          tunnel: isYes(t.tunnel),
          layer: Number.isFinite(layer) ? layer : 0,
          roundabout,
          link,
        };
        if (Number.isFinite(lanes) && lanes > 0) way.lanes = lanes;
        if (t.name && settings.roads.names) way.name = t.name;
        out.ways.push(way);
        continue;
      }

      if (t.waterway === 'river' || t.waterway === 'stream' || t.waterway === 'canal') {
        if (t.waterway === 'stream' && frame.scale < 0.4) continue;
        const pts = toGame(g);
        if (!intersects(pts)) continue;
        const ww: Waterway = { kind: t.waterway, pts };
        const wm = parseWidth(t.width);
        if (wm !== undefined) ww.widthM = wm;
        if (t.name) ww.name = t.name;
        out.waterways.push(ww);
        continue;
      }

      if (t.power === 'line') {
        const pts = toGame(g);
        if (intersects(pts)) out.powerLines.push(pts);
        continue;
      }

      if (closed && (isWater(t) || areaKind(t))) {
        pushArea(t, [[toGame(g)]]);
      }
      continue;
    }

    if (el.type === 'relation') {
      if (!(isWater(t) || areaKind(t))) continue;
      const outerSegs: LL[][] = [];
      const innerSegs: LL[][] = [];
      for (const m of el.members ?? []) {
        if (m.type !== 'way') continue;
        const g = cleanGeom(m.geometry);
        if (g.length < 2) continue;
        (m.role === 'inner' ? innerSegs : outerSegs).push(g);
      }
      const outers = joinRings(outerSegs).map(toGame);
      if (!outers.length) continue;
      const inners = joinRings(innerSegs).map(toGame);
      pushArea(t, assemblePolygons(outers, inners));
    }
  }
  return out;
}

// ------------------------------------------------------------------ loading

async function queryOverpass(fetch: FetchBytes, query: string): Promise<{ elements?: OsmElement[] }> {
  const body = `data=${encodeURIComponent(query)}`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const attempt = async (url: string) => {
    const bytes = await fetch(url, { method: 'POST', body, headers });
    const json = JSON.parse(new TextDecoder().decode(bytes)) as { elements?: OsmElement[]; remark?: string };
    if (!json || !Array.isArray(json.elements)) throw new Error('Overpass: no elements in response');
    if (json.remark && /error|timed out|out of memory/i.test(json.remark) && json.elements.length === 0) {
      throw new Error(`Overpass: ${json.remark}`);
    }
    return json;
  };
  try {
    return await attempt(OVERPASS_URL);
  } catch (e1) {
    try {
      return await attempt(OVERPASS_MIRROR);
    } catch (e2) {
      throw new Error(`Overpass failed on both endpoints: ${(e1 as Error).message}; ${(e2 as Error).message}`);
    }
  }
}

export async function loadVectors(
  frame: Frame,
  settings: BuildSettings,
  fetch: FetchBytes,
  progress?: Progress,
): Promise<VectorData> {
  const stage = 'Kartdata';
  progress?.(stage, 0, 'Fetching OpenStreetMap');
  const query = buildOverpassQuery(frame, settings);
  const json = await queryOverpass(fetch, query);
  progress?.(stage, 0.8, 'Processing');
  const data = parseOverpass(json, frame, settings);
  progress?.(stage, 1);
  return data;
}
