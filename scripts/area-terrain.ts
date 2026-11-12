/**
 * Build and cache the real terrain (heights + water mask) of an area for road reports and tests.
 *
 *   npx tsx scripts/area-terrain.ts <name> <lat> <lon> <sizeMeters> [--full]
 *
 * Same pieces as src/core/pipeline.ts (elevation, vector tiles for water carving, land cover,
 * world water, buildTerrain). Network responses are cached under .cache/terrain-report.
 * Writes exports/<name>-terrain.bin (see writeTerrain / readTerrain in scripts/terrainFile.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadElevation } from '../src/core/data/elevation';
import { loadLandcover } from '../src/core/data/landcover';
import { loadVectorsFromTiles } from '../src/core/data/vectortiles';
import { loadWorldWater } from '../src/core/data/worldWater';
import { createFrame } from '../src/core/geo/frame';
import { buildTerrain } from '../src/core/terrain/buildTerrain';
import { CS2, DEFAULT_SETTINGS, type FetchBytes, type Selection } from '../src/core/types';
import { writeTerrain } from './terrainFile';

const CACHE = '.cache/terrain-report';
mkdirSync(CACHE, { recursive: true });
const nodeFetch: FetchBytes = async (url, opts) => {
  const key = createHash('sha1').update(`${opts?.method ?? 'GET'} ${url} ${JSON.stringify(opts?.headers ?? {})} ${opts?.body ?? ''}`).digest('hex');
  const file = `${CACHE}/${key}`;
  if (existsSync(file)) return new Uint8Array(readFileSync(file));
  const res = await fetch(url, {
    method: opts?.method ?? 'GET',
    headers: { 'User-Agent': 'CS2MapBuilder/0.1', ...(opts?.headers ?? {}) },
    body: opts?.method === 'POST' ? opts.body : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(file, bytes);
  return bytes;
};

async function main() {
  const [name, lat, lon, size] = process.argv.slice(2);
  if (!name || !lat || !lon) {
    console.error('usage: npx tsx scripts/area-terrain.ts <name> <lat> <lon> <sizeMeters> [--full]');
    process.exit(1);
  }
  const full = process.argv.includes('--full');
  const sel: Selection = { centerLat: Number(lat), centerLon: Number(lon), sizeMeters: Number(size ?? 14336), rotationDeg: 0 };
  const frame = createFrame(sel);
  const settings = { ...DEFAULT_SETTINGS, quality: full ? ('full' as const) : ('draft' as const) };
  const t0 = Date.now();
  const [playableElev, worldElev, vectors, landcover, worldWater] = await Promise.all([
    loadElevation(frame, CS2.PLAYABLE_SIZE_M, full ? 2048 : 1024, nodeFetch),
    loadElevation(frame, CS2.WORLD_SIZE_M, full ? 1024 : 256, nodeFetch),
    loadVectorsFromTiles(frame, settings, nodeFetch),
    loadLandcover(frame, CS2.PLAYABLE_SIZE_M, 512, nodeFetch).catch(() => undefined),
    loadWorldWater(frame, nodeFetch).catch(() => undefined),
  ]);
  if (!settings.water.streams) vectors.waterways = vectors.waterways.filter((w) => w.kind !== 'stream');
  const terrain = buildTerrain({
    frame, settings: settings.terrain, quality: settings.quality, playableElev, worldElev, vectors, landcover, worldWater,
  });
  mkdirSync('exports', { recursive: true });
  writeTerrain(`exports/${name}-terrain.bin`, terrain);
  const water = terrain.waterMask.reduce((s, v) => s + (v ? 1 : 0), 0) / terrain.waterMask.length;
  console.log(
    `${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s, grid ${terrain.playable.size}, scale ${terrain.scale.horizontal.toFixed(4)}, ` +
      `heights ${terrain.minHeight.toFixed(1)}..${terrain.maxHeight.toFixed(1)}, sea ${terrain.hasSea} at ${terrain.seaLevel.toFixed(1)}, water ${(water * 100).toFixed(1)} %`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
