/**
 * The game view: the complete map as it will be imported into Cities: Skylines II, explorable with
 * a game-like camera. Owns its own WebGL renderer; build() constructs the scene in stages so the
 * UI can show progress, dispose() releases everything.
 */
import * as THREE from 'three';
import type { BuildResult } from '../../core/types';
import { Atmosphere, buildSkyDome } from './atmosphere';
import { renderStill, nextFrame, type StillResult } from './accumulate';
import { CameraRig, DEFAULT_LIMITS, poseOf, type RigState } from './cameraRig';
import {
  GameTerrain,
  GameTrees,
  buildGameWater,
  buildGameWorld,
  buildStartTiles,
  buildTileLines,
  createGameGpu,
  gameHeights,
  snowLineOf,
  type GameGpu,
  type GameHeights,
} from './gameScene';
import { waterGrids } from './gameWater';
import { LabelLayer } from './roadLabels';
import { metresPerPixel } from './scaleBar';
import { buildConnectionPins, buildHouses, buildRoadGroup, buildZoneCells, connectionAnchor, disposeObject, prepareResult, type BuildCtx, type GpuShared } from './sceneBuilders';
import { heightUniforms, vertexGridTexture } from './materials';

export interface GameLayers {
  trees: boolean;
  roads: boolean;
  water: boolean;
  tunnels: boolean;
  names: boolean;
  tileGrid: boolean;
  startTiles: boolean;
  connections: boolean;
  zones: boolean;
  houses: boolean;
}

export const DEFAULT_GAME_LAYERS: GameLayers = {
  trees: true, roads: true, water: true, tunnels: false, names: false,
  tileGrid: false, startTiles: true, connections: false, zones: false, houses: false,
};

export interface GameStats {
  trees: number;
  segments: number;
  waterSources: number;
  bridges: number;
  tunnels: number;
  lakesFilled: number;
  dryAreas: number;
  waterFromData: boolean;
  labels: number;
}

export interface GameViewInfo {
  metresPerPx: number;
  heightAboveGround: number;
}

export const GAME_EXPOSURE = 0.82;

export class GameEngine {
  private readonly container: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 1, 200_000);
  private readonly atm = new Atmosphere();
  private readonly sky: THREE.Mesh;
  private readonly rig: CameraRig;
  private readonly labels: LabelLayer;
  private readonly pxScale = { value: 0.001 };
  private readonly resizeObserver: ResizeObserver;
  private readonly result: BuildResult;
  private heights: GameHeights | null = null;
  private gpu: GameGpu | null = null;
  private quickGpu: GpuShared | null = null;
  private terrain: GameTerrain | null = null;
  private trees: GameTrees | null = null;
  private objs: Partial<Record<string, THREE.Object3D>> = {};
  private layers: GameLayers = { ...DEFAULT_GAME_LAYERS };
  private raf = 0;
  private last = 0;
  private dirty = true;
  private disposed = false;
  private lost = false;
  private stilling = false;
  private cssH = 1;
  private cssW = 1;
  private frameMs = 0;
  readonly notes: string[] = [];
  stats: GameStats | null = null;
  hour = 15.5;

  onView: ((v: GameViewInfo) => void) | null = null;
  onFrame: (() => void) | null = null;
  onContext: ((lost: boolean) => void) | null = null;

  constructor(container: HTMLElement, result: BuildResult) {
    this.container = container;
    this.result = result;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = GAME_EXPOSURE;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const el = renderer.domElement;
    el.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
    el.tabIndex = 0;
    container.appendChild(el);
    this.renderer = renderer;
    this.labels = new LabelLayer(container);

    this.scene.add(this.atm.hemi, this.atm.sun, this.atm.sun.target);
    this.sky = buildSkyDome(this.atm);
    this.scene.add(this.sky);
    const sel = result.selection;
    this.atm.set(result.climate?.latitude ?? sel.centerLat, sel.rotationDeg, this.hour);
    this.atm.uniforms.uSeaLevelY.value = result.terrain.seaLevel;
    const sun = this.atm.sun;
    sun.castShadow = true;
    const size = Math.min(4096, renderer.capabilities.maxTextureSize);
    if (size < 4096) this.notes.push(`Shadows use a ${size} px map (graphics card limit).`);
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.0003;

    const half = result.terrain.playable.extentM / 2;
    this.rig = new CameraRig(el, { tx: 0, tz: half * 0.05, yaw: 0, pitch: 0.75, distance: half * 2.6 }, { ...DEFAULT_LIMITS, half });
    this.rig.onChange = () => { this.dirty = true; };

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    el.addEventListener('webglcontextlost', this.onLost);
    el.addEventListener('webglcontextrestored', this.onRestored);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
  }

  // ------------------------------------------------------------ building

  /** Builds the scene in stages; `progress` gets 0..1 and an English message. */
  async build(progress: (f: number, msg: string) => void): Promise<void> {
    const r = this.result;
    const step = async (f: number, msg: string): Promise<void> => {
      progress(f, msg);
      await nextFrame();
      if (this.disposed) throw new Error('closed');
    };
    await step(0.02, 'Reading the height map');
    const h = gameHeights(r);
    this.heights = h;
    this.rig.groundAt = (x, z) => Math.max(h.heightAt(x, z), r.terrain.hasSea ? r.terrain.seaLevel : -Infinity);
    await step(0.12, 'Filling lakes and rivers');
    const grids = waterGrids(r.terrain, r.waterSources, 1024, 1024);
    await step(0.25, 'Preparing terrain textures');
    const gpu = createGameGpu(r, h, grids.play, this.renderer.capabilities.maxTextureSize);
    this.gpu = gpu;
    this.notes.push(...gpu.notes);
    const snow = snowLineOf(r);
    this.terrain = new GameTerrain(h, gpu, this.atm, snow);
    this.scene.add(this.terrain.mesh);
    this.add('world', buildGameWorld(r, h, this.atm, snow));
    await step(0.35, 'Placing water');
    const water = buildGameWater(r, grids, gpu.ground, this.atm, true);
    this.add('water', water.group);
    await step(0.45, 'Laying roads and junctions');
    const roads = buildRoadGroup(r, h.heightAt, this.atm, this.pxScale, { maxStep: 8, key: 'game-road' });
    if (roads) this.add('roads', roads.group);
    await step(0.6, `Planting ${(r.trees?.count ?? 0).toLocaleString('en-US')} trees`);
    this.trees = new GameTrees(r, h.heightAt, this.atm, h.playExtent);
    this.scene.add(this.trees.group);
    await step(0.85, 'Overlays');
    const st = buildStartTiles(r, h.heightAt);
    if (st) this.add('startTiles', st);
    const grid = buildTileLines(r, h.heightAt);
    if (grid) this.add('tileGrid', grid);
    this.labels.setData(r.roads, h.heightAt);
    this.stats = {
      trees: r.trees?.count ?? 0,
      segments: r.roads?.edges.length ?? 0,
      waterSources: r.waterSources.length,
      bridges: roads?.scene?.bridgeCount ?? 0,
      tunnels: roads?.scene?.tunnels ?? 0,
      lakesFilled: water.filled,
      dryAreas: water.dry,
      waterFromData: water.fromData,
      labels: this.labels.count,
    };
    this.applyLayers();
    await step(0.95, 'Compiling shaders');
    this.renderer.compile(this.scene, this.camera);
    progress(1, 'Ready');
    this.dirty = true;
    this.start();
  }

  private add(key: string, o: THREE.Object3D): void {
    disposeObject(this.objs[key]);
    this.objs[key] = o;
    this.scene.add(o);
  }

  /** Lazily built optional layers (zoning grid, example houses, connection pins). */
  private ensureOptional(key: 'zones' | 'houses' | 'connections'): THREE.Object3D | undefined {
    if (this.objs[key] || !this.heights) return this.objs[key];
    const ctx = this.quickCtx();
    let o: THREE.Object3D | null = null;
    if (key === 'zones') o = buildZoneCells(ctx);
    if (key === 'houses') o = buildHouses(ctx, undefined, 'game');
    if (key === 'connections') o = buildConnectionPins(ctx);
    if (o) this.add(key, o);
    return o ?? undefined;
  }

  /** A minimal quick-preview context for the shared builders (zones drape on a vertex grid). */
  private quickCtx(): BuildCtx {
    const p = prepareResult(this.result);
    const h = this.heights!;
    const prepared = { ...p, groundAt: h.heightAt };
    if (!this.quickGpu) {
      const tex = vertexGridTexture(p.playV);
      this.quickGpu = {
        heightTex: tex, height: heightUniforms(tex, p.playV), weightsA: tex, weightsB: tex,
        dispose: () => tex.dispose(),
      };
    }
    return { p: prepared, atm: this.atm, gpu: this.quickGpu, pxScale: this.pxScale };
  }

  setLayers(l: GameLayers): void {
    this.layers = l;
    this.applyLayers();
  }

  private applyLayers(): void {
    const l = this.layers;
    const show = (k: string, on: boolean): void => {
      const o = this.objs[k];
      if (o) o.visible = on;
    };
    if (this.trees) this.trees.group.visible = l.trees;
    show('roads', l.roads);
    const roads = this.objs.roads;
    const tunnels = roads?.getObjectByName('tunnels');
    if (tunnels) tunnels.visible = l.tunnels;
    show('water', l.water);
    show('tileGrid', l.tileGrid);
    show('startTiles', l.startTiles);
    if (l.zones) this.ensureOptional('zones');
    if (l.houses) this.ensureOptional('houses');
    if (l.connections) this.ensureOptional('connections');
    show('zones', l.zones);
    show('houses', l.houses);
    show('connections', l.connections);
    this.labels.visible = l.names;
    this.dirty = true;
  }

  setHour(h: number): void {
    this.hour = h;
    const sel = this.result.selection;
    this.atm.set(this.result.climate?.latitude ?? sel.centerLat, sel.rotationDeg, h);
    this.dirty = true;
  }

  rigState(): RigState {
    return this.rig.goal;
  }

  setRig(s: Partial<RigState>, immediate = false): void {
    this.rig.set({ ...this.rig.goal, ...s }, immediate);
    this.dirty = true;
  }

  connectionAnchors(): THREE.Vector3[] {
    const list = this.result.playability?.outsideConnections ?? [];
    const h = this.heights;
    if (!h) return [];
    const p = { groundAt: h.heightAt, seaLevel: this.result.terrain.seaLevel };
    return list.map((c) => connectionAnchor(p as Parameters<typeof connectionAnchor>[0], c));
  }

  connectionsVisible(): boolean {
    return this.layers.connections;
  }

  project(v: THREE.Vector3, out: { x: number; y: number }): boolean {
    const t = v.clone().project(this.camera);
    if (t.z > 1 || t.z < -1) return false;
    out.x = (t.x * 0.5 + 0.5) * this.cssW;
    out.y = (-t.y * 0.5 + 0.5) * this.cssH;
    return true;
  }

  /** Last measured frame time in ms (CPU side). */
  frameTime(): number {
    return this.frameMs;
  }

  /**
   * Renders `frames` frames of the current view back to back and waits for the GPU, returning the
   * mean time per frame and the draw statistics. Used to measure performance.
   */
  benchmark(frames = 8): { ms: number; calls: number; triangles: number; nodes: number; detailedTrees: number } {
    if (!this.terrain) return { ms: 0, calls: 0, triangles: 0, nodes: 0, detailedTrees: 0 };
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    this.rig.cur = { ...this.rig.goal };
    this.updateCamera();
    this.fitShadow();
    this.renderer.render(this.scene, this.camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      this.terrain.update(this.camera);
      this.trees?.update(this.camera);
      this.renderer.render(this.scene, this.camera);
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ms = (performance.now() - t0) / frames;
    this.dirty = true;
    const info = this.renderer.info.render;
    return { ms, calls: info.calls, triangles: info.triangles, nodes: this.terrain.nodeCount, detailedTrees: this.trees?.visibleDetailed ?? 0 };
  }

  // ------------------------------------------------------------ still image

  async saveImage(width: number, height: number, onProgress: (f: number, msg: string) => void, isCancelled: () => boolean): Promise<StillResult> {
    if (!this.terrain || this.lost) throw new Error('The game view is not ready.');
    this.stilling = true;
    const sun = this.atm.sun;
    try {
      const cam = this.camera.clone();
      cam.aspect = width / height;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      this.terrain.splitK = 4.2;
      this.terrain.update(cam);
      this.trees?.update(cam, 1.6);
      this.fitShadow();
      const base = sun.position.clone().sub(sun.target.position).normalize();
      const target = sun.target.position.clone();
      const dist = sun.position.distanceTo(target);
      const u = new THREE.Vector3().crossVectors(base, new THREE.Vector3(0, 1, 0)).normalize();
      const w = new THREE.Vector3().crossVectors(base, u).normalize();
      const res = await renderStill(this.renderer, this.scene, cam, {
        width, height, exposure: GAME_EXPOSURE, onProgress, isCancelled,
        isLost: () => this.lost || this.disposed,
        beforeSample: (k) => {
          const a = Math.sin(k * 2.399) * Math.sqrt(k / 32) * 0.012;
          const b = Math.cos(k * 2.399) * Math.sqrt(k / 32) * 0.012;
          const d = base.clone().addScaledVector(u, a).addScaledVector(w, b).normalize();
          sun.position.copy(target).addScaledVector(d, dist);
          sun.shadow.needsUpdate = true;
        },
      });
      res.notes.unshift(...this.notes);
      return res;
    } finally {
      this.stilling = false;
      this.terrain.splitK = 3.2;
      this.dirty = true;
    }
  }

  // ------------------------------------------------------------ loop

  private start(): void {
    if (this.raf || this.disposed || document.hidden) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    if (this.disposed || document.hidden) return;
    const dt = (now - this.last) / 1000;
    this.last = now;
    const moving = this.rig.update(dt) || this.rig.active();
    if (moving) this.dirty = true;
    if (this.dirty && !this.stilling && !this.lost && this.terrain) {
      this.dirty = false;
      const t0 = performance.now();
      this.updateCamera();
      this.terrain.update(this.camera);
      this.trees?.update(this.camera);
      this.fitShadow();
      this.sky.position.copy(this.camera.position);
      this.renderer.render(this.scene, this.camera);
      this.labels.update({
        project: (x, y, z, out) => this.project(new THREE.Vector3(x, y, z), out),
        camera: this.camera.position, width: this.cssW, height: this.cssH,
      });
      this.frameMs = this.frameMs * 0.8 + (performance.now() - t0) * 0.2;
      this.emitView();
      this.onFrame?.();
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private updateCamera(): void {
    const s = this.rig.cur;
    const ty = this.rig.groundAt(s.tx, s.tz);
    const [x, y, z] = poseOf(s, ty);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(s.tx, ty, s.tz);
    const above = y - this.rig.groundAt(x, z);
    this.camera.near = Math.max(0.3, Math.min(50, above * 0.25, s.distance * 0.05));
    this.camera.far = Math.max(60000, s.distance * 8);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** Shadow camera around the point the camera looks at, sized by viewing distance. */
  private fitShadow(): void {
    const s = this.rig.cur;
    const ty = this.rig.groundAt(s.tx, s.tz);
    const centre = new THREE.Vector3(s.tx, ty, s.tz);
    const radius = Math.max(250, Math.min(6000, s.distance * 1.4));
    const sun = this.atm.sun;
    const sc = sun.shadow.camera;
    sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
    sc.near = 10;
    sc.far = radius * 2 + 12000;
    sc.updateProjectionMatrix();
    sun.shadow.normalBias = ((2 * radius) / sun.shadow.mapSize.x) * 0.9;
    this.atm.aimSun(centre, radius + 6000);
  }

  private emitView(): void {
    if (!this.onView) return;
    const s = this.rig.cur;
    const cam = this.camera.position;
    this.onView({
      metresPerPx: metresPerPixel(s.distance, this.camera.fov, this.cssH),
      heightAboveGround: cam.y - this.rig.groundAt(cam.x, cam.z),
    });
  }

  private resize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w < 2 || h < 2) return;
    this.cssW = w;
    this.cssH = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pxScale.value = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
    this.dirty = true;
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else {
      this.dirty = true;
      this.start();
    }
  };

  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.lost = true;
    this.onContext?.(true);
  };

  private readonly onRestored = (): void => {
    this.lost = false;
    // three re-uploads geometry and textures lazily after a restore
    this.dirty = true;
    this.onContext?.(false);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    const el = this.renderer.domElement;
    el.removeEventListener('webglcontextlost', this.onLost);
    el.removeEventListener('webglcontextrestored', this.onRestored);
    this.rig.dispose();
    this.labels.dispose();
    for (const k of Object.keys(this.objs)) disposeObject(this.objs[k]);
    this.objs = {};
    this.trees?.dispose();
    if (this.terrain) disposeObject(this.terrain.mesh);
    this.gpu?.dispose();
    this.quickGpu?.dispose();
    this.atm.sun.shadow.dispose();
    disposeObject(this.sky);
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    el.remove();
    this.onView = null;
    this.onFrame = null;
  }
}
