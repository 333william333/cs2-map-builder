/**
 * Regression tests on small real extracts (OpenFreeMap vector tiles, game coordinates, recentred)
 * for cases that used to break: a motorway through an interchange, a ramp pair over a motorway,
 * a tile seam on a secondary road, and mountain switchbacks.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RawWay } from '../types';
import { buildRoadsTraced, lastBuildRoadsStats, validateNetwork } from './buildRoads';
import { checkContinuity } from './continuity';
import { type FixtureTerrain, settings, terrain, terrainFromFixture, vectors } from './testutil';

function load(name: string): { ways: RawWay[]; scale: number; half: number; terrain?: FixtureTerrain } {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

const MAJOR = ['motorway', 'trunk', 'primary', 'secondary', 'rail'] as const;

function run(name: string) {
  const { ways, scale, half, terrain: ft } = load(name);
  const s = settings({ detail: 1 });
  const v = vectors(ways);
  const t = ft ? terrainFromFixture(ft, scale) : terrain({ scale });
  const { net, snapshots } = buildRoadsTraced(v, t, s);
  const stats = lastBuildRoadsStats()!;
  const rings = (stats.roundabouts?.rings ?? []).map((g) => ({ cx: g.cx, cz: g.cz, r: Math.max(g.builtR, g.realR * scale) }));
  const report = checkContinuity(v, net, s, snapshots, rings);
  const violations = validateNetwork(net);
  if (violations.length) console.log(violations.slice(0, 10).join('\n'));
  // ways are cut at the extract's edge: ignore the outer band where they end artificially
  const inner = (b: { p: [number, number] }) => Math.max(Math.abs(b.p[0]), Math.abs(b.p[1])) < half - 120;
  const major = report.breaks.filter((b) => (MAJOR as readonly string[]).includes(b.cls) && inner(b));
  if (major.length) console.log(name, major.map((b) => `${b.cls} ${b.kind} ${b.p.map(Math.round)} ${b.stage}`).join('\n'));
  const majorDrops = Object.entries(stats.droppedByClass).filter(([c]) => (MAJOR as readonly string[]).includes(c));
  return { net, report, violations, major, stats, terrain: t, majorDrops };
}

describe('real-data regressions', () => {
  it('motorway through an interchange stays one unbroken line (Frankfurter Kreuz)', () => {
    const { net, violations, major, report } = run('interchange-frankfurt');
    expect(violations).toEqual([]);
    expect(major.filter((b) => b.cls === 'motorway')).toEqual([]);
    // a ramp may be re-aligned a little further than the checker tolerance, never cut
    expect(major.filter((b) => b.kind === 'disconnected')).toEqual([]);
    expect(major.length).toBeLessThanOrEqual(1);
    expect(report.classes.motorway!.missingKm).toBeLessThan(0.1);
    expect(net.edges.some((e) => e.cls === 'motorway' && e.name)).toBe(true);
  });

  it('a ramp pair over the motorway keeps both ramps connected (Uppsala E4)', () => {
    const { violations, major } = run('ramp-pair-uppsala');
    expect(violations).toEqual([]);
    expect(major).toEqual([]);
  });

  it('a tile seam on a secondary road does not become a gap (Uppsala)', () => {
    const { violations, major, report, net } = run('seam-uppsala');
    expect(violations).toEqual([]);
    expect(major).toEqual([]);
    expect(net.edges.some((e) => e.name === 'Kuggebrovägen')).toBe(true);
  });

  it('mountain switchbacks are legalised, not deleted (Bergen)', () => {
    const { violations, report } = run('switchback-bergen');
    expect(violations).toEqual([]);
    const res = report.classes.residential!;
    expect(res.missingKm / res.inKm).toBeLessThan(0.05);
  });

  it('a roundabout with five roads stays a one-way ring with every arm (Frankfurt)', () => {
    const { net, violations, stats } = run('roundabout-frankfurt');
    expect(violations).toEqual([]);
    const ring = stats.roundabouts!.rings.find((r) => Math.hypot(r.cx, r.cz) < 30)!;
    expect(ring).toBeDefined();
    expect(ring.outcome).not.toBe('collapsed');
    expect(ring.arms).toBeGreaterThanOrEqual(5);
    const ringEdges = net.edges.filter((e) => e.oneway && e.pts.every((p) => Math.abs(Math.hypot(p[0] - ring.cx, p[1] - ring.cz) - ring.builtR) < 4));
    expect(ringEdges.length).toBeGreaterThanOrEqual(3);
    expect(ringEdges.every((e) => e.name)).toBe(true);
    // arm junctions sit on the ring
    const deg = new Map<number, number>();
    for (const e of net.edges) {
      deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
      deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
    }
    const junctions = net.nodes.filter((n) => (deg.get(n.id) ?? 0) >= 3 &&
      Math.abs(Math.hypot(n.p[0] - ring.cx, n.p[1] - ring.cz) - ring.builtR) < 1);
    // known gap: arms that end in very short stubs are pruned and their ring arcs merge
    expect(junctions.length).toBeGreaterThanOrEqual(2);
  });

  it('a long tunnel under a hill stays a tunnel below the hill (Bergen)', () => {
    const { net, violations, report, majorDrops } = run('hill-tunnel-bergen');
    expect(violations).toEqual([]);
    expect(majorDrops).toEqual([]);
    const tun = report.structures.tunnel;
    expect(tun.keptKm / tun.expectedKm).toBeGreaterThan(0.9);
    // the road inside is deep below the summit, not climbing over it
    const tunnelNodes = new Set<number>();
    for (const e of net.edges) if (e.tunnel) { tunnelNodes.add(e.a); tunnelNodes.add(e.b); }
    let deepest = 0;
    for (const i of tunnelNodes) {
      expect(net.nodes[i].elevation).toBeLessThanOrEqual(-8);
      deepest = Math.min(deepest, net.nodes[i].elevation);
    }
    expect(deepest).toBeLessThan(-40);
  });

  it('an underwater rail tunnel passes below the water with cover (Stockholm, scale 0.24)', () => {
    const { net, violations, report, terrain: t } = run('underwater-stockholm');
    expect(violations).toEqual([]);
    // known gap at scale 0.24: part of the tunnel length is surfaced near crowded portals
    expect(report.structures.tunnel.keptKm / report.structures.tunnel.expectedKm).toBeGreaterThan(0.6);
    const N = t.playable.size;
    const cell = t.playable.extentM / N;
    let wetTunnelNodes = 0;
    for (const e of net.edges) {
      if (!e.tunnel) continue;
      for (const i of [e.a, e.b]) {
        const n = net.nodes[i];
        const c = Math.floor((n.p[0] + t.playable.extentM / 2) / cell);
        const r = Math.floor((t.playable.extentM / 2 - n.p[1]) / cell);
        if (t.waterMask[r * N + c]) {
          wetTunnelNodes++;
          expect(n.ground + n.elevation).toBeLessThan(Math.min(n.ground, t.seaLevel) - 8 + 1e-6);
        }
      }
    }
    expect(wetTunnelNodes).toBeGreaterThan(0);
  });

  it('a sea bridge is carried over the water with clearance (Bergen, Nygardsbroen)', () => {
    const { net, violations, report, terrain: t } = run('sea-bridge-bergen');
    expect(violations).toEqual([]);
    // known gap: the bridge meets a tunnel interchange; parts of it are surfaced by the final fallback
    expect(report.structures.bridge.keptKm / report.structures.bridge.expectedKm).toBeGreaterThan(0.5);
    const bridges = net.edges.filter((e) => e.bridge);
    expect(bridges.length).toBeGreaterThan(0);
    for (const e of bridges) for (const i of [e.a, e.b]) {
      const n = net.nodes[i];
      expect(n.elevation).toBeGreaterThanOrEqual(8);
      expect(n.ground + n.elevation).toBeGreaterThan(t.seaLevel + 8);
    }
  });

  it('an underground interchange stays legal; known gap: some trunk segments are still cut (Bergen)', () => {
    const { violations, majorDrops, report } = run('tunnel-interchange-bergen');
    expect(violations).toEqual([]);
    // regression guard for the known gap (tunnels of one interchange pull each other down when one
    // is moved deeper, so the last-resort fallback still removes some trunk segments here)
    expect(majorDrops.reduce((s, [, n]) => s + n, 0)).toBeLessThanOrEqual(9);
    expect(report.classes.motorway?.breaks ?? 0).toBe(0);
  });
});
