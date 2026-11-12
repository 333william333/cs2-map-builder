import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION } from '../../core/types';
import {
  bearingDeg, clampSize, distanceM, formatKm, formatScale, placeSizeFromWidth,
  pointInPolygon, ringGeo, rotationFromPointer, sizeFromCornerDistance, snapRotation,
} from './geometry';

describe('size', () => {
  it('clamps to 2..200 km', () => {
    expect(clampSize(10)).toBe(2000);
    expect(clampSize(1e9)).toBe(200000);
    expect(clampSize(14336)).toBe(14336);
    expect(clampSize(NaN)).toBe(14336);
  });
  it('corner distance gives side = d * sqrt2', () => {
    expect(sizeFromCornerDistance(5000)).toBeCloseTo(7071.07, 1);
    expect(sizeFromCornerDistance(10)).toBe(2000);
    expect(placeSizeFromWidth(100000)).toBe(40000);
    expect(placeSizeFromWidth(1000)).toBe(2000);
  });
});

describe('rotation', () => {
  it('snaps within 3 degrees and wraps', () => {
    expect(snapRotation(2.9)).toBe(0);
    expect(snapRotation(357.5)).toBe(0);
    expect(snapRotation(-1)).toBe(0);
    expect(snapRotation(92)).toBe(90);
    expect(snapRotation(177.5)).toBe(180);
    expect(snapRotation(176.5)).toBe(176.5);
    expect(snapRotation(273)).toBe(270);
    expect(snapRotation(94)).toBe(94);
    expect(snapRotation(-45)).toBe(315);
  });
  it('bearing of cardinal directions', () => {
    expect(bearingDeg(50, 10, 51, 10)).toBeCloseTo(0, 3);
    expect(bearingDeg(0, 10, 0, 11)).toBeCloseTo(90, 3);
    expect(bearingDeg(50, 10, 49, 10)).toBeCloseTo(180, 3);
    expect(bearingDeg(0, 10, 0, 9)).toBeCloseTo(270, 3);
  });
  it('rotationFromPointer uses the selection centre', () => {
    const s = { ...DEFAULT_SELECTION };
    expect(rotationFromPointer(s, s.centerLat + 0.1, s.centerLon)).toBe(0);
    expect(rotationFromPointer(s, s.centerLat, s.centerLon + 0.1)).toBeCloseTo(90, 0);
  });
});

describe('formatting', () => {
  it('scale', () => {
    expect(formatScale(14336)).toBe('1 : 1');
    expect(formatScale(28672)).toBe('1 : 2');
    expect(formatScale(200000)).toBe('1 : 14');
    expect(formatScale(21504)).toBe('1 : 1.5');
    expect(formatScale(7168)).toBe('2 : 1');
    expect(formatScale(2000)).toBe('7.2 : 1');
  });
  it('km', () => {
    expect(formatKm(14336)).toBe('14.3');
  });
});

describe('ring', () => {
  it('is closed and metrically square', () => {
    const sel = { centerLat: 65, centerLon: 20, sizeMeters: 30000, rotationDeg: 30 };
    // 14336 game metres at scale 14336/30000 = 30000 real metres per side
    const ring = ringGeo(sel, 14336, 1);
    expect(ring).toHaveLength(5);
    expect(ring[4]).toEqual(ring[0]);
    for (let i = 0; i < 4; i++) {
      const a = ring[i]!;
      const b = ring[i + 1]!;
      const d = distanceM(a[1], a[0], b[1], b[0]);
      expect(d).toBeGreaterThan(30000 * 0.995);
      expect(d).toBeLessThan(30000 * 1.005);
    }
  });
  it('point in polygon', () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(pointInPolygon(5, 5, sq)).toBe(true);
    expect(pointInPolygon(15, 5, sq)).toBe(false);
  });
});
