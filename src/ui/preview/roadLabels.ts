/**
 * Road name labels: candidate positions along named edges (pure) and a small DOM layer that
 * places them each frame, major roads first, decluttered by screen space and camera distance.
 */
import type { RoadClass, RoadNetwork } from '../../core/types';
import { CLASS_RANK, pointAt } from './roadNetwork';

export interface LabelCandidate {
  text: string;
  /** scene position and unit direction along the road */
  x: number;
  z: number;
  dx: number;
  dz: number;
  rank: number;
  /** hidden when the camera is farther than this (metres) */
  maxDist: number;
}

const MAX_DIST: Record<RoadClass, number> = {
  motorway: 40000, trunk: 30000, primary: 14000, secondary: 9000, tertiary: 5000,
  residential: 2400, service: 1200, pedestrian: 800, rail: 3000, tram: 2500, subway: 0,
};

/** Label text of an edge: its name, else its route reference when present. */
export function labelText(e: { name?: string; ref?: string }): string | undefined {
  const t = e.name?.trim() || e.ref?.trim();
  return t ? t : undefined;
}

/**
 * One candidate per named edge midpoint, thinned so the same name repeats at most every
 * `spacing` metres. Sorted by importance, longest edges first.
 */
export function labelCandidates(net: RoadNetwork, spacing = 350): LabelCandidate[] {
  const byName = new Map<string, { len: number; x: number; z: number; dx: number; dz: number; rank: number; maxDist: number }[]>();
  for (const e of net.edges) {
    if (e.cls === 'subway' || e.pts.length < 2) continue;
    const text = labelText(e as { name?: string; ref?: string });
    if (!text) continue;
    let len = 0;
    for (let i = 1; i < e.pts.length; i++) len += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
    if (len < 30) continue;
    const m = pointAt(e.pts, len / 2);
    const a = pointAt(e.pts, Math.max(0, len / 2 - 8));
    const b = pointAt(e.pts, Math.min(len, len / 2 + 8));
    const dx = b[0] - a[0];
    const dz = -(b[1] - a[1]);
    const l = Math.hypot(dx, dz) || 1;
    const list = byName.get(text) ?? [];
    list.push({ len, x: m[0], z: -m[1], dx: dx / l, dz: dz / l, rank: CLASS_RANK[e.cls] ?? 1, maxDist: MAX_DIST[e.cls] ?? 2000 });
    byName.set(text, list);
  }
  const out: LabelCandidate[] = [];
  for (const [text, list] of byName) {
    list.sort((p, q) => q.len - p.len);
    const kept: typeof list = [];
    for (const c of list) {
      if (kept.every((k) => Math.hypot(k.x - c.x, k.z - c.z) >= spacing)) kept.push(c);
    }
    for (const c of kept) out.push({ text, x: c.x, z: c.z, dx: c.dx, dz: c.dz, rank: c.rank, maxDist: c.maxDist });
  }
  out.sort((p, q) => q.rank - p.rank);
  return out;
}

interface Rect { x0: number; y0: number; x1: number; y1: number }

/** Greedy declutter: accepts rectangles that do not overlap any accepted one. */
export function acceptRect(placed: Rect[], r: Rect, pad = 4): boolean {
  for (const p of placed) {
    if (r.x0 < p.x1 + pad && r.x1 > p.x0 - pad && r.y0 < p.y1 + pad && r.y1 > p.y0 - pad) return false;
  }
  placed.push(r);
  return true;
}

export interface LabelProjector {
  /** scene point to container pixels; false when behind the camera or off screen */
  project(x: number, y: number, z: number, out: { x: number; y: number }): boolean;
  camera: { x: number; y: number; z: number };
  width: number;
  height: number;
}

/** Pool of absolutely positioned spans in an overlay element. */
export class LabelLayer {
  private readonly root: HTMLDivElement;
  private readonly pool: HTMLDivElement[] = [];
  private candidates: LabelCandidate[] = [];
  private heightAt: (x: number, z: number) => number = () => 0;
  max = 40;
  visible = false;

  constructor(parent: HTMLElement) {
    const root = document.createElement('div');
    root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    parent.appendChild(root);
    this.root = root;
  }

  setData(net: RoadNetwork | undefined, heightAt: (x: number, z: number) => number): void {
    this.candidates = net ? labelCandidates(net) : [];
    this.heightAt = heightAt;
  }

  get count(): number {
    return this.candidates.length;
  }

  private span(i: number): HTMLDivElement {
    let el = this.pool[i];
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;font:500 11px system-ui,sans-serif;color:#f4f6f8;'
        + 'text-shadow:0 0 3px #10161b,0 0 2px #10161b,0 1px 2px #10161b;will-change:transform;';
      this.root.appendChild(el);
      this.pool.push(el);
    }
    return el;
  }

  update(p: LabelProjector): void {
    let used = 0;
    if (this.visible) {
      const placed: Rect[] = [];
      const pt = { x: 0, y: 0 };
      const q = { x: 0, y: 0 };
      for (const c of this.candidates) {
        if (used >= this.max) break;
        const dist = Math.hypot(c.x - p.camera.x, c.z - p.camera.z, this.heightAt(c.x, c.z) - p.camera.y);
        if (dist > c.maxDist) continue;
        const y = this.heightAt(c.x, c.z) + 2;
        if (!p.project(c.x, y, c.z, pt)) continue;
        if (pt.x < -50 || pt.y < -20 || pt.x > p.width + 50 || pt.y > p.height + 20) continue;
        if (!p.project(c.x + c.dx * 30, y, c.z + c.dz * 30, q)) continue;
        let ang = Math.atan2(q.y - pt.y, q.x - pt.x);
        if (ang > Math.PI / 2) ang -= Math.PI;
        if (ang < -Math.PI / 2) ang += Math.PI;
        const w = c.text.length * 6.2 + 6;
        const hgt = 14;
        const cs = Math.abs(Math.cos(ang));
        const sn = Math.abs(Math.sin(ang));
        const bw = w * cs + hgt * sn;
        const bh = w * sn + hgt * cs;
        if (!acceptRect(placed, { x0: pt.x - bw / 2, y0: pt.y - bh / 2, x1: pt.x + bw / 2, y1: pt.y + bh / 2 })) continue;
        const el = this.span(used++);
        if (el.textContent !== c.text) el.textContent = c.text;
        el.style.display = '';
        el.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px) translate(-50%, -50%) rotate(${ang.toFixed(3)}rad)`;
      }
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }

  dispose(): void {
    this.root.remove();
    this.pool.length = 0;
  }
}
