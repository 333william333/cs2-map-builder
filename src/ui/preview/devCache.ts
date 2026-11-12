/**
 * Development helper: `?devfile=<name>` loads a prebuilt result from
 * `node_modules/.cache/cs2mb-dev/<name>.bin` (written by a local Node build), so visual checks of
 * full builds survive page reloads. `&game=1` also opens the game view. Inactive in production.
 *
 * File format: uint32 JSON length, uint32 blob base, JSON (typed arrays as {$ta, o, n} refs,
 * non-finite numbers as {$num}), then the 8-byte aligned typed array data.
 */
import type { BuildResult } from '../../core/types';

export function devFileName(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    const v = new URLSearchParams(window.location.search).get('devfile');
    return v && /^[a-z0-9-]+$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function devOpenGame(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return new URLSearchParams(window.location.search).get('game') === '1';
  } catch {
    return false;
  }
}

type TypedCtor = new (buffer: ArrayBuffer, byteOffset: number, length: number) => ArrayBufferView;
const CTORS: Record<string, TypedCtor> = {
  Float32Array, Float64Array, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
};

/** Inverse of the Node-side writer. */
export function deserializeResult(buf: ArrayBuffer): BuildResult {
  const dv = new DataView(buf);
  const len = dv.getUint32(0, true);
  const base = dv.getUint32(4, true);
  const json = new TextDecoder().decode(new Uint8Array(buf, 8, len));
  return JSON.parse(json, (_k, v: unknown) => {
    if (v && typeof v === 'object') {
      const o = v as { $ta?: string; o?: number; n?: number; $num?: string };
      if (o.$ta && CTORS[o.$ta]) return new CTORS[o.$ta](buf, base + (o.o ?? 0), o.n ?? 0);
      if (o.$num !== undefined) return Number(o.$num);
    }
    return v;
  }) as BuildResult;
}

export async function loadDevFile(name: string): Promise<BuildResult | null> {
  const res = await fetch(`/node_modules/.cache/cs2mb-dev/${name}.bin`);
  if (!res.ok) return null;
  return deserializeResult(await res.arrayBuffer());
}
