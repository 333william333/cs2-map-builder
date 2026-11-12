/**
 * Smoke test of the remote data loaders against the real services.
 * Run once: npx tsx scripts/smoke-data.ts
 */
import { createFrame } from '../src/core/geo/frame';
import { loadElevation } from '../src/core/data/elevation';
import { loadVectors } from '../src/core/data/osm';
import { loadLandcover } from '../src/core/data/landcover';
import { CS2, DEFAULT_SELECTION, DEFAULT_SETTINGS, type FetchBytes } from '../src/core/types';

let requests = 0;
const nodeFetch: FetchBytes = async (url, opts) => {
  requests++;
  const res = await fetch(url, {
    method: opts?.method ?? 'GET',
    headers: { 'User-Agent': 'CS2MapBuilder/0.1', ...(opts?.headers ?? {}) },
    body: opts?.method === 'POST' ? opts.body : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const lap = (label: string) => console.log(`  (${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s since start, ${requests} requests)`);

async function main() {
  const frame = createFrame(DEFAULT_SELECTION);
  console.log(`Selection: Uppsala ${DEFAULT_SELECTION.sizeMeters} m, scale ${frame.scale}`);

  console.log('\n== Elevation ==');
  const elev = await loadElevation(frame, CS2.PLAYABLE_SIZE_M, 1024, nodeFetch);
  let min = Infinity, max = -Infinity, sum = 0;
  const N = 64;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const gx = -CS2.PLAYABLE_SIZE_M / 2 + ((c + 0.5) * CS2.PLAYABLE_SIZE_M) / N;
      const gz = CS2.PLAYABLE_SIZE_M / 2 - ((r + 0.5) * CS2.PLAYABLE_SIZE_M) / N;
      const [lat, lon] = frame.gameToGeo(gx, gz);
      const h = elev.sample(lat, lon);
      if (h < min) min = h;
      if (h > max) max = h;
      sum += h;
    }
  }
  console.log(`zoom ${elev.zoom}, tiles ${elev.tileCount}`);
  console.log(`elevation over ${N}x${N}: min ${min.toFixed(1)} m, max ${max.toFixed(1)} m, mean ${(sum / (N * N)).toFixed(1)} m`);
  lap('elevation');

  console.log('\n== OSM vectors ==');
  let vec;
  try {
    vec = await loadVectors(frame, DEFAULT_SETTINGS, nodeFetch);
  } catch (e) {
    console.log(`first attempt failed (${(e as Error).message}); waiting 30 s and retrying once`);
    await sleep(30_000);
    vec = await loadVectors(frame, DEFAULT_SETTINGS, nodeFetch);
  }
  const perClass: Record<string, number> = {};
  for (const w of vec.ways) perClass[w.cls] = (perClass[w.cls] ?? 0) + 1;
  console.log('ways per class:', perClass, `(total ${vec.ways.length})`);
  const extra = {
    oneway: vec.ways.filter((w) => w.oneway).length,
    bridge: vec.ways.filter((w) => w.bridge).length,
    tunnel: vec.ways.filter((w) => w.tunnel).length,
    roundabout: vec.ways.filter((w) => w.roundabout).length,
    link: vec.ways.filter((w) => w.link).length,
    named: vec.ways.filter((w) => w.name).length,
  };
  console.log('way flags:', extra);
  const wk: Record<string, number> = {};
  for (const w of vec.waterPolygons) wk[w.kind] = (wk[w.kind] ?? 0) + 1;
  const holes = vec.waterPolygons.filter((w) => w.rings.length > 1).length;
  console.log('water polygons:', vec.waterPolygons.length, wk, `with holes: ${holes}`);
  const wwk: Record<string, number> = {};
  for (const w of vec.waterways) wwk[w.kind] = (wwk[w.kind] ?? 0) + 1;
  console.log('waterways:', vec.waterways.length, wwk, `with width: ${vec.waterways.filter((w) => w.widthM).length}`);
  const ak: Record<string, number> = {};
  for (const a of vec.areas) ak[a.kind] = (ak[a.kind] ?? 0) + 1;
  console.log('areas:', vec.areas.length, ak);
  console.log(`treePoints ${vec.treePoints.length}, powerLines ${vec.powerLines.length}`);
  lap('osm');

  console.log('\n== Landcover (256 grid) ==');
  const lc = await loadLandcover(frame, CS2.PLAYABLE_SIZE_M, 256, nodeFetch);
  const hist: Record<number, number> = {};
  for (const v of lc.data) hist[v] = (hist[v] ?? 0) + 1;
  const total = lc.data.length;
  const names: Record<number, string> = {
    0: 'None', 10: 'Tree', 20: 'Shrub', 30: 'Grass', 40: 'Crop', 50: 'Built', 60: 'Bare', 70: 'Snow',
    80: 'Water', 90: 'Wetland', 95: 'Mangrove', 100: 'Moss',
  };
  for (const [k, n] of Object.entries(hist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padStart(3)} ${(names[+k] ?? '?').padEnd(8)} ${((100 * n) / total).toFixed(1)} %  (${n})`);
  }
  lap('landcover');
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
