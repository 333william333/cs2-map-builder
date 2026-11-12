/**
 * Zoning preview: the game's 8 x 8 m zoning grid along zonable roads (up to 6 rows per side)
 * plus example building lots for scale. Preview only.
 *
 * All overlap tests use uniform 4 m occupancy grids (typed arrays). Game metres everywhere.
 */
import type {
  AreaPolygon, LandcoverGrid, NetPrefab, RoadClass, RoadNetwork, TerrainResult, VectorData, ZonePreview,
} from '../types';
import { LC } from '../types';
import { HALF, IMPORTANCE, PREFAB_WIDTH } from '../roads/params';

export interface ZoneInput {
  roads: RoadNetwork;
  terrain: TerrainResult;
  landcover?: LandcoverGrid;
  vectors?: VectorData;
}

const CELL = 8;
const ROWS = 6;
const G = 4; // occupancy grid cell (m)
const NG = Math.ceil((2 * HALF) / G); // 3584
const MARGIN = 16;
const MAX_SLOPE = 0.2;
const ROAD_MARGIN = 1; // extra corridor half width
const MIN_CENTRE_DIST = 7;
const MAX_LOTS = 150000;
const LU = 16; // land-use raster cell (m)
const NLU = Math.ceil((2 * HALF) / LU); // 896
const DENS_R = 6; // neighbourhood half width in LU cells (about 200 m window)
const MULTI = 0xffff;

const EMPTY_PREVIEW = (): ZonePreview => ({
  cellCount: 0,
  cells: new Float32Array(0),
  cellDepth: new Uint8Array(0),
  lotCount: 0,
  lots: new Float32Array(0),
  lotKind: new Uint8Array(0),
});

function zonable(prefab: NetPrefab): boolean {
  return prefab.startsWith('road_');
}

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function growF32(a: Float32Array<ArrayBuffer>, need: number): Float32Array<ArrayBuffer> {
  if (need <= a.length) return a;
  const b = new Float32Array(Math.max(need, a.length * 2, 1024));
  b.set(a);
  return b;
}
function growU8(a: Uint8Array<ArrayBuffer>, need: number): Uint8Array<ArrayBuffer> {
  if (need <= a.length) return a;
  const b = new Uint8Array(Math.max(need, a.length * 2, 1024));
  b.set(a);
  return b;
}

/** Rasterise OSM land-use polygons into a 16 m grid (0 none, 1 residential, 2 commercial, 3 industrial). */
function rasterAreas(areas: AreaPolygon[], out: Uint8Array): void {
  const order: Array<[string, number]> = [['residential', 1], ['commercial', 2], ['industrial', 3]];
  const xs: number[] = [];
  for (const [kind, code] of order) {
    for (const poly of areas) {
      if (poly.kind !== kind) continue;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const ring of poly.rings) {
        for (const p of ring) {
          if (p[1] < minZ) minZ = p[1];
          if (p[1] > maxZ) maxZ = p[1];
        }
      }
      if (!(minZ <= maxZ)) continue;
      const r0 = Math.max(0, Math.floor((HALF - maxZ) / LU - 0.5));
      const r1 = Math.min(NLU - 1, Math.ceil((HALF - minZ) / LU - 0.5));
      for (let r = r0; r <= r1; r++) {
        const zc = HALF - (r + 0.5) * LU;
        xs.length = 0;
        for (const ring of poly.rings) {
          const m = ring.length;
          for (let i = 0; i < m; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % m];
            if (a[1] <= zc !== b[1] <= zc) {
              xs.push(a[0] + ((zc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
            }
          }
        }
        if (xs.length < 2) continue;
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.ceil((xs[k] + HALF) / LU - 0.5));
          const c1 = Math.min(NLU - 1, Math.floor((xs[k + 1] + HALF) / LU - 0.5));
          for (let c = c0; c <= c1; c++) out[r * NLU + c] = code;
        }
      }
    }
  }
}

function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px;
  const ez = az + t * dz - pz;
  return ex * ex + ez * ez;
}

export function buildZones(input: ZoneInput): ZonePreview {
  const { roads, terrain, landcover, vectors } = input;
  const nodeById = new Map<number, number>();
  roads.nodes.forEach((n, i) => nodeById.set(n.id, i));

  // ---- zonable edges, in claiming order (major roads first)
  const zEdges: number[] = [];
  for (let i = 0; i < roads.edges.length; i++) {
    const e = roads.edges[i];
    if (!zonable(e.prefab) || e.bridge || e.tunnel || e.pts.length < 2) continue;
    const na = nodeById.get(e.a);
    const nb = nodeById.get(e.b);
    if (na === undefined || nb === undefined) continue;
    if (roads.nodes[na].elevation !== 0 || roads.nodes[nb].elevation !== 0) continue;
    zEdges.push(i);
  }
  if (zEdges.length === 0) return EMPTY_PREVIEW();
  zEdges.sort((a, b) => {
    const d = IMPORTANCE[roads.edges[b].cls as RoadClass] - IMPORTANCE[roads.edges[a].cls as RoadClass];
    return d !== 0 ? d : a - b;
  });

  // ---- chains: edges joined at degree-2 nodes with the same prefab share one corridor id
  const deg = new Map<number, number[]>();
  roads.edges.forEach((e, i) => {
    for (const nid of [e.a, e.b]) {
      let l = deg.get(nid);
      if (!l) deg.set(nid, (l = []));
      l.push(i);
    }
  });
  const parent = new Int32Array(roads.edges.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const l of deg.values()) {
    if (l.length === 2 && roads.edges[l[0]].prefab === roads.edges[l[1]].prefab) {
      parent[find(l[0])] = find(l[1]);
    }
  }
  const gidOf = (ei: number): number => (find(ei) % (MULTI - 1)) + 1;

  // ---- corridor grid: every non-tunnel edge (road or rail)
  const corr = new Uint16Array(NG * NG);
  for (let ei = 0; ei < roads.edges.length; ei++) {
    const e = roads.edges[ei];
    if (e.tunnel || e.pts.length < 2) continue;
    const gid = gidOf(ei);
    const r = PREFAB_WIDTH[e.prefab] / 2 + ROAD_MARGIN + G * 0.35;
    const r2 = r * r;
    for (let k = 0; k + 1 < e.pts.length; k++) {
      const ax = e.pts[k][0];
      const az = e.pts[k][1];
      const bx = e.pts[k + 1][0];
      const bz = e.pts[k + 1][1];
      const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - r + HALF) / G));
      const ix1 = Math.min(NG - 1, Math.floor((Math.max(ax, bx) + r + HALF) / G));
      const iz0 = Math.max(0, Math.floor((Math.min(az, bz) - r + HALF) / G));
      const iz1 = Math.min(NG - 1, Math.floor((Math.max(az, bz) + r + HALF) / G));
      for (let iz = iz0; iz <= iz1; iz++) {
        const cz = (iz + 0.5) * G - HALF;
        for (let ix = ix0; ix <= ix1; ix++) {
          const cx = (ix + 0.5) * G - HALF;
          if (segDist2(cx, cz, ax, az, bx, bz) <= r2) {
            const idx = iz * NG + ix;
            const v = corr[idx];
            if (v === 0) corr[idx] = gid;
            else if (v !== gid) corr[idx] = MULTI;
          }
        }
      }
    }
  }
  const claim = new Uint8Array(NG * NG);
  const centres = new Uint16Array(NG * NG); // 0x8000 | qx<<7 | qz, at most one centre per bucket

  // ---- terrain access
  const pg = terrain.playable;
  const hd = pg.data;
  const hs = pg.size;
  const hext = pg.extentM;
  const wm = terrain.waterMask;
  const sea = terrain.seaLevel;
  const texel = hext / hs;
  const hAt = (x: number, z: number): number => {
    let u = (x + hext / 2) / texel - 0.5;
    let v = (hext / 2 - z) / texel - 0.5;
    u = u < 0 ? 0 : u > hs - 1 ? hs - 1 : u;
    v = v < 0 ? 0 : v > hs - 1 ? hs - 1 : v;
    const u0 = Math.floor(u);
    const v0 = Math.floor(v);
    const u1 = Math.min(hs - 1, u0 + 1);
    const v1 = Math.min(hs - 1, v0 + 1);
    const fu = u - u0;
    const fv = v - v0;
    const a = hd[v0 * hs + u0] * (1 - fu) + hd[v0 * hs + u1] * fu;
    const b = hd[v1 * hs + u0] * (1 - fu) + hd[v1 * hs + u1] * fu;
    return a * (1 - fv) + b * fv;
  };
  const isWater = (x: number, z: number): boolean => {
    const c = Math.floor((x + hext / 2) / texel);
    const r = Math.floor((hext / 2 - z) / texel);
    if (c < 0 || r < 0 || c >= hs || r >= hs) return true;
    return wm[r * hs + c] !== 0;
  };
  const sd = Math.max(4, texel);

  // ---- land use raster (built-up evidence, kinds, density)
  const hasEvidence = !!landcover || !!vectors;
  const lu = new Uint8Array(hasEvidence ? NLU * NLU : 0);
  const built = new Uint8Array(hasEvidence ? NLU * NLU : 0);
  const dens = new Uint8Array(hasEvidence ? NLU * NLU : 0);
  if (hasEvidence) {
    if (vectors) rasterAreas(vectors.areas, lu);
    for (let r = 0; r < NLU; r++) {
      for (let c = 0; c < NLU; c++) {
        let b = lu[r * NLU + c] > 0 ? 1 : 0;
        if (!b && landcover) {
          const ext = landcover.extentM;
          const x = (c + 0.5) * LU - HALF;
          const z = HALF - (r + 0.5) * LU;
          const lc = Math.floor(((x + ext / 2) / ext) * landcover.size);
          const lr = Math.floor(((ext / 2 - z) / ext) * landcover.size);
          if (lc >= 0 && lr >= 0 && lc < landcover.size && lr < landcover.size) {
            if (landcover.data[lr * landcover.size + lc] === LC.Built) b = 1;
          }
        }
        built[r * NLU + c] = b;
      }
    }
    const W = NLU + 1;
    const S = new Uint32Array(W * W);
    for (let r = 0; r < NLU; r++) {
      let row = 0;
      for (let c = 0; c < NLU; c++) {
        row += built[r * NLU + c];
        S[(r + 1) * W + c + 1] = S[r * W + c + 1] + row;
      }
    }
    for (let r = 0; r < NLU; r++) {
      const r0 = Math.max(0, r - DENS_R);
      const r1 = Math.min(NLU, r + DENS_R + 1);
      for (let c = 0; c < NLU; c++) {
        const c0 = Math.max(0, c - DENS_R);
        const c1 = Math.min(NLU, c + DENS_R + 1);
        const sum = S[r1 * W + c1] - S[r0 * W + c1] - S[r1 * W + c0] + S[r0 * W + c0];
        dens[r * NLU + c] = Math.round((255 * sum) / ((r1 - r0) * (c1 - c0)));
      }
    }
  }
  const luIndex = (x: number, z: number): number => {
    const c = Math.floor((x + HALF) / LU);
    const r = Math.floor((HALF - z) / LU);
    if (c < 0 || r < 0 || c >= NLU || r >= NLU) return -1;
    return r * NLU + c;
  };

  // ---- outputs
  let cells = new Float32Array(1 << 14);
  let depth = new Uint8Array(1 << 12);
  let cellCount = 0;
  let lots = new Float32Array(7 * 4096);
  let lotKind = new Uint8Array(4096);
  let lotCount = 0;

  const OFF3 = [-3, 0, 3];
  const OFF2 = [-2, 0, 2];

  /** All terrain / overlap tests for one candidate cell; registers its centre when accepted. */
  const tryCell = (cx: number, cz: number, tx: number, tz: number, gid: number): boolean => {
    if (cx > HALF - MARGIN - 4 || cx < -HALF + MARGIN + 4 || cz > HALF - MARGIN - 4 || cz < -HALF + MARGIN + 4) return false;
    const nx = -tz;
    const nz = tx;
    // roads and rails
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const x = cx + tx * OFF3[a] + nx * OFF3[b];
        const z = cz + tz * OFF3[a] + nz * OFF3[b];
        const idx = Math.floor((z + HALF) / G) * NG + Math.floor((x + HALF) / G);
        const v = corr[idx];
        if (v !== 0 && v !== gid) return false;
      }
    }
    // water and terrain
    if (isWater(cx, cz)) return false;
    if (isWater(cx + 3 * tx + 3 * nx, cz + 3 * tz + 3 * nz)) return false;
    if (isWater(cx + 3 * tx - 3 * nx, cz + 3 * tz - 3 * nz)) return false;
    if (isWater(cx - 3 * tx + 3 * nx, cz - 3 * tz + 3 * nz)) return false;
    if (isWater(cx - 3 * tx - 3 * nx, cz - 3 * tz - 3 * nz)) return false;
    const h = hAt(cx, cz);
    if (h < sea + 0.3) return false;
    const gx = (hAt(cx + sd, cz) - hAt(cx - sd, cz)) / (2 * sd);
    const gz = (hAt(cx, cz + sd) - hAt(cx, cz - sd)) / (2 * sd);
    if (Math.sqrt(gx * gx + gz * gz) > MAX_SLOPE) return false;
    // cells claimed by earlier roads
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const x = cx + tx * OFF2[a] + nx * OFF2[b];
        const z = cz + tz * OFF2[a] + nz * OFF2[b];
        if (claim[Math.floor((z + HALF) / G) * NG + Math.floor((x + HALF) / G)]) return false;
      }
    }
    // cell centres must keep a minimum spacing (inside of bends, crossings)
    const bx = Math.floor((cx + HALF) / G);
    const bz = Math.floor((cz + HALF) / G);
    const min2 = (MIN_CENTRE_DIST + 0.2) * (MIN_CENTRE_DIST + 0.2);
    for (let dz = -2; dz <= 2; dz++) {
      const z2 = bz + dz;
      if (z2 < 0 || z2 >= NG) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const x2 = bx + dx;
        if (x2 < 0 || x2 >= NG) continue;
        const v = centres[z2 * NG + x2];
        if (v === 0) continue;
        const ox = (x2 + ((v >> 7) & 127) / 127) * G - HALF;
        const oz = (z2 + (v & 127) / 127) * G - HALF;
        const ddx = ox - cx;
        const ddz = oz - cz;
        if (ddx * ddx + ddz * ddz < min2) return false;
      }
    }
    const qx = Math.min(126, Math.floor(((cx + HALF) / G - bx) * 127));
    const qz = Math.min(126, Math.floor(((cz + HALF) / G - bz) * 127));
    centres[bz * NG + bx] = 0x8000 | (qx << 7) | qz;
    return true;
  };

  // scratch per edge
  let px = new Float64Array(64);
  let pz = new Float64Array(64);
  let tx = new Float64Array(64);
  let tz = new Float64Array(64);
  let cum = new Float64Array(64);

  const COS_BEND = Math.cos((25 * Math.PI) / 180);

  for (const ei of zEdges) {
    const e = roads.edges[ei];
    const gid = gidOf(ei);
    const halfW = PREFAB_WIDTH[e.prefab] / 2;
    const pts = e.pts;
    const np = pts.length;
    if (cum.length < np) cum = new Float64Array(np * 2);
    cum[0] = 0;
    for (let k = 1; k < np; k++) {
      cum[k] = cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    }
    const L = cum[np - 1];
    const nSt = L >= 2 * CELL ? Math.floor((L - 4 - 4) / CELL) + 1 : 0;
    if (nSt <= 0) continue;
    if (px.length < nSt) {
      const m = nSt * 2;
      px = new Float64Array(m); pz = new Float64Array(m); tx = new Float64Array(m); tz = new Float64Array(m);
    }
    // position along the polyline
    let seg = 0;
    const posAt = (s: number, out: number[]): void => {
      // binary search is unnecessary: stations are queried near-monotonically, so walk both ways
      if (s <= 0) { out[0] = pts[0][0]; out[1] = pts[0][1]; return; }
      if (s >= L) { out[0] = pts[np - 1][0]; out[1] = pts[np - 1][1]; return; }
      while (seg > 0 && cum[seg] > s) seg--;
      while (seg < np - 2 && cum[seg + 1] < s) seg++;
      const l = cum[seg + 1] - cum[seg];
      const t = l > 0 ? (s - cum[seg]) / l : 0;
      out[0] = pts[seg][0] + t * (pts[seg + 1][0] - pts[seg][0]);
      out[1] = pts[seg][1] + t * (pts[seg + 1][1] - pts[seg][1]);
    };
    const a0 = [0, 0];
    const a1 = [0, 0];
    const a2 = [0, 0];
    for (let i = 0; i < nSt; i++) {
      const s = 4 + CELL * i;
      posAt(s, a0);
      posAt(s - 3, a1);
      posAt(s + 3, a2);
      let dx = a2[0] - a1[0];
      let dz = a2[1] - a1[1];
      const l = Math.hypot(dx, dz);
      if (l < 1e-9) { dx = 1; dz = 0; } else { dx /= l; dz /= l; }
      px[i] = a0[0]; pz[i] = a0[1]; tx[i] = dx; tz[i] = dz;
    }

    const cellStart = cellCount;
    const kLots = (side: number, sideDep: Uint8Array, sideBlt: Uint8Array): void => {
      let i = 0;
      while (i < nSt) {
        if (sideDep[i] < 2 || !sideBlt[i]) { i++; continue; }
        // kind from the first station's row-0 centre
        const lat0 = halfW + CELL / 2;
        const c0x = px[i] - tz[i] * side * lat0;
        const c0z = pz[i] + tx[i] * side * lat0;
        const li = luIndex(c0x, c0z);
        const d01 = li >= 0 ? dens[li] / 255 : 0;
        const poly = li >= 0 ? lu[li] : 0;
        const big = e.prefab.startsWith('road_medium') || e.prefab.startsWith('road_large');
        const r5 = hash3(e.id, side * 100003 + i, 5);
        let kind = 0;
        if (poly === 3) kind = 3;
        else if (poly === 2) kind = 2;
        else if (d01 >= 0.45 && big && r5 < 0.6) kind = 2;
        else if (d01 >= 0.55) kind = 1;
        const r1 = hash3(e.id, side * 100003 + i, 1);
        const r2 = hash3(e.id, side * 100003 + i, 2);
        let wT: number;
        let dT: number;
        switch (kind) {
          case 1: wT = 3 + Math.floor(r1 * 3); dT = 3 + Math.floor(r2 * 3); break;
          case 2: wT = 3 + Math.floor(r1 * 4); dT = 2 + Math.floor(r2 * 3); break;
          case 3: wT = 4 + Math.floor(r1 * 3); dT = 4 + Math.floor(r2 * 3); break;
          default: wT = 2 + Math.floor(r1 * 2); dT = 2 + Math.floor(r2 * 3); break;
        }
        let j = i;
        let minDep = ROWS;
        while (j < nSt && j - i < wT && sideDep[j] >= 2 && sideBlt[j]
          && tx[i] * tx[j] + tz[i] * tz[j] >= COS_BEND) {
          if (sideDep[j] < minDep) minDep = sideDep[j];
          j++;
        }
        const w = j - i;
        if (w < 2) { i++; continue; }
        const d = Math.min(dT, minDep);
        if (hash3(e.id, side * 100003 + i, 3) < 0.15) { i = j; continue; }
        let mx = 0, mz = 0, mtx = 0, mtz = 0;
        for (let q = i; q < j; q++) { mx += px[q]; mz += pz[q]; mtx += tx[q]; mtz += tz[q]; }
        mx /= w; mz /= w;
        const tl = Math.hypot(mtx, mtz) || 1;
        mtx /= tl; mtz /= tl;
        const lat = halfW + (CELL * d + 1.5) / 2;
        const cxl = mx - mtz * side * lat;
        const czl = mz + mtx * side * lat;
        const r4 = hash3(e.id, side * 100003 + i, 4);
        let height: number;
        switch (kind) {
          case 1: height = 12 + r4 * (6 + 12 * d01); break;
          case 2: height = 8 + r4 * 17; break;
          case 3: height = 8 + r4 * 6; break;
          default: height = 5 + r4 * 4; break;
        }
        if (lotCount >= lotKind.length) lotKind = growU8(lotKind, lotCount + 1);
        lots = growF32(lots, (lotCount + 1) * 7);
        const o = lotCount * 7;
        lots[o] = cxl; lots[o + 1] = czl; lots[o + 2] = mtx; lots[o + 3] = mtz;
        lots[o + 4] = w * CELL - 3; lots[o + 5] = CELL * d - 4.5; lots[o + 6] = height;
        lotKind[lotCount] = kind;
        lotCount++;
        i = j;
      }
    };

    // cells, station by station, both sides
    const depL = new Uint8Array(nSt);
    const depR = new Uint8Array(nSt);
    const bltL = new Uint8Array(nSt);
    const bltR = new Uint8Array(nSt);
    for (let i = 0; i < nSt; i++) {
      for (let sd2 = 0; sd2 < 2; sd2++) {
        const side = sd2 === 0 ? 1 : -1;
        const nxs = -tz[i] * side;
        const nzs = tx[i] * side;
        let k = 0;
        for (; k < ROWS; k++) {
          const lat = halfW + CELL / 2 + CELL * k;
          const cx = px[i] + nxs * lat;
          const cz = pz[i] + nzs * lat;
          if (!tryCell(cx, cz, tx[i], tz[i], gid)) break;
          if (cellCount * 4 + 4 > cells.length) cells = growF32(cells, cellCount * 4 + 4);
          if (cellCount >= depth.length) depth = growU8(depth, cellCount + 1);
          const o = cellCount * 4;
          cells[o] = cx; cells[o + 1] = cz; cells[o + 2] = tx[i]; cells[o + 3] = tz[i];
          depth[cellCount] = k;
          cellCount++;
          if (k === 0 && hasEvidence) {
            const li = luIndex(cx, cz);
            if (li >= 0 && built[li]) (side > 0 ? bltL : bltR)[i] = 1;
          }
        }
        (side > 0 ? depL : depR)[i] = k;
      }
    }

    // claim this edge's cells for the later (less important) edges
    for (let c = cellStart; c < cellCount; c++) {
      const cx = cells[c * 4];
      const cz = cells[c * 4 + 1];
      const dx = cells[c * 4 + 2];
      const dz = cells[c * 4 + 3];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          const x = cx + dx * OFF2[a] - dz * OFF2[b];
          const z = cz + dz * OFF2[a] + dx * OFF2[b];
          claim[Math.floor((z + HALF) / G) * NG + Math.floor((x + HALF) / G)] = 1;
        }
      }
    }

    if (hasEvidence) {
      kLots(1, depL, bltL);
      kLots(-1, depR, bltR);
    }
  }

  // ---- cap lots by uniform thinning
  let outLots: Float32Array<ArrayBuffer>;
  let outKind: Uint8Array<ArrayBuffer>;
  let outCount: number;
  if (lotCount > MAX_LOTS) {
    outLots = new Float32Array(MAX_LOTS * 7);
    outKind = new Uint8Array(MAX_LOTS);
    for (let i = 0; i < MAX_LOTS; i++) {
      const src = Math.floor((i * lotCount) / MAX_LOTS);
      outLots.set(lots.subarray(src * 7, src * 7 + 7), i * 7);
      outKind[i] = lotKind[src];
    }
    outCount = MAX_LOTS;
  } else {
    outLots = lots.slice(0, lotCount * 7);
    outKind = lotKind.slice(0, lotCount);
    outCount = lotCount;
  }

  return {
    cellCount,
    cells: cells.slice(0, cellCount * 4),
    cellDepth: depth.slice(0, cellCount),
    lotCount: outCount,
    lots: outLots,
    lotKind: outKind,
  };
}
