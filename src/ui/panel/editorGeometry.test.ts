import { describe, expect, it } from 'vitest';
import {
  BADGE_OFFSET, canvasToGame, fitSquare, gameToCanvas, hitTestMarkers, moveTile, snapPointerToBorder, tileAt,
  tileBounds, tileCentre, viewScale, type EditorView,
} from './editorGeometry';
import { buildMarkers, groupMarkers } from './editorModel';
import { renderBackdrop } from './editorRender';
import { makeSynthTerrain } from '../../core/playability/synthTerrain';
import type { PlayabilityReport } from '../../core/types';

const v: EditorView = { size: 700, pad: 28 };
const k = viewScale(v);

describe('canvas <-> game', () => {
  it('keeps north up and east right', () => {
    const nw = gameToCanvas([-7168, 7168], v);
    const se = gameToCanvas([7168, -7168], v);
    expect(nw).toEqual([28, 28]);
    expect(se[0]).toBeCloseTo(672, 6);
    expect(se[1]).toBeCloseTo(672, 6);
    const centre = gameToCanvas([0, 0], v);
    expect(centre[0]).toBeCloseTo(350, 6);
    expect(centre[1]).toBeCloseTo(350, 6);
    // moving north (+gz) lowers the canvas y
    expect(gameToCanvas([0, 1000], v)[1]).toBeLessThan(gameToCanvas([0, 0], v)[1]);
  });

  it('round-trips', () => {
    for (const p of [[0, 0], [1234.5, -987.25], [-7168, 7168], [7000, -7100]] as [number, number][]) {
      const q = canvasToGame(gameToCanvas(p, v), v);
      expect(q[0]).toBeCloseTo(p[0], 6);
      expect(q[1]).toBeCloseTo(p[1], 6);
    }
    expect(k).toBeCloseTo(644 / 14336, 9);
  });
});

describe('tiles', () => {
  it('finds the tile under a point, row 0 on top', () => {
    expect(tileAt([-7168, 7168])).toEqual({ col: 0, row: 0 });
    expect(tileAt([7168, -7168])).toEqual({ col: 22, row: 22 });
    expect(tileAt([0, 0])).toEqual({ col: 11, row: 11 });
    expect(tileAt([-7000, -7000])).toEqual({ col: 0, row: 22 });
    expect(tileAt([7169, 0])).toBeNull();
    expect(tileAt([0, -7200])).toBeNull();
    expect(tileAt([NaN, 0])).toBeNull();
  });

  it('centre and bounds agree with tileAt', () => {
    for (const t of [{ col: 0, row: 0 }, { col: 5, row: 17 }, { col: 22, row: 22 }]) {
      expect(tileAt(tileCentre(t))).toEqual(t);
      const b = tileBounds(t);
      expect(b.x1 - b.x0).toBeCloseTo(14336 / 23, 6);
      expect(b.z1 - b.z0).toBeCloseTo(14336 / 23, 6);
      expect(tileAt([b.x0 + 1, b.z1 - 1])).toEqual(t);
    }
  });

  it('moves with the arrow keys and stays inside the grid', () => {
    expect(moveTile({ col: 3, row: 3 }, 1, 0)).toEqual({ col: 4, row: 3 });
    expect(moveTile({ col: 3, row: 3 }, 0, -1)).toEqual({ col: 3, row: 2 });
    expect(moveTile({ col: 0, row: 0 }, -1, -1)).toEqual({ col: 0, row: 0 });
    expect(moveTile({ col: 22, row: 22 }, 1, 1)).toEqual({ col: 22, row: 22 });
  });
});

describe('snapping to the border', () => {
  it('snaps a pointer near an edge to that edge', () => {
    const p = snapPointerToBorder(gameToCanvas([-6900, 2000], v), v, 'ship')!;
    expect(p).toEqual([-7168, 2000]);
    const top = snapPointerToBorder(gameToCanvas([1500, 7300], v), v, 'air')!;
    expect(top).toEqual([1500, 7168]);
  });

  it('ignores a pointer far from the border', () => {
    expect(snapPointerToBorder(gameToCanvas([0, 0], v), v, 'road')).toBeNull();
    expect(snapPointerToBorder(gameToCanvas([-5000, 0], v), v, 'road')).toBeNull();
  });

  it('keeps road connections away from the corners more than the others', () => {
    const corner = gameToCanvas([-7168, 7168], v);
    const road = snapPointerToBorder(corner, v, 'road')!;
    const ship = snapPointerToBorder(corner, v, 'ship')!;
    expect(Math.abs(road[0]) <= 7168 && Math.abs(road[1]) <= 7168).toBe(true);
    const cornerDist = (p: [number, number]) => Math.min(Math.abs(Math.abs(p[0]) - 7168), Math.abs(Math.abs(p[1]) - 7168)) === 0
      ? Math.max(7168 - Math.abs(p[0]), 7168 - Math.abs(p[1])) : 0;
    expect(cornerDist(road)).toBeGreaterThan(cornerDist(ship));
  });
});

describe('hit testing', () => {
  const markers = [
    { key: 'a', p: [-7168, 0] as [number, number] },
    { key: 'b', p: [-7168, 150] as [number, number] },
    { key: 'c', p: [0, 7168] as [number, number] },
  ];

  it('returns the nearest marker within the radius', () => {
    const c = gameToCanvas(markers[2].p, v);
    expect(hitTestMarkers(markers, [c[0] + 3, c[1] + 2], v)!.marker.key).toBe('c');
    expect(hitTestMarkers(markers, [c[0] + 40, c[1]], v)).toBeNull();
    const a = gameToCanvas(markers[0].p, v);
    const b = gameToCanvas(markers[1].p, v);
    const mid: [number, number] = [a[0], (a[1] + b[1]) / 2 + 1];
    expect(hitTestMarkers(markers, mid, v)).not.toBeNull();
  });

  it('prefers the remove badge when the marker has one', () => {
    const c = gameToCanvas(markers[2].p, v);
    const onBadge: [number, number] = [c[0] + BADGE_OFFSET[0], c[1] + BADGE_OFFSET[1]];
    const hit = hitTestMarkers(markers, onBadge, v, (m) => m.key === 'c')!;
    expect(hit.marker.key).toBe('c');
    expect(hit.badge).toBe(true);
    expect(hitTestMarkers(markers, onBadge, v)!.badge).toBe(false);
  });
});

describe('fitSquare', () => {
  it('uses the smaller side with a floor', () => {
    expect(fitSquare(900, 600)).toBe(600);
    expect(fitSquare(100, 100)).toBe(240);
  });
});

describe('buildMarkers', () => {
  const report = (c: PlayabilityReport['outsideConnections']): PlayabilityReport => ({
    buildableFraction: 1, waterFraction: 0, checks: [], startTile: { col: 1, row: 1 }, outsideConnections: c,
  });

  it('classifies automatic, synthetic and manual connections', () => {
    const m = buildMarkers(report([
      { kind: 'road', p: [-7168, 0], synthetic: false },
      { kind: 'air', p: [0, 7168], synthetic: true },
      { kind: 'ship', p: [100, -7168], synthetic: false, manual: true },
    ]), [{ kind: 'ship', p: [100, -7000] }]);
    expect(m.find((x) => x.kind === 'ship')).toMatchObject({ origin: 'manual', addedIndex: 0, p: [100, -7168] });
    expect(m.find((x) => x.kind === 'air')!.origin).toBe('synthetic');
    expect(m.find((x) => x.kind === 'road')!.origin).toBe('auto');
    expect(m).toHaveLength(3);
  });

  it('keeps a failed road entry visible and removable', () => {
    const m = buildMarkers(report([{ kind: 'road', p: [-7168, 0], synthetic: false }]), [{ kind: 'road', p: [3000, 7168] }]);
    const failed = m.find((x) => x.failed)!;
    expect(failed).toMatchObject({ kind: 'road', addedIndex: 0, origin: 'manual' });
    expect(failed.p).toEqual([3000, 7168]);
  });

  it('matches each entry to its own report connection', () => {
    const m = buildMarkers(report([
      { kind: 'road', p: [3000, 7168], synthetic: false, manual: true },
      { kind: 'road', p: [-3000, 7168], synthetic: false, manual: true },
    ]), [{ kind: 'road', p: [-3010, 7000] }, { kind: 'road', p: [3000, 7168] }]);
    expect(m.map((x) => [x.addedIndex, x.p[0]])).toEqual([[0, -3000], [1, 3000]]);
    expect(m.some((x) => x.failed)).toBe(false);
  });

  it('groups by kind in display order', () => {
    const g = groupMarkers(buildMarkers(report([
      { kind: 'water', p: [0, 0], synthetic: false },
      { kind: 'road', p: [0, 0], synthetic: false },
      { kind: 'road', p: [1, 0], synthetic: false },
    ]), []));
    expect(g.map((x) => [x.kind, x.items.length])).toEqual([['road', 2], ['water', 1]]);
  });
});

describe('renderBackdrop', () => {
  it('fills an opaque image with water in blue and land greener than red', () => {
    const terrain = makeSynthTerrain({ size: 64 });
    const size = 48;
    const px = renderBackdrop({ terrain }, size);
    expect(px.length).toBe(size * size * 4);
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255);
    // south edge is sea (gz < -6000): last pixel row is blue
    const o = ((size - 1) * size + 24) * 4;
    expect(px[o + 2]).toBeGreaterThan(px[o]);
    // north-west land is not blue-dominant
    const l = (2 * size + 3) * 4;
    expect(px[l + 2]).toBeLessThanOrEqual(px[l + 1]);
  });
});
