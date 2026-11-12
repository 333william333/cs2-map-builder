import { describe, expect, it, vi } from 'vitest';
import { applyManualWith, MANUAL_WARNING_PREFIX, type Connector } from './applyManualCore';
import { borderParam, borderPointAt, snapToBorder } from './border';
import { makeSynthResult, makeSynthRoads, makeSynthTerrain } from '../playability/synthTerrain';
import { DEFAULT_SETTINGS, type BuildResult, type ManualEdits, type RoadNetwork } from '../types';

const terrain = makeSynthTerrain({ size: 128 });

/** Adds a straight 200 m stub from the border point inwards, ending in a free-standing inner node. */
function fakeConnector(fail?: (kind: 'road' | 'rail', p: [number, number]) => string | undefined): Connector & ReturnType<typeof vi.fn> {
  return vi.fn((net: RoadNetwork, _t, kind, p) => {
    const reason = fail?.(kind, p);
    if (reason) return { net, ok: false, reason };
    const snapped = snapToBorder(p);
    const id = net.nodes.reduce((m, n) => Math.max(m, n.id), -1) + 1;
    const inner: [number, number] = [snapped[0] * 0.97, snapped[1] * 0.97];
    const cls = kind === 'rail' ? 'rail' : 'motorway';
    return {
      ok: true,
      net: {
        nodes: [
          ...net.nodes,
          { id, p: snapped, ground: 30, elevation: 0, outside: true },
          { id: id + 1, p: inner, ground: 30, elevation: 0, outside: false },
        ],
        edges: [
          ...net.edges,
          {
            id: net.edges.length, a: id, b: id + 1, cls, prefab: kind === 'rail' ? 'rail_double' : 'highway_twoway_2lane',
            pts: [snapped, inner], bezier: [snapped, snapped, inner, inner], oneway: false, bridge: false, tunnel: false,
          },
        ],
      },
    };
  }) as Connector & ReturnType<typeof vi.fn>;
}

function make(manual: ManualEdits = { added: [] }, withRoad = true): BuildResult {
  const r = makeSynthResult(terrain);
  r.settings = { ...DEFAULT_SETTINGS, quality: 'full', manual };
  if (withRoad) r.roads = makeSynthRoads([[-7168, -1200], [-2000, -1200], [-1000, -3000]], 'primary');
  return r;
}

describe('border helpers', () => {
  it('snaps to the nearest side and keeps away from corners', () => {
    expect(snapToBorder([100, 6000])).toEqual([100, 7168]);
    expect(snapToBorder([-9000, 20])).toEqual([-7168, 20]);
    expect(snapToBorder([7000, 7100], 320)[0]).toBeLessThanOrEqual(7168 - 320 + 1e-9);
  });
  it('round-trips the perimeter parameter', () => {
    for (const p of [[-7168, 0], [3000, 7168], [7168, -2000], [-500, -7168]] as [number, number][]) {
      const q = borderPointAt(borderParam(p));
      expect(q[0]).toBeCloseTo(p[0], 6);
      expect(q[1]).toBeCloseTo(p[1], 6);
    }
  });
});

describe('applyManual', () => {
  it('is idempotent, starts from baseRoads and does not mutate its input', () => {
    const input = make({ added: [{ kind: 'road', p: [3000, 7168] }, { kind: 'ship', p: [100, -7168] }] });
    const before = JSON.stringify({ roads: input.roads, settings: input.settings, w: input.warnings });
    const once = applyManualWith(input, fakeConnector());
    const twice = applyManualWith(once, fakeConnector());
    expect(JSON.stringify({ roads: input.roads, settings: input.settings, w: input.warnings })).toBe(before);
    expect(input.baseRoads).toBeUndefined();
    expect(once.baseRoads).toBe(input.roads);
    expect(twice.baseRoads).toBe(input.roads);
    expect(twice).toEqual(once);
    expect(once.roads).not.toBe(input.roads);
    expect(once.roads!.nodes.length).toBe(input.roads!.nodes.length + 2);
    // heavy arrays are shared
    expect(once.terrain).toBe(input.terrain);
    expect(twice.terrain.waterMask).toBe(input.terrain.waterMask);
  });

  it('removing an edit goes back to the base network', () => {
    const withEdit = applyManualWith(make({ added: [{ kind: 'road', p: [3000, 7168] }] }), fakeConnector());
    const cleared = applyManualWith({ ...withEdit, settings: { ...withEdit.settings, manual: { added: [] } } }, fakeConnector());
    expect(cleared.roads).toBe(withEdit.baseRoads);
    expect(cleared.playability!.outsideConnections.some((c) => c.manual)).toBe(false);
  });

  it('flags hand-added road and rail connections as manual', () => {
    const r = applyManualWith(make({ added: [{ kind: 'road', p: [3000, 7168] }, { kind: 'rail', p: [6000, -7168] }] }), fakeConnector());
    const manual = r.playability!.outsideConnections.filter((c) => c.manual);
    expect(manual.map((c) => c.kind).sort()).toEqual(['rail', 'road']);
    expect(manual.every((c) => !c.synthetic)).toBe(true);
    const road = manual.find((c) => c.kind === 'road')!;
    expect(road.p).toEqual([3000, 7168]);
    // the original border road is still there and not flagged
    expect(r.playability!.outsideConnections.some((c) => c.kind === 'road' && !c.manual && c.p[0] === -7168)).toBe(true);
  });

  it('lets the chosen start tile override the automatic one and describes it', () => {
    const auto = applyManualWith(make(), fakeConnector());
    const chosen = { col: 3, row: 4 };
    const r = applyManualWith(make({ added: [], startTile: chosen }), fakeConnector());
    expect(r.playability!.startTile).toEqual(chosen);
    expect(auto.playability!.startTile).not.toEqual(chosen);
    expect(r.playability!.checks.find((c) => c.id === 'startTile')!.message).toContain('column 4, row 5');
  });

  it('warns clearly for a start tile in the sea instead of replacing it', () => {
    const r = applyManualWith(make({ added: [], startTile: { col: 11, row: 22 } }), fakeConnector());
    expect(r.playability!.startTile).toEqual({ col: 11, row: 22 });
    const c = r.playability!.checks.find((x) => x.id === 'startTile')!;
    expect(c.status).toBe('warn');
    expect(c.message).toMatch(/water/);
  });

  it('puts a manual ship marker on the border and replaces the nearby automatic one', () => {
    const base = applyManualWith(make(), fakeConnector());
    const autoShip = base.playability!.outsideConnections.filter((c) => c.kind === 'ship');
    expect(autoShip).toHaveLength(1);
    const r = applyManualWith(make({ added: [{ kind: 'ship', p: [autoShip[0].p[0] + 300, -8500] }] }), fakeConnector());
    const ships = r.playability!.outsideConnections.filter((c) => c.kind === 'ship');
    expect(ships).toHaveLength(1);
    expect(ships[0]).toMatchObject({ manual: true, synthetic: false });
    expect(ships[0].p[1]).toBe(-7168);
    expect(ships[0].p[0]).toBeCloseTo(autoShip[0].p[0] + 300, 6);
  });

  it('keeps a far-away automatic marker next to a manual one', () => {
    const r = applyManualWith(make({ added: [{ kind: 'air', p: [-7168, -5000] }] }), fakeConnector());
    const air = r.playability!.outsideConnections.filter((c) => c.kind === 'air');
    expect(air).toHaveLength(2);
    expect(air.filter((c) => c.manual)).toHaveLength(1);
  });

  it('warns about a ship connection on land', () => {
    const r = applyManualWith(make({ added: [{ kind: 'ship', p: [0, 7168] }] }), fakeConnector());
    expect(r.warnings!.some((w) => w.startsWith(MANUAL_WARNING_PREFIX) && w.includes('land'))).toBe(true);
  });

  it('adds a connector road at the border when the network has none', () => {
    const connector = fakeConnector();
    const input = make({ added: [] }, false);
    const r = applyManualWith(input, connector);
    expect(connector).toHaveBeenCalledTimes(1);
    const road = r.playability!.outsideConnections.find((c) => c.kind === 'road')!;
    expect(road.synthetic).toBe(true);
    expect(road.manual).toBeUndefined();
    expect(r.roads!.nodes.some((n) => n.outside)).toBe(true);
    expect(Math.max(Math.abs(road.p[0]), Math.abs(road.p[1]))).toBeCloseTo(7168, 3);
    // not in the sea (south of gz = -6000)
    expect(road.p[1]).toBeGreaterThan(-6000);
    expect(applyManualWith(r, connector).roads).toEqual(r.roads);
  });

  it('adds one when the network only has rail leaving the map', () => {
    const connector = fakeConnector();
    const input = make();
    input.roads = makeSynthRoads([[-7168, -1200], [-2000, -1200]], 'rail');
    const r = applyManualWith(input, connector);
    expect(connector).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'road', expect.anything());
    expect(r.playability!.outsideConnections.filter((c) => c.kind === 'road' && c.synthetic)).toHaveLength(1);
  });

  it('tries other sides when the first border point fails', () => {
    let calls = 0;
    const connector = fakeConnector(() => (++calls <= 2 ? 'Error.' : undefined));
    const r = applyManualWith(make({ added: [] }, false), connector);
    expect(connector).toHaveBeenCalledTimes(3);
    expect(r.playability!.outsideConnections.find((c) => c.kind === 'road')!.synthetic).toBe(true);
  });

  it('does not call the connector when a road already leaves the map', () => {
    const connector = fakeConnector();
    applyManualWith(make(), connector);
    expect(connector).not.toHaveBeenCalled();
  });

  it('reports connector failures once, also when applied repeatedly, and drops them when fixed', () => {
    const failing = fakeConnector((kind) => (kind === 'rail' ? 'Too close to an existing rail connection.' : undefined));
    const input = make({ added: [{ kind: 'rail', p: [6000, -7168] }] });
    input.warnings = ['Other warning'];
    const once = applyManualWith(input, failing);
    const twice = applyManualWith(once, failing);
    const thrice = applyManualWith(twice, failing);
    for (const r of [once, twice, thrice]) {
      expect(r.warnings!.filter((w) => w.startsWith(MANUAL_WARNING_PREFIX))).toHaveLength(1);
      expect(r.warnings).toContain('Other warning');
    }
    expect(thrice.warnings![thrice.warnings!.length - 1]).toContain('rail connection');
    // the failed entry adds no marker
    expect(thrice.playability!.outsideConnections.filter((c) => c.manual)).toHaveLength(0);
    const fixed = applyManualWith({ ...thrice, settings: { ...thrice.settings, manual: { added: [] } } }, failing);
    expect(fixed.warnings).toEqual(['Other warning']);
  });

  it('survives a throwing connector', () => {
    const boom: Connector = () => { throw new Error('boom'); };
    const r = applyManualWith(make({ added: [{ kind: 'road', p: [3000, 7168] }] }), boom);
    expect(r.warnings!.join(' ')).toContain('boom');
    expect(r.playability).toBeDefined();
  });

  it('falls back to a report-only synthetic road when no connector can build one', () => {
    const r = applyManualWith(make({ added: [] }, false), fakeConnector(() => 'Nej.'));
    expect(r.roads).toBeUndefined();
    expect(r.playability!.outsideConnections.find((c) => c.kind === 'road')!.synthetic).toBe(true);
    expect(r.warnings!.some((w) => w.includes('automatically'))).toBe(true);
  });
});
