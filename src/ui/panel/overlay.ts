import { CS2, type BuildResult, type Pt, type RoadClass } from '../../core/types';

export const OVERLAY_SIZE = 4096;

/** Game metres to overlay pixels. Row 0 = top (max gz), per the Grid convention in types.ts. */
export function gameToPixel(gx: number, gz: number, size = OVERLAY_SIZE, extentM: number = CS2.PLAYABLE_SIZE_M): Pt {
  return [(gx / extentM + 0.5) * size, (0.5 - gz / extentM) * size];
}

export interface RoadStyle {
  width: number;
  color: string;
  dash?: number[];
}

/** Line style in pixels (4096 px over 14336 m is about 0.29 px per metre). */
export function roadStyle(cls: RoadClass): RoadStyle {
  switch (cls) {
    case 'motorway':
      return { width: 14, color: 'rgba(255,152,0,0.95)' };
    case 'trunk':
      return { width: 11, color: 'rgba(255,183,77,0.95)' };
    case 'primary':
      return { width: 9, color: 'rgba(255,235,59,0.95)' };
    case 'secondary':
      return { width: 7, color: 'rgba(255,255,255,0.95)' };
    case 'tertiary':
      return { width: 5, color: 'rgba(255,255,255,0.9)' };
    case 'rail':
    case 'tram':
    case 'subway':
      return { width: 5, color: 'rgba(30,30,40,0.95)', dash: [18, 14] };
    default:
      return { width: 3, color: 'rgba(255,255,255,0.85)' };
  }
}

/** Draw order: thin first so the big roads end up on top. */
const ORDER: RoadClass[] = [
  'pedestrian', 'service', 'residential', 'tram', 'subway', 'rail', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway',
];

interface Ctx2D {
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(rule?: 'evenodd' | 'nonzero'): void;
  stroke(): void;
  setLineDash(d: number[]): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
}

function tracePolys(ctx: Ctx2D, rings: Pt[][], size: number): void {
  ctx.beginPath();
  for (const ring of rings) {
    if (ring.length < 3) continue;
    ring.forEach((p, i) => {
      const [x, y] = gameToPixel(p[0], p[1], size);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
}

/** Draws the reference layers onto a transparent canvas context. Pure drawing, no DOM access. */
export function drawOverlay(ctx: Ctx2D, result: BuildResult, size = OVERLAY_SIZE): void {
  ctx.clearRect(0, 0, size, size);
  const v = result.vectors;

  if (v) {
    ctx.fillStyle = 'rgba(110,190,110,0.22)';
    for (const a of v.areas) {
      if (a.kind !== 'forest' && a.kind !== 'park') continue;
      tracePolys(ctx, a.rings, size);
      ctx.fill('evenodd');
    }
    ctx.fillStyle = 'rgba(52,130,230,0.55)';
    for (const w of v.waterPolygons) {
      tracePolys(ctx, w.rings, size);
      ctx.fill('evenodd');
    }
  }

  const lines: { cls: RoadClass; pts: Pt[] }[] = result.roads?.edges.length
    ? result.roads.edges.map((e) => ({ cls: e.cls, pts: e.pts }))
    : (v?.ways ?? []).map((w) => ({ cls: w.cls, pts: w.pts }));

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const cls of ORDER) {
    const st = roadStyle(cls);
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.width;
    ctx.setLineDash(st.dash ?? []);
    ctx.beginPath();
    for (const l of lines) {
      if (l.cls !== cls || l.pts.length < 2) continue;
      l.pts.forEach((p, i) => {
        const [x, y] = gameToPixel(p[0], p[1], size);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/** Renders the overlay as PNG bytes. Uses OffscreenCanvas when available. */
export async function renderOverlayPng(result: BuildResult, size = OVERLAY_SIZE): Promise<Uint8Array> {
  let blob: Blob | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Could not create a drawing surface');
    drawOverlay(ctx as unknown as Ctx2D, result, size);
    blob = await c.convertToBlob({ type: 'image/png' });
  } else {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Could not create a drawing surface');
    drawOverlay(ctx, result, size);
    blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  }
  if (!blob) throw new Error('Could not create the PNG image');
  return new Uint8Array(await blob.arrayBuffer());
}
