import type { OutsideConnection, RoadNetwork } from '../../core/types';
import { CS2 } from '../../core/types';
import { sideOf } from '../../core/manual/border';
import {
  BADGE_OFFSET, BADGE_RADIUS, MARKER_RADIUS, gameToCanvas, tileBounds, type EditorView, type Tile,
} from './editorGeometry';
import { KIND_COLOR, KIND_LABEL, type EditorMarker } from './editorModel';
import { ROAD_DRAW_ORDER, ROAD_STYLE } from './editorRender';

export type ToolId = 'start' | OutsideConnection['kind'] | 'remove';

export interface DrawState {
  view: EditorView;
  dpr: number;
  backdrop: HTMLCanvasElement | null;
  roads?: RoadNetwork;
  markers: EditorMarker[];
  startTile: Tile | null;
  manualStart: boolean;
  hoverTile: Tile | null;
  /** marker following the pointer (or keyboard cursor) while a connection tool is active */
  preview: { kind: OutsideConnection['kind']; p: [number, number] } | null;
}

const BG = '#0e1317';
const ACCENT = '#4fd1b5';
const TEXT = '#e6edf3';
const DANGER = '#ef6b6b';

/** Draws one small icon (about 12 px square) centred on cx, cy. */
export function drawGlyph(ctx: CanvasRenderingContext2D, kind: OutsideConnection['kind'], cx: number, cy: number, color: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (kind) {
    case 'road':
      ctx.moveTo(-5, 6); ctx.lineTo(-2, -6);
      ctx.moveTo(5, 6); ctx.lineTo(2, -6);
      ctx.stroke();
      ctx.beginPath();
      ctx.lineWidth = 1.4;
      ctx.moveTo(0, 5); ctx.lineTo(0, 2);
      ctx.moveTo(0, -1); ctx.lineTo(0, -4);
      break;
    case 'rail':
      ctx.moveTo(-3, -6); ctx.lineTo(-3, 6);
      ctx.moveTo(3, -6); ctx.lineTo(3, 6);
      ctx.moveTo(-3, -3); ctx.lineTo(3, -3);
      ctx.moveTo(-3, 0); ctx.lineTo(3, 0);
      ctx.moveTo(-3, 3); ctx.lineTo(3, 3);
      break;
    case 'ship':
      ctx.moveTo(-6, 1); ctx.lineTo(6, 1); ctx.lineTo(3.5, 5); ctx.lineTo(-3.5, 5); ctx.closePath();
      ctx.moveTo(0, 1); ctx.lineTo(0, -6);
      ctx.moveTo(0, -5); ctx.lineTo(4, -1); ctx.lineTo(0, -1);
      break;
    case 'air':
      ctx.moveTo(0, -6); ctx.lineTo(0, 6);
      ctx.moveTo(-6, 0); ctx.lineTo(6, 0);
      ctx.moveTo(-3, 5.5); ctx.lineTo(3, 5.5);
      break;
    case 'power':
      ctx.moveTo(2, -6.5); ctx.lineTo(-4, 1); ctx.lineTo(0, 1); ctx.lineTo(-2, 6.5); ctx.lineTo(4, -1.5); ctx.lineTo(0, -1.5); ctx.closePath();
      break;
    case 'water':
      ctx.moveTo(0, -6.5);
      ctx.quadraticCurveTo(6.5, 1, 4.5, 3.5);
      ctx.quadraticCurveTo(0, 8.5, -4.5, 3.5);
      ctx.quadraticCurveTo(-6.5, 1, 0, -6.5);
      break;
  }
  ctx.stroke();
  ctx.restore();
}

function drawMarker(ctx: CanvasRenderingContext2D, view: EditorView, m: EditorMarker, ghost = false): void {
  const [cx, cy] = gameToCanvas(m.p, view);
  const color = m.failed ? DANGER : KIND_COLOR[m.kind];
  ctx.save();
  if (ghost) ctx.globalAlpha = 0.7;
  // ring and fill by origin
  ctx.beginPath();
  ctx.arc(cx, cy, MARKER_RADIUS, 0, Math.PI * 2);
  if (m.origin === 'manual') {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    if (m.failed) ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    drawGlyph(ctx, m.kind, cx, cy, BG);
  } else {
    ctx.fillStyle = BG;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    if (m.origin === 'synthetic') ctx.setLineDash([3.5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    drawGlyph(ctx, m.kind, cx, cy, color);
  }
  if (m.origin === 'manual' && m.addedIndex !== undefined && !ghost) {
    const bx = cx + BADGE_OFFSET[0], by = cy + BADGE_OFFSET[1];
    ctx.beginPath();
    ctx.arc(bx, by, BADGE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = BG;
    ctx.beginPath();
    ctx.moveTo(bx - 2.6, by - 2.6); ctx.lineTo(bx + 2.6, by + 2.6);
    ctx.moveTo(bx + 2.6, by - 2.6); ctx.lineTo(bx - 2.6, by + 2.6);
    ctx.stroke();
  }
  // label towards the inside of the map
  const side = sideOf(m.p);
  const tag = m.failed ? ' (failed)' : m.origin === 'manual' ? ' (custom)' : m.origin === 'synthetic' ? ' (auto)' : '';
  const text = KIND_LABEL[m.kind] + tag;
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  let tx = cx, ty = cy;
  if (side === 'west') { ctx.textAlign = 'left'; tx = cx + MARKER_RADIUS + 5; }
  else if (side === 'east') { ctx.textAlign = 'right'; tx = cx - MARKER_RADIUS - 5; }
  else if (side === 'north') { ctx.textAlign = 'center'; ty = cy + MARKER_RADIUS + 9; }
  else { ctx.textAlign = 'center'; ty = cy - MARKER_RADIUS - 9; }
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(14,19,23,0.85)';
  ctx.strokeText(text, tx, ty);
  ctx.fillStyle = TEXT;
  ctx.fillText(text, tx, ty);
  ctx.restore();
}

export function drawEditor(ctx: CanvasRenderingContext2D, s: DrawState): void {
  const { view } = s;
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  ctx.clearRect(0, 0, view.size, view.size);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, view.size, view.size);
  const inner = view.size - 2 * view.pad;
  if (s.backdrop) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(s.backdrop, view.pad, view.pad, inner, inner);
  } else {
    ctx.fillStyle = '#1e272f';
    ctx.fillRect(view.pad, view.pad, inner, inner);
  }

  // roads, small first
  if (s.roads) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const byClass = new Map<string, typeof s.roads.edges>();
    for (const e of s.roads.edges) {
      const l = byClass.get(e.cls);
      if (l) l.push(e); else byClass.set(e.cls, [e]);
    }
    const trace = (edges: typeof s.roads.edges) => {
      ctx.beginPath();
      for (const e of edges) {
        const pts = e.pts && e.pts.length > 1 ? e.pts : e.bezier;
        const [x0, y0] = gameToCanvas(pts[0], view);
        ctx.moveTo(x0, y0);
        for (let i = 1; i < pts.length; i++) {
          const [x, y] = gameToCanvas(pts[i], view);
          ctx.lineTo(x, y);
        }
      }
    };
    for (const cls of ROAD_DRAW_ORDER) {
      const edges = byClass.get(cls);
      if (!edges) continue;
      const st = ROAD_STYLE[cls];
      if (st.casing) {
        trace(edges);
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(14,19,23,0.55)';
        ctx.lineWidth = st.width + 2;
        ctx.stroke();
      }
      trace(edges);
      ctx.setLineDash(st.dash ?? []);
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.width;
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // tile grid
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(230,237,243,0.16)';
  ctx.beginPath();
  const step = inner / CS2.TILE_GRID;
  for (let i = 1; i < CS2.TILE_GRID; i++) {
    const o = Math.round(view.pad + i * step) + 0.5;
    ctx.moveTo(o, view.pad); ctx.lineTo(o, view.pad + inner);
    ctx.moveTo(view.pad, o); ctx.lineTo(view.pad + inner, o);
  }
  ctx.stroke();

  // hover tile
  if (s.hoverTile) {
    const b = tileBounds(s.hoverTile);
    const [x0, y0] = gameToCanvas([b.x0, b.z1], view);
    const [x1, y1] = gameToCanvas([b.x1, b.z0], view);
    ctx.fillStyle = 'rgba(230,237,243,0.12)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(230,237,243,0.8)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    ctx.setLineDash([]);
  }

  // start tile
  if (s.startTile) {
    const b = tileBounds(s.startTile);
    const [x0, y0] = gameToCanvas([b.x0, b.z1], view);
    const [x1, y1] = gameToCanvas([b.x1, b.z0], view);
    ctx.fillStyle = 'rgba(79,209,181,0.25)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 3;
    if (!s.manualStart) ctx.setLineDash([6, 4]);
    ctx.strokeRect(x0 + 1.5, y0 + 1.5, x1 - x0 - 3, y1 - y0 - 3);
    ctx.setLineDash([]);
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(14,19,23,0.85)';
    ctx.strokeText('Start', (x0 + x1) / 2, (y0 + y1) / 2);
    ctx.fillStyle = ACCENT;
    ctx.fillText('Start', (x0 + x1) / 2, (y0 + y1) / 2);
  }

  // playable border
  ctx.strokeStyle = 'rgba(230,237,243,0.85)';
  ctx.lineWidth = 2;
  ctx.strokeRect(view.pad, view.pad, inner, inner);

  for (const m of s.markers) drawMarker(ctx, view, m);
  if (s.preview) {
    drawMarker(ctx, view, { key: 'preview', kind: s.preview.kind, p: s.preview.p, origin: 'manual' }, true);
  }
}
