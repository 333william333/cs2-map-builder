/**
 * Shared contract for CS2 Map Builder. Single source of truth for every module.
 * Changing exported names or shapes affects every module, so do it deliberately.
 *
 * COORDINATE FRAMES
 *  - Geo:   WGS84 lat/lon in degrees.
 *  - Real:  metres [x, y] from the selection centre, in the selection's ROTATED frame
 *           (x = right edge direction, y = top edge direction of the square).
 *  - Game:  metres [gx, gz] = Real * scale.horizontal. Origin = map centre.
 *           +gx = right (east when rotation = 0), +gz = top (north when rotation = 0).
 *           Playable area spans [-7168, 7168] on both axes, world area [-28672, 28672].
 *  - Grid:  row-major square arrays. row 0 = TOP (max gz), col 0 = LEFT (min gx).
 *           Sample (row r, col c) of a grid with `size` samples covering `extentM`
 *           sits at gx = -extentM/2 + (c + 0.5) * extentM/size, gz = extentM/2 - (r + 0.5) * extentM/size.
 *  - Heights are GAME metres above the heightmap zero (0 .. heightScale).
 */

export const CS2 = {
  PLAYABLE_SIZE_M: 14336,
  WORLD_SIZE_M: 57344,
  HEIGHTMAP_RES: 4096,
  DEFAULT_HEIGHT_SCALE_M: 4096,
  /** 23 x 23 purchasable map tiles inside the playable area */
  TILE_GRID: 23,
} as const;

export type Pt = [number, number];

// ---------------------------------------------------------------- selection

export interface Selection {
  centerLat: number;
  centerLon: number;
  /** real-world side length (m) of the square that becomes the playable area */
  sizeMeters: number;
  /** clockwise rotation of the square's top edge direction from true north, degrees */
  rotationDeg: number;
}

export interface Scale {
  /** game metres per real metre, = 14336 / selection.sizeMeters */
  horizontal: number;
  /** game height metres per real elevation metre */
  vertical: number;
}

// ---------------------------------------------------------------- settings

export type Quality = 'draft' | 'full';

export interface TerrainSettings {
  /** 'true' = vertical 1:1 real metres, 'proportional' = same factor as horizontal, 'custom' = verticalFactor */
  verticalMode: 'true' | 'proportional' | 'custom';
  /** used when verticalMode = 'custom' (game m per real m) */
  verticalFactor: number;
  /** extra multiplier on top of the mode, 0.5 .. 3 */
  exaggeration: number;
  /** game height (m) that real sea level / lowest water maps to. Leaves room for sea depth. */
  seaLevelGame: number;
  /** 0..1 */
  smoothing: number;
  carveWater: boolean;
}

export type RoadClass =
  | 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary'
  | 'residential' | 'service' | 'pedestrian'
  | 'rail' | 'tram' | 'subway';

export interface RoadSettings {
  enabled: boolean;
  classes: Record<RoadClass, boolean>;
  /** 0 = only the biggest roads, 1 = everything that fits */
  detail: number;
  names: boolean;
}

export interface TreeSettings {
  enabled: boolean;
  /** max number of trees placed */
  budget: number;
  /** 0..1 density multiplier */
  density: number;
}

export interface BuildSettings {
  quality: Quality;
  terrain: TerrainSettings;
  roads: RoadSettings;
  trees: TreeSettings;
  water: {
    enabled: boolean;
    /** also carve small streams/ditches (many tiny water sources in the game; off by default) */
    streams: boolean;
  };
  climate: { enabled: boolean };
  resources: { enabled: boolean };
  manual: ManualEdits;
}

/** Hand-made adjustments that make the map playable. Cleared when the selection moves. */
export interface ManualEdits {
  /** start tile chosen by the user (0-based, row 0 = top); overrides the automatic choice */
  startTile?: { col: number; row: number };
  /**
   * Outside connections added by the user at a point on the playable border.
   * 'road' and 'rail' get a real connector built from the border to the network.
   */
  added: { kind: 'road' | 'rail' | 'ship' | 'air' | 'power' | 'water'; p: Pt }[];
}

// ---------------------------------------------------------------- I/O abstraction

/** Fetches a URL and returns its bytes. In the app this goes through the caching proxy. */
export type FetchBytes = (
  url: string,
  opts?: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string },
) => Promise<Uint8Array>;

export type Progress = (stage: string, fraction: number, message?: string) => void;

// ---------------------------------------------------------------- raster data

export interface HeightGrid {
  size: number;
  /** game metres covered by the grid side (14336 playable, 57344 world) */
  extentM: number;
  /** game height metres, row-major, row 0 = top */
  data: Float32Array;
}

/** Real elevation lookup, metres above sea level. Negative below sea level (bathymetry). */
export interface ElevationSampler {
  sample(lat: number, lon: number): number;
}

/** ESA WorldCover class codes */
export const LC = {
  None: 0, Tree: 10, Shrub: 20, Grass: 30, Crop: 40, Built: 50,
  Bare: 60, Snow: 70, Water: 80, Wetland: 90, Mangrove: 95, Moss: 100,
} as const;

export interface LandcoverGrid {
  size: number;
  extentM: number;
  /** WorldCover class code per cell, row 0 = top */
  data: Uint8Array;
}

// ---------------------------------------------------------------- vector data (game coords)

export interface RawWay {
  id: number;
  cls: RoadClass;
  pts: Pt[];
  lanes?: number;
  oneway: boolean;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
  roundabout: boolean;
  /** motorway_link, primary_link ... */
  link: boolean;
  name?: string;
}

export interface WaterPolygon {
  kind: 'lake' | 'river' | 'reservoir' | 'sea';
  /** rings[0] = outer, rest = holes */
  rings: Pt[][];
}

export interface Waterway {
  kind: 'river' | 'stream' | 'canal';
  pts: Pt[];
  /** REAL metres, if tagged */
  widthM?: number;
  name?: string;
}

export type AreaKind =
  | 'forest' | 'farmland' | 'park' | 'residential' | 'industrial' | 'commercial'
  | 'beach' | 'rock' | 'wetland' | 'quarry' | 'airport' | 'harbour';

export interface AreaPolygon {
  kind: AreaKind;
  rings: Pt[][];
  leafType?: 'broadleaved' | 'needleleaved' | 'mixed';
}

export interface VectorData {
  ways: RawWay[];
  waterPolygons: WaterPolygon[];
  waterways: Waterway[];
  areas: AreaPolygon[];
  treePoints: Pt[];
  powerLines: Pt[][];
}

// ---------------------------------------------------------------- processed results

/** Abstract prefab ids. The CS2 mod maps these to real game prefabs. */
export type NetPrefab =
  | 'highway_1lane_oneway' | 'highway_2lane_oneway' | 'highway_3lane_oneway' | 'highway_4lane_oneway'
  | 'highway_twoway_2lane' | 'highway_twoway_3lane'
  | 'road_large_6lane' | 'road_large_oneway' | 'road_medium_4lane' | 'road_medium_oneway'
  | 'road_small_2lane' | 'road_small_oneway'
  | 'road_gravel' | 'road_alley' | 'path_pedestrian'
  | 'rail_double' | 'rail_single' | 'tram_double' | 'subway_double';

export interface RoadNode {
  id: number;
  p: Pt;
  /** terrain game height at p */
  ground: number;
  /** vertical offset from ground: > 0 bridge, < 0 tunnel */
  elevation: number;
  /** node lies on the playable border and is an outside connection */
  outside: boolean;
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  cls: RoadClass;
  prefab: NetPrefab;
  /** polyline from node a to node b sampled along the curve, endpoints included (for drawing) */
  pts: Pt[];
  /**
   * The edge as ONE cubic Bezier [p0, c1, c2, p3] with p0 = node a, p3 = node b.
   * One edge = one game road segment: its length is 24 .. 200 game metres.
   */
  bezier: [Pt, Pt, Pt, Pt];
  oneway: boolean;
  bridge: boolean;
  tunnel: boolean;
  name?: string;
}

export interface RoadNetwork {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

export type TreeSpecies =
  | 'birch' | 'oak' | 'linden' | 'chestnut' | 'poplar' | 'alder' | 'apple'
  | 'hickory' | 'plane' | 'pine' | 'spruce' | 'bush' | 'palm' | 'eucalyptus';

export interface TreeSet {
  count: number;
  /** [gx0, gz0, gx1, gz1, ...] */
  xz: Float32Array;
  /** index into speciesTable */
  species: Uint8Array;
  /** 0 = young, 1 = teen, 2 = adult, 3 = elderly, 4 = dead */
  age: Uint8Array;
  speciesTable: TreeSpecies[];
}

/** Inland water only. The sea is terrain.hasSea + terrain.seaLevel (CS2 has a global sea level). */
export interface WaterSource {
  kind: 'borderRiver' | 'river' | 'lake';
  p: Pt;
  /** game metres */
  radius: number;
  /** game height of the water surface */
  level: number;
  /** relative flow 0..1 for river kinds */
  rate?: number;
}

export interface ClimateProfile {
  latitude: number;
  longitude: number;
  /** Köppen-Geiger code, e.g. 'Dfb' */
  koppen: string;
  monthlyMeanC: number[];
  monthlyMinC: number[];
  monthlyMaxC: number[];
  monthlyPrecipMm: number[];
  /** 0..1 mean cloud cover per month */
  monthlyCloud: number[];
  theme: 'european' | 'northAmerican';
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface OutsideConnection {
  kind: 'road' | 'rail' | 'ship' | 'air' | 'power' | 'water';
  p: Pt;
  /** true when no real connection existed and one was synthesised */
  synthetic: boolean;
  /** true when the user added it by hand */
  manual?: boolean;
}

export interface ResourceMasks {
  /** masks are 0..255, row 0 = top, cover the playable area. size is always 256 (CS2 cell maps). */
  size: number;
  fertile: Uint8Array;
  forest: Uint8Array;
  ore: Uint8Array;
  oil: Uint8Array;
  groundwater: Uint8Array;
}

export interface PlayabilityReport {
  /** fraction of playable land with slope gentle enough to build */
  buildableFraction: number;
  waterFraction: number;
  checks: { id: string; status: CheckStatus; message: string }[];
  /** 0-based tile in the 23 x 23 grid, row 0 = top */
  startTile: { col: number; row: number };
  outsideConnections: OutsideConnection[];
  resources?: ResourceMasks;
}

export interface TerrainResult {
  playable: HeightGrid;
  world: HeightGrid;
  scale: Scale;
  /** game height of sea level / base water */
  seaLevel: number;
  /** value for CS2's height scale setting (m) so that uint16 65535 = heightScale */
  heightScale: number;
  /** water kind per playable cell: 0 = land, 1 = sea, 2 = lake, 3 = river. Same size as playable. */
  waterMask: Uint8Array;
  /** real elevation (m) that maps to seaLevel: 0 for coastal areas, else the lowest real elevation */
  baseElevation: number;
  /** true when the area touches the sea; the game's global sea level is then seaLevel */
  hasSea: boolean;
  minHeight: number;
  maxHeight: number;
}

/**
 * Preview of the game's zoning grid: 8 x 8 game metre cells, up to 6 deep on each side of a
 * zonable road, plus example buildings for scale. Preview only, never exported to the game.
 */
export interface ZonePreview {
  cellCount: number;
  /** [gx, gz, dirX, dirZ] per cell: cell centre and unit vector along the road */
  cells: Float32Array;
  /** row from the road, 0..5 */
  cellDepth: Uint8Array;
  lotCount: number;
  /** [gx, gz, dirX, dirZ, widthM, depthM, heightM] per lot: centre of the building footprint */
  lots: Float32Array;
  /** 0 = low residential, 1 = dense residential, 2 = commercial, 3 = industrial */
  lotKind: Uint8Array;
}

export interface BuildResult {
  selection: Selection;
  settings: BuildSettings;
  terrain: TerrainResult;
  landcover?: LandcoverGrid;
  vectors?: VectorData;
  roads?: RoadNetwork;
  /** the network before manual edits and automatic connectors were applied */
  baseRoads?: RoadNetwork;
  zones?: ZonePreview;
  trees?: TreeSet;
  waterSources: WaterSource[];
  climate?: ClimateProfile;
  playability?: PlayabilityReport;
  /** user-facing notes about data that could not be loaded or was limited */
  warnings?: string[];
}

// ---------------------------------------------------------------- defaults

export const ALL_ROAD_CLASSES: RoadClass[] = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'residential', 'service', 'pedestrian', 'rail', 'tram', 'subway',
];

export const DEFAULT_SETTINGS: BuildSettings = {
  quality: 'draft',
  terrain: {
    verticalMode: 'proportional',
    verticalFactor: 1,
    exaggeration: 1,
    seaLevelGame: 64,
    smoothing: 0.3,
    carveWater: true,
  },
  roads: {
    enabled: true,
    classes: {
      motorway: true, trunk: true, primary: true, secondary: true, tertiary: true,
      residential: true, service: false, pedestrian: false, rail: true, tram: false, subway: false,
    },
    detail: 0.7,
    names: true,
  },
  trees: { enabled: true, budget: 400_000, density: 0.6 },
  water: { enabled: true, streams: false },
  climate: { enabled: true },
  resources: { enabled: true },
  manual: { added: [] },
};

export const DEFAULT_SELECTION: Selection = {
  centerLat: 59.8586,
  centerLon: 17.6389,
  sizeMeters: CS2.PLAYABLE_SIZE_M,
  rotationDeg: 0,
};
