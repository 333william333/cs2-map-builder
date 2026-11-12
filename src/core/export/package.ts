import { encode } from 'fast-png';
import type { BuildResult, ClimateProfile, NetPrefab, RoadClass, TreeSet, TreeSpecies } from '../types';
import { CS2 } from '../types';
import { encodeHeightmapPng } from './heightmap';

export interface PackageFile { path: string; bytes: Uint8Array }

/** Abstract net prefab id to the game prefab name (validated by the mod at runtime). */
export const NET_PREFAB_NAMES: Record<NetPrefab, string> = {
  highway_1lane_oneway: 'Highway Oneway - 1 lane',
  highway_2lane_oneway: 'Highway Oneway - 2 lanes',
  highway_3lane_oneway: 'Highway Oneway - 3 lanes',
  highway_4lane_oneway: 'Highway Oneway - 4 lanes',
  highway_twoway_2lane: 'Highway Twoway - 2 lanes',
  highway_twoway_3lane: 'Highway Twoway - 3 lanes',
  road_large_6lane: 'Large Road',
  road_large_oneway: 'Large Road Oneway',
  road_medium_4lane: 'Medium Road',
  road_medium_oneway: 'Medium Road Oneway',
  road_small_2lane: 'Small Road',
  road_small_oneway: 'Small Road Oneway',
  road_gravel: 'Gravel Road',
  road_alley: 'Alley',
  path_pedestrian: 'Pavement Path',
  rail_double: 'Double Train Track',
  rail_single: 'Twoway Train Track',
  tram_double: 'Double Tram Track',
  subway_double: 'Double Subway Track',
};

/** Tree species to game prefab name. Eucalyptus has no vanilla prefab. */
export const TREE_PREFAB_NAMES: Record<TreeSpecies, string> = {
  birch: 'BirchTree01',
  oak: 'OakTree01',
  linden: 'NA_LindenTree01',
  chestnut: 'EU_ChestnutTree01',
  poplar: 'EU_PoplarTree01',
  alder: 'EU_AlderTree01',
  apple: 'AppleTree01',
  hickory: 'NA_HickoryTree01',
  plane: 'NA_LondonPlaneTree01',
  pine: 'PineTree01',
  spruce: 'SpruceTree01',
  bush: 'GreenBushWild01',
  palm: 'CoconutPalmTree01',
  eucalyptus: 'NA_LondonPlaneTree01',
};

export const ATTRIBUTION =
  'Map data: OpenStreetMap contributors (ODbL). Elevation: Mapzen/AWS Terrain Tiles. ' +
  'Land cover: ESA WorldCover 2021 (CC BY 4.0). Climate: Open-Meteo. Created with CS2 Map Builder.';

export interface PackageOptions {
  /** required heightmap side in pixels; defaults to 4096. Tests pass a smaller value. */
  heightmapSize?: number;
}

const enc = new TextEncoder();
const r2 = (v: number) => Math.round(v * 100) / 100;
const json = (o: unknown, indent?: number): Uint8Array => enc.encode(JSON.stringify(o, null, indent));

/** Sort rank: motorway first, pedestrian paths last. */
const CLASS_ORDER: RoadClass[] = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service',
  'rail', 'tram', 'subway', 'pedestrian',
];

export function encodeTreesBin(trees: TreeSet): Uint8Array {
  const n = trees.count;
  const buf = new ArrayBuffer(12 + n * 8 + n + n);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x43); // C
  dv.setUint8(1, 0x53); // S
  dv.setUint8(2, 0x32); // 2
  dv.setUint8(3, 0x54); // T
  dv.setUint32(4, 1, true);
  dv.setUint32(8, n, true);
  let o = 12;
  for (let i = 0; i < n; i++) {
    dv.setFloat32(o, trees.xz[2 * i], true);
    dv.setFloat32(o + 4, trees.xz[2 * i + 1], true);
    o += 8;
  }
  const u8 = new Uint8Array(buf);
  u8.set(trees.species.subarray(0, n), o);
  o += n;
  u8.set(trees.age.subarray(0, n), o);
  return u8;
}

/** Four seasons from the monthly normals. startMonth is 1..12. */
export function buildSeasons(c: ClimateProfile): {
  name: string; startMonth: number; tempNightC: number; tempDayC: number; cloudChance: number; precipChance: number;
}[] {
  const south = c.latitude < 0;
  // northern hemisphere: winter Dec-Feb, spring Mar-May, summer Jun-Aug, autumn Sep-Nov
  const defs: [string, number][] = south
    ? [['winter', 6], ['spring', 9], ['summer', 12], ['autumn', 3]]
    : [['winter', 12], ['spring', 3], ['summer', 6], ['autumn', 9]];
  const avg = (arr: number[], months: number[], fallback: number) => {
    const v = months.map((mo) => arr[mo]).filter((x) => Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : fallback;
  };
  return defs.map(([name, startMonth]) => {
    const months = [0, 1, 2].map((k) => (startMonth - 1 + k) % 12);
    const mean = avg(c.monthlyMeanC, months, 10);
    const night = avg(c.monthlyMinC, months, mean - 4);
    const day = avg(c.monthlyMaxC, months, mean + 4);
    const cloud = avg(c.monthlyCloud, months, 0.5);
    const precip = avg(c.monthlyPrecipMm, months, 50);
    return {
      name,
      startMonth,
      tempNightC: Math.round(night * 10) / 10,
      tempDayC: Math.round(day * 10) / 10,
      cloudChance: r2(Math.min(1, Math.max(0, cloud))),
      // about 150 mm per month counts as certain rain
      precipChance: r2(Math.min(1, Math.max(0, precip / 150))),
    };
  });
}

function greyPng(mask: Uint8Array, size: number): Uint8Array {
  return encode({ width: size, height: size, data: mask, depth: 8, channels: 1 });
}

/** Builds the package folder contents (version 1) for the CS2 importer mod. Needs a full-quality build. */
export function buildPackageFiles(result: BuildResult, name: string, opts: PackageOptions = {}): PackageFile[] {
  const size = opts.heightmapSize ?? CS2.HEIGHTMAP_RES;
  if (result.settings.quality !== 'full') {
    throw new Error('The package requires a full-quality build (the heightmaps must be 4096 x 4096). Rebuild at full quality.');
  }
  const t = result.terrain;
  if (t.playable.size !== size || t.world.size !== size) {
    throw new Error(`The heightmaps have the wrong size: ${t.playable.size} and ${t.world.size}, expected ${size} x ${size}.`);
  }

  const files: PackageFile[] = [];
  const roads = result.roads && result.roads.edges.length > 0 ? result.roads : undefined;
  const trees = result.trees && result.trees.count > 0 ? result.trees : undefined;

  files.push({ path: 'heightmap.png', bytes: encodeHeightmapPng(t.playable, t.heightScale) });
  files.push({ path: 'worldmap.png', bytes: encodeHeightmapPng(t.world, t.heightScale) });

  if (roads) {
    const nodes = roads.nodes.map((n) => [n.id, r2(n.p[0]), r2(n.p[1]), r2(n.elevation), n.outside ? 1 : 0]);
    const rank = (c: RoadClass) => CLASS_ORDER.indexOf(c);
    const edges = roads.edges
      .slice()
      .sort((a, b) => rank(a.cls) - rank(b.cls) || a.id - b.id)
      .map((e) => {
        const o: Record<string, unknown> = {
          id: e.id, a: e.a, b: e.b, cls: e.cls, prefab: e.prefab,
          oneway: e.oneway, bridge: e.bridge, tunnel: e.tunnel,
        };
        if (e.name) o.name = e.name;
        o.bezier = e.bezier.flatMap((p) => [r2(p[0]), r2(p[1])]);
        return o;
      });
    files.push({ path: 'roads.json', bytes: json({ nodes, edges }) });
  }

  if (trees) files.push({ path: 'trees.bin', bytes: encodeTreesBin(trees) });

  files.push({
    path: 'water.json',
    bytes: json({
      seaLevel: r2(t.seaLevel),
      hasSea: t.hasSea,
      sources: result.waterSources.map((s) => {
        const o: Record<string, unknown> = { kind: s.kind, x: r2(s.p[0]), z: r2(s.p[1]), radius: r2(s.radius), level: r2(s.level) };
        if (s.rate !== undefined) o.rate = r2(s.rate);
        return o;
      }),
    }),
  });

  if (result.climate) {
    files.push({ path: 'climate.json', bytes: json({ ...result.climate, seasons: buildSeasons(result.climate) }, 2) });
  }

  const res = result.playability?.resources;
  if (res) {
    files.push({ path: 'resources/fertile.png', bytes: greyPng(res.fertile, res.size) });
    files.push({ path: 'resources/ore.png', bytes: greyPng(res.ore, res.size) });
    files.push({ path: 'resources/oil.png', bytes: greyPng(res.oil, res.size) });
    files.push({ path: 'resources/groundwater.png', bytes: greyPng(res.groundwater, res.size) });
  }

  const manifest = {
    format: 'cs2mapbuilder',
    version: 1,
    name,
    selection: result.selection,
    scale: t.scale,
    heightScale: t.heightScale,
    seaLevel: t.seaLevel,
    hasSea: t.hasSea,
    baseElevation: t.baseElevation,
    theme: result.climate?.theme ?? 'european',
    startTile: result.playability?.startTile ?? { col: 11, row: 11 },
    ...(result.playability
      ? {
          outsideConnections: result.playability.outsideConnections.map((c) => ({
            kind: c.kind,
            x: r2(c.p[0]),
            z: r2(c.p[1]),
            synthetic: c.synthetic,
            manual: c.manual === true,
          })),
        }
      : {}),
    counts: {
      nodes: roads ? roads.nodes.length : 0,
      edges: roads ? roads.edges.length : 0,
      trees: trees ? trees.count : 0,
      waterSources: result.waterSources.length,
    },
    netPrefabs: NET_PREFAB_NAMES,
    treePrefabs: TREE_PREFAB_NAMES,
    treeSpecies: result.trees?.speciesTable ?? [],
    warnings: result.warnings ?? [],
    attribution: ATTRIBUTION,
  };
  files.unshift({ path: 'manifest.json', bytes: json(manifest, 2) });
  return files;
}
