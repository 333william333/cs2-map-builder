/**
 * three.js object builders for the 3D preview. Each builder returns a self-contained Object3D that
 * owns its geometries/materials (see `disposeObject`). Shared GPU resources (height and landcover
 * textures) live in `GpuShared` and are disposed by the engine. Scene frame: x = gx, y = height, z = -gz.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CS2, type BuildResult, type OutsideConnection, type RoadClass } from '../../core/types';
import { downsampleMean, waterGrids, type LevelGrid } from './gameWater';
import type { Atmosphere } from './atmosphere';
import { bridgeStructures, houseInstances, treeLook, type TreeLook } from './instances';
import { buildRoadScene, ROAD_SURFACE_LIFT, type Portal, type RoadScene } from './roadNetwork';
import {
  heightUniforms,
  makeHouseMaterial,
  makeLitMaterial,
  makeRoadMaterial,
  makeTunnelMaterial,
  meshGroundHeight,
  makeTerrainMaterial,
  makeWaterMaterial,
  cellGroundHeight,
  floatTexture,
  makeZoneMaterial,
  vertexGridTexture,
  weightsTexture,
} from './materials';
import { buildRibbons, hexToLinear, roadRibbonStyle, CLASS_PREFAB, type RibbonGeometry, type RibbonInput } from './roadRibbons';
import { groundWeights, nearWaterLevel, terrainAO, type GroundWeights } from './terrainFields';
import { snowLineGame } from './terrainColor';
import {
  alignedWorldVertexCount,
  buildGridIndices,
  buildGridPositions,
  computeNormals,
  decimateHeightGrid,
  meshHeightAt,
  resampleToVertices,
  type VertexGrid,
} from './terrainGrid';
import { buildWaterIndices, computeWaterSurface, type WaterSurface } from './waterSurface';

export const MAX_PLAYABLE_VERTS = 513;
export const MAX_WORLD_CELLS = 256;
export const MAX_TREES = 250_000;
/** Shore band carried this many vertices away from water (x ~28 m at draft resolution). */
const SHORE_RINGS = 6;

export interface Prepared {
  result: BuildResult;
  seaLevel: number;
  snowLine: number;
  playV: VertexGrid;
  playN: Float32Array;
  worldV: VertexGrid;
  worldN: Float32Array;
  surface: WaterSurface;
  /** water depth per playable vertex */
  playDepth: Float32Array;
  /** nearest water level per playable vertex (NaN far from water) */
  nearLevel: Float32Array;
  /** per playable vertex: [heightAboveWater, waterDepth, ao, 0] */
  playInfo: Float32Array;
  worldInfo: Float32Array;
  weights: GroundWeights;
  /** average playable height, used to aim the camera */
  meanHeight: number;
  groundAt(x: number, z: number): number;
}

/**
 * Per-vertex terrain shader inputs: [height above nearest water, water depth, ao, sea (1) or
 * inland water (0)]. `sea` < Infinity marks water at that level as sea (sandy beaches).
 */
export function infoArray(v: VertexGrid, depth: Float32Array, level: Float32Array, ao: Float32Array, sea: number): Float32Array {
  const n = v.n * v.n;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const lv = level[i];
    out[i * 4] = lv === lv ? v.data[i] - lv : 999;
    out[i * 4 + 1] = depth[i];
    out[i * 4 + 2] = ao[i];
    out[i * 4 + 3] = lv === lv && Math.abs(lv - sea) < 0.3 ? 1 : 0;
  }
  return out;
}

export function prepareResult(result: BuildResult): Prepared {
  const t = result.terrain;
  const seaLevel = t.seaLevel;
  const playV = decimateHeightGrid(t.playable, MAX_PLAYABLE_VERTS);
  const playN = computeNormals(playV);

  const wn = alignedWorldVertexCount(t.world.extentM, t.playable.extentM, MAX_WORLD_CELLS);
  const worldV: VertexGrid = {
    n: wn,
    extentM: t.world.extentM,
    data: resampleToVertices(t.world.data, t.world.size, wn, 'mean'),
  };
  const worldN = computeNormals(worldV);

  const mask = t.waterMask.length === t.playable.size * t.playable.size
    ? resampleToVertices(t.waterMask, t.playable.size, playV.n, 'max')
    : new Float32Array(playV.n * playV.n);
  const surface = computeWaterSurface(playV, mask, seaLevel);
  const playDepth = new Float32Array(playV.n * playV.n);
  for (let i = 0; i < playDepth.length; i++) {
    if (surface.wet[i]) playDepth[i] = Math.max(0, surface.level[i] - playV.data[i]);
  }
  const nearLevel = nearWaterLevel(playV, surface, SHORE_RINGS);
  const seaMark = t.hasSea ? seaLevel : Infinity;
  const playInfo = infoArray(playV, playDepth, nearLevel, terrainAO(playV), seaMark);

  const wDepth = new Float32Array(wn * wn);
  const wLevel = new Float32Array(wn * wn).fill(t.hasSea ? seaLevel : NaN);
  for (let i = 0; i < wDepth.length; i++) wDepth[i] = Math.max(0, seaLevel - worldV.data[i]);
  const worldInfo = infoArray(worldV, wDepth, wLevel, terrainAO(worldV), seaMark);

  const lcSize = result.landcover?.size ?? 0;
  const wSize = Math.max(256, Math.min(1024, lcSize > 0 ? lcSize : 512));
  const weights = groundWeights(t.playable.extentM, wSize, result.landcover, result.trees, 1);

  let sum = 0;
  let cnt = 0;
  const step = Math.max(1, Math.floor(playV.n / 64));
  for (let r = 0; r < playV.n; r += step) {
    for (let c = 0; c < playV.n; c += step) {
      sum += playV.data[r * playV.n + c];
      cnt++;
    }
  }

  const half = t.playable.extentM / 2;
  return {
    result,
    seaLevel,
    snowLine: snowLineGame(result.climate, seaLevel, t.scale.vertical),
    playV,
    playN,
    worldV,
    worldN,
    surface,
    playDepth,
    nearLevel,
    playInfo,
    worldInfo,
    weights,
    meanHeight: cnt > 0 ? sum / cnt : seaLevel,
    groundAt(x, z) {
      if (Math.abs(x) <= half && Math.abs(z) <= half) return meshHeightAt(playV, x, z);
      return meshHeightAt(worldV, x, z);
    },
  };
}

// ---------------------------------------------------------------- shared GPU resources

export interface GpuShared {
  heightTex: THREE.DataTexture;
  height: Record<string, THREE.IUniform>;
  weightsA: THREE.DataTexture;
  weightsB: THREE.DataTexture;
  dispose(): void;
}

export function createGpuShared(p: Prepared, heightGrid?: VertexGrid): GpuShared {
  const hv = heightGrid ?? p.playV;
  const heightTex = vertexGridTexture(hv);
  const weightsA = weightsTexture(p.weights.a, p.weights.size);
  const weightsB = weightsTexture(p.weights.b, p.weights.size);
  return {
    heightTex,
    height: heightUniforms(heightTex, hv),
    weightsA,
    weightsB,
    dispose() {
      heightTex.dispose();
      weightsA.dispose();
      weightsB.dispose();
    },
  };
}

export interface BuildCtx {
  p: Prepared;
  atm: Atmosphere;
  gpu: GpuShared;
  /** 2 tan(fov/2) / viewport height in px: world metres per pixel per metre of distance */
  pxScale: THREE.IUniform<number>;
  /** 1 tints the quick preview ground by land cover (reference only) */
  landcover?: THREE.IUniform<number>;
}

// ---------------------------------------------------------------- helpers

export function disposeObject(o: THREE.Object3D | null | undefined): void {
  if (!o) return;
  o.traverse((c) => {
    for (const t of (c.userData.textures as THREE.Texture[] | undefined) ?? []) t.dispose();
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
    const im = c as THREE.InstancedMesh;
    if (im.isInstancedMesh) im.dispose();
  });
  o.removeFromParent();
}

export function terrainGeometry(v: VertexGrid, normals: Float32Array, info: Float32Array, index: Uint32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(buildGridPositions(v), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

function ribbonMesh(geo: RibbonGeometry, material: THREE.Material): THREE.Mesh | null {
  if (geo.vertexCount === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
  const normals = new Float32Array(geo.vertexCount * 3);
  for (let i = 0; i < geo.vertexCount; i++) normals[i * 3 + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(geo.colors, 3));
  g.setIndex(new THREE.BufferAttribute(geo.indices, 1));
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, material);
  m.frustumCulled = false;
  return m;
}

// ---------------------------------------------------------------- terrain

export function buildTerrainMesh(ctx: BuildCtx): THREE.Mesh {
  const { p } = ctx;
  const idx = buildGridIndices(p.playV.n);
  const mat = makeTerrainMaterial(ctx.atm, {
    weightsA: ctx.gpu.weightsA,
    weightsB: ctx.gpu.weightsB,
    weightsSize: p.weights.size,
    playExtent: p.result.terrain.playable.extentM,
    snowLine: p.snowLine,
    landcover: ctx.landcover,
    key: 'play',
  });
  const mesh = new THREE.Mesh(terrainGeometry(p.playV, p.playN, p.playInfo, idx), mat);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}

export function buildWorldMesh(ctx: BuildCtx): THREE.Mesh {
  const { p } = ctx;
  const v = p.worldV;
  const n = v.n;
  const d = v.extentM / (n - 1);
  const half = v.extentM / 2;
  const ph = p.result.terrain.playable.extentM / 2;
  const eps = d * 1e-3;
  const inside = (x: number, z: number): boolean => x >= -ph - eps && x <= ph + eps && z >= -ph - eps && z <= ph + eps;

  // quads whose four corners all lie on/inside the playable footprint are covered by the detailed mesh
  const idx = buildGridIndices(n, (r, c) => {
    const x0 = -half + c * d;
    const z0 = -half + r * d;
    return inside(x0, z0) && inside(x0 + d, z0 + d);
  });
  const geo = terrainGeometry(v, p.worldN, p.worldInfo, idx);
  // seal cracks: border vertices follow the playable mesh
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = -half + c * d;
      const z = -half + r * d;
      if (!inside(x, z)) continue;
      const onEdge = Math.abs(Math.abs(x) - ph) < eps || Math.abs(Math.abs(z) - ph) < eps;
      if (onEdge) pos.setY(r * n + c, meshHeightAt(p.playV, x, z) - 0.3);
    }
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();

  const mat = makeTerrainMaterial(ctx.atm, {
    weightsA: null,
    weightsB: null,
    weightsSize: 1,
    playExtent: p.result.terrain.playable.extentM,
    snowLine: p.snowLine,
    edgeFade: [half * 0.45, half * 0.96],
    key: 'world',
  });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 1;
  mat.polygonOffsetUnits = 1;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'world';
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------- water

function waterGeometry(v: VertexGrid, level: Float32Array, depth: Float32Array, index: Uint32Array): THREE.BufferGeometry {
  const n = v.n;
  const lv: VertexGrid = { n, extentM: v.extentM, data: level };
  const pos = buildGridPositions(lv);
  // NaN levels only occur in quads that are not drawn; keep positions finite anyway
  for (let i = 0; i < n * n; i++) if (!Number.isFinite(pos[i * 3 + 1])) pos[i * 3 + 1] = 0;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/** Local water over the playable area (sea, lakes, rivers) plus the sea over the world backdrop. */
/** Mesh over a level grid: vertices at cell centres, the outer ring snapped to the grid edge. */
export function levelGridGeometry(grid: LevelGrid, depthOf?: (x: number, z: number, level: number) => number): THREE.BufferGeometry | null {
  const { n, extentM: E } = grid;
  const L = grid.level;
  const cell = E / n;
  const coord = (i: number): number => (i === 0 ? -E / 2 : i === n - 1 ? E / 2 : -E / 2 + (i + 0.5) * cell);
  const idx: number[] = [];
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const i = r * n + c;
      if (L[i] !== L[i] || L[i + 1] !== L[i + 1] || L[i + n] !== L[i + n] || L[i + n + 1] !== L[i + n + 1]) continue;
      idx.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
    }
  }
  if (idx.length === 0) return null;
  const pos = new Float32Array(n * n * 3);
  const depth = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const x = coord(c);
      const z = coord(r);
      const lv = L[i] === L[i] ? L[i] : 0;
      pos[i * 3] = x;
      pos[i * 3 + 1] = lv;
      pos[i * 3 + 2] = z;
      depth[i] = depthOf && L[i] === L[i] ? depthOf(x, z, lv) : 0;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Water from the build's own per-cell levels (newer builds): one sea surface over playable and
 * world alike, and lakes / rivers that continue across the playable border at the same level.
 */
function buildWaterFromFields(ctx: BuildCtx, hq: boolean): THREE.Group {
  const { p } = ctx;
  const t = p.result.terrain;
  const group = new THREE.Group();
  group.name = 'water';
  const ph = t.playable.extentM / 2;
  const wHalf = t.world.extentM / 2;
  const fade: [number, number] = [wHalf * 0.45, wHalf * 0.96];
  const grids = waterGrids(t, p.result.waterSources, 1024, 512);
  // shorelines from the full-resolution grids, so they are as crisp as in the game view
  const ps = Math.min(2048, t.playable.size);
  const ws = Math.min(1024, t.world.size);
  const playTex = floatTexture(downsampleMean(t.playable.data, t.playable.size, ps), ps);
  const worldTex = floatTexture(downsampleMean(t.world.data, t.world.size, ws), ws);
  group.userData.textures = [playTex, worldTex];
  const ground = cellGroundHeight(playTex, ps, t.playable.extentM, worldTex, ws, t.world.extentM);
  if (t.hasSea) {
    const w = p.worldV;
    const n = w.n;
    const sea = p.seaLevel;
    const h = w.data;
    const idx = buildGridIndices(n, (r, c) => {
      const i = r * n + c;
      return !(h[i] < sea + 2 || h[i + 1] < sea + 2 || h[i + n] < sea + 2 || h[i + n + 1] < sea + 2);
    });
    if (idx.length > 0) {
      const level = new Float32Array(n * n).fill(sea);
      const depth = new Float32Array(n * n);
      for (let i = 0; i < n * n; i++) depth[i] = sea - h[i];
      const m = new THREE.Mesh(waterGeometry(w, level, depth, idx), makeWaterMaterial(ctx.atm, ground, { hq, edgeFade: fade }));
      m.renderOrder = 2;
      m.frustumCulled = false;
      group.add(m);
    }
  }
  const play = levelGridGeometry(grids.play);
  if (play) {
    const m = new THREE.Mesh(play, makeWaterMaterial(ctx.atm, ground, { hq, clipOutside: ph }));
    m.renderOrder = 2;
    m.frustumCulled = false;
    group.add(m);
  }
  if (grids.world) {
    const wg = levelGridGeometry(grids.world);
    if (wg) {
      const m = new THREE.Mesh(wg, makeWaterMaterial(ctx.atm, ground, { hq, edgeFade: fade, clipInside: ph }));
      m.renderOrder = 2;
      m.frustumCulled = false;
      group.add(m);
    }
  }
  return group;
}

export function buildWater(ctx: BuildCtx, hq = false): THREE.Group {
  const { p } = ctx;
  if (p.result.terrain.waterLevel) return buildWaterFromFields(ctx, hq);
  const group = new THREE.Group();
  group.name = 'water';

  if (p.surface.hasWater) {
    const v = p.playV;
    const idx = buildWaterIndices(v.n, p.surface.level);
    if (idx.length > 0) {
      const mesh = new THREE.Mesh(
        waterGeometry(v, p.surface.level, p.playDepth, idx),
        makeWaterMaterial(ctx.atm, meshGroundHeight(ctx.gpu.height), { hq }),
      );
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }

  // world backdrop: sea at sea level wherever the backdrop is lower
  const w = p.worldV;
  const n = w.n;
  const d = w.extentM / (n - 1);
  const half = w.extentM / 2;
  const ph = p.result.terrain.playable.extentM / 2;
  const eps = d * 1e-3;
  const inside = (x: number, z: number): boolean => x >= -ph - eps && x <= ph + eps && z >= -ph - eps && z <= ph + eps;
  const h = w.data;
  const sea = p.seaLevel;
  const idx = buildGridIndices(n, (r, c) => {
    const x0 = -half + c * d;
    const z0 = -half + r * d;
    if (inside(x0, z0) && inside(x0 + d, z0 + d)) return true;
    const i = r * n + c;
    return !(h[i] < sea - 0.05 || h[i + 1] < sea - 0.05 || h[i + n] < sea - 0.05 || h[i + n + 1] < sea - 0.05);
  });
  if (idx.length > 0) {
    const level = new Float32Array(n * n).fill(sea);
    const depth = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) depth[i] = Math.max(0, sea - h[i]);
    const mesh = new THREE.Mesh(
      waterGeometry(w, level, depth, idx),
      makeWaterMaterial(ctx.atm, null, { hq, edgeFade: [half * 0.45, half * 0.96] }),
    );
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}

// ---------------------------------------------------------------- roads

/** Ribbon geometry with the extra attributes the road shader needs. */
function roadGeometry(geo: RibbonGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
  const normals = new Float32Array(geo.vertexCount * 3);
  for (let i = 0; i < geo.vertexCount; i++) normals[i * 3 + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('aRoadUv', new THREE.BufferAttribute(geo.uvs, 2));
  g.setAttribute('aRoadP', new THREE.BufferAttribute(geo.params, 4));
  // offset from the ribbon centre line, per vertex (vertices come in left/right pairs)
  const off = new Float32Array(geo.vertexCount * 3);
  const P = geo.positions;
  for (let i = 0; i + 1 < geo.vertexCount; i += 2) {
    const a = i * 3, b = a + 3;
    const hx = (P[a] - P[b]) / 2, hy = (P[a + 1] - P[b + 1]) / 2, hz = (P[a + 2] - P[b + 2]) / 2;
    off[a] = hx; off[a + 1] = hy; off[a + 2] = hz;
    off[b] = -hx; off[b + 1] = -hy; off[b + 2] = -hz;
  }
  g.setAttribute('aCenterOff', new THREE.BufferAttribute(off, 3));
  g.setIndex(new THREE.BufferAttribute(geo.indices, 1));
  g.computeBoundingSphere();
  return g;
}

export interface RoadGroupOptions {
  maxStep?: number;
  keep?: (x: number, z: number) => boolean;
  key?: string;
}

/** Portal frames (two walls and a lintel) where roads enter the ground. */
function portalGeometry(portals: Portal[]): THREE.BufferGeometry | null {
  if (portals.length === 0) return null;
  const parts: THREE.BufferGeometry[] = [];
  for (const pt of portals) {
    const w = pt.width + 3;
    const hgt = 7.5;
    const t = 1.6;
    const yaw = Math.atan2(pt.dx, pt.dz);
    const add = (sx: number, sy: number, sz: number, ox: number, oy: number): void => {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate(ox, oy, 0);
      g.rotateY(yaw);
      g.translate(pt.x, pt.y, pt.z);
      g.deleteAttribute('uv');
      parts.push(g);
    };
    add(t, hgt, 3, -w / 2, hgt / 2 - 1);
    add(t, hgt, 3, w / 2, hgt / 2 - 1);
    add(w + t, 1.8, 3.2, 0, hgt - 0.1);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged;
}

function attrGeometry(positions: Float32Array, uvs: Float32Array, params: Float32Array, count: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('aRoadUv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('aRoadP', new THREE.BufferAttribute(params, 4));
  g.setAttribute('aCenterOff', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * Roads of a network as drawable pieces: ribbons trimmed at junctions, one junction surface per
 * node, bridge girders and piers, tunnel portals and (child named 'tunnels') dashed guides along
 * underground stretches. Falls back to raw OSM ways when there is no processed network.
 */
export function buildRoadGroup(
  result: BuildResult,
  heightAt: (x: number, z: number) => number,
  atm: Atmosphere,
  pxScale: THREE.IUniform<number>,
  opts: RoadGroupOptions = {},
): { group: THREE.Group; scene: RoadScene | null } | null {
  let scene: RoadScene | null = null;
  let ribbons: RibbonInput[] = [];
  if (result.roads && result.roads.edges.length > 0) {
    scene = buildRoadScene(result.roads, heightAt, { keep: opts.keep });
    ribbons = scene.ribbons;
  } else if (result.vectors && result.vectors.ways.length > 0) {
    for (const w of result.vectors.ways) {
      if (w.tunnel || w.cls === 'subway' || w.pts.length < 2) continue;
      const st = roadRibbonStyle(w.cls as RoadClass, CLASS_PREFAB[w.cls as RoadClass]);
      st.lift = ROAD_SURFACE_LIFT;
      ribbons.push({ pts: w.pts, style: st });
    }
  }
  if (ribbons.length === 0) return null;
  const group = new THREE.Group();
  group.name = 'roads';
  const key = opts.key ?? 'road';
  const roadMat = makeRoadMaterial(atm, pxScale, key);
  const geo = buildRibbons(ribbons, heightAt, { maxStep: opts.maxStep ?? 24 });
  if (geo.vertexCount > 0) {
    const mesh = new THREE.Mesh(roadGeometry(geo), roadMat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  if (scene && scene.junctions.vertexCount > 0) {
    const j = scene.junctions;
    const m = new THREE.Mesh(attrGeometry(j.positions, j.uvs, j.params, j.vertexCount), makeRoadMaterial(atm, pxScale, key));
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.renderOrder = 1;
    m.name = 'junctions';
    group.add(m);
  }
  if (scene && scene.bridges.length > 0) {
    const md = bridgeStructures(scene.bridges, heightAt);
    if (md.indices.length > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(md.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(md.normals, 3));
      g.setIndex(new THREE.BufferAttribute(md.indices, 1));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, makeLitMaterial(atm, `bridge-${key}`, { color: 0x9a9893 }));
      m.castShadow = true;
      m.receiveShadow = true;
      m.name = 'bridges';
      group.add(m);
    }
  }
  const pg = scene ? portalGeometry(scene.portals) : null;
  if (pg) {
    const m = new THREE.Mesh(pg, makeLitMaterial(atm, `portal-${key}`, { color: 0xa3a19b }));
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'portals';
    group.add(m);
  }
  if (scene && scene.underground.length > 0) {
    const inputs: RibbonInput[] = scene.underground.map((u) => ({
      pts: u.pts,
      style: { width: u.width * 0.5, color: [1, 1, 1] as const, lift: 0.8, params: [u.width / 4, 0, 0, 0] as const },
    }));
    const tg = buildRibbons(inputs, heightAt, { maxStep: opts.maxStep ?? 24 });
    if (tg.vertexCount > 0) {
      const m = new THREE.Mesh(roadGeometry(tg), makeTunnelMaterial(atm, pxScale));
      m.frustumCulled = false;
      m.renderOrder = 4;
      m.name = 'tunnels';
      group.add(m);
    }
  }
  return { group, scene };
}

export function buildRoads(ctx: BuildCtx, opts: RoadGroupOptions = {}): THREE.Group | null {
  return buildRoadGroup(ctx.p.result, ctx.p.groundAt, ctx.atm, ctx.pxScale, opts)?.group ?? null;
}

// ---------------------------------------------------------------- trees

/** Gives a geometry a vertical colour gradient (dark bottom, light top) for cheap crown shading. */
function shadeVertical(g: THREE.BufferGeometry, y0: number, y1: number, dark: number, light: number, tint?: [number, number, number]): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - y0) / (y1 - y0)));
    const k = dark + (light - dark) * t;
    col[i * 3] = k * (tint ? tint[0] : 1);
    col[i * 3 + 1] = k * (tint ? tint[1] : 1);
    col[i * 3 + 2] = k * (tint ? tint[2] : 1);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function cone(r: number, y0: number, y1: number, sides: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, y1 - y0, sides, 1, false).toNonIndexed();
  g.translate(0, (y0 + y1) / 2, 0);
  g.deleteAttribute('uv');
  return g;
}

function blob(r: number, ry: number, x: number, y: number, z: number, detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.scale(r, ry, r);
  g.translate(x, y, z);
  g.deleteAttribute('uv');
  return g;
}

function trunk(r: number, h: number, sides: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r * 0.7, r, h, sides, 1, true).toNonIndexed();
  g.translate(0, h / 2, 0);
  g.deleteAttribute('uv');
  return g;
}

const BARK: [number, number, number] = [0.55, 0.42, 0.42];

/**
 * Unit tree shapes: height 1, crown radius 1 (scaled per instance). `hq` = render quality.
 */
export function treeGeometry(kind: 'conifer' | 'broadleaf', hq: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (kind === 'conifer') {
    const sides = hq ? 9 : 6;
    if (hq) {
      parts.push(shadeVertical(trunk(0.09, 0.3, 5), 0, 0.3, 0.35, 0.45, BARK));
      const layers = [[1.0, 0.12, 0.5], [0.82, 0.3, 0.66], [0.62, 0.48, 0.82], [0.4, 0.66, 1.0]];
      for (const [r, a, b] of layers) parts.push(shadeVertical(cone(r, a, b, sides), a, b, 0.55, 1.05));
    } else {
      parts.push(shadeVertical(cone(1, 0.06, 0.72, sides), 0.06, 0.72, 0.55, 0.95));
      parts.push(shadeVertical(cone(0.68, 0.42, 1.0, sides), 0.42, 1.0, 0.75, 1.08));
    }
  } else if (hq) {
    parts.push(shadeVertical(trunk(0.07, 0.45, 5), 0, 0.45, 0.35, 0.45, BARK));
    const blobs: [number, number, number, number, number][] = [
      [0.72, 0.36, 0, 0.6, 0], [0.55, 0.3, 0.42, 0.55, 0.18], [0.52, 0.28, -0.36, 0.58, 0.26],
      [0.5, 0.3, 0.1, 0.56, -0.44], [0.5, 0.28, -0.05, 0.82, 0.05],
    ];
    for (const [r, ry, x, y, z] of blobs) parts.push(shadeVertical(blob(r, ry, x, y, z, 1), 0.3, 1.0, 0.5, 1.1));
  } else {
    parts.push(shadeVertical(trunk(0.08, 0.35, 4), 0, 0.35, 0.35, 0.45, BARK));
    parts.push(shadeVertical(blob(0.95, 0.4, 0, 0.6, 0, 0), 0.2, 1.0, 0.55, 1.0));
    parts.push(shadeVertical(blob(0.6, 0.26, 0.2, 0.8, -0.15, 0), 0.55, 1.05, 0.8, 1.1));
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  if (!merged) throw new Error('tree geometry');
  merged.computeVertexNormals();
  return merged;
}

export interface TreeBuildOptions {
  hq?: boolean;
  /** drop trees (scene x, z) */
  keep?: (x: number, z: number) => boolean;
  /** use the detailed shapes only within this distance of `near` (scene coords) */
  near?: THREE.Vector3;
  nearDist?: number;
  key?: string;
}

/** Instanced trees at true game size with per-instance colour variation. */
export function buildTrees(ctx: BuildCtx, opts: TreeBuildOptions = {}): THREE.Group | null {
  const { p } = ctx;
  const trees = p.result.trees;
  if (!trees || trees.count === 0) return null;
  const total = Math.min(trees.count, MAX_TREES);
  // buckets: [conifer quick, broad quick, conifer hq, broad hq]
  const buckets: number[][] = [[], [], [], []];
  const wet = p.surface.wet;
  const v = p.playV;
  const dv = v.extentM / (v.n - 1);
  const nd2 = (opts.nearDist ?? 0) ** 2;
  for (let k = 0; k < total; k++) {
    const i = total === trees.count ? k : Math.floor((k * trees.count) / total);
    const x = trees.xz[i * 2];
    const z = -trees.xz[i * 2 + 1];
    if (opts.keep && !opts.keep(x, z)) continue;
    const c = Math.round((x + v.extentM / 2) / dv);
    const r = Math.round((z + v.extentM / 2) / dv);
    if (c >= 0 && r >= 0 && c < v.n && r < v.n && wet[r * v.n + c] && p.playDepth[r * v.n + c] > 0.4) continue;
    const sp = trees.speciesTable[trees.species[i]];
    const con = sp === 'pine' || sp === 'spruce' ? 0 : 1;
    let hq = !!opts.hq;
    if (hq && opts.near && nd2 > 0) {
      const dx = x - opts.near.x, dz = z - opts.near.z;
      hq = dx * dx + dz * dz < nd2;
    }
    buckets[con + (hq ? 2 : 0)].push(i);
  }

  const group = new THREE.Group();
  group.name = 'trees';
  const look: TreeLook = { conifer: false, radius: 0, height: 0, rot: 0, r: 0, g: 0, b: 0 };
  const make = (indices: number[], conifer: boolean, hq: boolean): void => {
    if (indices.length === 0) return;
    const geo = treeGeometry(conifer ? 'conifer' : 'broadleaf', hq);
    const mat = makeLitMaterial(ctx.atm, `tree-${opts.key ?? 'q'}`, { vertexColors: true, flatShading: !hq });
    const mesh = new THREE.InstancedMesh(geo, mat, indices.length);
    const m = mesh.instanceMatrix.array as Float32Array;
    const col = new Float32Array(indices.length * 3);
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const x = trees.xz[i * 2];
      const z = -trees.xz[i * 2 + 1];
      treeLook(trees.speciesTable[trees.species[i]], trees.age[i], i, look);
      const rad = look.radius;
      const hgt = look.height;
      const cs = Math.cos(look.rot), sn = Math.sin(look.rot);
      const y = p.groundAt(x, z) - 0.3;
      const o = k * 16;
      m[o] = rad * cs; m[o + 1] = 0; m[o + 2] = -rad * sn; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = hgt; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = rad * sn; m[o + 9] = 0; m[o + 10] = rad * cs; m[o + 11] = 0;
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
      col[k * 3] = look.r;
      col[k * 3 + 1] = look.g;
      col[k * 3 + 2] = look.b;
    }
    mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  make(buckets[0], true, false);
  make(buckets[1], false, false);
  make(buckets[2], true, true);
  make(buckets[3], false, true);
  return group;
}

// ---------------------------------------------------------------- zones and example houses

/** The game's zoning grid, one instanced quad per 8 x 8 m cell, draped on the terrain in the shader. */
export function buildZoneCells(ctx: BuildCtx, height?: Record<string, THREE.IUniform>): THREE.Mesh | null {
  const z = ctx.p.result.zones;
  if (!z || z.cellCount === 0) return null;
  const count = Math.min(z.cellCount, Math.floor(z.cells.length / 4), z.cellDepth.length);
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));
  g.setAttribute('iCell', new THREE.InstancedBufferAttribute(z.cells.subarray(0, count * 4), 4));
  g.setAttribute('iDepth', new THREE.InstancedBufferAttribute(z.cellDepth.subarray(0, count), 1));
  g.instanceCount = count;
  const mat = makeZoneMaterial(ctx.atm, height ?? ctx.gpu.height);
  mat.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.name = 'zones';
  return mesh;
}

function prismGeometry(): THREE.BufferGeometry {
  // ridge along x at y = 1, eaves at z = +-0.5, y = 0; gable ends at x = +-0.5
  const p = [
    // slopes
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0,
    0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0,
    // gables
    0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0,
    -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
  g.computeVertexNormals();
  return g;
}

export function buildHouses(ctx: BuildCtx, keep?: (x: number, z: number) => boolean, key = 'q'): THREE.Group | null {
  const z = ctx.p.result.zones;
  if (!z || z.lotCount === 0) return null;
  const inst = houseInstances(z, ctx.p.groundAt, keep);
  if (inst.bodyCount === 0) return null;
  const group = new THREE.Group();
  group.name = 'houses';
  const boxG = new THREE.BoxGeometry(1, 1, 1);
  boxG.translate(0, 0.5, 0);
  boxG.deleteAttribute('uv');
  boxG.setAttribute('iRoof', new THREE.InstancedBufferAttribute(inst.bodyRoof, 3));
  const body = new THREE.InstancedMesh(boxG, makeHouseMaterial(ctx.atm, `house-${key}`), inst.bodyCount);
  (body.instanceMatrix.array as Float32Array).set(inst.body);
  body.instanceColor = new THREE.InstancedBufferAttribute(inst.bodyColor, 3);
  body.frustumCulled = false;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  if (inst.roofCount > 0) {
    const roof = new THREE.InstancedMesh(prismGeometry(), makeLitMaterial(ctx.atm, `roof-${key}`, { color: 0xffffff }), inst.roofCount);
    (roof.instanceMatrix.array as Float32Array).set(inst.roof);
    roof.instanceColor = new THREE.InstancedBufferAttribute(inst.roofColor, 3);
    roof.frustumCulled = false;
    roof.castShadow = true;
    roof.receiveShadow = true;
    group.add(roof);
  }
  return group;
}

// ---------------------------------------------------------------- overlays

const ACCENT = hexToLinear(0x4fd1b5);
const WARN = hexToLinear(0xe5b454);
const WHITE = hexToLinear(0xe6edf3);

function overlayMaterial(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: opacity < 1,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
}

function squarePts(x0: number, gz0: number, x1: number, gz1: number): [number, number][] {
  return [[x0, gz0], [x1, gz0], [x1, gz1], [x0, gz1], [x0, gz0]];
}

/** Crisp outline around the playable area. */
export function buildBorder(ctx: BuildCtx): THREE.Mesh | null {
  const { p } = ctx;
  const h = p.result.terrain.playable.extentM / 2;
  const geo = buildRibbons(
    [{ pts: squarePts(-h, -h, h, h), style: { width: 40, color: ACCENT, lift: 4 }, closed: true }],
    p.groundAt,
    { maxStep: 60 },
  );
  const mesh = ribbonMesh(geo, overlayMaterial(0.9));
  if (mesh) {
    mesh.name = 'border';
    mesh.renderOrder = 3;
  }
  return mesh;
}

/** The 23 x 23 tile grid. */
export function buildTileGrid(ctx: BuildCtx): THREE.Mesh | null {
  const { p } = ctx;
  const E = p.result.terrain.playable.extentM;
  const h = E / 2;
  const T = E / CS2.TILE_GRID;
  const lines: RibbonInput[] = [];
  const style = { width: 12, color: WHITE, lift: 3 };
  for (let k = 1; k < CS2.TILE_GRID; k++) {
    const o = -h + k * T;
    lines.push({ pts: [[o, -h], [o, h]], style });
    lines.push({ pts: [[-h, o], [h, o]], style });
  }
  const mesh = ribbonMesh(buildRibbons(lines, p.groundAt, { maxStep: 80 }), overlayMaterial(0.28));
  if (mesh) {
    mesh.name = 'grid';
    mesh.renderOrder = 3;
  }
  return mesh;
}

/** Highlight of the start tile (translucent fill + outline). */
export function buildStartTile(ctx: BuildCtx): THREE.Group | null {
  const { p } = ctx;
  const st = p.result.playability?.startTile;
  if (!st) return null;
  const E = p.result.terrain.playable.extentM;
  const T = E / CS2.TILE_GRID;
  const x0 = -E / 2 + st.col * T;
  const x1 = x0 + T;
  const gz1 = E / 2 - st.row * T;
  const gz0 = gz1 - T;
  const group = new THREE.Group();
  group.name = 'startTile';

  const N = 16;
  const pos = new Float32Array((N + 1) * (N + 1) * 3);
  const col = new Float32Array((N + 1) * (N + 1) * 3);
  let o = 0;
  for (let r = 0; r <= N; r++) {
    for (let c = 0; c <= N; c++) {
      const x = x0 + (T * c) / N;
      const z = -(gz1 - (T * r) / N);
      pos[o] = x; pos[o + 1] = p.groundAt(x, z) + 2.5; pos[o + 2] = z;
      col[o] = WARN[0]; col[o + 1] = WARN[1]; col[o + 2] = WARN[2];
      o += 3;
    }
  }
  const idx = buildGridIndices(N + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const fill = new THREE.Mesh(g, overlayMaterial(0.18));
  fill.frustumCulled = false;
  fill.renderOrder = 3;
  group.add(fill);

  const outline = ribbonMesh(
    buildRibbons(
      [{ pts: squarePts(x0, gz0, x1, gz1), style: { width: 30, color: WARN, lift: 3.5 }, closed: true }],
      p.groundAt,
      { maxStep: 30 },
    ),
    overlayMaterial(1),
  );
  if (outline) {
    outline.renderOrder = 4;
    group.add(outline);
  }
  return group;
}

// ---------------------------------------------------------------- outside connections

export const CONNECTION_HEX: Record<OutsideConnection['kind'], number> = {
  road: 0xe6edf3,
  rail: 0xc9a27a,
  ship: 0x6fb3e8,
  air: 0xb7a2ee,
  power: 0xf2d25c,
  water: 0x5fd0d8,
};

/** Scene position of a connection's marker anchor (on the ground, inside the border). */
export function connectionAnchor(p: Prepared, c: OutsideConnection): THREE.Vector3 {
  const x = c.p[0];
  const z = -c.p[1];
  const y = Math.max(p.groundAt(x, z), c.kind === 'ship' ? p.seaLevel : -Infinity);
  return new THREE.Vector3(x, y, z);
}

/** Poles with a ground ring at every outside connection (labels are drawn in HTML). */
export function buildConnectionPins(ctx: BuildCtx): THREE.Group | null {
  const list = ctx.p.result.playability?.outsideConnections ?? [];
  if (list.length === 0) return null;
  const group = new THREE.Group();
  group.name = 'connections';
  const pole = new THREE.CylinderGeometry(3, 3, 1, 8, 1, true);
  pole.translate(0, 0.5, 0);
  const ring = new THREE.RingGeometry(55, 75, 40);
  ring.rotateX(-Math.PI / 2);
  for (const c of list) {
    const a = connectionAnchor(ctx.p, c);
    const hex = c.manual ? 0x4fd1b5 : c.synthetic ? 0xe5b454 : CONNECTION_HEX[c.kind];
    const mat = new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.9, depthWrite: false });
    const pm = new THREE.Mesh(pole, mat);
    pm.position.copy(a);
    pm.scale.set(1, 160, 1);
    pm.renderOrder = 5;
    group.add(pm);
    const rm = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity: c.synthetic ? 0.45 : 0.75, depthWrite: false, side: THREE.DoubleSide,
    }));
    rm.position.set(a.x, a.y + 3, a.z);
    rm.renderOrder = 5;
    group.add(rm);
  }
  return group;
}

