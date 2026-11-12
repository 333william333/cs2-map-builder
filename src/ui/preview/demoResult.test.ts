import { describe, expect, it } from 'vitest';
import { CS2 } from '../../core/types';
import { makeDemoResult } from './demoResult';

describe('demo result', () => {
  const r = makeDemoResult();

  it('has the documented grids and consistent masks', () => {
    expect(r.terrain.playable.size).toBe(512);
    expect(r.terrain.world.size).toBe(256);
    expect(r.terrain.playable.extentM).toBe(CS2.PLAYABLE_SIZE_M);
    expect(r.terrain.world.extentM).toBe(CS2.WORLD_SIZE_M);
    expect(r.terrain.waterMask.length).toBe(512 * 512);
    expect(r.terrain.playable.data.every((v) => Number.isFinite(v))).toBe(true);
    expect(r.terrain.maxHeight).toBeGreaterThan(r.terrain.minHeight + 500);
  });

  it('contains sea, an inland lake above sea level and a river', () => {
    const { playable, waterMask, seaLevel } = r.terrain;
    let sea = 0;
    let inland = 0;
    for (let i = 0; i < waterMask.length; i++) {
      if (!waterMask[i]) continue;
      if (playable.data[i] < seaLevel) sea++;
      else inland++;
    }
    expect(sea).toBeGreaterThan(2000);
    expect(inland).toBeGreaterThan(300);
  });

  it('has a few hundred road edges incl. a motorway and a bridge', () => {
    const roads = r.roads!;
    expect(roads.edges.length).toBeGreaterThan(200);
    expect(roads.edges.length).toBeLessThan(2000);
    expect(roads.edges.some((e) => e.cls === 'motorway')).toBe(true);
    expect(roads.edges.some((e) => e.bridge)).toBe(true);
    expect(roads.edges.some((e) => e.cls === 'rail')).toBe(true);
    for (const e of roads.edges) {
      expect(roads.nodes[e.a]).toBeDefined();
      expect(roads.nodes[e.b]).toBeDefined();
      expect(e.pts.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('has 50 000 trees inside the playable area and a landcover grid', () => {
    const t = r.trees!;
    expect(t.count).toBe(50_000);
    expect(t.xz.length).toBe(100_000);
    const half = CS2.PLAYABLE_SIZE_M / 2;
    for (let i = 0; i < t.count; i += 97) {
      expect(Math.abs(t.xz[i * 2])).toBeLessThanOrEqual(half);
      expect(Math.abs(t.xz[i * 2 + 1])).toBeLessThanOrEqual(half);
      expect(t.species[i]).toBeLessThan(t.speciesTable.length);
    }
    expect(r.landcover!.data.length).toBe(512 * 512);
  });

  it('has climate and a valid start tile', () => {
    expect(r.climate!.monthlyMeanC).toHaveLength(12);
    const st = r.playability!.startTile;
    expect(st.col).toBeGreaterThanOrEqual(0);
    expect(st.col).toBeLessThan(CS2.TILE_GRID);
    expect(st.row).toBeGreaterThanOrEqual(0);
    expect(st.row).toBeLessThan(CS2.TILE_GRID);
  });
});
