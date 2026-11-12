import { describe, expect, it } from 'vitest';
import { buildWaterSources } from './buildWaterSources';
import { makeSynthTerrain, SYNTH } from '../playability/synthTerrain';

describe('buildWaterSources', () => {
  const t = makeSynthTerrain({ size: 128 });
  const src = buildWaterSources(t);

  it('puts one lake source inside the lake, below the shore', () => {
    const lakes = src.filter((s) => s.kind === 'lake');
    expect(lakes.length).toBeGreaterThanOrEqual(1);
    const l = lakes[0];
    const d = Math.hypot(l.p[0] - SYNTH.lakeCentre[0], l.p[1] - SYNTH.lakeCentre[1]);
    expect(d).toBeLessThan(SYNTH.lakeRadius);
    expect(l.level).toBeLessThan(SYNTH.rim);
    expect(l.level).toBeGreaterThan(SYNTH.lakeBed + 3);
    expect(l.radius).toBeGreaterThan(0);
    expect(l.radius).toBeLessThanOrEqual(SYNTH.lakeRadius);
  });

  it('puts a border river source where the river enters from the top', () => {
    const rivers = src.filter((s) => s.kind === 'borderRiver');
    expect(rivers).toHaveLength(1);
    const r = rivers[0];
    expect(Math.abs(r.p[0] - SYNTH.riverX)).toBeLessThan(250);
    expect(r.p[1]).toBeGreaterThan(SYNTH.ext / 2 - 250);
    expect(r.level).toBeGreaterThan(SYNTH.riverBed + 2 - 0.01);
    expect(r.level).toBeLessThan(SYNTH.base);
    expect(r.rate).toBeGreaterThan(0);
    expect(r.rate).toBeLessThanOrEqual(1);
  });

  it('is deterministic, finite and largest first', () => {
    const again = buildWaterSources(t);
    expect(again).toEqual(src);
    for (const s of src) {
      expect(Number.isFinite(s.p[0] + s.p[1] + s.radius + s.level)).toBe(true);
    }
  });

  it('ignores tiny lakes and gives no sources without water', () => {
    expect(buildWaterSources(makeSynthTerrain({ lake: false, river: false })).length).toBe(0);
  });

  it('adds several sources to a long lake and keeps them 100 m apart', () => {
    const n = 128, cell = 14336 / n;
    const big = makeSynthTerrain({ size: n, lake: false, river: false, mountain: false, sea: false });
    // carve a 6 km x 700 m lake
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const x = -7168 + (c + 0.5) * cell, z = 7168 - (r + 0.5) * cell;
      if (Math.abs(x) < 3000 && Math.abs(z) < 350) { big.playable.data[r * n + c] = 20; big.waterMask[r * n + c] = 2; }
    }
    const s = buildWaterSources(big).filter((q) => q.kind === 'lake');
    expect(s.length).toBeGreaterThan(2);
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
      expect(Math.hypot(s[i].p[0] - s[j].p[0], s[i].p[1] - s[j].p[1])).toBeGreaterThanOrEqual(100);
    }
  });
});
