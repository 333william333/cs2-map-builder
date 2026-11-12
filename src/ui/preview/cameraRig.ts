/**
 * Game-like camera for the game view: a target on the ground, yaw, pitch and distance.
 * WASD / arrow keys move, Q / E rotate, the wheel zooms, right or middle drag orbits and left drag
 * pans. Movement is smoothed, the target stays inside the map and the camera never goes below the
 * terrain. The pose math is pure and unit-tested.
 */

export interface RigState {
  /** scene x / z of the point the camera looks at */
  tx: number;
  tz: number;
  /** radians, 0 = looking towards -z (north) */
  yaw: number;
  /** radians above the horizon, looking down */
  pitch: number;
  distance: number;
}

export interface RigLimits {
  /** |tx|, |tz| at most this */
  half: number;
  minDistance: number;
  maxDistance: number;
  minPitch: number;
  maxPitch: number;
  /** metres the camera keeps above the ground */
  clearance: number;
}

export const DEFAULT_LIMITS: RigLimits = {
  half: 7168,
  minDistance: 12,
  maxDistance: 32000,
  minPitch: 0.07,
  maxPitch: 1.53,
  clearance: 3,
};

export function clampState(s: RigState, lim: RigLimits): RigState {
  return {
    tx: Math.max(-lim.half, Math.min(lim.half, s.tx)),
    tz: Math.max(-lim.half, Math.min(lim.half, s.tz)),
    yaw: s.yaw,
    pitch: Math.max(lim.minPitch, Math.min(lim.maxPitch, s.pitch)),
    distance: Math.max(lim.minDistance, Math.min(lim.maxDistance, s.distance)),
  };
}

/** Camera position for a state, with the target at height `ty`. */
export function poseOf(s: RigState, ty: number): [number, number, number] {
  const h = Math.cos(s.pitch) * s.distance;
  return [s.tx + Math.sin(s.yaw) * h, ty + Math.sin(s.pitch) * s.distance, s.tz + Math.cos(s.yaw) * h];
}

/** Moves the target in the camera's ground frame: forward/right in metres. */
export function moveTarget(s: RigState, forward: number, right: number): RigState {
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  return { ...s, tx: s.tx + fx * forward + -fz * right, tz: s.tz + fz * forward + fx * right };
}

/** Smallest pitch that keeps the camera `clearance` above `groundAt` along the view (a few probes). */
export function liftPitch(s: RigState, ty: number, groundAt: (x: number, z: number) => number, clearance: number, maxPitch: number): number {
  let pitch = s.pitch;
  for (let k = 0; k < 12; k++) {
    const [x, y, z] = poseOf({ ...s, pitch }, ty);
    if (y >= groundAt(x, z) + clearance || pitch >= maxPitch) break;
    pitch = Math.min(maxPitch, pitch + 0.04);
  }
  return pitch;
}

/** Exponential approach factor for smoothing at a given frame time. */
export function smoothing(dt: number, rate: number): number {
  return 1 - Math.exp(-rate * dt);
}

type Listener = [EventTarget, string, EventListenerOrEventListenerObject, AddEventListenerOptions | undefined];

/** Input handling and smoothing on top of the pure pose math. */
export class CameraRig {
  goal: RigState;
  cur: RigState;
  limits: RigLimits;
  private readonly keys = new Set<string>();
  private readonly listeners: Listener[] = [];
  private drag: { mode: 'orbit' | 'pan'; x: number; y: number } | null = null;
  private readonly el: HTMLElement;
  /** set by the owner: ground height at scene x/z */
  groundAt: (x: number, z: number) => number = () => 0;
  onChange: (() => void) | null = null;

  constructor(el: HTMLElement, start: RigState, limits: RigLimits = DEFAULT_LIMITS) {
    this.el = el;
    this.limits = limits;
    this.goal = clampState(start, limits);
    this.cur = { ...this.goal };
    const on = (t: EventTarget, type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions): void => {
      t.addEventListener(type, fn, opts);
      this.listeners.push([t, type, fn, opts]);
    };
    on(window, 'keydown', this.onKey as EventListener);
    on(window, 'keyup', this.onKeyUp as EventListener);
    on(window, 'blur', () => this.keys.clear());
    on(el, 'wheel', this.onWheel as EventListener, { passive: false });
    on(el, 'pointerdown', this.onDown as EventListener);
    on(window, 'pointermove', this.onMove as EventListener);
    on(window, 'pointerup', this.onUp as EventListener);
    on(el, 'contextmenu', (e) => e.preventDefault());
  }

  dispose(): void {
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
    this.keys.clear();
  }

  set(s: RigState, immediate = false): void {
    this.goal = clampState(s, this.limits);
    if (immediate) this.cur = { ...this.goal };
    this.onChange?.();
  }

  /** Advances the smoothing; returns true while the camera is still moving. */
  update(dt: number): boolean {
    dt = Math.min(0.1, Math.max(0, dt));
    const g = this.goal;
    // keyboard
    const speed = Math.max(20, g.distance * 0.9) * dt;
    let f = 0;
    let r = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) f += speed;
    if (this.keys.has('s') || this.keys.has('arrowdown')) f -= speed;
    if (this.keys.has('d') || this.keys.has('arrowright')) r += speed;
    if (this.keys.has('a') || this.keys.has('arrowleft')) r -= speed;
    let yaw = g.yaw;
    if (this.keys.has('q')) yaw += 1.6 * dt;
    if (this.keys.has('e')) yaw -= 1.6 * dt;
    if (f !== 0 || r !== 0 || yaw !== g.yaw) this.goal = clampState({ ...moveTarget(g, f, r), yaw }, this.limits);

    const k = smoothing(dt, 12);
    const c = this.cur;
    const n: RigState = {
      tx: c.tx + (this.goal.tx - c.tx) * k,
      tz: c.tz + (this.goal.tz - c.tz) * k,
      yaw: c.yaw + (this.goal.yaw - c.yaw) * k,
      pitch: c.pitch + (this.goal.pitch - c.pitch) * k,
      distance: c.distance * Math.pow(this.goal.distance / c.distance, k),
    };
    const ty = this.groundAt(n.tx, n.tz);
    n.pitch = liftPitch(n, ty, this.groundAt, this.limits.clearance, this.limits.maxPitch);
    const moving =
      Math.abs(n.tx - c.tx) + Math.abs(n.tz - c.tz) > 0.01 ||
      Math.abs(n.yaw - c.yaw) + Math.abs(n.pitch - c.pitch) > 1e-5 ||
      Math.abs(n.distance - c.distance) > 0.01;
    this.cur = n;
    return moving;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      this.keys.add(k);
      e.preventDefault();
      this.onChange?.();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  /** true while a movement key is held */
  active(): boolean {
    return this.keys.size > 0 || this.drag !== null;
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const factor = Math.exp(dy * 0.0015);
    this.goal = clampState({ ...this.goal, distance: this.goal.distance * factor }, this.limits);
    this.onChange?.();
  };

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button === 2 || e.button === 1) this.drag = { mode: 'orbit', x: e.clientX, y: e.clientY };
    else if (e.button === 0) this.drag = { mode: 'pan', x: e.clientX, y: e.clientY };
    if (this.drag) {
      e.preventDefault();
      this.el.focus?.();
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    const g = this.goal;
    if (d.mode === 'orbit') {
      this.goal = clampState({ ...g, yaw: g.yaw - dx * 0.005, pitch: g.pitch + dy * 0.004 }, this.limits);
    } else {
      // pan: ground metres per pixel at the target
      const h = Math.max(1, this.el.clientHeight);
      const mpp = (2 * g.distance * Math.tan((40 * Math.PI) / 360)) / h;
      const fwd = dy * mpp / Math.max(0.3, Math.sin(g.pitch));
      this.goal = clampState(moveTarget(g, fwd, -dx * mpp), this.limits);
    }
    this.onChange?.();
  };

  private readonly onUp = (): void => {
    this.drag = null;
  };
}
