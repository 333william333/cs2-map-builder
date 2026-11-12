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
import { sampleElevationGrid } from './sample';
import { edgeAwareSmooth } from './filters';
import { createScratch, prepareLines, processWater, type GridCtx, type Scratch } from './water';
import { embedPlayable } from './world';

export interface TerrainInput {
  frame: Frame;
  settings: TerrainSettings;
  /** output resolution: draft = playable 512 / world 256, full = 4096 / 4096 */
  quality: Quality;
  playableElev: ElevationSampler;
  worldElev: ElevationSampler;
  /** water polygons / waterways for carving */
  vectors?: VectorData;
  /** water class as extra water evidence */
  landcover?: LandcoverGrid;
}

export const TERRAIN_RES: Record<Quality, { playable: number; world: number }> = {
  draft: { playable: 512, world: 256 },
  full: { playable: 4096, world: 4096 },
};

/** Share of world samples at or below 0 m from which the area counts as coastal (base = sea level). */
const COASTAL_SHARE = 0.005;

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

function smoothGrid(ctx: GridCtx, smoothing: number): void {
  const s = Math.min(1, Math.max(0, smoothing));
  if (s <= 0) return;
  const n = ctx.N * ctx.N;
  const cellReal = ctx.cell / ctx.scaleH;
  const r = Math.max(1, Math.min(Math.floor(ctx.N / 8), Math.round((s * 120) / cellReal)));
  const tau = Math.max(1e-3, ctx.vertical * (0.75 + 2.5 * s));
  const strength = Math.min(1, 0.4 + s);
  edgeAwareSmooth(
    ctx.H, ctx.N, r, tau, strength,
    new Float32Array(ctx.scratch.a, 0, n),
    new Float32Array(ctx.scratch.b, 0, n),
  );
}

function processGrid(ctx: GridCtx, smoothing: number): Uint8Array {
  smoothGrid(ctx, smoothing);
  const lines = prepareLines(ctx);
  return processWater(ctx, lines);
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

  report(0, 'Reading world heightmap data');
  const Hw = sampleElevationGrid(frame, input.worldElev, Ew, Nw);
  report(0.2, 'Reading playable-area heightmap data');
  const Hp = sampleElevationGrid(frame, input.playableElev, Ep, Np);

  // base elevation: sea level for coastal areas, otherwise the lowest point of the area
  let below = 0;
  let minReal = Infinity;
  for (let i = 0; i < Hw.length; i++) {
    const v = Hw[i];
    if (v <= 0) below++;
    if (v < minReal) minReal = v;
  }
  for (let i = 0; i < Hp.length; i++) if (Hp[i] < minReal) minReal = Hp[i];
  const coastal = below >= COASTAL_SHARE * Hw.length;
  // Inland: a robust low quantile instead of the absolute minimum, so a sliver of distant sea
  // or a DEM pit in the world area does not lift the whole map (there is seaLevel of room below).
  const baseElev = coastal ? 0 : Math.max(minReal, Math.min(lowQuantile(Hw), lowQuantile(Hp)));

  const toGame = (R: Float32Array): Uint8Array | null => {
    const cand = coastal ? new Uint8Array(R.length) : null;
    for (let i = 0; i < R.length; i++) {
      if (cand && R[i] <= 0) cand[i] = 1;
      R[i] = seaLevel + (R[i] - baseElev) * vertical;
    }
    return cand;
  };
  const seaCandW = toGame(Hw);
  const seaCandP = toGame(Hp);

  const scratch: Scratch = createScratch(Math.max(Np, Nw) ** 2);
  const common = {
    seaLevel, coastal, scaleH: horizontal, vertical, carve: settings.carveWater,
    vectors: input.vectors, landcover: input.landcover, scratch,
  };

  report(0.4, 'Processing terrain and water in the playable area');
  const waterMask = processGrid(
    { ...common, N: Np, E: Ep, cell: Ep / Np, H: Hp, seaCand: seaCandP, isWorld: false },
    settings.smoothing,
  );

  report(0.75, 'Processing the world map');
  processGrid(
    { ...common, N: Nw, E: Ew, cell: Ew / Nw, H: Hw, seaCand: seaCandW, isWorld: true },
    settings.smoothing,
  );

  report(0.9, 'Blending the world map with the playable area');
  embedPlayable(Hw, Nw, Hp, Np);

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
    waterMask,
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
