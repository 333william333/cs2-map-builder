import { describe, expect, it } from 'vitest';
import type { VertexGrid } from './terrainGrid';
import { buildWaterIndices, computeWaterSurface } from './waterSurface';

function grid(n: number, f: (r: number, c: number) => number): VertexGrid {
  const data = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) data[r * n + c] = f(r, c);
  return { n, extentM: (n - 1) * 20, data };
}

describe('water surface', () => {
  it('reports no water for a dry map', () => {
    const v = grid(8, () => 100);
    const w = computeWaterSurface(v, new Uint8Array(64), 64);
    expect(w.hasWater).toBe(false);
  });

  it('puts a lake at its lowest bank, above sea level and above its bed', () => {
    const n = 21;
    const mask = new Uint8Array(n * n);
    const v = grid(n, (r, c) => {
      const inside = Math.hypot(r - 10, c - 10) < 4;
      if (inside) mask[r * n + c] = 1;
      return inside ? 95 : 100 + (c > 10 ? 3 : 0);
    });
    const w = computeWaterSurface(v, mask, 64);
    expect(w.hasWater).toBe(true);
    const mid = w.level[10 * n + 10];
    expect(mid).toBeGreaterThan(95);
    expect(mid).toBeLessThan(104);
    // flat to within the slope allowance
    expect(Math.abs(w.level[10 * n + 8] - w.level[10 * n + 12])).toBeLessThan(5);
    // dry corner has no level
    expect(Number.isNaN(w.level[0])).toBe(true);
  });

  it('treats terrain below sea level as sea, level = sea level', () => {
    const v = grid(6, (_r, c) => (c < 2 ? 40 : 70));
    const w = computeWaterSurface(v, new Uint8Array(36), 64);
    expect(w.hasWater).toBe(true);
    expect(w.level[0]).toBeCloseTo(64);
  });

  it('lets a river fall downstream', () => {
    const n = 40;
    const mask = new Uint8Array(n * n);
    const v = grid(n, (r, c) => {
      const river = r === 20 || r === 21;
      if (river) mask[r * n + c] = 1;
      const bank = 200 - c * 2; // falls towards +c
      return river ? bank - 4 : bank;
    });
    const w = computeWaterSurface(v, mask, 64);
    expect(w.level[20 * n + 5]).toBeGreaterThan(w.level[20 * n + 35] + 20);
  });

  it('builds indices only where there is water', () => {
    const n = 8;
    const mask = new Uint8Array(n * n);
    mask[3 * n + 3] = 1;
    const v = grid(n, () => 100);
    const w = computeWaterSurface(v, mask, 64);
    const idx = buildWaterIndices(n, w.level);
    expect(idx.length).toBeGreaterThan(0);
    expect(idx.length).toBeLessThan((n - 1) * (n - 1) * 6);
  });
});
