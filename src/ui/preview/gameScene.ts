/**
 * Scene parts of the game view: LOD terrain from the full height grid, the world backdrop, water
 * exactly as exported, chunked trees with three levels of detail, start tiles and the tile grid.
 * Scene frame: x = gx, y = height, z = -gz.
 */
import * as THREE from 'three';
import { CS2, type BuildResult } from '../../core/types';
import { quantizeHeights } from '../../core/export/heightmap';
import { ATM_GLSL, patchMaterial, type Atmosphere } from './atmosphere';
import { downsampleMean, type LevelGrid, type WaterGrids } from './gameWater';
import { chunkTrees, type TreeAttrs, type TreeChunk } from './instances';
import { GROUND_GLSL, TERRAIN_H_GLSL, cellGroundHeight, floatTexture, makeTerrainMaterial, makeWaterMaterial, type GroundHeight } from './materials';
import { buildRibbons, hexToLinear, type RibbonInput } from './roadRibbons';
import { infoArray, levelGridGeometry, terrainGeometry, treeGeometry } from './sceneBuilders';
import { groundWeights, nearWaterLevel, terrainAO } from './terrainFields';
import { snowLineGame } from './terrainColor';
import { buildGridIndices, computeNormals, resampleToVertices, type VertexGrid } from './terrainGrid';
import { boxDistance, buildMinMax, patchGrid, selectNodes, PATCH_CELLS, type MinMaxPyramid } from './terrainLod';

// ---------------------------------------------------------------- heights

/** Heights exactly as the package stores them: 16-bit quantised to the height scale. */
export interface GameHeights {
  play: Float32Array;
  playSize: number;
  playExtent: number;
  world: Float32Array;
  worldSize: number;
  worldExtent: number;
  /** cell-centred bilinear height at scene x / z (playable grid inside, world grid outside) */
  heightAt(x: number, z: number): number;
}

function dequantize(q: Uint16Array, scale: number): Float32Array {
  const out = new Float32Array(q.length);
  const k = scale / 65535;
  for (let i = 0; i < q.length; i++) out[i] = q[i] * k;
  return out;
}

/** Bilinear lookup in a cell-centred grid (row 0 = north = smallest scene z), clamped. */
export function cellHeight(data: Float32Array, size: number, extent: number, x: number, z: number): number {
  let fc = ((x + extent / 2) / extent) * size - 0.5;
  let fr = ((z + extent / 2) / extent) * size - 0.5;
  fc = fc < 0 ? 0 : fc > size - 1 ? size - 1 : fc;
  fr = fr < 0 ? 0 : fr > size - 1 ? size - 1 : fr;
  const c0 = Math.floor(fc);
  const r0 = Math.floor(fr);
  const c1 = Math.min(size - 1, c0 + 1);
  const r1 = Math.min(size - 1, r0 + 1);
  const u = fc - c0;
  const v = fr - r0;
  const a = data[r0 * size + c0];
  const b = data[r0 * size + c1];
  const c = data[r1 * size + c0];
  const d = data[r1 * size + c1];
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

export function gameHeights(result: BuildResult): GameHeights {
  const t = result.terrain;
  const play = dequantize(quantizeHeights(t.playable, t.heightScale), t.heightScale);
  const world = dequantize(quantizeHeights(t.world, t.heightScale), t.heightScale);
  const ps = t.playable.size;
  const pe = t.playable.extentM;
  const ws = t.world.size;
  const we = t.world.extentM;
  const half = pe / 2;
  return {
    play, playSize: ps, playExtent: pe, world, worldSize: ws, worldExtent: we,
    heightAt(x, z) {
      if (Math.abs(x) <= half && Math.abs(z) <= half) return cellHeight(play, ps, pe, x, z);
      return cellHeight(world, ws, we, x, z);
    },
  };
}

// ---------------------------------------------------------------- shared GPU data

export interface GameGpu {
  playTex: THREE.DataTexture;
  playTexSize: number;
  worldTex: THREE.DataTexture;
  worldTexSize: number;
  aux: THREE.DataTexture;
  level: THREE.DataTexture;
  auxSize: number;
  /** uniforms for terrainH(xz) in shaders */
  ground: GroundHeight;
  notes: string[];
  dispose(): void;
}


export function createGameGpu(result: BuildResult, h: GameHeights, waterLevels: LevelGrid, maxTex: number): GameGpu {
  const notes: string[] = [];
  let ps = h.playSize;
  let playData = h.play;
  if (ps > maxTex) {
    ps = Math.min(maxTex, 2048);
    playData = downsampleMean(h.play, h.playSize, ps);
    notes.push(`Terrain detail was reduced to ${ps} samples per side (graphics card texture limit).`);
  }
  const playTex = floatTexture(playData, ps);
  const ws = Math.min(h.worldSize, 1024, maxTex);
  const worldTex = floatTexture(downsampleMean(h.world, h.worldSize, ws), ws);

  // aux fields on an A x A vertex grid: canopy, ao, sea shore flag; and the nearest water level
  const A = Math.min(1024, h.playSize);
  const E = h.playExtent;
  const v: VertexGrid = { n: A, extentM: E, data: resampleToVertices(h.play, h.playSize, A, 'mean') };
  const ao = terrainAO(v);
  const canopy = groundWeights(E, A, undefined, result.trees, 1).b;
  const sea = result.terrain.seaLevel;
  const hasSea = result.terrain.hasSea;
  const inland = waterLevels.n === A ? waterLevels.level : resampleToVertices(waterLevels.level.map((x) => (x === x ? x : -1e6)), waterLevels.n, A, 'max').map((x) => (x > -1e5 ? x : NaN));
  const wet = new Uint8Array(A * A);
  const lvl = new Float32Array(A * A).fill(NaN);
  for (let i = 0; i < A * A; i++) {
    if (inland[i] === inland[i] && inland[i] > v.data[i]) { wet[i] = 1; lvl[i] = inland[i]; }
    else if (hasSea && v.data[i] < sea) { wet[i] = 1; lvl[i] = sea; }
  }
  const near = nearWaterLevel(v, { wet, level: lvl, hasWater: true }, 6);
  const auxData = new Uint8Array(A * A * 4);
  const levelData = new Float32Array(A * A);
  for (let i = 0; i < A * A; i++) {
    // on dry land the level never exceeds the ground: no lake bed colour away from the water
    if (!wet[i] && near[i] === near[i] && near[i] > v.data[i]) near[i] = v.data[i];
    auxData[i * 4] = canopy[i * 4 + 2];
    auxData[i * 4 + 1] = Math.round(Math.min(1, ao[i]) * 255);
    auxData[i * 4 + 2] = hasSea && near[i] === near[i] && Math.abs(near[i] - sea) < 0.3 ? 255 : 0;
    levelData[i] = near[i] === near[i] ? near[i] : -1e6;
  }
  const aux = new THREE.DataTexture(auxData, A, A, THREE.RGBAFormat, THREE.UnsignedByteType);
  aux.minFilter = THREE.LinearMipmapLinearFilter;
  aux.magFilter = THREE.LinearFilter;
  aux.generateMipmaps = true;
  aux.needsUpdate = true;
  const level = floatTexture(levelData, A);
  const ground: GroundHeight = cellGroundHeight(playTex, ps, h.playExtent, worldTex, ws, h.worldExtent);
  return {
    playTex, playTexSize: ps, worldTex, worldTexSize: ws, aux, level, auxSize: A, ground, notes,
    dispose() {
      playTex.dispose();
      worldTex.dispose();
      aux.dispose();
      level.dispose();
    },
  };
}

// ---------------------------------------------------------------- LOD terrain

const PATCH_VERTEX = /* glsl */ `
attribute vec3 iNode;
${TERRAIN_H_GLSL}
`;

const PATCH_BEGIN = /* glsl */ `
  vec2 gxz = iNode.xy + position.xz * iNode.z;
  float cellSz = iNode.z / ${PATCH_CELLS}.0;
  float gh = cellH(uPlayH, uPlayN, uPlayE, gxz);
`;

/** The playable terrain as one instanced patch drawn once per selected quadtree node. */
export class GameTerrain {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly nodeAttr: THREE.InstancedBufferAttribute;
  private readonly pyramid: MinMaxPyramid;
  private readonly frustum = new THREE.Frustum();
  private readonly box = new THREE.Box3();
  private readonly projView = new THREE.Matrix4();
  readonly extent: number;
  splitK = 3.2;
  nodeCount = 0;

  constructor(h: GameHeights, gpu: GameGpu, atm: Atmosphere, snowLine: number) {
    this.extent = h.playExtent;
    this.pyramid = buildMinMax(h.play, h.playSize, h.playExtent, 64);
    const grid = patchGrid();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(grid.positions, 3));
    g.setIndex(new THREE.BufferAttribute(grid.indices, 1));
    const cap = 4096;
    this.nodeAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.nodeAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iNode', this.nodeAttr);
    g.instanceCount = 0;
    this.geo = g;

    const uniforms = {
      ...gpu.ground.uniforms,
      uAux: { value: gpu.aux },
      uLevel: { value: gpu.level },
      uAuxN: { value: gpu.auxSize },
      uSnowLine: { value: Number.isFinite(snowLine) ? snowLine : 1e9 },
    };
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    patchMaterial(mat, atm, {
      key: 'game-terrain',
      uniforms,
      vertexDecl: PATCH_VERTEX,
      vertexReplace: {
        '#include <beginnormal_vertex>': `${PATCH_BEGIN}
          float nx = cellH(uPlayH, uPlayN, uPlayE, gxz + vec2(cellSz, 0.0)) - cellH(uPlayH, uPlayN, uPlayE, gxz - vec2(cellSz, 0.0));
          float nz = cellH(uPlayH, uPlayN, uPlayE, gxz + vec2(0.0, cellSz)) - cellH(uPlayH, uPlayN, uPlayE, gxz - vec2(0.0, cellSz));
          vec3 objectNormal = normalize(vec3(-nx, 2.0 * cellSz, -nz));`,
        '#include <begin_vertex>': 'vec3 transformed = vec3(gxz.x, gh + position.y * cellSz * 4.0, gxz.y);',
      },
      fragmentDecl: `${TERRAIN_H_GLSL}
        ${GROUND_GLSL}
        uniform sampler2D uAux;
        uniform sampler2D uLevel;
        uniform float uAuxN;
        float vertexGridH(sampler2D tex, float n, float extent, vec2 xz) {
          vec2 f = clamp((xz + 0.5 * extent) / extent * (n - 1.0), vec2(0.0), vec2(n - 1.001));
          vec2 i0 = floor(f);
          vec2 u = f - i0;
          ivec2 a = ivec2(i0);
          float h00 = texelFetch(tex, a, 0).r;
          float h10 = texelFetch(tex, a + ivec2(1, 0), 0).r;
          float h01 = texelFetch(tex, a + ivec2(0, 1), 0).r;
          float h11 = texelFetch(tex, a + ivec2(1, 1), 0).r;
          return mix(mix(h00, h10, u.x), mix(h01, h11, u.x), u.y);
        }`,
      fragmentReplace: {
        '#include <color_fragment>': `#include <color_fragment>
          vec2 wp = vAtmW.xz;
          float fw = max(length(fwidth(wp)), 1e-3);
          float dN = max(uPlayE / uPlayN, fw * 0.7);
          float gx = cellH(uPlayH, uPlayN, uPlayE, wp + vec2(dN, 0.0)) - cellH(uPlayH, uPlayN, uPlayE, wp - vec2(dN, 0.0));
          float gz = cellH(uPlayH, uPlayN, uPlayE, wp + vec2(0.0, dN)) - cellH(uPlayH, uPlayN, uPlayE, wp - vec2(0.0, dN));
          vec3 terrN = normalize(vec3(-gx, 2.0 * dN, -gz));
          vec2 auv = ((wp + 0.5 * uPlayE) / uPlayE * (uAuxN - 1.0) + 0.5) / uAuxN;
          vec4 aux = texture2D(uAux, auv);
          float lv = vertexGridH(uLevel, uAuxN, uPlayE, wp);
          float h = vAtmW.y;
          float above = lv > -1e5 ? h - lv : 999.0;
          float depth = lv > -1e5 ? max(0.0, lv - h) : 0.0;
          float tCanopy = clamp(aux.r * 1.15, 0.0, 1.0);
          float tAO = aux.g;
          diffuseColor.rgb = groundAlbedo(wp, h, terrN.y, above, aux.b, tCanopy, depth, fw);`,
        '#include <normal_fragment_begin>': `#include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(terrN, 0.0)).xyz);`,
        '#include <aomap_fragment>': `#include <aomap_fragment>
          reflectedLight.indirectDiffuse *= tAO * (1.0 - tCanopy * 0.3);
          reflectedLight.directDiffuse *= mix(1.0, tAO, 0.3) * (1.0 - tCanopy * 0.2);`,
      },
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    // the shadow pass would see the camera's LOD selection; coarse distant patches then shadow
    // the fine near ones, so the terrain only receives shadows (hills are shaded by their slope)
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    this.mesh = mesh;
  }

  /** Picks the nodes for this camera. */
  update(camera: THREE.PerspectiveCamera): void {
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const p = camera.position;
    const nodes = selectNodes({
      extent: this.extent,
      minNode: this.extent / 64,
      camera: [p.x, p.y, p.z],
      splitK: this.splitK,
      pyramid: this.pyramid,
      maxNodes: 4096,
      visible: (x0, y0, z0, x1, y1, z1) => {
        this.box.min.set(x0, y0, z0);
        this.box.max.set(x1, y1, z1);
        return this.frustum.intersectsBox(this.box);
      },
    });
    const a = this.nodeAttr.array as Float32Array;
    const n = Math.min(nodes.length, a.length / 3);
    for (let i = 0; i < n; i++) {
      a[i * 3] = nodes[i].x0;
      a[i * 3 + 1] = nodes[i].z0;
      a[i * 3 + 2] = nodes[i].size;
    }
    this.nodeAttr.clearUpdateRanges();
    this.nodeAttr.addUpdateRange(0, n * 3);
    this.nodeAttr.needsUpdate = true;
    this.geo.instanceCount = n;
    this.nodeCount = n;
  }
}

/** World backdrop with a hole for the playable area; its inner edge follows the playable grid. */
export function buildGameWorld(result: BuildResult, h: GameHeights, atm: Atmosphere, snowLine: number): THREE.Mesh {
  const E = h.worldExtent;
  const ph = h.playExtent / 2;
  // vertex count so that the playable border lies on a vertex line
  const ratio = Math.round(E / h.playExtent);
  const cells = Math.floor(Math.min(1024, h.worldSize) / ratio) * ratio;
  const n = cells + 1;
  const v: VertexGrid = { n, extentM: E, data: resampleToVertices(h.world, h.worldSize, n, 'mean') };
  const d = E / (n - 1);
  const eps = d * 1e-3;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = -E / 2 + c * d;
      const z = -E / 2 + r * d;
      if (Math.abs(x) <= ph + eps && Math.abs(z) <= ph + eps) v.data[r * n + c] = h.heightAt(Math.max(-ph, Math.min(ph, x)), Math.max(-ph, Math.min(ph, z)));
    }
  }
  const normals = computeNormals(v);
  const sea = result.terrain.seaLevel;
  const depth = new Float32Array(n * n);
  const level = new Float32Array(n * n).fill(result.terrain.hasSea ? sea : NaN);
  for (let i = 0; i < n * n; i++) depth[i] = result.terrain.hasSea ? Math.max(0, sea - v.data[i]) : 0;
  const info = infoArray(v, depth, level, terrainAO(v), result.terrain.hasSea ? sea : Infinity);
  const inside = (x: number, z: number): boolean => Math.abs(x) <= ph + eps && Math.abs(z) <= ph + eps;
  const idx = buildGridIndices(n, (r, c) => {
    const x0 = -E / 2 + c * d;
    const z0 = -E / 2 + r * d;
    return inside(x0, z0) && inside(x0 + d, z0 + d);
  });
  const mat = makeTerrainMaterial(atm, {
    weightsA: null, weightsB: null, weightsSize: 1, playExtent: h.playExtent, snowLine,
    edgeFade: [E / 2 * 0.55, E / 2 * 0.97], key: 'game-world',
  });
  const mesh = new THREE.Mesh(terrainGeometry(v, normals, info, idx), mat);
  mesh.receiveShadow = true;
  mesh.name = 'world';
  return mesh;
}

// ---------------------------------------------------------------- water

export interface GameWaterInfo {
  group: THREE.Group;
  playLevels: LevelGrid;
  fromData: boolean;
  filled: number;
  dry: number;
}

/** Sea plane (when the map has sea) plus lakes and rivers from the export's water data. */
export function buildGameWater(result: BuildResult, grids: WaterGrids, ground: GroundHeight, atm: Atmosphere, hq: boolean): GameWaterInfo {
  const t = result.terrain;
  const group = new THREE.Group();
  group.name = 'water';
  const half = t.playable.extentM / 2;
  const fade: [number, number] = [t.world.extentM / 2 * 0.55, t.world.extentM / 2 * 0.97];
  if (t.hasSea) {
    const geo = new THREE.PlaneGeometry(t.world.extentM, t.world.extentM, 64, 64);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, t.seaLevel, 0);
    geo.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count).fill(30), 1));
    const m = new THREE.Mesh(geo, makeWaterMaterial(atm, ground, { hq, edgeFade: fade }));
    m.renderOrder = 2;
    m.frustumCulled = false;
    m.name = 'sea';
    group.add(m);
  }
  const play = levelGridGeometry(grids.play);
  if (play) {
    const m = new THREE.Mesh(play, makeWaterMaterial(atm, ground, { hq, clipOutside: half }));
    m.renderOrder = 2;
    m.frustumCulled = false;
    group.add(m);
  }
  if (grids.world) {
    const wg = levelGridGeometry(grids.world);
    if (wg) {
      const m = new THREE.Mesh(wg, makeWaterMaterial(atm, ground, { hq, edgeFade: fade, clipInside: half }));
      m.renderOrder = 2;
      m.frustumCulled = false;
      group.add(m);
    }
  }
  return { group, playLevels: grids.play, fromData: grids.fromData, filled: grids.filled, dry: grids.dry };
}

// ---------------------------------------------------------------- trees

const TREE_VERTEX_DECL = /* glsl */ `
attribute vec4 iPos;
attribute vec2 iSize;
attribute vec3 iCol;
`;
const TREE_TRANSFORM = /* glsl */ `
  float tCs = cos(iPos.w);
  float tSn = sin(iPos.w);
  vec3 tP = position * vec3(iSize.x, iSize.y, iSize.x);
  vec3 transformed = vec3(tCs * tP.x + tSn * tP.z, tP.y, -tSn * tP.x + tCs * tP.z) + iPos.xyz;
`;

function treeMaterials(atm: Atmosphere, key: string, flat: boolean): { mat: THREE.MeshLambertMaterial; depth: THREE.MeshDepthMaterial } {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: flat });
  patchMaterial(mat, atm, {
    key,
    vertexDecl: TREE_VERTEX_DECL,
    vertexReplace: {
      '#include <beginnormal_vertex>': `vec3 objectNormal = normalize(vec3(cos(iPos.w) * normal.x / iSize.x + sin(iPos.w) * normal.z / iSize.x, normal.y / iSize.y, -sin(iPos.w) * normal.x / iSize.x + cos(iPos.w) * normal.z / iSize.x));`,
      '#include <begin_vertex>': TREE_TRANSFORM,
      '#include <color_vertex>': '#include <color_vertex>\nvColor.rgb *= iCol;',
    },
  });
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TREE_VERTEX_DECL}`)
      .replace('#include <begin_vertex>', TREE_TRANSFORM);
  };
  depth.customProgramCacheKey = () => `${key}-depth`;
  return { mat, depth };
}

function impostorMaterial(atm: Atmosphere, conifer: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...atm.uniforms },
    defines: conifer ? { CONIFER: 1 } : {},
    vertexShader: /* glsl */ `
      ${TREE_VERTEX_DECL}
      varying vec2 vUv;
      varying vec3 vCol;
      varying vec3 vW;
      varying vec3 vRight;
      void main() {
        vec3 base = iPos.xyz;
        vec3 toCam = cameraPosition - base;
        vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-4, 0.0, 0.0));
        vec3 p = base + right * position.x * iSize.x * 2.0 + vec3(0.0, position.y * iSize.y, 0.0);
        vUv = vec2(position.x + 0.5, position.y);
        vCol = iCol;
        vW = p;
        vRight = right;
        vec3 toC = cameraPosition - p;
        p += toC / max(length(toC), 1e-3) * min(length(toC) * 0.002, 40.0);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${ATM_GLSL}
      varying vec2 vUv;
      varying vec3 vCol;
      varying vec3 vW;
      varying vec3 vRight;
      void main() {
        float x = (vUv.x - 0.5) * 2.0;
        float y = vUv.y;
        float inside;
        vec2 nrm;
        #ifdef CONIFER
          float top = 1.0 - (y - 0.05) / 0.95;
          inside = step(0.05, y) * step(abs(x), top);
          nrm = vec2(x / max(top, 0.05), 0.5);
        #else
          vec2 q = vec2(x, (y - 0.62) / 0.38);
          inside = step(dot(q, q), 1.0);
          nrm = q;
        #endif
        if (inside < 0.5) discard;
        vec3 toCam = normalize(cameraPosition - vW);
        vec3 n = normalize(vRight * nrm.x * 0.8 + vec3(0.0, max(nrm.y, 0.0) * 0.6 + 0.5, 0.0) + toCam * 0.6);
        float sun = max(dot(n, uSunDir), 0.0);
        vec3 amb = mix(uSkyHorizon, uSkyZenith, 0.5) * 0.55 + vec3(0.06);
        vec3 lit = vCol * (uSunColor * sun * 1.05 + amb) * (0.62 + 0.38 * y);
        gl_FragColor = vec4(atmHaze(lit, vW), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

interface ChunkMeshes {
  chunk: TreeChunk;
  meshes: [THREE.Mesh | null, THREE.Mesh | null, THREE.Mesh | null][];
}

/** Every tree of the result, chunked, with detailed / simple / impostor levels of detail. */
export class GameTrees {
  readonly group = new THREE.Group();
  private readonly chunks: ChunkMeshes[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly box = new THREE.Box3();
  private readonly pv = new THREE.Matrix4();
  readonly disposables: { dispose(): void }[] = [];
  nearDist = 650;
  midDist = 2600;
  count = 0;
  visibleDetailed = 0;

  constructor(result: BuildResult, heightAt: (x: number, z: number) => number, atm: Atmosphere, extent: number) {
    this.group.name = 'trees';
    const trees = result.trees;
    if (!trees || trees.count === 0) return;
    this.count = trees.count;
    const chunks = chunkTrees(trees, extent, 1024, heightAt);
    const geos = [
      [treeGeometry('conifer', true), treeGeometry('conifer', false)],
      [treeGeometry('broadleaf', true), treeGeometry('broadleaf', false)],
    ];
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    const mats = [
      [treeMaterials(atm, 'gtree-hq', false), treeMaterials(atm, 'gtree-lo', true)],
      [treeMaterials(atm, 'gtree-hq', false), treeMaterials(atm, 'gtree-lo', true)],
    ];
    const imp = [impostorMaterial(atm, true), impostorMaterial(atm, false)];
    for (const g of [...geos.flat(), quad]) this.disposables.push(g);
    for (const m of mats.flat()) this.disposables.push(m.mat, m.depth);
    this.disposables.push(...imp);
    for (const chunk of chunks) {
      const entry: ChunkMeshes = { chunk, meshes: [] };
      [chunk.conifer, chunk.broadleaf].forEach((attrs: TreeAttrs, type) => {
        if (attrs.count === 0) {
          entry.meshes.push([null, null, null]);
          return;
        }
        const iPos = new THREE.InstancedBufferAttribute(attrs.pos, 4);
        const iSize = new THREE.InstancedBufferAttribute(attrs.size, 2);
        const iCol = new THREE.InstancedBufferAttribute(attrs.col, 3);
        const make = (base: THREE.BufferGeometry, mat: THREE.Material, depth: THREE.Material | null): THREE.Mesh => {
          const g = new THREE.InstancedBufferGeometry();
          for (const name of Object.keys(base.attributes)) g.setAttribute(name, base.getAttribute(name));
          if (base.index) g.setIndex(base.index);
          g.setAttribute('iPos', iPos);
          g.setAttribute('iSize', iSize);
          g.setAttribute('iCol', iCol);
          g.instanceCount = attrs.count;
          this.disposables.push({ dispose: () => g.dispose() });
          const m = new THREE.Mesh(g, mat);
          m.frustumCulled = false;
          m.visible = false;
          if (depth) {
            m.customDepthMaterial = depth;
            m.castShadow = true;
            m.receiveShadow = true;
          }
          this.group.add(m);
          return m;
        };
        entry.meshes.push([
          make(geos[type][0], mats[type][0].mat, mats[type][0].depth),
          make(geos[type][1], mats[type][1].mat, mats[type][1].depth),
          make(quad, imp[type], null),
        ]);
      });
      this.chunks.push(entry);
    }
  }

  update(camera: THREE.PerspectiveCamera, scale = 1): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const p = camera.position;
    let detailed = 0;
    for (const { chunk, meshes } of this.chunks) {
      this.box.min.set(chunk.x0, chunk.minY, chunk.z0);
      this.box.max.set(chunk.x0 + chunk.size, chunk.maxY, chunk.z0 + chunk.size);
      const vis = this.frustum.intersectsBox(this.box);
      const d = boxDistance(p.x, p.y, p.z, chunk.x0, chunk.minY, chunk.z0, chunk.x0 + chunk.size, chunk.maxY, chunk.z0 + chunk.size);
      const lod = d < this.nearDist * scale ? 0 : d < this.midDist * scale ? 1 : 2;
      for (const set of meshes) {
        for (let k = 0; k < 3; k++) {
          const m = set[k];
          if (m) m.visible = vis && k === lod;
        }
        if (vis && lod === 0) detailed += (set[0]?.geometry as THREE.InstancedBufferGeometry | undefined)?.instanceCount ?? 0;
      }
    }
    this.visibleDetailed = detailed;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------- overlays

function overlayMesh(inputs: RibbonInput[], heightAt: (x: number, z: number) => number, opacity: number, maxStep: number): THREE.Mesh | null {
  const geo = buildRibbons(inputs, heightAt, { maxStep });
  if (geo.vertexCount === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(geo.colors, 3));
  g.setIndex(new THREE.BufferAttribute(geo.indices, 1));
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  }));
  m.frustumCulled = false;
  m.renderOrder = 5;
  return m;
}

const sq = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];

/** The 3 x 3 start tiles the mod unlocks around the start tile (clamped to the grid). */
export function startTileBlock(col: number, row: number, grid = CS2.TILE_GRID): { c0: number; r0: number; c1: number; r1: number } {
  const c0 = Math.max(0, Math.min(grid - 3, col - 1));
  const r0 = Math.max(0, Math.min(grid - 3, row - 1));
  return { c0, r0, c1: c0 + 2, r1: r0 + 2 };
}

export function buildStartTiles(result: BuildResult, heightAt: (x: number, z: number) => number): THREE.Group | null {
  const st = result.playability?.startTile;
  if (!st) return null;
  const E = result.terrain.playable.extentM;
  const T = E / CS2.TILE_GRID;
  const b = startTileBlock(st.col, st.row);
  const x0 = -E / 2 + b.c0 * T;
  const x1 = -E / 2 + (b.c1 + 1) * T;
  const gz1 = E / 2 - b.r0 * T;
  const gz0 = E / 2 - (b.r1 + 1) * T;
  const warn = hexToLinear(0xe5b454);
  const group = new THREE.Group();
  group.name = 'startTiles';
  const outer = overlayMesh([{ pts: sq(x0, gz0, x1, gz1), style: { width: 6, color: warn, lift: 3 }, closed: true }], heightAt, 0.75, 40);
  const inner: RibbonInput[] = [];
  for (let k = 1; k < 3; k++) {
    inner.push({ pts: [[x0 + k * T, gz0], [x0 + k * T, gz1]], style: { width: 3, color: warn, lift: 3 } });
    inner.push({ pts: [[x0, gz0 + k * T], [x1, gz0 + k * T]], style: { width: 3, color: warn, lift: 3 } });
  }
  const lines = overlayMesh(inner, heightAt, 0.45, 40);
  if (outer) group.add(outer);
  if (lines) group.add(lines);
  return group;
}

export function buildTileLines(result: BuildResult, heightAt: (x: number, z: number) => number): THREE.Mesh | null {
  const E = result.terrain.playable.extentM;
  const h = E / 2;
  const T = E / CS2.TILE_GRID;
  const white = hexToLinear(0xe6edf3);
  const lines: RibbonInput[] = [];
  for (let k = 0; k <= CS2.TILE_GRID; k++) {
    const o = -h + k * T;
    lines.push({ pts: [[o, -h], [o, h]], style: { width: 6, color: white, lift: 3 } });
    lines.push({ pts: [[-h, o], [h, o]], style: { width: 6, color: white, lift: 3 } });
  }
  const m = overlayMesh(lines, heightAt, 0.35, 60);
  if (m) m.name = 'tileGrid';
  return m;
}

export function snowLineOf(result: BuildResult): number {
  return snowLineGame(result.climate, result.terrain.seaLevel, result.terrain.scale.vertical);
}
