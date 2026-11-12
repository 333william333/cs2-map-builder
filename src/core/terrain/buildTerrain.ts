import {
  CS2,
  type ElevationSampler,
  type LandcoverGrid,
  type Progress,
  type Quality,
  type TerrainResult,
  type TerrainSettings,
  type VectorData,
} from '../types';
import type { Frame } from '../geo/frame';
import type { WorldWater } from '../data/worldWater';
import { sampleElevationGrid } from './sample';
import { edgeAwareSmooth } from './filters';
import {
  addLandcoverLakes,
  addToField,
  bodyStats,
  boxFor,
  carveAreas,
  carveLines,
  carveSea,
  classifySea,
  collectBodies,
  createScratch,
  createSurfField,
  labelGrid,
  makeHeightAt,
  prepareLines,
  WATER,
  type Scratch,
  type WGrid,
} from './water';
import { centreRegion, embedPlayable, embedPlayableWater } from './world';

export interface TerrainInput {
  frame: Frame;
  settings: TerrainSettings;
  /** output resolution: draft = playable 512 / world 256, full = 4096 / 4096 */
  quality: Quality;
  playableElev: ElevationSampler;
  worldElev: ElevationSampler;
  /** detailed water polygons / waterways (playable area + 5 % margin) for carving */
  vectors?: VectorData;
  /** water class as extra water evidence (playable area) */
  landcover?: LandcoverGrid;
  /** coarse water outlines for the whole world area (sea, lakes, major rivers) */
  worldWater?: WorldWater;
}

export const TERRAIN_RES: Record<Quality, { playable: number; world: number }> = {
  draft: { playable: 512, world: 256 },
  full: { playable: 4096, world: 4096 },
};

/** Share of world cells that must be sea for the area to count as coastal (base = sea level). */
const COASTAL_SHARE = 0.005;
/** detailed vectors cover the playable area plus this margin (see data/osm.ts, data/vectortiles.ts) */
const DETAIL_MARGIN = 1.05;

/** Game height metres per real elevation metre. */
export function verticalScale(settings: TerrainSettings, horizontal: number): number {
  const mode =
    settings.verticalMode === 'true' ? 1
    : settings.verticalMode === 'proportional' ? horizontal
    : settings.verticalFactor;
  return mode * settings.exaggeration;
}

/** 4096 when everything fits, else the next multiple of 512 above the maximum height. */
export function chooseHeightScale(maxHeight: number): number {
  if (maxHeight <= CS2.DEFAULT_HEIGHT_SCALE_M) return CS2.DEFAULT_HEIGHT_SCALE_M;
  return (Math.floor(maxHeight / 512) + 1) * 512;
}

function smoothGrid(g: WGrid, smoothing: number, scaleH: number, vertical: number, scratch: Scratch): void {
  const s = Math.min(1, Math.max(0, smoothing));
  if (s <= 0) return;
  const n = g.N * g.N;
  const cellReal = g.cell / scaleH;
  const r = Math.max(1, Math.min(Math.floor(g.N / 8), Math.round((s * 120) / cellReal)));
  const tau = Math.max(1e-3, vertical * (0.75 + 2.5 * s));
  const strength = Math.min(1, 0.4 + s);
  edgeAwareSmooth(
    g.H, g.N, r, tau, strength,
    new Float32Array(scratch.a, 0, n),
    new Float32Array(scratch.b, 0, n),
  );
}

export function buildTerrain(input: TerrainInput, progress?: Progress): TerrainResult {
  const report = (f: number, msg: string) => progress?.('terrain', f, msg);
  const { frame, settings } = input;
  const res = TERRAIN_RES[input.quality];
  const Np = res.playable;
  const Nw = res.world;
  const Ep = CS2.PLAYABLE_SIZE_M;
  const Ew = CS2.WORLD_SIZE_M;
  const horizontal = frame.scale;
  const vertical = verticalScale(settings, horizontal);
  const seaLevel = settings.seaLevelGame;
  const carve = settings.carveWater;

  report(0, 'Reading world heightmap data');
  const Hw = sampleElevationGrid(frame, input.worldElev, Ew, Nw);
  report(0.2, 'Reading playable-area heightmap data');
  const Hp = sampleElevationGrid(frame, input.playableElev, Ep, Np);

  const { lo, hi } = centreRegion(Nw);
  const lo0 = lo, hi0 = hi;
  // The two grids come from different DEM zoom levels. Make the world's raw elevation agree with the
  // playable grid where they overlap (centre quarter = area-averaged playable, faded over a band),
  // so sea, lakes, rivers and land are classified and shaped from the same numbers on both sides.
  // The band is wide (1/8 of the playable side) because the sources can differ a lot (bathymetry).
  const RAW_BAND = 1 / 8;
  embedPlayable(Hw, Nw, Hp, Np, RAW_BAND);
  const rawBand = Math.max(4, Math.round((hi0 - lo0) * RAW_BAND));

  // ---- one set of water bodies for both grids
  report(0.35, 'Identifying water bodies');
  const B = collectBodies(input.vectors?.waterPolygons, input.worldWater?.waterPolygons);
  const Labels = B.polys.length < 30000 ? Uint16Array : Int32Array;
  const grid = (N: number, E: number, H: Float32Array, isWorld: boolean): WGrid => ({
    N, E, cell: E / N, H,
    water: new Uint8Array(N * N),
    level: new Float32Array(N * N).fill(NaN),
    labels: new Labels(N * N),
    isWorld,
    detailBox: isWorld ? boxFor(N, E, (Ep / 2) * DETAIL_MARGIN) : null,
    skipBox: isWorld ? { c0: lo, c1: hi - 1, r0: lo, r1: hi - 1 } : null,
    fineDemBox: isWorld ? { c0: lo - rawBand, c1: hi - 1 + rawBand, r0: lo - rawBand, r1: hi - 1 + rawBand } : null,
  });
  const play = grid(Np, Ep, Hp, false);
  const world = grid(Nw, Ew, Hw, true);
  const scratch: Scratch = createScratch(Math.max(Np, Nw) ** 2);
  if (B.polys.length) {
    labelGrid(world, B);
    labelGrid(play, B);
  }

  // ---- sea, from real elevations and ocean outlines, consistent on both grids
  const useOcean = !!input.worldWater || B.ocean.length > 0;
  classifySea(world, play, Hw, Hp, B, useOcean, horizontal, scratch);
  let seaW = 0, seaP = 0;
  for (let i = 0; i < world.water.length; i++) if (world.water[i] === WATER.sea) seaW++;
  for (let i = 0; i < play.water.length; i++) if (play.water[i] === WATER.sea) seaP++;
  const coastal = seaW >= COASTAL_SHARE * Nw * Nw || seaP > 0;
  if (!coastal) {
    world.water.fill(0);
    play.water.fill(0);
  }

  // base elevation: sea level for coastal areas, otherwise a robust low point of the area
  let minReal = Infinity;
  for (let i = 0; i < Hw.length; i++) if (Hw[i] < minReal) minReal = Hw[i];
  for (let i = 0; i < Hp.length; i++) if (Hp[i] < minReal) minReal = Hp[i];
  // Inland: a robust low quantile instead of the absolute minimum, so a sliver of distant sea
  // or a DEM pit in the world area does not lift the whole map (there is seaLevel of room below).
  const baseElev = coastal ? 0 : Math.max(minReal, Math.min(lowQuantile(Hw), lowQuantile(Hp)));
  for (const H of [Hw, Hp]) for (let i = 0; i < H.length; i++) H[i] = seaLevel + (H[i] - baseElev) * vertical;

  report(0.45, 'Smoothing terrain');
  smoothGrid(play, settings.smoothing, horizontal, vertical, scratch);
  smoothGrid(world, settings.smoothing, horizontal, vertical, scratch);

  report(0.55, 'Shaping sea, lakes and rivers');
  if (coastal) {
    carveSea(world, seaLevel, carve, scratch);
    carveSea(play, seaLevel, carve, scratch);
  }
  if (carve && input.landcover) addLandcoverLakes(play, input.landcover, B, horizontal, vertical, scratch);
  if (B.kind.length > 1) {
    const stats = bodyStats([play, world], B, scratch);
    carveAreas(play, B, stats, carve, scratch);
    carveAreas(world, B, stats, carve, scratch);
  }

  if (carve) {
    // waterway profiles in game coordinates, shared by both grids
    const heightAt = makeHeightAt(play, world);
    const cellP = Ep / Np;
    const lim = Ew / 2;
    const coarseW = input.worldWater?.waterways ?? [];
    const detailW = input.vectors?.waterways ?? [];
    const field = createSurfField(Ew, Math.min(1024, 2 * Nw));
    let coarse = prepareLines(coarseW, false, heightAt, null, horizontal, cellP, lim);
    addToField(field, coarse);
    const detail = prepareLines(detailW, true, heightAt, field, horizontal, cellP, lim);
    if (detail.length && coarse.length) {
      addToField(field, detail);
      coarse = prepareLines(coarseW, false, heightAt, field, horizontal, cellP, lim);
    }
    const lines = [...detail, ...coarse];
    report(0.75, 'Carving rivers');
    carveLines(play, lines, B.hasDetail, carve, scratch);
    carveLines(world, lines, B.hasDetail, carve, scratch);
  }

  report(0.9, 'Blending the world map with the playable area');
  embedPlayable(Hw, Nw, Hp, Np);
  embedPlayableWater(world.water, world.level, Nw, play.water, play.level, Np);

  let minH = Infinity;
  let maxH = -Infinity;
  for (const H of [Hp, Hw]) {
    for (let i = 0; i < H.length; i++) {
      let v = H[i];
      if (!(v > 0)) v = H[i] = 0; // clamp at 0 (also catches NaN)
      if (v < minH) minH = v;
      if (v > maxH) maxH = v;
    }
  }
  const heightScale = chooseHeightScale(maxH);
  report(1, 'Terrain done');

  return {
    playable: { size: Np, extentM: Ep, data: Hp },
    world: { size: Nw, extentM: Ew, data: Hw },
    scale: { horizontal, vertical },
    seaLevel,
    heightScale,
    waterMask: play.water,
    worldWaterMask: world.water,
    waterLevel: play.level,
    worldWaterLevel: world.level,
    baseElevation: baseElev,
    hasSea: coastal,
    minHeight: minH,
    maxHeight: maxH,
  };
}

/** 0.2 % quantile of a grid, estimated from a strided subsample. */
function lowQuantile(H: Float32Array): number {
  const stride = Math.max(1, Math.floor(H.length / 200_000));
  const n = Math.ceil(H.length / stride);
  const sub = new Float32Array(n);
  for (let i = 0, k = 0; i < H.length; i += stride, k++) sub[k] = H[i];
  sub.sort();
  return sub[Math.min(n - 1, Math.floor(n * 0.002))];
}
