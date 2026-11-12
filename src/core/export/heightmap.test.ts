import { describe, expect, it } from 'vitest';
import { decode } from 'fast-png';
import { encodeHeightmapPng, quantizeHeights } from './heightmap';
import type { HeightGrid } from '../types';

describe('heightmap export', () => {
  it('quantizes with clamping', () => {
    const grid: HeightGrid = { size: 2, extentM: 1, data: Float32Array.from([-5, 0, 2048, 9999]) };
    expect(Array.from(quantizeHeights(grid, 4096))).toEqual([0, 0, 32768, 65535]);
  });

  it('round-trips a 16-bit single-channel PNG', () => {
    const size = 37;
    const data = new Float32Array(size * size);
    for (let i = 0; i < data.length; i++) data[i] = (i * 97.31) % 5000;
    const grid: HeightGrid = { size, extentM: 14336, data };
    const png = encodeHeightmapPng(grid, 5120);
    const dec = decode(png);
    expect(dec.width).toBe(size);
    expect(dec.height).toBe(size);
    expect(dec.depth).toBe(16);
    expect(dec.channels).toBe(1);
    expect(Array.from(dec.data)).toEqual(Array.from(quantizeHeights(grid, 5120)));
    // row 0 is the top image row
    expect(dec.data[1]).toBe(Math.round((data[1] / 5120) * 65535));
  });
});
