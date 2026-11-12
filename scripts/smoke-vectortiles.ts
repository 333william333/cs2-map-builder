/**
 * Smoke test of the OpenFreeMap vector tile loader against the real service.
 * Run once: npx tsx scripts/smoke-vectortiles.ts [name lat lon sizeMeters]
 * Writes exports/<name>-vectors.json ({ ...vectors, scale }) for other scripts (default: Uppsala).
 * Areas used for the road report: uppsala (default), bergen 60.3943 5.3259 14336,
 * stockholm60 59.33 18.06 60000, frankfurt 50.0537 8.5856 14336 (motorway interchanges).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createFrame } from '../src/core/geo/frame';
import { loadVectorsFromTilesDetailed } from '../src/core/data/vectortiles';
import { DEFAULT_SELECTION, DEFAULT_SETTINGS, type FetchBytes } from '../src/core/types';

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

async function main() {
  const [name = 'uppsala', lat, lon, size] = process.argv.slice(2);
  const sel = lat
    ? { ...DEFAULT_SELECTION, centerLat: Number(lat), centerLon: Number(lon), sizeMeters: Number(size ?? 14336) }
    : DEFAULT_SELECTION;
  const frame = createFrame(sel);
  console.log(`Selection: ${name} ${sel.sizeMeters} m, scale ${frame.scale}`);
  const t0 = Date.now();
  const { data, info } = await loadVectorsFromTilesDetailed(frame, DEFAULT_SETTINGS, nodeFetch, (_s, f, m) => {
    if (m && Math.round(f * 100) % 25 === 0) console.log(`  ${(f * 100).toFixed(0)}% ${m}`);
  });
  const secs = (Date.now() - t0) / 1000;
  console.log(`zoom ${info.zoom}, tiles ${info.tileCount} (failed ${info.failedTiles}, empty ${info.emptyTiles}), ${requests} requests`);
  console.log(`bytes ${info.bytes} (${(info.bytes / 1e6).toFixed(2)} MB), time ${secs.toFixed(1)} s`);

  console.log('\nways per class (before -> after stitching):');
  const classes = new Set([...Object.keys(info.waysBefore), ...Object.keys(info.waysAfter)]);
  for (const c of classes) {
    console.log(`  ${c.padEnd(12)} ${String(info.waysBefore[c as keyof typeof info.waysBefore] ?? 0).padStart(6)} -> ${String(info.waysAfter[c as keyof typeof info.waysAfter] ?? 0).padStart(6)}`);
  }
  const nb = Object.values(info.waysBefore).reduce((a, b) => a + (b ?? 0), 0);
  console.log(`  total        ${String(nb).padStart(6)} -> ${String(data.ways.length).padStart(6)}`);
  console.log(`named ways: ${info.namedWays} / ${data.ways.length} (${((100 * info.namedWays) / Math.max(1, data.ways.length)).toFixed(1)} %)`);
  console.log(`water polygons: ${data.waterPolygons.length} (pieces before union, all polygon kinds: ${info.polygonPiecesBefore})`);
  console.log(`waterways: ${data.waterways.length} (pieces before: ${info.waterwaysBefore})`);
  const kinds: Record<string, number> = {};
  for (const a of data.areas) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
  console.log('areas per kind:', kinds);
  console.log('seen polygon/water classes:', info.seenClasses);

  mkdirSync('exports', { recursive: true });
  writeFileSync(`exports/${name}-vectors.json`, JSON.stringify({ ...data, scale: frame.scale }));
  console.log(`\nwrote exports/${name}-vectors.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
