import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { makeSynthResult, makeSynthRoads, makeSynthTerrain } from '../core/playability/synthTerrain';
import { DEFAULT_SELECTION, DEFAULT_SETTINGS } from '../core/types';

const terrain = makeSynthTerrain({ size: 64 });

function loaded() {
  const r = makeSynthResult(terrain);
  r.roads = makeSynthRoads([[-7168, -1200], [-2000, -1200], [-1000, -3000]], 'primary');
  return r;
}

beforeEach(() => {
  useStore.setState({
    selection: { ...DEFAULT_SELECTION },
    settings: structuredClone(DEFAULT_SETTINGS),
    result: null,
    autoPreview: false,
  });
});

describe('store.setManual', () => {
  it('updates the settings without a result', () => {
    useStore.getState().setManual((m) => ({ ...m, startTile: { col: 5, row: 6 } }));
    expect(useStore.getState().settings.manual.startTile).toEqual({ col: 5, row: 6 });
    expect(useStore.getState().result).toBeNull();
  });

  it('re-applies the edits to the loaded result at once', () => {
    useStore.getState().loadResult(loaded());
    const before = useStore.getState().result!;
    useStore.getState().setManual((m) => ({
      startTile: { col: 4, row: 3 },
      added: [...m.added, { kind: 'ship', p: [200, -7000] }],
    }));
    const s = useStore.getState();
    expect(s.settings.manual.added).toHaveLength(1);
    expect(s.result).not.toBe(before);
    expect(s.result!.settings.manual).toEqual(s.settings.manual);
    expect(s.result!.playability!.startTile).toEqual({ col: 4, row: 3 });
    const ship = s.result!.playability!.outsideConnections.find((c) => c.kind === 'ship')!;
    expect(ship.manual).toBe(true);
    expect(ship.p[1]).toBe(-7168);
    expect(s.result!.terrain).toBe(before.terrain);
    expect(s.result!.baseRoads).toBe(before.roads);

    s.setManual(() => ({ added: [] }));
    expect(useStore.getState().result!.playability!.outsideConnections.some((c) => c.manual)).toBe(false);
  });
});

describe('store.setSelection', () => {
  it('clears manual edits (and the applied result) when the square moves', () => {
    useStore.getState().loadResult(loaded());
    useStore.getState().setManual(() => ({ startTile: { col: 4, row: 3 }, added: [{ kind: 'air', p: [0, 7168] }] }));
    useStore.getState().setSelection({ centerLat: DEFAULT_SELECTION.centerLat + 0.5 });
    const s = useStore.getState();
    expect(s.settings.manual).toEqual({ added: [] });
    expect(s.result!.settings.manual).toEqual({ added: [] });
    expect(s.result!.playability!.startTile).not.toEqual({ col: 4, row: 3 });
  });

  it('keeps manual edits when the selection does not change', () => {
    useStore.getState().setManual(() => ({ startTile: { col: 4, row: 3 }, added: [] }));
    useStore.getState().setSelection({ ...DEFAULT_SELECTION });
    expect(useStore.getState().settings.manual.startTile).toEqual({ col: 4, row: 3 });
  });
});
