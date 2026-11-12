import { create } from 'zustand';
import {
  DEFAULT_SELECTION,
  DEFAULT_SETTINGS,
  type BuildResult,
  type BuildSettings,
  type ManualEdits,
  type Quality,
  type Selection,
} from '../core/types';
import { applyManual } from '../core/manual/applyManual';
import type { BuildMessage, BuildRequest } from '../worker/build.worker';

export interface AppState {
  selection: Selection;
  settings: BuildSettings;
  status: {
    phase: 'idle' | 'building' | 'done' | 'error';
    stage?: string;
    fraction: number;
    message?: string;
  };
  result: BuildResult | null;
  layers: { water: boolean; roads: boolean; trees: boolean; grid: boolean; world: boolean; startTile: boolean };
  /** rebuild a fast terrain-only preview whenever the square moves */
  autoPreview: boolean;
  setSelection(patch: Partial<Selection>): void;
  setSettings(fn: (s: BuildSettings) => BuildSettings): void;
  setLayer(key: keyof AppState['layers'], on: boolean): void;
  /**
   * Updates `settings.manual` and, when a result is loaded, immediately re-applies the edits to it
   * (synchronously: cheap). Cleared by `setSelection` because tile and border coordinates change meaning.
   */
  setManual(fn: (m: ManualEdits) => ManualEdits): void;
  setAutoPreview(on: boolean): void;
  /** 'draft' = quick low-resolution build, 'full' = export quality */
  build(quality: Quality, opts?: { terrainOnly?: boolean }): void;
  loadResult(result: BuildResult): void;
}

let worker: Worker | null = null;
/** true while the running/last build was an automatic terrain-only preview */
let currentIsAuto = false;
let lastAutoKey = '';
const selKey = (s: Selection) =>
  `${s.centerLat.toFixed(5)},${s.centerLon.toFixed(5)},${Math.round(s.sizeMeters)},${s.rotationDeg.toFixed(1)}`;

function startWorker(req: BuildRequest, onMessage: (m: BuildMessage) => void): void {
  // A running build cannot be interrupted, so a new request replaces the worker.
  worker?.terminate();
  worker = new Worker(new URL('../worker/build.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  w.onmessage = (ev: MessageEvent<BuildMessage>) => {
    if (w !== worker) return;
    onMessage(ev.data);
  };
  w.onerror = (ev) => {
    if (w !== worker) return;
    onMessage({ type: 'error', message: ev.message || 'Unknown error in the build process' });
  };
  w.postMessage(req);
}

export const useStore = create<AppState>((set, get) => ({
  selection: { ...DEFAULT_SELECTION },
  settings: structuredClone(DEFAULT_SETTINGS),
  status: { phase: 'idle', fraction: 0 },
  result: null,
  layers: { water: true, roads: true, trees: true, grid: true, world: true, startTile: true },
  autoPreview: true,
  setSelection: (patch) =>
    set((s) => {
      const selection = { ...s.selection, ...patch };
      if (selKey(selection) === selKey(s.selection)) return { selection };
      // tile and border coordinates mean something else for a new square: drop the hand-made edits
      const m = s.settings.manual;
      if (!m || (m.added.length === 0 && !m.startTile)) return { selection };
      const settings = { ...s.settings, manual: { added: [] } };
      return {
        selection,
        settings,
        result: s.result ? applyManual({ ...s.result, settings: { ...s.result.settings, manual: settings.manual } }) : s.result,
      };
    }),
  setSettings: (fn) => set((s) => ({ settings: fn(s.settings) })),
  setManual: (fn) =>
    set((s) => {
      const manual = fn(s.settings.manual ?? { added: [] });
      const settings = { ...s.settings, manual };
      return {
        settings,
        result: s.result ? applyManual({ ...s.result, settings: { ...s.result.settings, manual } }) : s.result,
      };
    }),
  setLayer: (key, on) => set((s) => ({ layers: { ...s.layers, [key]: on } })),
  setAutoPreview: (on) => set({ autoPreview: on }),
  loadResult: (result) => set({ result, status: { phase: 'done', fraction: 1 } }),
  build: (quality, opts) => {
    const { selection, settings } = get();
    currentIsAuto = !!opts?.terrainOnly;
    lastAutoKey = selKey(selection);
    const req: BuildRequest = {
      selection: { ...selection },
      settings: { ...structuredClone(settings), quality },
      opts,
    };
    set({ status: { phase: 'building', stage: 'data', fraction: 0, message: 'Starting' } });
    startWorker(req, (m) => {
      if (m.type === 'progress') {
        set({ status: { phase: 'building', stage: m.stage, fraction: m.fraction, message: m.message } });
      } else if (m.type === 'result') {
        const warn = m.result.warnings?.length ? m.result.warnings.join(' ') : undefined;
        set({ result: m.result, status: { phase: 'done', fraction: 1, message: warn } });
      } else {
        set({ status: { phase: 'error', fraction: 0, message: m.message } });
      }
    });
  },
}));

// ---- auto preview: quick terrain-only draft shortly after the square stops moving ----
let autoTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleAutoPreview(delayMs: number): void {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    const s = useStore.getState();
    if (!s.autoPreview || selKey(s.selection) === lastAutoKey) return;
    // never replace a build the user started explicitly while it is still running
    if (s.status.phase === 'building' && !currentIsAuto) return;
    s.build('draft', { terrainOnly: true });
  }, delayMs);
}

useStore.subscribe((state, prev) => {
  if (state.selection === prev.selection && state.autoPreview === prev.autoPreview) return;
  if (state.autoPreview) scheduleAutoPreview(900);
});

// first preview shortly after start (not in demo mode, not in tests)
if (typeof window !== 'undefined' && !new URLSearchParams(window.location.search).has('demo')) {
  scheduleAutoPreview(1200);
}

// development aid: inspect the store from the browser console
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __store?: typeof useStore }).__store = useStore;
}
