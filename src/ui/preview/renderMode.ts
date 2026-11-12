/**
 * "Rendera": a high-detail offscreen render of the current camera view. Builds a separate scene
 * (high-resolution terrain tiles, detailed trees, roads, bridges, water, optional zones/houses),
 * renders it with soft sun shadows into a half-float target and accumulates jittered samples for
 * anti-aliasing and penumbrae, tile by tile, then tone maps into a 2D canvas. Progressive and
 * cancellable; yields to the browser between samples.
 */
import * as THREE from 'three';
import { Atmosphere, buildSkyDome } from './atmosphere';
import { createGpuShared, infoArray, buildHouses, buildRoads, buildTrees, buildWater, buildWorldMesh, buildZoneCells, disposeObject, type BuildCtx, type Prepared } from './sceneBuilders';
import { makeTerrainMaterial, vertexGridTexture, heightUniforms } from './materials';
import { jitter, samplesFor, tileLayout } from './renderMath';
import { terrainAO, upsampleField } from './terrainFields';
import { computeNormals, decimateHeightGrid, meshHeightAt, type VertexGrid } from './terrainGrid';

export interface RenderOptions {
  width: number;
  height: number;
  hour: number;
  zones: boolean;
  houses: boolean;
  exposure: number;
}

export interface RenderProgress {
  fraction: number;
  message: string;
}

export interface RenderOutput {
  canvas: HTMLCanvasElement;
  notes: string[];
  ms: number;
  samples: number;
}

export interface RenderJob {
  promise: Promise<RenderOutput>;
  cancel(): void;
  /** the canvas being filled (shown live while rendering) */
  canvas: HTMLCanvasElement;
}

export class RenderCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

const TILE_VERTS = 257;

/** Yields to the browser: the next animation frame, or a short timeout when frames are throttled. */
const nextFrame = (): Promise<void> => new Promise((res) => {
  let done = false;
  const f = (): void => {
    if (!done) {
      done = true;
      res();
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(f);
  setTimeout(f, 40);
});

/** Ground footprint (scene x/z box) of the camera frustum, clamped to `lim`. */
function viewFootprint(cam: THREE.PerspectiveCamera, groundY: number, lim: number): THREE.Box2 {
  const box = new THREE.Box2();
  box.expandByPoint(new THREE.Vector2(cam.position.x, cam.position.z));
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0], [0, 0]];
  const o = cam.position;
  const far = Math.min(cam.far, lim * 3);
  for (const [sx, sy] of corners) {
    const p = new THREE.Vector3(sx, sy, 0.5).unproject(cam);
    const d = p.sub(o).normalize();
    let t = far;
    if (d.y < -1e-4) t = Math.min(far, (groundY - o.y) / d.y);
    if (t < 0) t = far;
    box.expandByPoint(new THREE.Vector2(o.x + d.x * t, o.z + d.z * t));
  }
  const pad = Math.max(400, (box.max.x - box.min.x + box.max.y - box.min.y) * 0.08);
  box.expandByScalar(pad);
  box.min.clampScalar(-lim, lim);
  box.max.clampScalar(-lim, lim);
  return box;
}

interface HiTerrain {
  v: VertexGrid;
  normals: Float32Array;
  info: Float32Array;
}

function buildHiTerrain(p: Prepared, verts: number): HiTerrain {
  const t = p.result.terrain;
  const v = decimateHeightGrid(t.playable, verts);
  const normals = computeNormals(v);
  const ao = terrainAO(v);
  const level = upsampleField(p.nearLevel, p.playV.n, v.n);
  const n = v.n * v.n;
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lv = level[i];
    depth[i] = lv === lv ? Math.max(0, lv - v.data[i]) : 0;
  }
  const info = infoArray(v, depth, level, ao, t.hasSea ? p.seaLevel : Infinity);
  return { v, normals, info };
}

/** Terrain tiles of the high-resolution grid that intersect `box`. */
function buildTerrainTiles(hi: HiTerrain, box: THREE.Box2, mat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const { v } = hi;
  const N = v.n;
  const d = v.extentM / (N - 1);
  const half = v.extentM / 2;
  const step = TILE_VERTS - 1;
  for (let r0 = 0; r0 < N - 1; r0 += step) {
    for (let c0 = 0; c0 < N - 1; c0 += step) {
      const r1 = Math.min(N - 1, r0 + step);
      const c1 = Math.min(N - 1, c0 + step);
      const x0 = -half + c0 * d, x1 = -half + c1 * d;
      const z0 = -half + r0 * d, z1 = -half + r1 * d;
      if (x1 < box.min.x || x0 > box.max.x || z1 < box.min.y || z0 > box.max.y) continue;
      const rows = r1 - r0 + 1;
      const cols = c1 - c0 + 1;
      const data = new Float32Array(rows * cols);
      const nrm = new Float32Array(rows * cols * 3);
      const inf = new Float32Array(rows * cols * 4);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const s = (r0 + r) * N + (c0 + c);
          const o = r * cols + c;
          data[o] = v.data[s];
          nrm[o * 3] = hi.normals[s * 3]; nrm[o * 3 + 1] = hi.normals[s * 3 + 1]; nrm[o * 3 + 2] = hi.normals[s * 3 + 2];
          inf[o * 4] = hi.info[s * 4]; inf[o * 4 + 1] = hi.info[s * 4 + 1]; inf[o * 4 + 2] = hi.info[s * 4 + 2]; inf[o * 4 + 3] = hi.info[s * 4 + 3];
        }
      }
      const pos = new Float32Array(rows * cols * 3);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const o = (r * cols + c) * 3;
          pos[o] = x0 + c * d;
          pos[o + 1] = data[r * cols + c];
          pos[o + 2] = z0 + r * d;
        }
      }
      const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
      let k = 0;
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const i = r * cols + c;
          idx[k++] = i; idx[k++] = i + cols; idx[k++] = i + 1;
          idx[k++] = i + 1; idx[k++] = i + cols; idx[k++] = i + cols + 1;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setAttribute('aInfo', new THREE.BufferAttribute(inf, 4));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      m.castShadow = true;
      group.add(m);
    }
  }
  return group;
}

const OUTPUT_FRAG = /* glsl */ `
uniform sampler2D tAccum;
uniform float uScale;
uniform float uExposure;
varying vec2 vUv;
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) {
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= uExposure / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture2D(tAccum, vUv).rgb * uScale;
  c = toSrgb(aces(c));
  c += (rnd(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export interface RenderEnv {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  prepared: Prepared;
  layers: { water: boolean; roads: boolean; trees: boolean; world: boolean };
  isContextLost(): boolean;
}

export function startRender(env: RenderEnv, opts: RenderOptions, onProgress: (p: RenderProgress) => void): RenderJob {
  const canvas = document.createElement('canvas');
  canvas.width = opts.width;
  canvas.height = opts.height;
  let cancelled = false;
  const promise = runRender(env, opts, canvas, onProgress, () => cancelled);
  return { promise, canvas, cancel: () => { cancelled = true; } };
}

async function runRender(
  env: RenderEnv,
  opts: RenderOptions,
  canvas: HTMLCanvasElement,
  onProgress: (p: RenderProgress) => void,
  isCancelled: () => boolean,
): Promise<RenderOutput> {
  const t0 = performance.now();
  const notes: string[] = [];
  const { renderer, prepared: p } = env;
  const gl = renderer.getContext();
  const caps = renderer.capabilities;
  const check = async (): Promise<void> => {
    await nextFrame();
    if (env.isContextLost()) throw new Error('Grafikkortet tappade sammanhanget (WebGL context lost) under renderingen.');
    if (isCancelled()) throw new RenderCancelled();
  };

  const scene = new THREE.Scene();
  const cam = env.camera.clone();
  cam.near = Math.max(0.5, cam.near * 0.5);
  cam.aspect = opts.width / opts.height;
  cam.clearViewOffset();
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  const atm = new Atmosphere();
  const sel = p.result.selection;
  atm.set(p.result.climate?.latitude ?? sel.centerLat, sel.rotationDeg, opts.hour);
  atm.uniforms.uSeaLevelY.value = p.seaLevel;
  atm.uniforms.uTime.value = 7.3;
  scene.add(atm.hemi, atm.sun, atm.sun.target);
  const sky = buildSkyDome(atm);
  sky.position.copy(cam.position);
  scene.add(sky);

  const disposables: { dispose(): void }[] = [];
  const objects: THREE.Object3D[] = [];
  const prevShadow = renderer.shadowMap.enabled;
  const prevShadowType = renderer.shadowMap.type;
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;

  try {
    onProgress({ fraction: 0.01, message: 'Preparing high-resolution terrain' });
    await check();

    const E = p.result.terrain.playable.extentM;
    const box = viewFootprint(cam, p.meanHeight, E / 2);

    // ---- high resolution terrain (full builds give up to 2049 vertices per side)
    const srcSize = p.result.terrain.playable.size;
    let verts = srcSize >= 2048 ? 2049 : srcSize >= 1024 ? 1025 : p.playV.n;
    if (caps.maxTextureSize < verts) {
      verts = Math.min(p.playV.n, caps.maxTextureSize);
      notes.push(`The terrain was rendered with ${verts} points per side (graphics card texture limit).`);
    }
    let hi: HiTerrain;
    try {
      hi = buildHiTerrain(p, verts);
    } catch {
      verts = Math.min(1025, p.playV.n);
      hi = buildHiTerrain(p, verts);
      notes.push(`The terrain resolution was lowered to ${verts} points per side (out of memory).`);
    }
    if (srcSize < 1024) notes.push('Draft build: the terrain has low resolution. Build at full quality for sharper detail.');
    await check();

    const heightTex = vertexGridTexture(hi.v);
    disposables.push(heightTex);
    const height = heightUniforms(heightTex, hi.v);
    const gpu = createGpuShared(p);
    disposables.push(gpu);
    const hiGround = (x: number, z: number): number =>
      Math.abs(x) <= E / 2 && Math.abs(z) <= E / 2 ? meshHeightAt(hi.v, x, z) : p.groundAt(x, z);
    const rp: Prepared = { ...p, groundAt: hiGround };
    const pxScale = { value: (2 * Math.tan((cam.fov * Math.PI) / 360)) / opts.height };
    const ctx: BuildCtx = { p: rp, atm, gpu: { ...gpu, height, heightTex }, pxScale };

    const tMat = makeTerrainMaterial(atm, {
      weightsA: gpu.weightsA,
      weightsB: gpu.weightsB,
      weightsSize: p.weights.size,
      playExtent: E,
      snowLine: p.snowLine,
      key: 'render',
    });
    disposables.push(tMat);
    const terrain = buildTerrainTiles(hi, box, tMat);
    scene.add(terrain);
    objects.push(terrain);
    onProgress({ fraction: 0.05, message: 'Building water, roads and trees' });
    await check();

    const inBox = (x: number, z: number): boolean => x >= box.min.x - 60 && x <= box.max.x + 60 && z >= box.min.y - 60 && z <= box.max.y + 60;
    const add = (o: THREE.Object3D | null): void => {
      if (!o) return;
      scene.add(o);
      objects.push(o);
    };
    if (env.layers.world) add(buildWorldMesh(ctx));
    if (env.layers.water) add(buildWater(ctx, true));
    if (env.layers.roads) add(buildRoads(ctx, { maxStep: 6, keep: inBox, key: 'road-render' }));
    await check();
    if (env.layers.trees) {
      add(buildTrees(ctx, { hq: true, keep: inBox, near: cam.position, nearDist: Math.max(2500, (cam.position.y - p.meanHeight) * 2), key: 'r' }));
    }
    if (opts.houses) add(buildHouses(ctx, inBox, 'r'));
    if (opts.zones) add(buildZoneCells(ctx, height));
    await check();

    // ---- shadows: an orthographic light camera fitted to the footprint
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const sun = atm.sun;
    sun.castShadow = true;
    let shadowSize = Math.min(4096, caps.maxTextureSize);
    if (shadowSize < 4096) notes.push(`The shadow map was limited to ${shadowSize} px.`);
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    // shadow region: around the point the camera looks at, sized by the viewing distance, so
    // street-level views get sharp shadows and overviews still get terrain shadows
    const look = new THREE.Vector3();
    cam.getWorldDirection(look);
    let tHit = 4000;
    if (look.y < -1e-3) tHit = Math.min(30000, (p.meanHeight - cam.position.y) / look.y);
    const centre = cam.position.clone().addScaledVector(look, tHit);
    centre.y = p.meanHeight;
    const footR = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y) / 2 + 200;
    const radius = Math.min(footR, Math.max(500, tHit * 1.6));
    const sc = sun.shadow.camera;
    sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
    sc.near = 10;
    sc.far = radius * 2 + 20000;
    sc.updateProjectionMatrix();
    const texel = (2 * radius) / shadowSize;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = texel * 0.8;
    sun.shadow.radius = 2;
    const baseDir = atm.uniforms.uSunDir.value.clone();
    const aimSun = (k: number): void => {
      // jitter the light inside a ~0.7 degree cone for soft penumbrae
      const [a, b] = jitter(k + 1);
      const tmp = Math.abs(baseDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const u = new THREE.Vector3().crossVectors(baseDir, tmp).normalize();
      const w = new THREE.Vector3().crossVectors(baseDir, u).normalize();
      const s = 0.012;
      const d = baseDir.clone().addScaledVector(u, a * s).addScaledVector(w, b * s).normalize();
      sun.position.copy(centre).addScaledVector(d, radius + 10000);
      sun.target.position.copy(centre);
      sun.target.updateMatrixWorld();
    };

    // ---- targets
    const maxTile = Math.min(2048, caps.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
    const tiles = tileLayout(opts.width, opts.height, maxTile);
    if (tiles.length > 1) notes.push(`The image was rendered in ${tiles.length} parts.`);
    const samples = samplesFor(opts.width, opts.height, 32);
    const msaa = Math.min(4, caps.maxSamples ?? 0);
    const tw = Math.max(...tiles.map((t) => t.w));
    const th = Math.max(...tiles.map((t) => t.h));
    const rtSample = new THREE.WebGLRenderTarget(tw, th, { type: THREE.HalfFloatType, samples: msaa, depthBuffer: true });
    const rtAccum = new THREE.WebGLRenderTarget(tw, th, { type: THREE.HalfFloatType, depthBuffer: false });
    const rtOut = new THREE.WebGLRenderTarget(tw, th, { type: THREE.UnsignedByteType, depthBuffer: false });
    disposables.push(rtSample, rtAccum, rtOut);
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    disposables.push(quadGeo);
    const accMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: rtSample.texture }, uW: { value: 1 / samples } },
      vertexShader: QUAD_VERT,
      fragmentShader: 'uniform sampler2D tSrc; uniform float uW; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb * uW, 1.0); }',
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const outMat = new THREE.ShaderMaterial({
      uniforms: { tAccum: { value: rtAccum.texture }, uScale: { value: 1 }, uExposure: { value: opts.exposure } },
      vertexShader: QUAD_VERT,
      fragmentShader: OUTPUT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    disposables.push(accMat, outMat);
    const quadScene = new THREE.Scene();
    const quad = new THREE.Mesh(quadGeo, accMat);
    quad.frustumCulled = false;
    quadScene.add(quad);
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) throw new Error('Canvas 2D saknas.');
    const pixels = new Uint8Array(tw * th * 4);

    const writeTile = (tile: { x: number; y: number; w: number; h: number }, done: number): void => {
      outMat.uniforms.uScale.value = samples / Math.max(1, done);
      quad.material = outMat;
      renderer.setRenderTarget(rtOut);
      renderer.render(quadScene, quadCam);
      renderer.readRenderTargetPixels(rtOut, 0, 0, tile.w, tile.h, pixels);
      const img = ctx2d.createImageData(tile.w, tile.h);
      for (let r = 0; r < tile.h; r++) {
        const src = (tile.h - 1 - r) * tile.w * 4;
        img.data.set(pixels.subarray(src, src + tile.w * 4), r * tile.w * 4);
      }
      ctx2d.putImageData(img, tile.x, tile.y);
    };

    renderer.autoClear = true;
    const total = tiles.length * samples;
    let doneAll = 0;
    let warnedSlow = false;
    for (const tile of tiles) {
      renderer.setRenderTarget(rtAccum);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      for (let k = 0; k < samples; k++) {
        const ts = performance.now();
        const [jx, jy] = jitter(k);
        cam.setViewOffset(opts.width, opts.height, tile.x + jx, tile.y + jy, tile.w, tile.h);
        cam.updateProjectionMatrix();
        aimSun(k);
        sky.position.copy(cam.position);
        rtSample.setSize(tile.w, tile.h);
        rtAccum.setSize(tile.w, tile.h);
        rtOut.setSize(tile.w, tile.h);
        renderer.setRenderTarget(rtSample);
        renderer.render(scene, cam);
        quad.material = accMat;
        renderer.autoClear = false;
        renderer.setRenderTarget(rtAccum);
        renderer.render(quadScene, quadCam);
        renderer.autoClear = true;
        doneAll++;
        if (k === 0 || k === samples - 1 || k % 6 === 5) writeTile(tile, k + 1);
        onProgress({
          fraction: 0.08 + 0.92 * (doneAll / total),
          message: tiles.length > 1 ? `Rendering part ${tiles.indexOf(tile) + 1} of ${tiles.length}, sample ${k + 1} of ${samples}` : `Rendering sample ${k + 1} of ${samples}`,
        });
        renderer.setRenderTarget(null);
        await check();
        if (k === 0 && !warnedSlow && performance.now() - ts > 1500) {
          warnedSlow = true;
          notes.push('The graphics card is slow for this view; rendering may take a while.');
        }
      }
    }
    return { canvas, notes, ms: performance.now() - t0, samples };
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.enabled = prevShadow;
    renderer.shadowMap.type = prevShadowType;
    atm.sun.shadow.map?.dispose();
    atm.sun.shadow.dispose();
    for (const o of objects) disposeObject(o);
    disposeObject(sky);
    for (const d of disposables) d.dispose();
    scene.clear();
  }
}
