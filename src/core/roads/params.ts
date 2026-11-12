/**
 * Constants, class tables and prefab selection for the road builder.
 * All distances are GAME metres.
 */
import type { NetPrefab, RoadClass } from '../types';

export const HALF = 7168;
/** hard edge length limits of a game segment */
export const MIN_EDGE = 24;
export const MAX_EDGE = 200;
/** generation targets (kept inside the hard limits with a margin for Bezier vs polyline length) */
export const GEN_MIN_PIECE = 32;
export const GEN_MAX_PIECE = 185;
/** shortest chain that survives contraction */
export const MIN_CHAIN = 34;
export const MIN_NODE_GAP = 24;
export const GEN_NODE_GAP = 27;
/** dead ends of ways leaving the area stay this far inside */
export const BORDER_MARGIN = 40;
export const GEN_BORDER_MARGIN = 48;
/** distance from the border over which outside approaches are straightened */
export const APPROACH_LEN = 72;
export const MAX_ROAD_OUTSIDE = 8;
export const MAX_RAIL_OUTSIDE = 4;
export const MIN_NODE_ANGLE_DEG = 15;
export const MAX_TURN_DEG = 95;
export const OUTSIDE_APPROACH_TOL_DEG = 30;

export const BRIDGE_MIN_ELEV = 8;
export const TUNNEL_MIN_DEPTH = 8;
export const GEN_BRIDGE_ELEV = 9;
export const GEN_TUNNEL_DEPTH = 10;
export const VERTICAL_CLEARANCE = 7;
export const GEN_VERTICAL_CLEARANCE = 9;
export const MAX_RAMP_GRADE = 0.1;
export const GEN_RAMP_GRADE = 0.08;

/** output order: motorway first ... paths last */
export const CLASS_ORDER: RoadClass[] = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service',
  'rail', 'tram', 'subway', 'pedestrian',
];
export const CLASS_INDEX: Record<RoadClass, number> = Object.fromEntries(
  CLASS_ORDER.map((c, i) => [c, i]),
) as Record<RoadClass, number>;

/** base importance used for thinning, conflict victims and processing order */
export const IMPORTANCE: Record<RoadClass, number> = {
  motorway: 100, trunk: 90, primary: 80, rail: 78, secondary: 70, tertiary: 60,
  subway: 55, tram: 45, residential: 40, service: 20, pedestrian: 10,
};

/** road hierarchy rank (0 = most important) used for the detail cut-off */
export const ROAD_RANK: Record<RoadClass, number> = {
  motorway: 0, trunk: 0, primary: 1, secondary: 2, tertiary: 3, residential: 4,
  service: 5, pedestrian: 5, rail: 0, tram: 3, subway: 2,
};

export type Family = 'road' | 'rail' | 'tram' | 'subway';
export function family(c: RoadClass): Family {
  if (c === 'rail' || c === 'tram' || c === 'subway') return c;
  return 'road';
}
export const isRailFamily = (c: RoadClass) => family(c) !== 'road';

export function defaultLanes(c: RoadClass, oneway: boolean): number {
  switch (c) {
    case 'motorway': case 'trunk': return 2;
    case 'primary': return oneway ? 2 : 2;
    default: return oneway ? 1 : 2;
  }
}

/** Per-way attributes carried through the pipeline. */
export interface Attr {
  cls: RoadClass;
  link: boolean;
  oneway: boolean;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
  roundabout: boolean;
  lanes?: number;
  name?: string;
  ref?: string;
  unpaved?: boolean;
  /** produced by merging two carriageways / tracks */
  merged: boolean;
  /** source way id (for deterministic tie-breaks) */
  src: number;
}

export function choosePrefab(a: Attr): NetPrefab {
  const L = a.lanes;
  // unpaved minor roads (tracks, gravel) are gravel roads in the game
  if (a.unpaved && !a.oneway && (a.cls === 'tertiary' || a.cls === 'residential' || a.cls === 'service')) return 'road_gravel';
  const tot = L ?? (a.merged ? 4 : 2);
  switch (a.cls) {
    case 'motorway':
      if (a.oneway) {
        const n = Math.max(1, Math.min(4, Math.round(L ?? (a.link ? 1 : 2))));
        return (['highway_1lane_oneway', 'highway_2lane_oneway', 'highway_3lane_oneway', 'highway_4lane_oneway'] as const)[n - 1];
      }
      if (a.link) return 'highway_twoway_2lane';
      return (L ?? 4) >= 5 ? 'highway_twoway_3lane' : 'highway_twoway_2lane';
    case 'trunk':
      if (a.link) return a.oneway ? 'highway_1lane_oneway' : 'road_small_2lane';
      if (a.oneway) return (L ?? 2) >= 3 ? 'road_large_oneway' : 'road_medium_oneway';
      return a.merged || tot >= 5 ? 'road_large_6lane' : 'road_medium_4lane';
    case 'primary':
      if (a.link) return a.oneway ? 'road_small_oneway' : 'road_small_2lane';
      if (a.oneway) return (L ?? 2) >= 4 ? 'road_large_oneway' : 'road_medium_oneway';
      return tot >= 5 ? 'road_large_6lane' : 'road_medium_4lane';
    case 'secondary':
      if (a.link) return a.oneway ? 'road_small_oneway' : 'road_small_2lane';
      if (a.oneway) return (L ?? 1) >= 3 ? 'road_medium_oneway' : 'road_small_oneway';
      if (tot >= 5) return 'road_large_6lane';
      return L === undefined || tot >= 3 || a.merged ? 'road_medium_4lane' : 'road_small_2lane';
    case 'tertiary':
      if (a.oneway && !a.link) return (L ?? 1) >= 3 ? 'road_medium_oneway' : 'road_small_oneway';
      if (a.oneway) return 'road_small_oneway';
      return tot >= 4 ? 'road_medium_4lane' : 'road_small_2lane';
    case 'residential':
      return a.oneway ? 'road_small_oneway' : 'road_small_2lane';
    case 'service':
      return 'road_alley';
    case 'pedestrian':
      return 'path_pedestrian';
    case 'rail':
      return a.merged ? 'rail_double' : 'rail_single';
    case 'tram':
      return 'tram_double';
    case 'subway':
      return 'subway_double';
  }
}

export function prefabIsOneway(p: NetPrefab): boolean {
  return p.includes('oneway');
}

/** approximate game widths (m) of the abstract prefabs */
export const PREFAB_WIDTH: Record<NetPrefab, number> = {
  highway_1lane_oneway: 12, highway_2lane_oneway: 16, highway_3lane_oneway: 20, highway_4lane_oneway: 24,
  highway_twoway_2lane: 28, highway_twoway_3lane: 36,
  road_large_6lane: 32, road_large_oneway: 24, road_medium_4lane: 24, road_medium_oneway: 18,
  road_small_2lane: 16, road_small_oneway: 12, road_gravel: 12, road_alley: 10, path_pedestrian: 6,
  rail_double: 12, rail_single: 8, tram_double: 12, subway_double: 12,
};

/** required centre-line distance between two unconnected same-level edges */
export function clearance(a: NetPrefab, b: NetPrefab): number {
  return Math.max(MIN_NODE_GAP, (PREFAB_WIDTH[a] + PREFAB_WIDTH[b]) / 2 + 6);
}

/** minimum curve radius accepted by the validator */
export function minRadius(p: NetPrefab): number {
  if (p.startsWith('highway')) return 20;
  if (p === 'rail_double' || p === 'rail_single' || p === 'subway_double') return 20;
  if (p === 'tram_double') return 12;
  return 8;
}

/** preferred maximum piece length for a class (shorter pieces follow curves better) */
export function targetPiece(c: RoadClass): number {
  switch (c) {
    case 'motorway': case 'trunk': case 'rail': case 'subway': return 150;
    case 'primary': case 'secondary': return 120;
    default: return 95;
  }
}

/** max turning (radians) inside one generated piece */
export function maxPieceTurn(c: RoadClass): number {
  switch (c) {
    case 'motorway': case 'trunk': case 'rail': case 'subway': return (50 * Math.PI) / 180;
    default: return (70 * Math.PI) / 180;
  }
}

/** Gaussian smoothing sigma (m) applied to chains before curve fitting */
export function smoothSigma(c: RoadClass): number {
  switch (c) {
    case 'motorway': return 30;
    case 'trunk': return 24;
    case 'rail': case 'subway': return 34;
    case 'primary': return 16;
    case 'secondary': return 12;
    case 'tertiary': case 'tram': return 9;
    case 'residential': return 6;
    default: return 4;
  }
}

/** level key: all ground ways share one level, structures are separated by layer */
export function levelKey(a: { bridge: boolean; tunnel: boolean; layer: number }): string {
  if (a.bridge) return 'B' + a.layer;
  if (a.tunnel) return 'T' + a.layer;
  return 'G';
}

/** vertical ordering of levels: higher = above */
export function levelRank(a: { bridge: boolean; tunnel: boolean; layer: number }): number {
  if (a.bridge) return 10 + Math.max(0, a.layer);
  if (a.tunnel) return -10 + Math.min(0, a.layer);
  return 0;
}

export function attrKey(a: Attr): string {
  return `${a.cls}|${choosePrefab(a)}|${a.oneway ? 1 : 0}|${levelKey(a)}|${a.roundabout ? 1 : 0}`;
}
