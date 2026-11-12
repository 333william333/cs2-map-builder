import { describe, expect, it } from 'vitest';
import { createFrame } from './frame';
import { CS2, type Selection } from '../types';

const sel = (lat: number, rot: number, size: number = CS2.PLAYABLE_SIZE_M): Selection => ({
  centerLat: lat,
  centerLon: 17.6389,
  sizeMeters: size,
  rotationDeg: rot,
});

const metresToDegLat = (m: number) => (m / 6371008.8) * (180 / Math.PI);

describe('createFrame', () => {
  for (const lat of [0, 45, 59.86, 70]) {
    for (const rot of [0, 30, 90]) {
      it(`round trips at lat ${lat}, rotation ${rot}`, () => {
        const f = createFrame(sel(lat, rot));
        for (const [gx, gz] of [[0, 0], [3000, -2000], [-7168, 7168], [7168, 7168], [-5000, -7000]]) {
          const [la, lo] = f.gameToGeo(gx, gz);
          const [bx, bz] = f.geoToGame(la, lo);
          expect(bx).toBeCloseTo(gx, 4);
          expect(bz).toBeCloseTo(gz, 4);
        }
      });
    }
  }

  it('centre maps to origin', () => {
    const f = createFrame(sel(59.86, 0));
    const [x, z] = f.geoToGame(59.86, 17.6389);
    expect(Math.abs(x)).toBeLessThan(1e-6);
    expect(Math.abs(z)).toBeLessThan(1e-6);
  });

  it('a point 1000 m due north maps to [0, 1000 * scale] at rotation 0', () => {
    for (const size of [14336, 28672]) {
      const f = createFrame(sel(59.86, 0, size));
      const [x, z] = f.geoToGame(59.86 + metresToDegLat(1000), 17.6389);
      expect(x).toBeCloseTo(0, 3);
      expect(z).toBeCloseTo(1000 * f.scale, 2);
    }
  });

  it('scale is 0.5 for sizeMeters = 28672', () => {
    expect(createFrame(sel(45, 0, 28672)).scale).toBe(0.5);
  });

  it('scale is 1 for sizeMeters = 14336', () => {
    expect(createFrame(sel(45, 0)).scale).toBe(1);
  });

  it('rotation 90 puts true north on the game -x axis', () => {
    // The top edge points 90 deg clockwise from north (east), so north is to the game left.
    const f = createFrame(sel(45, 90));
    const [x, z] = f.geoToGame(45 + metresToDegLat(1000), 17.6389);
    expect(x).toBeCloseTo(-1000, 1);
    expect(z).toBeCloseTo(0, 1);
  });

  for (const rot of [0, 30, 90]) {
    it(`bbox contains all corners (rotation ${rot})`, () => {
      const f = createFrame(sel(59.86, rot));
      for (const extent of [CS2.PLAYABLE_SIZE_M, CS2.WORLD_SIZE_M]) {
        const [s, w, n, e] = f.bbox(extent);
        expect(s).toBeLessThan(n);
        expect(w).toBeLessThan(e);
        for (const [lat, lon] of f.corners(extent)) {
          expect(lat).toBeGreaterThanOrEqual(s);
          expect(lat).toBeLessThanOrEqual(n);
          expect(lon).toBeGreaterThanOrEqual(w);
          expect(lon).toBeLessThanOrEqual(e);
        }
      }
    });
  }
});
