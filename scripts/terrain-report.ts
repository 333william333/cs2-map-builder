/**
 * Terrain seam report on real data (network, cached under .cache/terrain-report).
 *
 *   npx tsx scripts/terrain-report.ts <uppsala|bergen|stockholm> [--full] [--verbose] [--no-world-water]
 *
 * Prints seam metrics along the playable border (playable grid vs world grid just outside, split
 * into land and water), the number of border positions with water on one side and land on the
 * other, the centre-match error, and writes exports/terrain-<area>-<quality>.png (hillshade of the
 * world grid with water and the playable border drawn) and ...-playable.png.
 * The jump metrics come with a baseline: the same measure on a parallel line 8 world cells further
 * out, i.e. what the terrain itself gives at that resolution.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { encode } from 'fast-png';
import { loadElevation } from '../src/core/data/elevation';
import { loadLandcover } from '../src/core/data/landcover';
import { loadVectorsFromTiles } from '../src/core/data/vectortiles';
import { loadWorldWater } from '../src/core/data/worldWater';
import { createFrame } from '../src/core/geo/frame';
import { buildTerrain } from '../src/core/terrain/buildTerrain';
import { seamMetrics, type SeamStat } from '../src/core/terrain/seam';
import { centreRegion } from '../src/core/terrain/world';
import { CS2, DEFAULT_SETTINGS, type FetchBytes, type Selection } from '../src/core/types';

const AREAS: Record<string, [number, number]> = {
  uppsala: [59.8586, 17.6389],
  bergen: [60.3943, 5.3259],
  stockholm: [59.33, 18.06],
};

const area = (process.argv[2] ?? '').toLowerCase();
if (!AREAS[area]) {
  console.error('usage: npx tsx scripts/terrain-report.ts <uppsala|bergen|stockholm> [--full]');
  process.exit(1);
}
const full = process.argv.includes('--full');
const noWorldWater = process.argv.includes('--no-world-water');

const CACHE = '.cache/terrain-report';
mkdirSync(CACHE, { recursive: true });
let requests = 0;
let cached = 0;
const nodeFetch: FetchBytes = async (url, opts) => {
  const key = createHash('sha1').update(`${opts?.method ?? 'GET'} ${url} ${JSON.stringify(opts?.headers ?? {})} ${opts?.body ?? ''}`).digest('hex');
  const file = `${CACHE}/${key}`;
  if (existsSync(file)) {
    cached++;
    return new Uint8Array(readFileSync(file));
  }
  requests++;
  const res = await fetch(url, {
    method: opts?.method ?? 'GET',
    headers: { 'User-Agent': 'CS2MapBuilder/0.1', ...(opts?.headers ?? {}) },
    body: opts?.method === 'POST' ? opts.body : undefined,
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(file, bytes);
  return bytes;
};

function fmt(s: SeamStat): string {
  return `n=${String(s.n).padStart(4)}  jump max ${s.maxJump.toFixed(2).padStart(7)} mean ${s.meanJump.toFixed(3).padStart(7)}` +
    `  |diff| max ${s.maxDiff.toFixed(2).padStart(7)} mean ${s.meanDiff.toFixed(3).padStart(7)}` +
    `  (terrain baseline jump max ${s.maxBase.toFixed(2)} mean ${s.meanBase.toFixed(3)})`;
}

async function main() {
  const [lat, lon] = AREAS[area];
  const sel: Selection = { centerLat: lat, centerLon: lon, sizeMeters: 14336, rotationDeg: 0 };
  const frame = createFrame(sel);
  const settings = { ...DEFAULT_SETTINGS, quality: full ? 'full' as const : 'draft' as const };
  const t0 = Date.now();
  const tw0 = Date.now();
  let worldWaterMs = 0;
  const [playableElev, worldElev, vectors, landcover, worldWater] = await Promise.all([
    loadElevation(frame, CS2.PLAYABLE_SIZE_M, full ? 2048 : 512, nodeFetch),
    loadElevation(frame, CS2.WORLD_SIZE_M, full ? 1024 : 256, nodeFetch),
    loadVectorsFromTiles(frame, settings, nodeFetch),
    loadLandcover(frame, CS2.PLAYABLE_SIZE_M, full ? 1024 : 512, nodeFetch),
    noWorldWater
      ? Promise.resolve(undefined)
      : loadWorldWater(frame, nodeFetch).then((w) => {
          worldWaterMs = Date.now() - tw0;
          return w;
        }),
  ]);
  console.log(
    `${area} ${settings.quality}: data ${((Date.now() - t0) / 1000).toFixed(1)} s (${requests} fetched, ${cached} cached)` +
      (worldWater
        ? `, world water z${worldWater.zoom} ${worldWater.tiles} tiles ${worldWaterMs} ms: ` +
          `${worldWater.waterPolygons.length} polygons (${worldWater.waterPolygons.filter((p) => p.kind === 'sea').length} sea), ${worldWater.waterways.length} waterways`
        : ''),
  );
  // as in pipeline.ts: small streams are opt-in
  if (!settings.water.streams) vectors.waterways = vectors.waterways.filter((w) => w.kind !== 'stream');
  console.log(`playable vectors: ${vectors.waterPolygons.length} water polygons, ${vectors.waterways.length} waterways`);

  const t1 = Date.now();
  const terrain = buildTerrain({
    frame,
    settings: settings.terrain,
    quality: settings.quality,
    playableElev,
    worldElev,
    vectors,
    landcover,
    worldWater,
  });
  const secs = (Date.now() - t1) / 1000;
  const seam = seamMetrics(terrain, process.argv.includes('--verbose'));
  console.log(
    `terrain ${secs.toFixed(2)} s, hasSea ${terrain.hasSea}, base ${terrain.baseElevation.toFixed(1)} m, ` +
      `h ${terrain.minHeight.toFixed(1)}..${terrain.maxHeight.toFixed(1)}, heightScale ${terrain.heightScale}`,
  );
  const kinds = (m: Uint8Array | undefined) => {
    if (!m) return 'n/a';
    const c = [0, 0, 0, 0];
    for (const v of m) c[v]++;
    return `sea ${(100 * c[1] / m.length).toFixed(1)} %, lake ${(100 * c[2] / m.length).toFixed(1)} %, river ${(100 * c[3] / m.length).toFixed(1)} %`;
  };
  console.log(`playable water: ${kinds(terrain.waterMask)}; world water: ${kinds(terrain.worldWaterMask)}`);
  console.log(`seam land : ${fmt(seam.land)}`);
  console.log(`seam water: ${fmt(seam.water)}`);
  console.log(`water/land mismatch across border: ${seam.mixed} of ${seam.positions} positions (between two world cells further out: ${seam.mixedBaseline})`);
  for (const l of seam.notes ?? []) console.log('  ' + l);
  console.log(`centre match error: ${seam.centreError.toExponential(2)} m`);

  writeShade(terrain.world.data, terrain.world.size, CS2.WORLD_SIZE_M, terrain.worldWaterMask, terrain.seaLevel, true,
    `exports/terrain-${area}-${settings.quality}${noWorldWater ? '-nowater' : ''}.png`);
  writeShade(terrain.playable.data, terrain.playable.size, CS2.PLAYABLE_SIZE_M, terrain.waterMask, terrain.seaLevel, false,
    `exports/terrain-${area}-${settings.quality}-playable.png`);
}

function writeShade(W: Float32Array, Nw: number, extent: number, mask: Uint8Array | undefined, seaLevel: number, border: boolean, out: string) {
  const step = Math.max(1, Math.floor(Nw / 1024));
  const scaleUp = Nw < 512 ? 3 : 1;
  const M = Math.floor(Nw / step) * scaleUp;
  const cell = extent / Nw;
  const img = new Uint8Array(M * M * 3);
  const { lo, hi } = centreRegion(Nw);
  for (let y = 0; y < M; y++) {
    for (let x = 0; x < M; x++) {
      const r = Math.min(Nw - 2, Math.max(1, Math.floor(y / scaleUp) * step));
      const c = Math.min(Nw - 2, Math.max(1, Math.floor(x / scaleUp) * step));
      const i = r * Nw + c;
      const dx = (W[i + 1] - W[i - 1]) / (2 * cell), dz = (W[i + Nw] - W[i - Nw]) / (2 * cell);
      const k = 4;
      const shade = (k * dx * -0.7 + k * dz * -0.7 + 1) / Math.hypot(k * dx, k * dz, 1);
      const v = Math.max(0, Math.min(255, 70 + 150 * shade));
      const kind = mask ? mask[i] : W[i] < seaLevel - 0.25 ? 1 : 0;
      const o = (y * M + x) * 3;
      if (kind === 1) { img[o] = v * 0.15; img[o + 1] = v * 0.3; img[o + 2] = 90 + v * 0.4; }
      else if (kind === 2) { img[o] = v * 0.2; img[o + 1] = v * 0.5; img[o + 2] = 120 + v * 0.5; }
      else if (kind === 3) { img[o] = 0; img[o + 1] = 120 + v * 0.4; img[o + 2] = 160 + v * 0.3; }
      else { img[o] = v; img[o + 1] = v; img[o + 2] = v * 0.9; }
      const onBorder = (rr: number, cc: number) =>
        (rr === lo || rr === hi) && cc >= lo && cc <= hi || (cc === lo || cc === hi) && rr >= lo && rr <= hi;
      const rr = Math.round(y / scaleUp * step), cc = Math.round(x / scaleUp * step);
      if (border && onBorder(rr, cc)) { img[o] = 255; img[o + 1] = 40; img[o + 2] = 40; }
    }
  }
  mkdirSync('exports', { recursive: true });
  writeFileSync(out, encode({ width: M, height: M, data: img, channels: 3, depth: 8 }));
  console.log(`wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
