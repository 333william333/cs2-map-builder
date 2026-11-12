import type { ManualEdits, OutsideConnection, PlayabilityReport, Pt } from '../../core/types';
import { OTHER_CORNER_MARGIN, ROAD_CORNER_MARGIN, snapToBorder } from '../../core/manual/border';

export type Origin = 'auto' | 'manual' | 'synthetic';

export interface EditorMarker {
  key: string;
  kind: OutsideConnection['kind'];
  p: Pt;
  origin: Origin;
  /** index into `settings.manual.added` for hand-added markers */
  addedIndex?: number;
  /** road or rail entry the connector could not build */
  failed?: boolean;
}

/** A road or rail node built by the connector may end up this far from the requested point. */
const ROAD_MATCH_M = 400;
const OTHER_MATCH_M = 5;

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Markers for the editor: every connection in the report, plus hand-added road / rail entries the
 * connector could not build (they are missing from the report but must stay visible and removable).
 */
export function buildMarkers(report: PlayabilityReport | undefined, added: ManualEdits['added']): EditorMarker[] {
  const conns = report?.outsideConnections ?? [];
  const markers: EditorMarker[] = [];
  const used = new Set<number>();
  added.forEach((a, i) => {
    const road = a.kind === 'road' || a.kind === 'rail';
    const snapped = snapToBorder(a.p, road ? ROAD_CORNER_MARGIN : OTHER_CORNER_MARGIN);
    let bi = -1;
    let bd = road ? ROAD_MATCH_M : OTHER_MATCH_M;
    conns.forEach((c, k) => {
      if (used.has(k) || !c.manual || c.kind !== a.kind) return;
      const d = dist(c.p, snapped);
      if (d <= bd) { bd = d; bi = k; }
    });
    if (bi >= 0) {
      used.add(bi);
      markers.push({ key: `m${i}`, kind: a.kind, p: conns[bi].p, origin: 'manual', addedIndex: i });
    } else {
      markers.push({ key: `m${i}`, kind: a.kind, p: snapped, origin: 'manual', addedIndex: i, failed: road });
    }
  });
  conns.forEach((c, k) => {
    if (used.has(k)) return;
    markers.push({
      key: `c${k}`,
      kind: c.kind,
      p: c.p,
      origin: c.manual ? 'manual' : c.synthetic ? 'synthetic' : 'auto',
    });
  });
  return markers;
}

export const KIND_ORDER: OutsideConnection['kind'][] = ['road', 'rail', 'ship', 'air', 'power', 'water'];

export const KIND_LABEL: Record<OutsideConnection['kind'], string> = {
  road: 'Road', rail: 'Rail', ship: 'Ship', air: 'Air', power: 'Power', water: 'Water',
};

export const KIND_COLOR: Record<OutsideConnection['kind'], string> = {
  road: '#f2a65a', rail: '#b29cf0', ship: '#5b8def', air: '#e98ab8', power: '#f5d547', water: '#62d0ee',
};

export const ORIGIN_LABEL: Record<Origin, string> = {
  auto: 'automatic', manual: 'added by hand', synthetic: 'created automatically',
};

export function groupMarkers(markers: EditorMarker[]): { kind: OutsideConnection['kind']; items: EditorMarker[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, items: markers.filter((m) => m.kind === kind) })).filter((g) => g.items.length > 0);
}
