import { classifyRings, VectorTile } from '@mapbox/vector-tile';
import { gunzipSync } from 'fflate';
import { PbfReader } from 'pbf';
import type { Frame } from '../geo/frame';
import { CS2, type FetchBytes, type Progress, type Pt, type WaterPolygon, type Waterway } from '../types';
import { chooseZoom, TILEJSON_URL } from './vectortiles';
import { isNotFound, runPool } from './util';

/**
 * Coarse water outlines for the whole world area (57344 game m): sea (OpenMapTiles "ocean"),
 * lakes, wide rivers and major waterways, from the OpenFreeMap vector tiles at a low zoom.
 * The terrain uses them to classify and carve water outside the playable area, where the
 * detailed vectors do not reach, so water bodies continue across the playable border.
 */
export interface WorldWater {
  /** kind 'sea' = ocean polygons; lake / reservoir / river as in VectorData */
  waterPolygons: WaterPolygon[];
  waterways: Waterway[];
  zoom: number;
  tiles: number;
}

/** small tile budget: about 9 to 20 tiles at zoom 10 or 11 */
export const WORLD_WATER_MAX_TILES = 20;
const WORLD_WATER_MAX_ZOOM = 11;
const CONCURRENCY = 8;
const STAGE = 'World water';
const R2D = 180 / Math.PI;

type Flat = number[];

/** Clips a polyline (flat u, v) to a box; boundary points are snapped exactly onto the box. */
function clipLine(c: Flat, x0: number, y0: number, x1: number, y1: number): Flat[] {
  const runs: Flat[] = [];
  let cur: Flat | null = null;
  for (let i = 0; i + 3 < c.length; i += 2) {
    const ax = c[i], ay = c[i + 1], bx = c[i + 2], by = c[i + 3];
    const dx = bx - ax, dy = by - ay;
    const P = [-dx, dx, -dy, dy];
    const Q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
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
    const at = (t: number, e: number): [number, number] => {
      let x = ax + t * dx, y = ay + t * dy;
      if (e === 0) x = x0; else if (e === 1) x = x1; else if (e === 2) y = y0; else y = y1;
      return [Math.min(x1, Math.max(x0, x)), Math.min(y1, Math.max(y0, y))];
    };
    const s = e0 < 0 ? [ax, ay] : at(t0, e0);
    const e = e1 < 0 ? [bx, by] : at(t1, e1);
    if (!cur || t0 > 0) {
      cur = [s[0], s[1]];
      runs.push(cur);
    }
    cur.push(e[0], e[1]);
    if (e1 >= 0) cur = null;
  }
  return runs.filter((r) => r.length >= 4);
}

interface LinePiece { key: string; kind: Waterway['kind']; name?: string; pts: Flat }

/** Joins pieces of the same waterway whose ends meet exactly (tile-edge cuts). */
function stitch(pieces: LinePiece[]): LinePiece[] {
  const ends = new Map<string, number[]>();
  const endKey = (p: LinePiece, side: number) => {
    const o = side === 0 ? 0 : p.pts.length - 2;
    return `${p.key}|${p.pts[o]}|${p.pts[o + 1]}`;
  };
  pieces.forEach((p, i) => {
    for (let s = 0; s < 2; s++) {
      const k = endKey(p, s);
      const l = ends.get(k);
      if (l) l.push(2 * i + s);
      else ends.set(k, [2 * i + s]);
    }
  });
  const used = new Uint8Array(pieces.length);
  const partner = (node: number): number => {
    const l = ends.get(endKey(pieces[node >> 1], node & 1));
    if (!l || l.length !== 2) return -1;
    return l[0] === node ? l[1] : l[0];
  };
  const out: LinePiece[] = [];
  const walk = (start: number) => {
    const pts: Flat = [];
    let node = start;
    const head = pieces[start >> 1];
    while (node >= 0 && !used[node >> 1]) {
      const pi = node >> 1;
      used[pi] = 1;
      const p = pieces[pi].pts;
      const fwd = (node & 1) === 0;
      for (let k = 0; k < p.length; k += 2) {
        const j = fwd ? k : p.length - 2 - k;
        const m = pts.length;
        if (m >= 2 && pts[m - 2] === p[j] && pts[m - 1] === p[j + 1]) continue;
        pts.push(p[j], p[j + 1]);
      }
      const other = node ^ 1;
      const nxt = partner(other);
      node = nxt;
    }
    if (pts.length >= 4) out.push({ ...head, pts });
  };
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    if (partner(2 * i) < 0) walk(2 * i);
    else if (partner(2 * i + 1) < 0) walk(2 * i + 1);
  }
  for (let i = 0; i < pieces.length; i++) if (!used[i]) walk(2 * i); // loops
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Pure part: decodes already fetched tiles. Exported for tests. */
export function buildWorldWater(
  tiles: { x: number; y: number; bytes: Uint8Array }[],
  zoom: number,
  frame: Frame,
): WorldWater {
  const nt = 2 ** zoom;
  const lim = (CS2.WORLD_SIZE_M / 2) * 1.02;
  const project = (u: number, v: number): Pt => {
    const lon = (u / nt) * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / nt))) * R2D;
    return frame.geoToGame(lat, lon);
  };
  const inside = (pts: Pt[]) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    return x1 >= -lim && x0 <= lim && z1 >= -lim && z0 <= lim;
  };
  const polys: WaterPolygon[] = [];
  const pieces: LinePiece[] = [];
  for (const t of tiles) {
    let bytes = t.bytes;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    if (bytes.length === 0) continue;
    const vt = new VectorTile(new PbfReader(bytes));
    const water = vt.layers.water;
    if (water) {
      for (let i = 0; i < water.length; i++) {
        const f = water.feature(i);
        if (f.type !== 3) continue;
        const cls = str(f.properties.class);
        if (cls === 'swimming_pool' || Number(f.properties.intermittent) === 1) continue;
        const kind: WaterPolygon['kind'] = cls === 'ocean' ? 'sea' : cls === 'river' ? 'river' : 'lake';
        for (const rings of classifyRings(f.loadGeometry())) {
          const out: Pt[][] = [];
          for (const r of rings) {
            if (r.length < 3) continue;
            out.push(r.map((q) => project(t.x + q.x / water.extent, t.y + q.y / water.extent)));
          }
          if (out.length && out[0].length >= 3 && inside(out[0])) polys.push({ kind, rings: out });
        }
      }
    }
    const ww = vt.layers.waterway;
    if (ww) {
      for (let i = 0; i < ww.length; i++) {
        const f = ww.feature(i);
        if (f.type !== 2) continue;
        const cls = str(f.properties.class);
        if (cls !== 'river' && cls !== 'canal') continue;
        if (Number(f.properties.intermittent) === 1) continue;
        const name = str(f.properties.name) ?? str(f.properties['name:latin']);
        for (const line of f.loadGeometry()) {
          if (line.length < 2) continue;
          const flat: Flat = [];
          for (const q of line) flat.push(t.x + q.x / ww.extent, t.y + q.y / ww.extent);
          for (const run of clipLine(flat, t.x, t.y, t.x + 1, t.y + 1)) {
            pieces.push({ key: `${cls}|${name ?? ''}`, kind: cls, name, pts: run });
          }
        }
      }
    }
  }
  const waterways: Waterway[] = [];
  for (const p of stitch(pieces)) {
    const pts: Pt[] = [];
    for (let k = 0; k < p.pts.length; k += 2) pts.push(project(p.pts[k], p.pts[k + 1]));
    if (!inside(pts)) continue;
    const w: Waterway = { kind: p.kind, pts };
    if (p.name) w.name = p.name;
    waterways.push(w);
  }
  return { waterPolygons: polys, waterways, zoom, tiles: tiles.length };
}

/** Loads world-area water from the OpenFreeMap tiles (a handful of low-zoom tiles). */
export async function loadWorldWater(frame: Frame, fetch: FetchBytes, progress?: Progress): Promise<WorldWater> {
  progress?.(STAGE, 0, 'Fetching water outlines for the world map');
  const tj = JSON.parse(new TextDecoder().decode(await fetch(TILEJSON_URL))) as { tiles?: string[]; maxzoom?: number };
  const template = tj.tiles?.[0];
  if (!template) throw new Error('OpenFreeMap TileJSON has no tiles url');
  const maxZoom = Math.min(WORLD_WATER_MAX_ZOOM, typeof tj.maxzoom === 'number' ? tj.maxzoom : 14);
  const range = chooseZoom(frame.bbox(CS2.WORLD_SIZE_M), maxZoom, WORLD_WATER_MAX_TILES);
  const list: { x: number; y: number }[] = [];
  for (let y = range.y0; y <= range.y1; y++) for (let x = range.x0; x <= range.x1; x++) list.push({ x, y });
  const tiles: { x: number; y: number; bytes: Uint8Array }[] = [];
  let failed = 0;
  let done = 0;
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
          if (isNotFound(e)) { bytes = new Uint8Array(0); break; }
          if (attempt === 1) throw e;
        }
      }
      tiles.push({ x, y, bytes: bytes ?? new Uint8Array(0) });
    } catch {
      failed++;
    }
    done++;
    progress?.(STAGE, 0.05 + 0.85 * (done / list.length), `Fetching water outlines ${done}/${list.length}`);
  });
  if (failed > 0) throw new Error(`${failed} of ${list.length} world water tiles failed`);
  tiles.sort((a, b) => a.y - b.y || a.x - b.x); // deterministic order
  const out = buildWorldWater(tiles, range.zoom, frame);
  progress?.(STAGE, 1);
  return out;
}
