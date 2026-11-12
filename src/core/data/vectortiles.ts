import { classifyRings, VectorTile } from '@mapbox/vector-tile';
import { gunzipSync } from 'fflate';
import { PbfReader } from 'pbf';
import polygonClipping from 'polygon-clipping';
import RBush from 'rbush';
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
import { activeRoadClasses } from './osm';
import { isNotFound, runPool } from './util';

/**
 * Vector data from the OpenFreeMap vector tiles (OpenMapTiles schema). Static files, fast and
 * reliable; same VectorData as the Overpass loader in osm.ts.
 *
 * Internally all geometry lives in "tile units" (u, v): the web-mercator world scaled so that
 * one tile at the chosen zoom is 1 x 1. Tile coordinates map to tile units exactly
 * (u = x + px / extent), so identical vertices in neighbouring tiles are bit-identical, which is
 * what makes the stitching exact. Projection to lat/lon and game metres happens last.
 */

export const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
/** bbox margin around the playable area, same as osm.ts */
const MARGIN = 0.05;
export const MAX_TILES = 200;
const CONCURRENCY = 8;
const STAGE = 'Kartdata';
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
/** tile buffer of the OpenMapTiles profile is 64 / 4096 = 0.0156 tiles; stay a bit above */
const BUFFER_UNITS = 0.03;

type Pair = [number, number];

// ------------------------------------------------------------------ tile maths

const lonToU = (lon: number) => (lon + 180) / 360;
const latToV = (lat: number) => {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

export interface TileRange {
  zoom: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  count: number;
}

/** Inclusive tile range covering bbox [south, west, north, east] at `zoom`. */
export function tileRange(bbox: [number, number, number, number], zoom: number): TileRange {
  const [s, w, n, e] = bbox;
  const nt = 2 ** zoom;
  const clamp = (v: number) => Math.max(0, Math.min(nt - 1, v));
  const x0 = clamp(Math.floor(lonToU(w) * nt));
  const x1 = clamp(Math.floor(lonToU(e) * nt));
  const y0 = clamp(Math.floor(latToV(n) * nt));
  const y1 = clamp(Math.floor(latToV(s) * nt));
  return { zoom, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

/** Highest zoom <= maxZoom whose tile count stays within maxTiles. */
export function chooseZoom(
  bbox: [number, number, number, number],
  maxZoom = 14,
  maxTiles = MAX_TILES,
): TileRange {
  for (let z = maxZoom; z > 0; z--) {
    const r = tileRange(bbox, z);
    if (r.count <= maxTiles) return r;
  }
  return tileRange(bbox, 0);
}

// ------------------------------------------------------------------ class mapping

/** OpenMapTiles `transportation` class/subclass to our RoadClass; null = not wanted. */
export function mapTransportClass(cls: string | undefined, subclass: string | undefined): RoadClass | null {
  switch (cls) {
    case 'motorway': case 'trunk': case 'primary': case 'secondary': case 'tertiary': case 'service':
      return cls;
    case 'minor':
      return 'residential';
    case 'path':
      if (subclass === undefined || ['footway', 'cycleway', 'path', 'pedestrian'].includes(subclass)) return 'pedestrian';
      return null;
    case 'rail':
      return subclass === undefined || subclass === 'rail' ? 'rail' : null;
    case 'transit':
      if (subclass === 'subway') return 'subway';
      if (subclass === 'tram' || subclass === 'light_rail') return 'tram';
      return null;
    default:
      return null; // track, raceway, busway, ferry, pier, aerialway, bridge, *_construction ...
  }
}

function landcoverKind(cls: string | undefined, sub: string | undefined): AreaKind | null {
  switch (cls) {
    case 'wood': return 'forest';
    case 'farmland': return 'farmland';
    case 'grass': return sub === 'meadow' ? 'farmland' : sub === 'park' ? 'park' : null;
    case 'rock': return 'rock';
    case 'sand': return 'beach';
    case 'wetland': return 'wetland';
    default: return null;
  }
}

function landuseKind(cls: string | undefined): AreaKind | null {
  switch (cls) {
    case 'residential': return 'residential';
    case 'industrial': return 'industrial';
    case 'commercial': case 'retail': return 'commercial';
    case 'quarry': return 'quarry';
    case 'park': return 'park';
    case 'aerodrome': case 'airport': return 'airport';
    default: return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

// ------------------------------------------------------------------ pieces

interface RoadAttrs {
  cls: RoadClass;
  link: boolean;
  oneway: boolean;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
  unpaved?: boolean;
}
interface WaterwayAttrs {
  kind: Waterway['kind'];
  name?: string;
}
interface LinePiece<T> {
  tile: number;
  seq: number;
  tx: number;
  ty: number;
  /** matching tolerance along a tile edge, tile units */
  tol: number;
  /** flat u, v pairs */
  pts: number[];
  gkey: string;
  attrs: T;
}
interface NamePiece {
  cls: RoadClass;
  name?: string;
  ref?: string;
  pts: number[];
}
interface PolyPiece {
  tile: number;
  seq: number;
  tx: number;
  ty: number;
  /** 'water:lake' | 'water:river' | 'area:<kind>' */
  group: string;
  poly: Pair[][];
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
}

export interface VectorTilesInfo {
  zoom: number;
  tileCount: number;
  failedTiles: number;
  emptyTiles: number;
  bytes: number;
  /** road pieces per class after clipping to tiles, before stitching */
  waysBefore: Partial<Record<RoadClass, number>>;
  waysAfter: Partial<Record<RoadClass, number>>;
  namedWays: number;
  waterwaysBefore: number;
  polygonPiecesBefore: number;
  /** "layer:class/subclass" counts of all polygon and water features seen (for tuning the mapping) */
  seenClasses: Record<string, number>;
}

// ------------------------------------------------------------------ line clipping

/** Clips a polyline (flat u,v) to a box. Boundary coordinates are snapped exactly onto the box. */
function clipLine(c: number[], x0: number, y0: number, x1: number, y1: number): number[][] {
  const runs: number[][] = [];
  let cur: number[] | null = null;
  const P = [0, 0, 0, 0];
  const Q = [0, 0, 0, 0];
  for (let i = 0; i + 3 < c.length; i += 2) {
    const ax = c[i], ay = c[i + 1], bx = c[i + 2], by = c[i + 3];
    const dx = bx - ax, dy = by - ay;
    P[0] = -dx; P[1] = dx; P[2] = -dy; P[3] = dy;
    Q[0] = ax - x0; Q[1] = x1 - ax; Q[2] = ay - y0; Q[3] = y1 - ay;
    let t0 = 0, t1 = 1, e0 = -1, e1 = -1;
    let ok = true;
    for (let k = 0; k < 4; k++) {
      const p = P[k], q = Q[k];
      if (p === 0) {
        if (q < 0) { ok = false; break; }
      } else {
        const r = q / p;
        if (p < 0) {
          if (r > t1) { ok = false; break; }
          if (r > t0) { t0 = r; e0 = k; }
        } else {
          if (r < t0) { ok = false; break; }
          if (r < t1) { t1 = r; e1 = k; }
        }
      }
    }
    if (!ok || t1 <= t0) { cur = null; continue; }
    const at = (t: number, e: number, px: number, py: number): Pair => {
      if (e < 0) return [px, py];
      let x = ax + t * dx, y = ay + t * dy;
      if (e === 0) x = x0; else if (e === 1) x = x1; else if (e === 2) y = y0; else y = y1;
      return [Math.min(x1, Math.max(x0, x)), Math.min(y1, Math.max(y0, y))];
    };
    const s = e0 < 0 ? ([ax, ay] as Pair) : at(t0, e0, ax, ay);
    const e = e1 < 0 ? ([bx, by] as Pair) : at(t1, e1, bx, by);
    if (!cur || t0 > 0) {
      cur = [s[0], s[1]];
      runs.push(cur);
    }
    cur.push(e[0], e[1]);
    if (e1 >= 0) cur = null; // left the box
  }
  return runs.filter((r) => r.length >= 4);
}

// ------------------------------------------------------------------ line stitching

interface Chain<T> {
  pts: number[];
  head: LinePiece<T>;
  pieces: number;
}

/**
 * Joins pieces whose ends meet on a tile edge (within the piece tolerance), snapping the matched
 * ends to identical coordinates. `directed`: only end-to-start joins (oneway roads).
 * All pieces must share one group key.
 */
function stitchLines<T>(pieces: LinePiece<T>[], directed: boolean): Chain<T>[] {
  const n = pieces.length;
  const link = new Int32Array(2 * n).fill(-1);
  interface Endpoint { node: number; along: number; tile: number; tol: number }
  const buckets = new Map<string, Endpoint[]>();
  const add = (k: string, e: Endpoint) => {
    const b = buckets.get(k);
    if (b) b.push(e);
    else buckets.set(k, [e]);
  };
  for (let i = 0; i < n; i++) {
    const p = pieces[i];
    for (let side = 0; side < 2; side++) {
      const o = side === 0 ? 0 : p.pts.length - 2;
      const u = p.pts[o], v = p.pts[o + 1];
      const e: Endpoint = { node: 2 * i + side, along: 0, tile: p.tile, tol: p.tol };
      if (u === p.tx || u === p.tx + 1) add(`V${u}`, { ...e, along: v });
      if (v === p.ty || v === p.ty + 1) add(`H${v}`, { ...e, along: u });
    }
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.along - b.along);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (link[a.node] >= 0) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.along - a.along > Math.max(a.tol, b.tol)) break;
        if (link[b.node] >= 0 || b.tile === a.tile || (a.node >> 1) === (b.node >> 1)) continue;
        if (directed && (a.node & 1) === (b.node & 1)) continue;
        link[a.node] = b.node;
        link[b.node] = a.node;
        // snap b's end onto a's end
        const pa = pieces[a.node >> 1].pts, pb = pieces[b.node >> 1].pts;
        const oa = a.node & 1 ? pa.length - 2 : 0;
        const ob = b.node & 1 ? pb.length - 2 : 0;
        pb[ob] = pa[oa];
        pb[ob + 1] = pa[oa + 1];
        break;
      }
    }
  }

  const visited = new Uint8Array(n);
  const chains: Chain<T>[] = [];
  const walk = (startNode: number) => {
    const out: number[] = [];
    const head = pieces[startNode >> 1];
    let count = 0;
    let node = startNode;
    for (;;) {
      const pi = node >> 1;
      if (visited[pi]) break;
      visited[pi] = 1;
      count++;
      const pts = pieces[pi].pts;
      const m = pts.length;
      if ((node & 1) === 0) {
        for (let k = 0; k < m; k += 2) pushPt(out, pts[k], pts[k + 1]);
      } else {
        for (let k = m - 2; k >= 0; k -= 2) pushPt(out, pts[k], pts[k + 1]);
      }
      const next = link[node ^ 1];
      if (next < 0) break;
      node = next;
    }
    if (out.length >= 4) chains.push({ pts: out, head, pieces: count });
  };
  for (let i = 0; i < n; i++) if (!visited[i] && link[2 * i] < 0) walk(2 * i);
  for (let i = 0; i < n; i++) if (!visited[i] && link[2 * i + 1] < 0) walk(2 * i + 1);
  for (let i = 0; i < n; i++) if (!visited[i]) walk(2 * i); // closed loops
  return chains;
}

function pushPt(out: number[], u: number, v: number): void {
  const m = out.length;
  if (m >= 2 && out[m - 2] === u && out[m - 1] === v) return;
  out.push(u, v);
}

// ------------------------------------------------------------------ polygon union

interface BoxItem { minX: number; minY: number; maxX: number; maxY: number; idx: number }

/** Unions overlapping pieces from different tiles; independent pieces pass through untouched. */
function mergePolygons(pieces: PolyPiece[]): Pair[][][] {
  const n = pieces.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const near: BoxItem[] = [];
  for (let i = 0; i < n; i++) {
    const p = pieces[i];
    if (
      p.minU < p.tx + BUFFER_UNITS || p.maxU > p.tx + 1 - BUFFER_UNITS ||
      p.minV < p.ty + BUFFER_UNITS || p.maxV > p.ty + 1 - BUFFER_UNITS
    ) near.push({ minX: p.minU, minY: p.minV, maxX: p.maxU, maxY: p.maxV, idx: i });
  }
  const tree = new RBush<BoxItem>();
  tree.load(near);
  for (const it of near) {
    const a = pieces[it.idx];
    for (const o of tree.search(it)) {
      if (o.idx === it.idx || pieces[o.idx].tile === a.tile) continue;
      const ra = find(it.idx), rb = find(o.idx);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  const out: Pair[][][] = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      out.push(pieces[members[0]].poly);
      continue;
    }
    try {
      const [first, ...rest] = members.map((i) => pieces[i].poly);
      for (const poly of polygonClipping.union(first, ...rest)) out.push(poly);
    } catch {
      for (const i of members) out.push(pieces[i].poly); // keep the unmerged pieces
    }
  }
  return out;
}

// ------------------------------------------------------------------ name matching

interface SegItem extends BoxItem { x1: number; y1: number; x2: number; y2: number; name: string }

function distToSeg(px: number, py: number, s: SegItem): number {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - s.x1) * dx + (py - s.y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
}

/** Sample points (flat u,v) at evenly spread fractions along a polyline. */
function sampleAlong(pts: number[], count: number): number[] {
  const m = pts.length / 2;
  const cum = new Array<number>(m).fill(0);
  for (let i = 1; i < m; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  }
  const total = cum[m - 1];
  const out: number[] = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const d = (total * (k + 0.5)) / count;
    while (seg < m - 1 && cum[seg] < d) seg++;
    const l = cum[seg] - cum[seg - 1];
    const t = l > 0 ? (d - cum[seg - 1]) / l : 0;
    out.push(
      pts[2 * seg - 2] + t * (pts[2 * seg] - pts[2 * seg - 2]),
      pts[2 * seg - 1] + t * (pts[2 * seg + 1] - pts[2 * seg - 1]),
    );
  }
  return out;
}

// ------------------------------------------------------------------ the collector

export interface RawTile {
  x: number;
  y: number;
  /** MVT bytes, plain or gzip-compressed */
  bytes: Uint8Array;
}

class Collector {
  readonly roads: LinePiece<RoadAttrs>[] = [];
  readonly waterways: LinePiece<WaterwayAttrs>[] = [];
  readonly names: NamePiece[] = [];
  readonly polys: PolyPiece[] = [];
  readonly seen: Record<string, number> = {};
  private readonly classes: Set<RoadClass>;
  private readonly lim: number;
  private readonly unitRect: [number, number, number, number];
  private readonly nt: number;

  constructor(
    readonly zoom: number,
    private readonly frame: Frame,
    private readonly settings: BuildSettings,
  ) {
    this.classes = activeRoadClasses(frame, settings);
    this.lim = (CS2.PLAYABLE_SIZE_M / 2) * (1 + MARGIN);
    this.nt = 2 ** zoom;
    const [s, w, n, e] = frame.bbox(CS2.PLAYABLE_SIZE_M * (1 + MARGIN));
    this.unitRect = [lonToU(w) * this.nt, latToV(n) * this.nt, lonToU(e) * this.nt, latToV(s) * this.nt];
  }

  private see(key: string) {
    this.seen[key] = (this.seen[key] ?? 0) + 1;
  }

  /** Decodes one tile into pieces. Returns false when the tile has no layers at all. */
  addTile(x: number, y: number, input: Uint8Array): boolean {
    let bytes = input;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    if (bytes.length === 0) return false;
    const vt = new VectorTile(new PbfReader(bytes));
    const layers = vt.layers;
    const tile = y * this.nt + x;
    let seq = 0;
    const scaleLow = this.frame.scale < 0.4;

    const toUnits = (line: { x: number; y: number }[], extent: number, reverse: boolean): number[] => {
      const out = new Array<number>(line.length * 2);
      for (let j = 0; j < line.length; j++) {
        const p = line[reverse ? line.length - 1 - j : j];
        out[2 * j] = x + p.x / extent;
        out[2 * j + 1] = y + p.y / extent;
      }
      return out;
    };

    const tr = layers.transportation;
    if (tr) {
      for (let i = 0; i < tr.length; i++) {
        const f = tr.feature(i);
        if (f.type !== 2) continue;
        const p = f.properties;
        const cls = mapTransportClass(str(p.class), str(p.subclass));
        if (!cls || !this.classes.has(cls)) continue;
        const brunnel = str(p.brunnel);
        if (brunnel === 'ford') continue;
        // rail yards and sidings are simplified to their through tracks at every scale; spurs only
        // when generalising
        if (cls === 'rail') {
          const svc = str(p.service);
          if (svc === 'yard' || svc === 'siding') continue;
          if (svc === 'spur' && this.frame.scale < 0.8) continue;
        }
        const ow = typeof p.oneway === 'number' ? p.oneway : undefined;
        let oneway = cls === 'motorway';
        let reverse = false;
        if (ow === 1) oneway = true;
        else if (ow === -1) { oneway = true; reverse = true; }
        else if (ow === 0) oneway = false;
        if (cls === 'rail' || cls === 'tram' || cls === 'subway') oneway = false;
        const layerN = typeof p.layer === 'number' && Number.isFinite(p.layer) ? p.layer : 0;
        const attrs: RoadAttrs = {
          cls,
          link: Number(p.ramp) === 1,
          oneway,
          bridge: brunnel === 'bridge',
          tunnel: brunnel === 'tunnel',
          layer: layerN,
        };
        if (str(p.surface) === 'unpaved') attrs.unpaved = true;
        const gkey = `${cls}|${+attrs.link}|${+oneway}|${+attrs.bridge}|${+attrs.tunnel}|${layerN}|${+!!attrs.unpaved}`;
        for (const line of f.loadGeometry()) {
          if (line.length < 2) continue;
          const flat = toUnits(line, tr.extent, reverse);
          for (const run of clipLine(flat, x, y, x + 1, y + 1)) {
            this.roads.push({ tile, seq: seq++, tx: x, ty: y, tol: 3 / tr.extent, pts: run, gkey, attrs });
          }
        }
      }
    }

    const tn = layers.transportation_name;
    if (tn && this.settings.roads.names) {
      for (let i = 0; i < tn.length; i++) {
        const f = tn.feature(i);
        if (f.type !== 2) continue;
        const p = f.properties;
        const cls = mapTransportClass(str(p.class), str(p.subclass));
        const name = str(p.name) ?? str(p['name:latin']) ?? str(p.name_en);
        const ref = str(p.ref);
        if (!cls || (!name && !ref) || !this.classes.has(cls)) continue;
        for (const line of f.loadGeometry()) {
          if (line.length >= 2) this.names.push({ cls, name, ref, pts: toUnits(line, tn.extent, false) });
        }
      }
    }

    const ww = layers.waterway;
    if (ww) {
      for (let i = 0; i < ww.length; i++) {
        const f = ww.feature(i);
        if (f.type !== 2) continue;
        const p = f.properties;
        const kind = str(p.class);
        this.see(`waterway:${kind}`);
        if (kind !== 'river' && kind !== 'canal' && kind !== 'stream') continue;
        if (kind === 'stream' && scaleLow) continue;
        const name = str(p.name) ?? str(p['name:latin']) ?? str(p.name_en);
        const attrs: WaterwayAttrs = { kind };
        if (name) attrs.name = name;
        const gkey = `${kind}|${name ?? ''}`;
        for (const line of f.loadGeometry()) {
          if (line.length < 2) continue;
          for (const run of clipLine(toUnits(line, ww.extent, false), x, y, x + 1, y + 1)) {
            this.waterways.push({ tile, seq: seq++, tx: x, ty: y, tol: 3 / ww.extent, pts: run, gkey, attrs });
          }
        }
      }
    }

    const addPolys = (
      layer: (typeof layers)[string] | undefined,
      pick: (p: Record<string, number | string | boolean>) => string | null,
      seenLabel: (p: Record<string, number | string | boolean>) => string,
    ) => {
      if (!layer) return;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        if (f.type !== 3) continue;
        const p = f.properties;
        this.see(seenLabel(p));
        const group = pick(p);
        if (!group) continue;
        for (const rings of classifyRings(f.loadGeometry())) {
          const poly: Pair[][] = [];
          let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
          for (const r of rings) {
            if (r.length < 3) continue;
            const ring: Pair[] = [];
            for (const q of r) {
              const u = x + q.x / layer.extent, v = y + q.y / layer.extent;
              ring.push([u, v]);
              if (poly.length === 0) {
                if (u < minU) minU = u;
                if (u > maxU) maxU = u;
                if (v < minV) minV = v;
                if (v > maxV) maxV = v;
              }
            }
            const a = ring[0], b = ring[ring.length - 1];
            if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
            if (ring.length >= 4) poly.push(ring);
            else if (poly.length === 0) break; // degenerate outer ring
          }
          if (poly.length === 0) continue;
          const [ru0, rv0, ru1, rv1] = this.unitRect;
          if (maxU < ru0 || minU > ru1 || maxV < rv0 || minV > rv1) continue;
          this.polys.push({ tile, seq: seq++, tx: x, ty: y, group, poly, minU, minV, maxU, maxV });
        }
      }
    };

    addPolys(
      layers.water,
      (p) => {
        const c = str(p.class);
        if (c === 'ocean' || c === 'swimming_pool') return null;
        return c === 'river' ? 'water:river' : 'water:lake';
      },
      (p) => `water:${str(p.class)}`,
    );
    addPolys(
      layers.landcover,
      (p) => {
        const k = landcoverKind(str(p.class), str(p.subclass));
        return k ? `area:${k}` : null;
      },
      (p) => `landcover:${str(p.class)}/${str(p.subclass)}`,
    );
    addPolys(
      layers.landuse,
      (p) => {
        const k = landuseKind(str(p.class));
        return k ? `area:${k}` : null;
      },
      (p) => `landuse:${str(p.class)}`,
    );
    addPolys(
      layers.park,
      (p) => (str(p.class) === 'park' ? 'area:park' : null),
      (p) => `park:${str(p.class)}`,
    );
    addPolys(
      layers.aeroway,
      (p) => (str(p.class) === 'aerodrome' ? 'area:airport' : null),
      (p) => `aeroway:${str(p.class)}`,
    );
    return true;
  }

  finish(info: VectorTilesInfo): VectorData {
    const { frame, zoom, lim, nt } = this;
    const out: VectorData = { ways: [], waterPolygons: [], waterways: [], areas: [], treePoints: [], powerLines: [] };
    const byOrder = <T extends { tile: number; seq: number }>(a: T, b: T) => a.tile - b.tile || a.seq - b.seq;

    const project = (flat: number[]): Pt[] => {
      const pts: Pt[] = new Array(flat.length / 2);
      for (let i = 0; i < pts.length; i++) {
        const lon = (flat[2 * i] / nt) * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * flat[2 * i + 1]) / nt))) * R2D;
        pts[i] = frame.geoToGame(lat, lon);
      }
      return pts;
    };
    const intersects = (pts: Pt[]) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [px, py] of pts) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      return maxX >= -lim && minX <= lim && maxY >= -lim && minY <= lim;
    };
    const groupBy = <T extends { gkey: string }>(list: T[]) => {
      const m = new Map<string, T[]>();
      for (const p of list) {
        const g = m.get(p.gkey);
        if (g) g.push(p);
        else m.set(p.gkey, [p]);
      }
      return m;
    };

    // ---- roads
    this.roads.sort(byOrder);
    for (const p of this.roads) info.waysBefore[p.attrs.cls] = (info.waysBefore[p.attrs.cls] ?? 0) + 1;
    const chains: Chain<RoadAttrs>[] = [];
    for (const group of groupBy(this.roads).values()) {
      for (const c of stitchLines(group, group[0].attrs.oneway)) chains.push(c);
    }

    // names: spatial match of same-class name features along each way
    const trees = new Map<RoadClass, RBush<SegItem>>();
    const lat0 = frame.sel.centerLat;
    const tileWidthM = (40075016.686 * Math.cos(lat0 * D2R)) / nt;
    const tolU = Math.max(6, (2.5 * tileWidthM) / 4096) / tileWidthM;
    if (this.names.length) {
      const items = new Map<RoadClass, SegItem[]>();
      for (const nm of this.names) {
        let list = items.get(nm.cls);
        if (!list) items.set(nm.cls, (list = []));
        for (let i = 0; i + 3 < nm.pts.length; i += 2) {
          const x1 = nm.pts[i], y1 = nm.pts[i + 1], x2 = nm.pts[i + 2], y2 = nm.pts[i + 3];
          list.push({
            minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2),
            idx: 0, x1, y1, x2, y2, name: `${nm.name ?? ''}\u0000${nm.ref ?? ''}`,
          });
        }
      }
      for (const [cls, list] of items) {
        const t = new RBush<SegItem>();
        t.load(list);
        trees.set(cls, t);
      }
    }
    const nameFor = (cls: RoadClass, pts: number[]): string | undefined => {
      const tree = trees.get(cls);
      if (!tree) return undefined;
      const len = pts.length / 2;
      const count = len > 6 ? 5 : 3;
      const samples = sampleAlong(pts, count);
      const votes = new Map<string, number>();
      for (let k = 0; k < count; k++) {
        const px = samples[2 * k], py = samples[2 * k + 1];
        const hit = new Set<string>();
        for (const s of tree.search({ minX: px - tolU, minY: py - tolU, maxX: px + tolU, maxY: py + tolU })) {
          if (!hit.has(s.name) && distToSeg(px, py, s) <= tolU) hit.add(s.name);
        }
        for (const nmv of hit) votes.set(nmv, (votes.get(nmv) ?? 0) + 1);
      }
      let best: string | undefined;
      let bestVotes = 0;
      for (const [nmv, v] of votes) if (v > bestVotes) { best = nmv; bestVotes = v; }
      return bestVotes >= Math.ceil(count / 2) ? best : undefined;
    };

    let nextId = 1;
    for (const c of chains) {
      const pts = project(c.pts);
      if (pts.length < 2 || !intersects(pts)) continue;
      const a = c.head.attrs;
      const way: RawWay = {
        id: nextId++,
        cls: a.cls,
        pts,
        oneway: a.oneway,
        bridge: a.bridge,
        tunnel: a.tunnel,
        layer: a.layer,
        roundabout: false,
        link: a.link,
      };
      if (this.settings.roads.names) {
        const nm = nameFor(a.cls, c.pts);
        if (nm) {
          const [n, r] = nm.split('\u0000');
          if (n) way.name = n;
          if (r) way.ref = r;
          info.namedWays++;
        }
        if (a.unpaved) way.unpaved = true;
      }
      out.ways.push(way);
      info.waysAfter[a.cls] = (info.waysAfter[a.cls] ?? 0) + 1;
    }

    // ---- waterways
    this.waterways.sort(byOrder);
    info.waterwaysBefore = this.waterways.length;
    for (const group of groupBy(this.waterways).values()) {
      for (const c of stitchLines(group, false)) {
        const pts = project(c.pts);
        if (pts.length < 2 || !intersects(pts)) continue;
        const ww: Waterway = { kind: c.head.attrs.kind, pts };
        if (c.head.attrs.name) ww.name = c.head.attrs.name;
        out.waterways.push(ww);
      }
    }

    // ---- polygons
    this.polys.sort(byOrder);
    info.polygonPiecesBefore = this.polys.length;
    const polyGroups = new Map<string, PolyPiece[]>();
    for (const p of this.polys) {
      const g = polyGroups.get(p.group);
      if (g) g.push(p);
      else polyGroups.set(p.group, [p]);
    }
    for (const [group, pieces] of polyGroups) {
      const [type, kind] = group.split(':');
      for (const poly of mergePolygons(pieces)) {
        const rings: Pt[][] = poly.map((r) => project(r.flat()));
        if (!intersects(rings[0])) continue;
        if (type === 'water') out.waterPolygons.push({ kind: kind as WaterPolygon['kind'], rings });
        else out.areas.push({ kind: kind as AreaPolygon['kind'], rings });
      }
    }
    return out;
  }
}

function emptyInfo(zoom: number, tileCount: number): VectorTilesInfo {
  return {
    zoom,
    tileCount,
    failedTiles: 0,
    emptyTiles: 0,
    bytes: 0,
    waysBefore: {},
    waysAfter: {},
    namedWays: 0,
    waterwaysBefore: 0,
    polygonPiecesBefore: 0,
    seenClasses: {},
  };
}

/** Pure part: decode tiles (already fetched) and build VectorData. No network. */
export function buildVectorsFromTiles(
  tiles: RawTile[],
  zoom: number,
  frame: Frame,
  settings: BuildSettings,
): { data: VectorData; info: VectorTilesInfo } {
  const info = emptyInfo(zoom, tiles.length);
  const col = new Collector(zoom, frame, settings);
  for (const t of tiles) {
    info.bytes += t.bytes.length;
    if (!col.addTile(t.x, t.y, t.bytes)) info.emptyTiles++;
  }
  const data = col.finish(info);
  info.seenClasses = col.seen;
  return { data, info };
}

// ------------------------------------------------------------------ loading

interface TileJson {
  tiles?: string[];
  maxzoom?: number;
}

export async function loadVectorsFromTilesDetailed(
  frame: Frame,
  settings: BuildSettings,
  fetch: FetchBytes,
  progress?: Progress,
): Promise<{ data: VectorData; info: VectorTilesInfo }> {
  progress?.(STAGE, 0, 'Fetching map tiles');
  const tj = JSON.parse(new TextDecoder().decode(await fetch(TILEJSON_URL))) as TileJson;
  const tmpl = tj.tiles?.[0];
  if (!tmpl) throw new Error('OpenFreeMap TileJSON has no tiles url');
  const template = tmpl;
  const maxZoom = Math.min(14, typeof tj.maxzoom === 'number' ? tj.maxzoom : 14);

  const bbox = frame.bbox(CS2.PLAYABLE_SIZE_M * (1 + MARGIN));
  const range = chooseZoom(bbox, maxZoom, MAX_TILES);
  const list: { x: number; y: number }[] = [];
  for (let y = range.y0; y <= range.y1; y++) for (let x = range.x0; x <= range.x1; x++) list.push({ x, y });

  const info = emptyInfo(range.zoom, list.length);
  const col = new Collector(range.zoom, frame, settings);
  let done = 0;
  const failures: string[] = [];
  progress?.(STAGE, 0.02, `Fetching map tiles 0/${list.length}`);
  await runPool(list, CONCURRENCY, async ({ x, y }) => {
    const url = new URL(
      template.replace('{z}', String(range.zoom)).replace('{x}', String(x)).replace('{y}', String(y)),
      TILEJSON_URL,
    ).href;
    try {
      let bytes: Uint8Array | null = null;
      for (let attempt = 0; attempt < 2 && !bytes; attempt++) {
        try {
          bytes = await fetch(url);
        } catch (e) {
          if (isNotFound(e)) {
            bytes = new Uint8Array(0);
            break;
          }
          if (attempt === 1) throw e;
        }
      }
      const b = bytes ?? new Uint8Array(0);
      info.bytes += b.length;
      if (!col.addTile(x, y, b)) info.emptyTiles++;
    } catch (e) {
      info.failedTiles++;
      failures.push(`${z(range.zoom)}/${x}/${y}: ${(e as Error).message}`);
    }
    done++;
    progress?.(STAGE, 0.02 + 0.83 * (done / list.length), `Fetching map tiles ${done}/${list.length}`);
  });
  if (info.failedTiles > list.length / 4) {
    throw new Error(
      `OpenFreeMap tiles: ${info.failedTiles} of ${list.length} tiles failed (e.g. ${failures[0] ?? 'unknown'})`,
    );
  }
  progress?.(STAGE, 0.88, 'Processing');
  const data = col.finish(info);
  info.seenClasses = col.seen;
  progress?.(STAGE, 1);
  return { data, info };
}

const z = (n: number) => `z${n}`;

/** OpenFreeMap vector tiles as a fast, reliable alternative to Overpass. Same VectorData. */
export async function loadVectorsFromTiles(
  frame: Frame,
  settings: BuildSettings,
  fetch: FetchBytes,
  progress?: Progress,
): Promise<VectorData> {
  return (await loadVectorsFromTilesDetailed(frame, settings, fetch, progress)).data;
}
