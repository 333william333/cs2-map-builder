import { encode } from 'fast-png';
import type { HeightGrid } from '../types';

/** Heights (game m) to uint16: round(h / heightScale * 65535), clamped. Row 0 = top image row. */
export function quantizeHeights(grid: HeightGrid, heightScale: number): Uint16Array {
  const src = grid.data;
  const out = new Uint16Array(src.length);
  const k = 65535 / heightScale;
  for (let i = 0; i < src.length; i++) {
    const v = Math.round(src[i] * k);
    out[i] = v > 0 ? (v < 65535 ? v : 65535) : 0; // NaN -> 0
  }
  return out;
}

/** 16-bit single-channel greyscale PNG of the grid, as CS2 expects for heightmaps. */
export function encodeHeightmapPng(grid: HeightGrid, heightScale: number): Uint8Array {
  return encode({
    width: grid.size,
    height: grid.size,
    data: quantizeHeights(grid, heightScale),
    depth: 16,
    channels: 1,
  });
}
