/**
 * Regression tests on small real extracts (OpenFreeMap vector tiles, game coordinates, recentred)
 * for cases that used to break: a motorway through an interchange, a ramp pair over a motorway,
 * a tile seam on a secondary road, and mountain switchbacks.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RawWay } from '../types';
import { buildRoadsTraced, validateNetwork } from './buildRoads';
import { checkContinuity } from './continuity';
import { settings, terrain, vectors } from './testutil';

function load(name: string): { ways: RawWay[]; scale: number; half: number } {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

const MAJOR = ['motorway', 'trunk', 'primary', 'secondary', 'rail'] as const;

function run(name: string) {
  const { ways, scale, half } = load(name);
  const s = settings({ detail: 1 });
  const v = vectors(ways);
  const { net, snapshots } = buildRoadsTraced(v, terrain({ scale }), s);
  const report = checkContinuity(v, net, s, snapshots);
  const violations = validateNetwork(net);
  if (violations.length) console.log(violations.slice(0, 10).join('\n'));
  // ways are cut at the extract's edge: ignore the outer band where they end artificially
  const inner = (b: { p: [number, number] }) => Math.max(Math.abs(b.p[0]), Math.abs(b.p[1])) < half - 120;
  const major = report.breaks.filter((b) => (MAJOR as readonly string[]).includes(b.cls) && inner(b));
  if (major.length) console.log(name, major.map((b) => `${b.cls} ${b.kind} ${b.p.map(Math.round)} ${b.stage}`).join('\n'));
  return { net, report, violations, major };
}

describe('real-data regressions', () => {
  it('motorway through an interchange stays one unbroken line (Frankfurter Kreuz)', () => {
    const { net, violations, major, report } = run('interchange-frankfurt');
    expect(violations).toEqual([]);
    expect(major.filter((b) => b.cls === 'motorway')).toEqual([]);
    // a ramp may be re-aligned a little further than the checker tolerance, never cut
    expect(major.filter((b) => b.kind === 'disconnected')).toEqual([]);
    expect(major.length).toBeLessThanOrEqual(1);
    expect(report.classes.motorway!.missingKm).toBeLessThan(0.05);
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
});
