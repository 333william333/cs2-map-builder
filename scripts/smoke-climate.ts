/**
 * Smoke test of the climate loader against the real Open-Meteo archive.
 * Run once: npx tsx scripts/smoke-climate.ts
 */
import { loadClimate } from '../src/core/data/climate';
import { DEFAULT_SELECTION, type FetchBytes } from '../src/core/types';

const nodeFetch: FetchBytes = async (url, opts) => {
  const res = await fetch(url, {
    method: opts?.method ?? 'GET',
    headers: { 'User-Agent': 'CS2MapBuilder/0.1', ...(opts?.headers ?? {}) },
    body: opts?.method === 'POST' ? opts.body : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
};

const places = [
  { name: 'Uppsala', ...DEFAULT_SELECTION },
  { name: 'Bergen', ...DEFAULT_SELECTION, centerLat: 60.3913, centerLon: 5.3221 },
];

const f1 = (a: number[]) => a.map((v) => v.toFixed(1)).join(' ');

for (const p of places) {
  const c = await loadClimate(p, nodeFetch);
  const mean = c.monthlyMeanC;
  const cold = mean.indexOf(Math.min(...mean));
  const warm = mean.indexOf(Math.max(...mean));
  console.log(`\n== ${p.name} (${c.latitude}, ${c.longitude}) ==`);
  console.log(`Koppen ${c.koppen}, theme ${c.theme}`);
  console.log(`coldest month ${cold + 1}: ${mean[cold].toFixed(1)} C, warmest month ${warm + 1}: ${mean[warm].toFixed(1)} C`);
  console.log('mean  ', f1(mean));
  console.log('precip', f1(c.monthlyPrecipMm), `(sum ${c.monthlyPrecipMm.reduce((a, b) => a + b, 0).toFixed(0)} mm)`);
  console.log('cloud ', f1(c.monthlyCloud.map((v) => v * 100)));
  await new Promise((r) => setTimeout(r, 1500));
}
