/**
 * Owns the WebGL renderer, camera, controls and the built scene objects of the 3D preview.
 * Framework-free so React only has to create it, feed it `result` / `layers` and dispose it.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BuildResult } from '../../core/types';
import type { AppState } from '../store';
import { Atmosphere, buildSkyDome } from './atmosphere';
import { metresPerPixel } from './scaleBar';
import {
  buildBorder,
  buildConnectionPins,
  buildHouses,
  buildRoads,
  buildStartTile,
  buildTerrainMesh,
  buildTileGrid,
  buildTrees,
  buildWater,
  buildWorldMesh,
  buildZoneCells,
  connectionAnchor,
  createGpuShared,
  disposeObject,
  prepareResult,
  type BuildCtx,
  type GpuShared,
  type Prepared,
} from './sceneBuilders';
import { startRender, type RenderJob, type RenderOptions, type RenderProgress } from './renderMode';

export type Layers = AppState['layers'];
/** Preview-only layers that are not in the store. */
export interface ExtraLayers {
  zones: boolean;
  houses: boolean;
}
type LayerKey = 'terrain' | 'border' | 'world' | 'water' | 'roads' | 'trees' | 'grid' | 'startTile' | 'zones' | 'houses' | 'connections';

export interface ViewInfo {
  /** ground metres per CSS pixel at the orbit target */
  metresPerPx: number;
  /** camera height above the ground below it, metres */
  heightAboveGround: number;
}

export const DEFAULT_HOUR = 15.5;
export const EXPOSURE = 0.82;

export class PreviewEngine {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly atm = new Atmosphere();
  private readonly sky: THREE.Mesh;
  private readonly content = new THREE.Group();
  private readonly resizeObserver: ResizeObserver;
  private readonly pxScale = { value: 0.001 };

  private raf = 0;
  private dirty = true;
  private disposed = false;
  private contextLost = false;
  private rendering = false;
  private renderJob: RenderJob | null = null;
  private prepared: Prepared | null = null;
  private gpu: GpuShared | null = null;
  private result: BuildResult | null = null;
  private layers: Layers = { water: true, roads: true, trees: true, grid: true, world: true, startTile: true };
  private extra: ExtraLayers = { zones: false, houses: false };
  private objs: Partial<Record<LayerKey, THREE.Object3D | null>> = {};
  private hour = DEFAULT_HOUR;
  private cssHeight = 1;

  /** called after every rendered frame (markers follow the camera) */
  onFrame: (() => void) | null = null;
  /** called when the view changed (scale bar, camera height) */
  onView: ((v: ViewInfo) => void) | null = null;
  /** called when the result changed and the scene was rebuilt */
  onContextChange: ((lost: boolean) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene.add(this.content);
    this.camera = new THREE.PerspectiveCamera(40, 1, 50, 400_000);

    this.scene.add(this.atm.hemi, this.atm.sun, this.atm.sun.target);
    this.sky = buildSkyDome(this.atm);
    this.scene.add(this.sky);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.rotateSpeed = 0.6;
    controls.minDistance = 30;
    controls.maxDistance = 140_000;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.addEventListener('change', () => { this.dirty = true; });
    this.controls = controls;

    this.resetView();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    document.addEventListener('visibilitychange', this.onVisibility);
    renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
    this.resize();
    this.start();
  }

  // ------------------------------------------------------------ public API

  setResult(result: BuildResult | null): void {
    if (result === this.result) return;
    const prevSel = this.result?.selection;
    this.result = result;
    this.cancelRender();
    this.clearContent();
    this.prepared = result ? prepareResult(result) : null;
    if (this.prepared) {
      this.gpu = createGpuShared(this.prepared);
      this.atm.uniforms.uSeaLevelY.value = this.prepared.seaLevel;
      this.syncSun();
      this.ensure('terrain');
      this.ensure('border');
    }
    this.applyLayers();
    // keep the camera when only the same selection was rebuilt
    const sel = result?.selection;
    const same = prevSel && sel && prevSel.centerLat === sel.centerLat && prevSel.centerLon === sel.centerLon && prevSel.sizeMeters === sel.sizeMeters;
    if (!same) this.resetView();
    this.dirty = true;
  }

  setLayers(layers: Layers): void {
    this.layers = layers;
    this.applyLayers();
    this.dirty = true;
  }

  setExtraLayers(extra: ExtraLayers): void {
    this.extra = extra;
    this.applyLayers();
    this.dirty = true;
  }

  /** Local solar hour of the sun (summer day at the map's latitude). */
  setHour(hour: number): void {
    this.hour = hour;
    this.syncSun();
    this.dirty = true;
  }

  getHour(): number {
    return this.hour;
  }

  hasResult(): boolean {
    return this.prepared !== null;
  }

  resetView(): void {
    const p = this.prepared;
    const ty = p ? p.meanHeight : 0;
    const extent = p ? p.result.terrain.playable.extentM : 14336;
    // narrow panes need more distance so the whole square stays in view
    const aspect = Math.max(0.3, this.camera.aspect || 1);
    const dist = extent * 1.3 * Math.max(1, 1.25 / aspect);
    this.controls.target.set(0, ty, extent * 0.02);
    this.camera.position.set(0, ty + dist * 0.6, extent * 0.02 + dist * 0.8);
    this.controls.update();
    this.dirty = true;
  }

  /** Moves the camera (scene coordinates); used by tests and dev tools. */
  lookAt(target: [number, number, number], position: [number, number, number]): void {
    this.controls.target.set(...target);
    this.camera.position.set(...position);
    this.controls.update();
    this.dirty = true;
  }

  /** Scene positions of the outside connections, for HTML labels. */
  connectionAnchors(): THREE.Vector3[] {
    const p = this.prepared;
    const list = p?.result.playability?.outsideConnections ?? [];
    return p ? list.map((c) => connectionAnchor(p, c)) : [];
  }

  /** Projects a scene point to container pixels; null when behind the camera. */
  project(v: THREE.Vector3, out: { x: number; y: number }): boolean {
    const t = v.clone().project(this.camera);
    if (t.z > 1 || t.z < -1) return false;
    out.x = (t.x * 0.5 + 0.5) * this.container.clientWidth;
    out.y = (-t.y * 0.5 + 0.5) * this.container.clientHeight;
    return true;
  }

  connectionsVisible(): boolean {
    return this.layers.startTile;
  }

  /** Starts the high-quality render of the current view. */
  render(opts: Omit<RenderOptions, 'exposure'>, onProgress: (p: RenderProgress) => void): RenderJob | null {
    const p = this.prepared;
    if (!p || this.contextLost) return null;
    this.cancelRender();
    this.rendering = true;
    const job = startRender(
      {
        renderer: this.renderer,
        camera: this.camera,
        prepared: p,
        layers: this.layers,
        isContextLost: () => this.contextLost || this.disposed,
      },
      { ...opts, exposure: EXPOSURE },
      onProgress,
    );
    this.renderJob = job;
    const finish = (): void => {
      if (this.renderJob === job) {
        this.renderJob = null;
        this.rendering = false;
        this.dirty = true;
        this.resize();
      }
    };
    job.promise.then(finish, finish);
    return job;
  }

  cancelRender(): void {
    this.renderJob?.cancel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRender();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.controls.dispose();
    this.clearContent();
    disposeObject(this.sky);
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.onFrame = null;
    this.onView = null;
  }

  // ------------------------------------------------------------ scene content

  private syncSun(): void {
    const r = this.result;
    const lat = r?.climate?.latitude ?? r?.selection.centerLat ?? 60;
    this.atm.set(lat, r?.selection.rotationDeg ?? 0, this.hour);
  }

  private clearContent(): void {
    for (const k of Object.keys(this.objs) as LayerKey[]) disposeObject(this.objs[k]);
    this.objs = {};
    this.gpu?.dispose();
    this.gpu = null;
  }

  private ctx(): BuildCtx | null {
    if (!this.prepared || !this.gpu) return null;
    return { p: this.prepared, atm: this.atm, gpu: this.gpu, pxScale: this.pxScale };
  }

  /** Builds the object of a layer on first use (lazy), returns it. */
  private ensure(key: LayerKey): THREE.Object3D | null {
    const ctx = this.ctx();
    if (!ctx) return null;
    if (key in this.objs) return this.objs[key] ?? null;
    let o: THREE.Object3D | null = null;
    switch (key) {
      case 'terrain': o = buildTerrainMesh(ctx); break;
      case 'border': o = buildBorder(ctx); break;
      case 'world': o = buildWorldMesh(ctx); break;
      case 'water': o = buildWater(ctx); break;
      case 'roads': o = buildRoads(ctx); break;
      case 'trees': o = buildTrees(ctx); break;
      case 'grid': o = buildTileGrid(ctx); break;
      case 'startTile': o = buildStartTile(ctx); break;
      case 'zones': o = buildZoneCells(ctx); break;
      case 'houses': o = buildHouses(ctx); break;
      case 'connections': o = buildConnectionPins(ctx); break;
    }
    this.objs[key] = o;
    if (o) this.content.add(o);
    return o;
  }

  private applyLayers(): void {
    if (!this.prepared) return;
    const l = this.layers;
    const want: [LayerKey, boolean][] = [
      ['world', l.world], ['water', l.water], ['roads', l.roads], ['trees', l.trees], ['grid', l.grid],
      ['startTile', l.startTile], ['connections', l.startTile],
      ['zones', this.extra.zones], ['houses', this.extra.houses],
    ];
    for (const [k, on] of want) {
      const existing = this.objs[k];
      if (on) {
        const o = existing ?? this.ensure(k);
        if (o) o.visible = true;
      } else if (existing) {
        existing.visible = false;
      }
    }
  }

  // ------------------------------------------------------------ loop

  private start(): void {
    if (this.raf || this.disposed || document.hidden) return;
    this.raf = requestAnimationFrame(this.tick);
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

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    this.cancelRender();
    this.onContextChange?.(true);
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    // three re-uploads buffers lazily; rebuild GPU-side textures and objects to be safe
    const r = this.result;
    const target = this.controls.target.clone();
    const pos = this.camera.position.clone();
    this.result = null;
    this.setResult(r);
    this.controls.target.copy(target);
    this.camera.position.copy(pos);
    this.controls.update();
    this.dirty = true;
    this.onContextChange?.(false);
  };

  private readonly tick = (): void => {
    this.raf = 0;
    if (this.disposed || document.hidden) return;
    this.controls.update();
    this.constrainCamera();
    if (this.dirty && !this.rendering && !this.contextLost) {
      this.dirty = false;
      this.updatePlanes();
      this.sky.position.copy(this.camera.position);
      this.renderer.render(this.scene, this.camera);
      this.emitView();
      this.onFrame?.();
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private emitView(): void {
    if (!this.onView) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const p = this.prepared;
    const cam = this.camera.position;
    const ground = p ? Math.max(p.groundAt(cam.x, cam.z), p.result.terrain.hasSea ? p.seaLevel : -Infinity) : 0;
    this.onView({
      metresPerPx: metresPerPixel(dist, this.camera.fov, this.cssHeight),
      heightAboveGround: cam.y - ground,
    });
  }

  /** Keeps the camera above the ground and the orbit target inside the world. */
  private constrainCamera(): void {
    const cam = this.camera.position;
    const t = this.controls.target;
    const lim = 50_000;
    if (Math.abs(t.x) > lim || Math.abs(t.z) > lim) {
      t.x = Math.max(-lim, Math.min(lim, t.x));
      t.z = Math.max(-lim, Math.min(lim, t.z));
    }
    const p = this.prepared;
    const sea = p ? p.seaLevel : 0;
    const ground = p ? Math.max(p.groundAt(cam.x, cam.z), sea) : 0;
    const minY = ground + 8;
    if (cam.y < minY) {
      cam.y = minY;
      this.dirty = true;
    }
  }

  private updatePlanes(): void {
    const cam = this.camera;
    const dist = cam.position.distanceTo(this.controls.target);
    const p = this.prepared;
    const above = p ? cam.position.y - p.groundAt(cam.position.x, cam.position.z) : cam.position.y;
    const near = Math.max(0.5, Math.min(300, Math.min(dist, Math.max(above, 8)) * 0.04));
    if (Math.abs(near - cam.near) / cam.near > 0.05) {
      cam.near = near;
      cam.updateProjectionMatrix();
    }
  }

  private resize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w < 2 || h < 2) return;
    this.cssHeight = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pxScale.value = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
    this.dirty = true;
  }
}
