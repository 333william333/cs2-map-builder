import { describe, expect, it } from 'vitest';
import { drawOverlay, gameToPixel, roadStyle } from './overlay';
import { DEFAULT_SETTINGS, type BuildResult } from '../../core/types';

describe('gameToPixel', () => {
  it('maps corners with row 0 = top', () => {
    expect(gameToPixel(-7168, 7168, 4096)).toEqual([0, 0]);
    expect(gameToPixel(7168, -7168, 4096)).toEqual([4096, 4096]);
    expect(gameToPixel(0, 0, 4096)).toEqual([2048, 2048]);
  });
  it('puts north (+gz) above south', () => {
    expect(gameToPixel(0, 1000, 4096)[1]).toBeLessThan(gameToPixel(0, -1000, 4096)[1]);
  });
});

describe('roadStyle', () => {
  it('orders widths and dashes rail', () => {
    expect(roadStyle('motorway').width).toBeGreaterThan(roadStyle('residential').width);
    expect(roadStyle('rail').dash).toBeDefined();
    expect(roadStyle('motorway').color).toContain('255,152');
  });
});

describe('drawOverlay', () => {
  it('falls back to vector ways when there is no road network', () => {
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : (..._a: unknown[]) => void calls.push(String(k))),
      set: (t, k, v) => ((t[k as string] = v), true),
    });
    const result = {
      settings: DEFAULT_SETTINGS,
      vectors: {
        ways: [{ cls: 'motorway', pts: [[0, 0], [100, 100]] }],
        waterPolygons: [{ kind: 'lake', rings: [[[0, 0], [10, 0], [10, 10]]] }],
        waterways: [], areas: [], treePoints: [], powerLines: [],
      },
    } as unknown as BuildResult;
    drawOverlay(ctx as never, result, 100);
    expect(calls).toContain('fill');
    expect(calls.filter((c) => c === 'lineTo').length).toBeGreaterThan(0);
  });
});
