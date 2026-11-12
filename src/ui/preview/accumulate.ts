/**
 * High-quality still of a scene: renders into a half-float target, accumulates jittered samples
 * (anti-aliasing, and soft shadows when the caller jitters the sun per sample), tile by tile, then
 * tone maps into a 2D canvas. Progressive, cancellable and yields to the browser between samples.
 */
import * as THREE from 'three';
import { jitter, samplesFor, tileLayout } from './renderMath';

export interface StillOptions {
  width: number;
  height: number;
  exposure: number;
  samples?: number;
  onProgress(fraction: number, message: string): void;
  isCancelled(): boolean;
  isLost(): boolean;
  /** called before every sample (k = 0-based sample index), e.g. to jitter the sun */
  beforeSample?(k: number): void;
}

export interface StillResult {
  canvas: HTMLCanvasElement;
  samples: number;
  ms: number;
  notes: string[];
}

export class StillCancelled extends Error {
  constructor() {
    super('cancelled');
  }
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

/** Yields to the browser: the next animation frame, or a short timeout when frames are throttled. */
export const nextFrame = (): Promise<void> => new Promise((res) => {
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

/**
 * Renders `scene` from `camera` (its aspect is changed to the output size on a clone) into a new
 * canvas. Leaves the renderer's target and clear state as it found them.
 */
export async function renderStill(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  o: StillOptions,
): Promise<StillResult> {
  const t0 = performance.now();
  const notes: string[] = [];
  const caps = renderer.capabilities;
  const gl = renderer.getContext();
  const cam = camera.clone();
  cam.aspect = o.width / o.height;
  cam.clearViewOffset();
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();

  const canvas = document.createElement('canvas');
  canvas.width = o.width;
  canvas.height = o.height;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('This browser cannot create a 2D canvas for the image.');

  const maxTile = Math.min(2048, caps.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
  const tiles = tileLayout(o.width, o.height, maxTile);
  if (tiles.length > 1) notes.push(`The image was rendered in ${tiles.length} parts.`);
  const samples = o.samples ?? samplesFor(o.width, o.height, 32);
  const tw = Math.max(...tiles.map((t) => t.w));
  const th = Math.max(...tiles.map((t) => t.h));
  const msaa = Math.min(4, caps.maxSamples ?? 0);
  const disposables: { dispose(): void }[] = [];
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  try {
    const rtSample = new THREE.WebGLRenderTarget(tw, th, { type: THREE.HalfFloatType, samples: msaa, depthBuffer: true });
    const rtAccum = new THREE.WebGLRenderTarget(tw, th, { type: THREE.HalfFloatType, depthBuffer: false });
    const rtOut = new THREE.WebGLRenderTarget(tw, th, { type: THREE.UnsignedByteType, depthBuffer: false });
    const quadGeo = new THREE.PlaneGeometry(2, 2);
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
      uniforms: { tAccum: { value: rtAccum.texture }, uScale: { value: 1 }, uExposure: { value: o.exposure } },
      vertexShader: QUAD_VERT,
      fragmentShader: OUTPUT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    disposables.push(rtSample, rtAccum, rtOut, quadGeo, accMat, outMat);
    const quadScene = new THREE.Scene();
    const quad = new THREE.Mesh(quadGeo, accMat);
    quad.frustumCulled = false;
    quadScene.add(quad);
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
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

    const total = tiles.length * samples;
    let done = 0;
    for (let ti = 0; ti < tiles.length; ti++) {
      const tile = tiles[ti];
      rtSample.setSize(tile.w, tile.h);
      rtAccum.setSize(tile.w, tile.h);
      rtOut.setSize(tile.w, tile.h);
      renderer.setRenderTarget(rtAccum);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      for (let k = 0; k < samples; k++) {
        const [jx, jy] = jitter(k);
        cam.setViewOffset(o.width, o.height, tile.x + jx, tile.y + jy, tile.w, tile.h);
        cam.updateProjectionMatrix();
        o.beforeSample?.(k);
        renderer.autoClear = true;
        renderer.setRenderTarget(rtSample);
        renderer.render(scene, cam);
        quad.material = accMat;
        renderer.autoClear = false;
        renderer.setRenderTarget(rtAccum);
        renderer.render(quadScene, quadCam);
        done++;
        if (k === 0 || k === samples - 1 || k % 8 === 7) writeTile(tile, k + 1);
        o.onProgress(done / total, tiles.length > 1 ? `Rendering part ${ti + 1} of ${tiles.length}, sample ${k + 1} of ${samples}` : `Rendering sample ${k + 1} of ${samples}`);
        renderer.setRenderTarget(prevTarget);
        await nextFrame();
        if (o.isLost()) throw new Error('The graphics card lost the 3D view (WebGL context lost) while rendering.');
        if (o.isCancelled()) throw new StillCancelled();
      }
    }
    return { canvas, samples, ms: performance.now() - t0, notes };
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevClear, prevAlpha);
    for (const d of disposables) d.dispose();
  }
}
