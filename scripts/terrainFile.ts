/** Compact on-disk form of the playable part of a TerrainResult (for road reports). */
import { readFileSync, writeFileSync } from 'node:fs';
import type { TerrainResult } from '../src/core/types';

interface Header {
  size: number;
  extentM: number;
  scale: { horizontal: number; vertical: number };
  seaLevel: number;
  heightScale: number;
  baseElevation: number;
  hasSea: boolean;
  minHeight: number;
  maxHeight: number;
}

export function writeTerrain(path: string, t: TerrainResult): void {
  const h: Header = {
    size: t.playable.size, extentM: t.playable.extentM, scale: t.scale, seaLevel: t.seaLevel, heightScale: t.heightScale,
    baseElevation: t.baseElevation, hasSea: t.hasSea, minHeight: t.minHeight, maxHeight: t.maxHeight,
  };
  const head = new TextEncoder().encode(JSON.stringify(h));
  const n = t.playable.size * t.playable.size;
  const buf = new Uint8Array(4 + head.length + n * 4 + n);
  new DataView(buf.buffer).setUint32(0, head.length, true);
  buf.set(head, 4);
  const off = 4 + head.length;
  buf.set(new Uint8Array(t.playable.data.buffer, t.playable.data.byteOffset, n * 4), off);
  buf.set(t.waterMask.subarray(0, n), off + n * 4);
  writeFileSync(path, buf);
}

export function readTerrain(path: string): TerrainResult {
  const raw = readFileSync(path);
  const buf = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const hl = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
  const h = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + hl))) as Header;
  const n = h.size * h.size;
  const off = 4 + hl;
  const data = new Float32Array(n);
  new Uint8Array(data.buffer).set(buf.subarray(off, off + n * 4));
  const waterMask = buf.slice(off + n * 4, off + n * 5);
  return {
    playable: { size: h.size, extentM: h.extentM, data },
    world: { size: 4, extentM: 57344, data: new Float32Array(16).fill(h.minHeight) },
    scale: h.scale,
    seaLevel: h.seaLevel,
    heightScale: h.heightScale,
    waterMask,
    baseElevation: h.baseElevation,
    hasSea: h.hasSea,
    minHeight: h.minHeight,
    maxHeight: h.maxHeight,
  } as TerrainResult;
}
