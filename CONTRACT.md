# CS2 Map Builder: architecture and module contract

Pick a square anywhere on a world map and get a playable Cities: Skylines II map of it:
terrain, water, roads, trees, climate. Read this file and `src/core/types.ts` before changing code.

## Architecture

```
src/core/      pure TypeScript, NO DOM / Node APIs. Runs in a Web Worker and in vitest (Node).
  types.ts       shared types and constants (shared, change with care)
  geo/frame.ts   Geo <-> Game coordinates (shared, change with care)
  data/          remote data loaders (elevation, osm, landcover, climate)
  terrain/       heightmap processing
  roads/ trees/ water/ playability/   M2 processing
  export/        PNG + package encoders
  pipeline.ts    runBuild(): the whole build, stage by stage
src/worker/    build.worker.ts wraps runBuild
src/ui/        React app (store.ts, map/, preview/, panel/)
server/        small Node server: caching fetch proxy + writing exports to disk
electron/      thin shell that starts the server and opens a window (M4)
mod/           CS2 importer mod, C# (M3)
docs/          research notes
```

All network access from `src/core` goes through an injected `FetchBytes`. In the app it calls
`/api/fetch?url=<encoded>` on our server, which caches to disk. Tests inject fakes or fixtures.

## Module APIs (fixed)

| File | Export |
|---|---|
| `core/geo/frame.ts` | `createFrame(sel): Frame` |
| `core/data/elevation.ts` | `loadElevation(frame, extentGameM, samplesAcross, fetch, progress?): Promise<ElevationSampler>` |
| `core/data/osm.ts` | `loadVectors(frame, settings, fetch, progress?): Promise<VectorData>` |
| `core/data/landcover.ts` | `loadLandcover(frame, extentGameM, size, fetch, progress?): Promise<LandcoverGrid>` |
| `core/data/climate.ts` | `loadClimate(sel, fetch): Promise<ClimateProfile>` |
| `core/terrain/buildTerrain.ts` | `buildTerrain(input: TerrainInput, progress?): TerrainResult` |
| `core/export/heightmap.ts` | `quantizeHeights(grid, heightScale): Uint16Array`, `encodeHeightmapPng(grid, heightScale): Uint8Array` |
| `core/roads/buildRoads.ts` | `buildRoads(vectors, terrain, settings.roads): RoadNetwork` |
| `core/trees/buildTrees.ts` | `buildTrees(input: TreeInput): TreeSet` |
| `core/water/buildWaterSources.ts` | `buildWaterSources(terrain, vectors): WaterSource[]` |
| `core/playability/analyze.ts` | `analyzePlayability(input): PlayabilityReport` |
| `core/export/package.ts` | `buildPackage(result): Uint8Array` (zip) |
| `core/pipeline.ts` | `runBuild(selection, settings, fetch, progress): Promise<BuildResult>` |

```ts
interface TerrainInput {
  frame: Frame;
  settings: TerrainSettings;
  /** output resolution: draft = playable 512 / world 256, full = 4096 / 4096 */
  quality: Quality;
  playableElev: ElevationSampler;
  worldElev: ElevationSampler;
  vectors?: VectorData;      // water polygons / waterways for carving
  landcover?: LandcoverGrid; // water class as extra water evidence
}
```

## UI store (`src/ui/store.ts`, zustand, fixed shape)

```ts
interface AppState {
  selection: Selection;
  settings: BuildSettings;
  status: { phase: 'idle' | 'building' | 'done' | 'error'; stage?: string; fraction: number; message?: string };
  result: BuildResult | null;
  layers: { water: boolean; roads: boolean; trees: boolean; grid: boolean; world: boolean; startTile: boolean };
  setSelection(patch: Partial<Selection>): void;
  setSettings(fn: (s: BuildSettings) => BuildSettings): void;
  setLayer(key: keyof AppState['layers'], on: boolean): void;
  build(quality: Quality): void;
}
```

## Data sources (no API keys)

| Data | URL |
|---|---|
| Vector basemap | MapLibre style `https://tiles.openfreemap.org/styles/liberty` (dark alternative: `.../styles/dark`) |
| Satellite layer | `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg` |
| Place search | `https://nominatim.openstreetmap.org/search?format=jsonv2&q=` (max 1 req/s, debounce) |
| Elevation | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, metres = R*256 + G + B/256 - 32768 |
| OSM vectors | Overpass POST `https://overpass-api.de/api/interpreter`, mirror `https://overpass.kumi.systems/api/interpreter` |
| Land cover | ESA WorldCover 2021 v200, 10 m, COGs `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{N57E012}_Map.tif` (3 degree tiles) |
| Climate | Open-Meteo archive API `https://archive-api.open-meteo.com/v1/archive` |

## Rules

1. `types.ts` and `frame.ts` are the shared contract: changing them affects every module.
2. Code and comments in English. User-visible UI text is currently Swedish.
3. `src/core` must stay free of DOM and Node APIs so it works in both the worker and vitest.
4. Tests live next to the code (`*.test.ts`) and must not hit the network; use fakes.
5. Heavy arrays are typed arrays. A full build handles 4096 x 4096 grids, so avoid per-cell objects
   and per-cell closures in hot loops.

## Visual design

Dark, calm, tool-like. Tailwind v4 tokens are defined in `src/ui/index.css`; use them, do not invent colours.

| Token | Value | Use |
|---|---|---|
| `bg` | `#0e1317` | app background |
| `surface` | `#161d23` | panels |
| `surface-2` | `#1e272f` | inputs, hover |
| `line` | `#2a353f` | borders |
| `text` | `#e6edf3` | primary text |
| `muted` | `#8b98a5` | secondary text |
| `accent` | `#4fd1b5` | primary actions, selection square |
| `warn` | `#e5b454` | warnings |
| `danger` | `#ef6b6b` | errors |

Font: `system-ui`. Radius 10 px on panels, 8 px on controls. Icons: `lucide-react`.
Layout: top bar (name, place search, build button), map left, 3D preview right (resizable split),
settings panel 340 px on the far right, status bar at the bottom.

## M2 additions

Changed APIs (these replace the rows in the table above):

| File | Export |
|---|---|
| `core/data/vectortiles.ts` | `loadVectorsFromTiles(frame, settings, fetch, progress?): Promise<VectorData>` (OpenFreeMap vector tiles, fallback and fast path for OSM data) |
| `core/roads/buildRoads.ts` | `buildRoads(vectors, terrain, settings.roads): RoadNetwork` |
| `core/trees/buildTrees.ts` | `buildTrees(input: TreeInput): TreeSet` |
| `core/water/buildWaterSources.ts` | `buildWaterSources(terrain, vectors?): WaterSource[]` |
| `core/playability/analyze.ts` | `analyzePlayability(input: PlayabilityInput): PlayabilityReport` |
| `core/export/package.ts` | `buildPackageFiles(result, name): PackageFile[]` |

```ts
interface TreeInput {
  terrain: TerrainResult;
  settings: TreeSettings;
  landcover?: LandcoverGrid;
  vectors?: VectorData;
  climate?: ClimateProfile;
  roads?: RoadNetwork;      // keep trees off roads
  centerLat: number;        // fallback biome when climate is missing
}
interface PlayabilityInput {
  terrain: TerrainResult;
  settings: BuildSettings;
  landcover?: LandcoverGrid;
  vectors?: VectorData;
  roads?: RoadNetwork;
  trees?: TreeSet;
}
interface PackageFile { path: string; bytes: Uint8Array }
```

### Facts from the CS2 mod research (docs/MOD_SPIKE.md) that the app must respect

- The mod creates one game road segment per `RoadEdge`, as a cubic Bezier. Segment length must be
  24 to 200 game metres. Validation is skipped on import, so the app must deliver a clean graph.
- The game merges nodes that are closer than about 22 m. Every pair of distinct nodes must be at
  least 24 game metres apart, and edges that are not connected must not run closer than that either
  (except where they cross on different levels).
- A road or rail node exactly on the playable border (gx or gz = +-7168) becomes an outside connection.
- Elevation is metres above the terrain per node: bridges need at least 8 m, tunnels are negative.
- The sea is a global level (`terrain.hasSea` + `terrain.seaLevel`); lakes and rivers are level
  sources (`WaterSource`) and need a carved bed in the heightmap.
- Natural resources are 256 x 256 cell maps. Forest comes from the trees themselves.
- Trees must not stand in water, on roads or on rails.

### Package format (version 1), a folder of files

Written to `%LocalLow%/Colossal Order/Cities Skylines II/ModsData/CS2MapBuilder/packages/<name>/`.

| File | Content |
|---|---|
| `manifest.json` | `{ format: "cs2mapbuilder", version: 1, name, selection, scale, heightScale, seaLevel, hasSea, baseElevation, theme, startTile, counts: { nodes, edges, trees, waterSources }, netPrefabs: { <NetPrefab>: "<game prefab name>" }, treePrefabs: { <TreeSpecies>: "<game prefab name>" }, treeSpecies: TreeSpecies[], warnings, attribution }` |
| `heightmap.png`, `worldmap.png` | 4096 x 4096, 16-bit greyscale, row 0 = top (max gz) |
| `roads.json` | `{ nodes: [[id, gx, gz, elevation, outside 0/1], ...], edges: [{ id, a, b, cls, prefab, oneway, bridge, tunnel, name?, bezier: [x0, z0, x1, z1, x2, z2, x3, z3] }, ...] }`, edges ordered motorway first, paths last |
| `trees.bin` | little-endian: magic `CS2T`, uint32 version (1), uint32 count, then count x (float32 gx, float32 gz), then count x uint8 species index, then count x uint8 age |
| `water.json` | `{ seaLevel, hasSea, sources: [{ kind, x, z, radius, level, rate? }] }` |
| `climate.json` | the `ClimateProfile` plus `seasons: [{ name, startMonth, tempNightC, tempDayC, cloudChance, precipChance }]` (4 entries) |
| `resources/fertile.png`, `ore.png`, `oil.png`, `groundwater.png` | 256 x 256, 8-bit greyscale |

Game prefab names (validated by the mod at runtime): highways `Highway Oneway - 1 lane` / `- 2 lanes` /
`- 3 lanes` / `- 4 lanes`, `Highway Twoway - 2 lanes` / `- 3 lanes`; `Large Road`, `Large Road Oneway`,
`Medium Road`, `Medium Road Oneway`, `Small Road`, `Small Road Oneway`, `Gravel Road`, `Alley`,
`Pavement Path`; `Double Train Track`, `Twoway Train Track`, `Double Tram Track`, `Double Subway Track`.
Trees: `BirchTree01`, `OakTree01`, `NA_LindenTree01`, `EU_ChestnutTree01`, `EU_PoplarTree01`,
`EU_AlderTree01`, `AppleTree01`, `NA_HickoryTree01`, `NA_LondonPlaneTree01`, `PineTree01`,
`SpruceTree01`, `GreenBushWild01`, `CoconutPalmTree01` (eucalyptus has no vanilla prefab: use `NA_LondonPlaneTree01`).

`climate.json` units (pinned): `startMonth` is 1 to 12, `cloudChance` and `precipChance` are 0..1,
temperatures in degrees Celsius. `roads.json` `prefab` holds the abstract `NetPrefab` id; the
manifest's `netPrefabs` maps it to the game prefab name.

## M5 additions: zoning preview, manual playability edits, connectors

| File | Export |
|---|---|
| `core/zoning/buildZones.ts` | `buildZones(input: ZoneInput): ZonePreview` |
| `core/roads/connector.ts` | `addOutsideConnection(net, terrain, kind: 'road' \| 'rail', p: Pt): ConnectorResult` |
| `core/manual/applyManual.ts` | `applyManual(result: BuildResult): BuildResult` |

```ts
interface ZoneInput { roads: RoadNetwork; terrain: TerrainResult; landcover?: LandcoverGrid; vectors?: VectorData }
interface ConnectorResult { net: RoadNetwork; ok: boolean; reason?: string } // reason in Swedish when !ok
```

- Game zoning facts: cells are 8 x 8 game metres, up to 6 cells (48 m) deep on both sides of a road.
  Zonable: small, medium and large roads (two-way and one-way), gravel roads and alleys.
  Not zonable: highways, rail, tram, subway, pedestrian paths, bridges, tunnels.
- `applyManual` is idempotent: it always starts from `result.baseRoads` (sets it from `result.roads`
  the first time), applies `result.settings.manual`, guarantees at least one road outside connection
  (adds a connector at the best border point when the real network has none), and recomputes
  `result.playability`. It returns a new `BuildResult` object sharing the untouched heavy arrays.
- The package manifest gains an optional `outsideConnections: [{ kind, x, z, synthetic, manual }]`
  list (all kinds, from the playability report) for the mod.
