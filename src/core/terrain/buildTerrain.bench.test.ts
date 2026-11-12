/**
 * Full-resolution timing / memory benchmark. Skipped by default; run with
 *   TERRAIN_BENCH=1 npx vitest run src/core/terrain/buildTerrain.bench.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createFrame } from '../geo/frame';
import { DEFAULT_SETTINGS, LC, type ElevationSampler, type Pt, type VectorData } from '../types';
import { buildTerrain } from './buildTerrain';

const RUN = typeof process !== 'undefined' && !!process.env.TERRAIN_BENCH;

/** ~30 m lat/lon raster with integer-metre quantisation and bilinear lookup, like a real DEM sampler. */
function demSampler(bbox: [number, number, number, number]): ElevationSampler {
  const [s, w, n, e] = bbox;
  const W = 2400, Hh = 2400;
  const d = new Float32Array(W * Hh);
  for (let r = 0; r < Hh; r++) {
    for (let c = 0; c < W; c++) {
      const x = c / W, y = r / Hh;
      let v = 60 * (x - 0.15) * 4 + 80 * Math.sin(x * 23) * Math.cos(y * 17) + 15 * Math.sin(x * 140 + y * 90);
      v += 3 * Math.sin(x * 900) * Math.cos(y * 700);
      d[r * W + c] = Math.round(v);
    }
  }
  return {
    sample(lat: number, lon: number) {
      const fx = ((lon - w) / (e - w)) * (W - 1);
      const fy = ((n - lat) / (n - s)) * (Hh - 1);
      const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(Hh - 2, Math.floor(fy)));
      const tx = Math.min(1, Math.max(0, fx - x0));
      const ty = Math.min(1, Math.max(0, fy - y0));
      const i = y0 * W + x0;
      const a = d[i] + (d[i + 1] - d[i]) * tx;
      const b = d[i + W] + (d[i + W + 1] - d[i + W]) * tx;
      return a + (b - a) * ty;
    },
  };
}

describe.skipIf(!RUN)('full-resolution benchmark', () => {
  it('builds two 4096 grids with carving', () => {
    const sel = { centerLat: 57.7, centerLon: 11.95, sizeMeters: 14336, rotationDeg: 15 };
    const frame = createFrame(sel);
    const smp = demSampler(frame.bbox(57344 * 1.05));
    const lakes = [];
    const rivers = [];
    for (let k = 0; k < 40; k++) {
      const cx = -6000 + ((k * 2971) % 12000), cz = -6000 + ((k * 4523) % 12000);
      const rad = 80 + ((k * 37) % 400);
      const ring: Pt[] = [];
      for (let q = 0; q < 48; q++) {
        const a = (q / 48) * Math.PI * 2;
        ring.push([cx + rad * Math.cos(a) * (1 + 0.2 * Math.sin(3 * a)), cz + rad * Math.sin(a)]);
      }
      lakes.push({ kind: 'lake' as const, rings: [ring] });
    }
    for (let k = 0; k < 200; k++) {
      const pts: Pt[] = [];
      let x = -20000 + ((k * 7919) % 40000), z = -20000 + ((k * 104729) % 40000);
      for (let q = 0; q < 60; q++) {
        pts.push([x, z]);
        x += 120 + 80 * Math.sin(q + k);
        z += 90 * Math.cos(q * 0.7 + k);
      }
      rivers.push({ kind: (k % 5 === 0 ? 'river' : 'stream') as 'river' | 'stream', pts });
    }
    const vectors: VectorData = {
      ways: [], areas: [], treePoints: [], powerLines: [],
      waterPolygons: [...lakes, { kind: 'river', rings: [[[-7000, -50], [7000, -50], [7000, 150], [-7000, 150]]] }],
      waterways: rivers,
    };
    const lcSize = 2048;
    const lc = new Uint8Array(lcSize * lcSize).fill(LC.Grass);
    for (let r = 300; r < 420; r++) for (let c = 1500; c < 1650; c++) lc[r * lcSize + c] = LC.Water;
    for (let i = 0; i < 5000; i++) lc[(i * 7907) % lc.length] = LC.Water; // speckle noise
    const mem0 = process.memoryUsage();
    let peak = 0;
    const t0 = performance.now();
    const stages: string[] = [];
    let last = t0;
    const res = buildTerrain(
      {
        frame, quality: 'full',
        settings: { ...DEFAULT_SETTINGS.terrain, carveWater: true, smoothing: 0.4 },
        playableElev: smp, worldElev: smp, vectors,
        landcover: { size: lcSize, extentM: 14336, data: lc },
      },
      (_s, f, m) => {
        const now = performance.now();
        const mu = process.memoryUsage();
        peak = Math.max(peak, mu.rss);
        stages.push(`${f.toFixed(2)} +${((now - last) / 1000).toFixed(2)}s ${m} rss=${(mu.rss / 2 ** 20).toFixed(0)}MB`);
        last = now;
      },
    );
    const t = (performance.now() - t0) / 1000;
    const mu = process.memoryUsage();
    peak = Math.max(peak, mu.rss);
    console.log(stages.join('\n'));
    console.log(
      `full build ${t.toFixed(2)} s, rss peak(sampled) ${(peak / 2 ** 20).toFixed(0)} MB ` +
        `(start ${(mem0.rss / 2 ** 20).toFixed(0)} MB), water ${res.waterMask.reduce((a, b) => a + b, 0)} cells, ` +
        `h ${res.minHeight.toFixed(1)}..${res.maxHeight.toFixed(1)} scale ${res.heightScale}`,
    );
    expect(res.playable.size).toBe(4096);
    expect(res.world.size).toBe(4096);
  }, 300_000);
});
