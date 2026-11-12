import { loadClimate } from './data/climate';
import { loadElevation } from './data/elevation';
import { loadLandcover } from './data/landcover';
import { loadVectors } from './data/osm';
import { loadVectorsFromTiles } from './data/vectortiles';
import { analyzePlayability } from './playability/analyze';
import { buildRoads } from './roads/buildRoads';
import { applyManual } from './manual/applyManual';
import { buildWaterSources } from './water/buildWaterSources';
import { buildZones } from './zoning/buildZones';
import { createFrame } from './geo/frame';
import { buildTerrain } from './terrain/buildTerrain';
import { buildTrees } from './trees/buildTrees';
import {
  CS2,
  type BuildResult,
  type BuildSettings,
  type ClimateProfile,
  type FetchBytes,
  type LandcoverGrid,
  type Progress,
  type Selection,
  type VectorData,
} from './types';

export interface BuildOptions {
  /** fast auto-preview: terrain and land cover only, no OSM download */
  terrainOnly?: boolean;
}

/** Stage weights for the overall progress bar. */
const STAGES = { data: 0.55, terrain: 0.3, features: 0.15 } as const;
const OVERPASS_BUDGET_MS = 75_000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The whole build: download data, shape the terrain, derive roads/trees/etc.
 * Missing optional data never fails the build; it is reported in `warnings`.
 */
export async function runBuild(
  selection: Selection,
  settings: BuildSettings,
  fetch: FetchBytes,
  progress: Progress,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  const frame = createFrame(selection);
  const draft = settings.quality === 'draft';
  const warnings: string[] = [];

  // ---- 1. data, in parallel ------------------------------------------------
  const part = { elevP: 0, elevW: 0, vec: 0, lc: 0 };
  const wantVectors = !opts.terrainOnly && (settings.water.enabled || settings.roads.enabled || settings.trees.enabled);
  const reportData = (msg?: string) => {
    const done = (part.elevP + part.elevW + (wantVectors ? part.vec : 1) + part.lc) / 4;
    progress('data', done * STAGES.data, msg);
  };
  reportData('Fetching elevation, map data and land cover');

  const elevPlayable = loadElevation(frame, CS2.PLAYABLE_SIZE_M, draft ? 512 : 2048, fetch, (_s, f) => {
    part.elevP = f;
    reportData('Fetching elevation');
  });
  const elevWorld = loadElevation(frame, CS2.WORLD_SIZE_M, draft ? 256 : 1024, fetch, (_s, f) => {
    part.elevW = f;
    reportData('Fetching surrounding elevation');
  });

  const vecProgress: Progress = (_s, f) => {
    part.vec = f;
    reportData('Fetching roads and water from OpenStreetMap');
  };
  // Draft: vector tiles (static files, about a second). Full: Overpass for richer tags
  // (lanes, roundabouts, single trees), with the tiles as fallback when it is slow or down.
  const fromTiles = () => loadVectorsFromTiles(frame, settings, fetch, vecProgress);
  const fromOverpass = () =>
    withTimeout(loadVectors(frame, settings, fetch, vecProgress), OVERPASS_BUDGET_MS, 'Overpass did not respond in time');
  const vectorsP: Promise<VectorData | undefined> = !wantVectors
    ? Promise.resolve(undefined)
    : (draft
        ? fromTiles()
        : fromOverpass().catch((e) => {
            warnings.push(
              `The OpenStreetMap Overpass server did not respond (${errText(e)}). Used vector tiles instead: lane counts and individual trees are missing.`,
            );
            return fromTiles();
          })
      ).catch((e) => {
        warnings.push(`Map data from OpenStreetMap could not be fetched (${errText(e)}). Roads and water outlines are missing.`);
        return undefined;
      });

  const landcoverP: Promise<LandcoverGrid | undefined> = loadLandcover(
    frame,
    CS2.PLAYABLE_SIZE_M,
    draft ? 512 : 1024,
    fetch,
    (_s, f) => {
      part.lc = f;
      reportData('Fetching land cover');
    },
  ).catch((e) => {
    warnings.push(`Land cover (ESA WorldCover) could not be fetched (${errText(e)}). Forest and farmland are not estimated.`);
    return undefined;
  });

  // climate is small and optional; never let it block or fail the build
  const climateP: Promise<ClimateProfile | undefined> =
    !opts.terrainOnly && (settings.climate.enabled || settings.trees.enabled)
      ? withTimeout(loadClimate(selection, fetch), 30_000, 'timeout').catch((e) => {
          warnings.push(`Climate data (Open-Meteo) could not be fetched (${errText(e)}). Trees are chosen by latitude.`);
          return undefined;
        })
      : Promise.resolve(undefined);

  const [playableElev, worldElev, vectors, landcover] = await Promise.all([
    elevPlayable,
    elevWorld,
    vectorsP.then((v) => {
      part.vec = 1;
      return v;
    }),
    landcoverP.then((l) => {
      part.lc = 1;
      return l;
    }),
  ]);

  // small streams are opt-in: each one needs its own water source in the game
  if (vectors && !settings.water.streams) {
    vectors.waterways = vectors.waterways.filter((w) => w.kind !== 'stream');
  }

  // ---- 2. terrain ----------------------------------------------------------
  const terrain = buildTerrain(
    {
      frame,
      settings: settings.terrain,
      quality: settings.quality,
      playableElev,
      worldElev,
      vectors: settings.water.enabled ? vectors : undefined,
      landcover: settings.water.enabled ? landcover : undefined,
    },
    (_s, f, msg) => progress('terrain', STAGES.data + f * STAGES.terrain, msg ?? 'Shaping terrain'),
  );

  const climate = await climateP;
  let result: BuildResult = {
    selection,
    settings,
    terrain,
    landcover,
    vectors,
    climate,
    waterSources: [],
    warnings,
  };

  // ---- 3. derived features ----------------------------------------------------
  const feat = (f: number, msg: string) => progress('features', STAGES.data + STAGES.terrain + f * STAGES.features, msg);
  const step = <T>(label: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      warnings.push(`${label} failed (${errText(e)}).`);
      return undefined;
    }
  };

  if (settings.water.enabled) {
    feat(0.1, 'Placing water sources');
    result.waterSources = step('Water sources', () => buildWaterSources(terrain, vectors)) ?? [];
  }

  if (settings.roads.enabled && vectors && !opts.terrainOnly) {
    feat(0.2, 'Building the road network');
    result.roads = step('Road network', () => buildRoads(vectors, terrain, settings.roads));
  }

  // Manual edits and the guaranteed road to the map edge come before zones and trees,
  // so those respect the connector roads. (Skipped for the terrain-only auto preview.)
  if (!opts.terrainOnly) {
    feat(0.3, 'Securing connections to the outside world');
    result = step('Connections', () => applyManual(result)) ?? result;
  }

  if (settings.trees.enabled && !opts.terrainOnly) {
    feat(0.5, 'Planting trees');
    // a draft shows the forest footprint with a small budget; the full build uses the user's budget
    const treeSettings = draft ? { ...settings.trees, budget: Math.min(settings.trees.budget, 120_000) } : settings.trees;
    result.trees = step('Tree placement', () =>
      buildTrees({
        terrain,
        settings: treeSettings,
        landcover,
        vectors,
        climate,
        roads: result.roads,
        centerLat: selection.centerLat,
      }),
    );
  }

  if (result.roads) {
    feat(0.7, 'Laying out zones');
    const roads = result.roads;
    result.zones = step('Zoning', () => buildZones({ roads, terrain, landcover, vectors }));
  }

  feat(0.8, 'Assessing playability');
  if (opts.terrainOnly) {
    result.playability = step('Playability report', () =>
      analyzePlayability({ terrain, settings, landcover, vectors, roads: result.roads, trees: result.trees }),
    );
  } else {
    // again at the end: refreshes the report with trees in place (idempotent, same connectors)
    result = step('Playability report', () => applyManual(result)) ?? result;
  }
  result.warnings = [...new Set(result.warnings ?? [])];

  progress('done', 1, 'Done');
  return result;
}
