/// <reference lib="webworker" />
import { proxyFetch } from '../core/fetchClient';
import { runBuild, type BuildOptions } from '../core/pipeline';
import type { BuildResult, BuildSettings, Selection } from '../core/types';

export interface BuildRequest {
  selection: Selection;
  settings: BuildSettings;
  opts?: BuildOptions;
}

export type BuildMessage =
  | { type: 'progress'; stage: string; fraction: number; message?: string }
  | { type: 'result'; result: BuildResult }
  | { type: 'error'; message: string };

/** Collects the ArrayBuffers of all typed arrays so the result moves to the UI thread without copying. */
function transferables(value: unknown, out: Set<ArrayBuffer> = new Set(), depth = 0): Set<ArrayBuffer> {
  if (!value || typeof value !== 'object' || depth > 6) return out;
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) out.add(value.buffer);
    return out;
  }
  if (Array.isArray(value)) {
    // arrays of plain numbers/points hold no buffers; only look into arrays of objects
    if (value.length && typeof value[0] === 'object' && !Array.isArray(value[0])) {
      for (const v of value) transferables(v, out, depth + 1);
    }
    return out;
  }
  for (const v of Object.values(value)) transferables(v, out, depth + 1);
  return out;
}

const post = (msg: BuildMessage, transfer: Transferable[] = []) =>
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<BuildRequest>) => {
  const { selection, settings, opts } = ev.data;
  let last = 0;
  try {
    const result = await runBuild(
      selection,
      settings,
      proxyFetch,
      (stage, fraction, message) => {
        const now = performance.now();
        if (now - last < 60 && fraction < 1) return;
        last = now;
        post({ type: 'progress', stage, fraction, message });
      },
      opts,
    );
    post({ type: 'result', result }, [...transferables(result)]);
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
