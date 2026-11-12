import { describe, expect, it } from 'vitest';
import type { ZonePreview } from '../../core/types';
import { bridgeStructures, houseInstances } from './instances';
import { halton, jitter, renderFileName, samplesFor, tileLayout } from './renderMath';
import { formatDistance, metresPerPixel, niceScaleBar } from './scaleBar';
import { formatHour, skyPalette, sunPosition, summerDay } from './sun';
import { boxBlur, classWeights, groundWeights, nearWaterLevel, shoreHeights, terrainAO, upsampleField } from './terrainFields';
import type { VertexGrid } from './terrainGrid';
import type { WaterSurface } from './waterSurface';
import { LC } from '../../core/types';

describe('sun', () => {
  it('is due south and highest at solar noon in the north', () => {
    const s = sunPosition(60, 172, 12);
    expect(s.azimuthDeg).toBeCloseTo(180, 0);
    expect(s.elevationDeg).toBeCloseTo(90 - 60 + 23.44, 0);
    // south is -gz, i.e. +z in the scene
    expect(s.dir[2]).toBeGreaterThan(0.5);
    expect(Math.hypot(...s.dir)).toBeCloseTo(1, 5);
  });

  it('is in the west in the afternoon and below the horizon at midnight in winter', () => {
    const pm = sunPosition(60, 196, 16);
    expect(pm.azimuthDeg).toBeGreaterThan(200);
    expect(pm.azimuthDeg).toBeLessThan(290);
    expect(pm.dir[0]).toBeLessThan(0); // west = -x
    expect(sunPosition(60, 355, 0).elevationDeg).toBeLessThan(-20);
  });

  it('follows the selection rotation', () => {
    const a = sunPosition(50, 196, 12, 0);
    const b = sunPosition(50, 196, 12, 90);
    // rotated 90 deg clockwise: true south becomes the map's left edge direction... the direction turns
    expect(a.dir[0]).toBeCloseTo(0, 3);
    expect(Math.abs(b.dir[0])).toBeGreaterThan(0.4);
    expect(b.elevationDeg).toBeCloseTo(a.elevationDeg, 6);
  });

  it('uses the southern summer below the equator', () => {
    expect(summerDay(-33)).toBeLessThan(60);
    expect(summerDay(59)).toBeGreaterThan(150);
  });

  it('has a warm low sun and a blue high sky', () => {
    const low = skyPalette(3);
    const high = skyPalette(50);
    expect(low.sun[2] / low.sun[0]).toBeLessThan(high.sun[2] / high.sun[0]);
    expect(high.zenith[2]).toBeGreaterThan(high.zenith[0]);
    expect(skyPalette(-10).sun[0]).toBeLessThan(0.05);
    expect(formatHour(15.5)).toBe('15:30');
  });
});

describe('scale bar', () => {
  it('computes metres per pixel and picks 1-2-5 lengths', () => {
    const mpp = metresPerPixel(1000, 40, 800);
    expect(mpp).toBeCloseTo((2 * 1000 * Math.tan((20 * Math.PI) / 180)) / 800, 6);
    const b = niceScaleBar(mpp, 120);
    expect([1, 2, 5].some((s) => Math.abs(b.metres / Math.pow(10, Math.floor(Math.log10(b.metres))) - s) < 1e-9)).toBe(true);
    expect(b.px).toBeLessThanOrEqual(120);
    expect(b.px).toBeGreaterThan(40);
  });

  it('formats distances in English', () => {
    expect(formatDistance(250)).toBe('250 m');
    expect(formatDistance(1000)).toBe('1 km');
    expect(formatDistance(2500)).toBe('2.5 km');
    expect(formatDistance(20000)).toBe('20 km');
    expect(niceScaleBar(0).label).toBe('');
  });
});

describe('render math', () => {
  it('generates a low-discrepancy jitter', () => {
    expect(halton(1, 2)).toBeCloseTo(0.5);
    expect(halton(2, 3)).toBeCloseTo(2 / 3);
    expect(jitter(0)).toEqual([0, 0]);
    for (let k = 1; k < 40; k++) {
      const [x, y] = jitter(k);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
    }
  });

  it('tiles large images and covers every pixel once', () => {
    const tiles = tileLayout(3840, 2160, 2048);
    expect(tiles.length).toBe(4);
    expect(tiles.reduce((a, t) => a + t.w * t.h, 0)).toBe(3840 * 2160);
    expect(tileLayout(1920, 1080, 2048)).toEqual([{ x: 0, y: 0, w: 1920, h: 1080 }]);
  });

  it('names files and scales samples', () => {
    expect(renderFileName(59.8586, 17.6389, 1920, 1080, 15.5)).toBe('cs2-map-59.859N-17.639E-1920x1080-1530.png');
    expect(renderFileName(-33.9, -70.1, 2560, 1440, 9)).toContain('33.900S-70.100W');
    expect(samplesFor(1920, 1080)).toBe(32);
    expect(samplesFor(3840, 2160)).toBeLessThan(32);
    expect(samplesFor(3840, 2160)).toBeGreaterThanOrEqual(8);
  });
});

function grid(n: number, f: (r: number, c: number) => number, extentM = 1000): VertexGrid {
  const data = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) data[r * n + c] = f(r, c);
  return { n, extentM, data };
}

describe('terrain fields', () => {
  it('blurs without changing a constant field', () => {
    const v = grid(16, () => 5);
    const b = boxBlur(v.data, 16, 3);
    for (const x of b) expect(x).toBeCloseTo(5);
  });

  it('darkens valleys and keeps plains open', () => {
    const flat = terrainAO(grid(64, () => 100, 6400));
    for (const x of flat) expect(x).toBeCloseTo(1, 1);
    const valley = terrainAO(grid(64, (_r, c) => Math.abs(c - 32) * 20, 6400));
    expect(valley[32 * 64 + 32]).toBeLessThan(0.9);
    expect(valley[32 * 64 + 2]).toBeGreaterThan(valley[32 * 64 + 32]);
  });

  it('spreads the water level a few rings over the shore', () => {
    const n = 20;
    const v = grid(n, (_r, c) => c * 1.0);
    const wet = new Uint8Array(n * n);
    const level = new Float32Array(n * n).fill(NaN);
    for (let r = 0; r < n; r++) for (let c = 0; c < 3; c++) { wet[r * n + c] = 1; level[r * n + c] = 2.5; }
    const surface: WaterSurface = { wet, level, hasWater: true };
    const lv = nearWaterLevel(v, surface, 4);
    expect(lv[5 * n + 6]).toBeCloseTo(2.5);
    expect(Number.isNaN(lv[5 * n + 10])).toBe(true);
    const above = shoreHeights(v, surface, 4);
    expect(above[5 * n + 5]).toBeCloseTo(2.5);
    expect(above[5 * n + 15]).toBe(999);
  });

  it('upsamples fields bilinearly and skips NaN corners', () => {
    const src = new Float32Array([0, 10, 0, NaN]);
    const up = upsampleField(src, 2, 3);
    expect(up[0]).toBe(0);
    expect(up[1]).toBeCloseTo(5);
    expect(up[2]).toBe(10);
    expect(Number.isNaN(up[8])).toBe(true);
  });

  it('builds soft landcover weights and tree canopy', () => {
    const size = 8;
    const data = new Uint8Array(size * size).fill(LC.Grass);
    for (let r = 0; r < size; r++) for (let c = 0; c < 4; c++) data[r * size + c] = LC.Crop;
    const lc = { size, extentM: 800, data };
    const xz = new Float32Array([300, 300, 310, 300, 305, 310]);
    const trees = { count: 3, xz, species: new Uint8Array(3), age: new Uint8Array(3), speciesTable: ['pine' as const] };
    const w = groundWeights(800, size, lc, trees, 1);
    expect(w.a[(4 * size + 0) * 4 + 1]).toBe(255); // crop far left
    expect(w.a[(4 * size + 7) * 4 + 1]).toBe(0); // grass far right
    const edge = w.a[(4 * size + 4) * 4 + 1];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255); // blurred edge
    // canopy near the top right (gz = 300 -> row 0/1, gx = 300 -> col 7)
    expect(w.b[(1 * size + 7) * 4 + 2]).toBeGreaterThan(0);
    expect(classWeights(LC.Tree)[0]).toBe(1);
  });
});

describe('instances', () => {
  const zones: ZonePreview = {
    cellCount: 0,
    cells: new Float32Array(0),
    cellDepth: new Uint8Array(0),
    lotCount: 2,
    // [gx, gz, dirX, dirZ, w, d, h]
    lots: new Float32Array([100, 50, 1, 0, 12, 10, 7, -40, 20, 0, 1, 30, 20, 18]),
    lotKind: new Uint8Array([0, 1]),
  };

  it('places houses on the lowest corner with the right size and roofs only on low residential', () => {
    const inst = houseInstances(zones, (x) => x * 0.01);
    expect(inst.bodyCount).toBe(2);
    expect(inst.roofCount).toBe(1);
    // first lot: along +x, width 12 on the x axis, centred at scene (100, -50)
    const m = inst.body;
    expect(m[0]).toBeCloseTo(12);
    expect(m[12]).toBeCloseTo(100);
    expect(m[14]).toBeCloseTo(-50);
    const base = m[13];
    expect(base).toBeLessThanOrEqual(0.94 - 0.5);
    // height reaches at least the requested height above the centre ground
    expect(base + m[5]).toBeGreaterThanOrEqual(1 + 7 - 1e-6);
    // second lot runs along gz (scene -z): its local x axis maps to -z
    expect(m[16 + 2]).toBeCloseTo(-30);
  });

  it('can filter lots', () => {
    expect(houseInstances(zones, () => 0, (x) => x > 0).bodyCount).toBe(1);
  });

  it('builds bridge girders and piers only where the deck is high', () => {
    const md = bridgeStructures([{ pts: [[0, 0], [200, 0]], y0: 20, y1: 20, hump: 0, width: 12 }], () => 0, 40);
    expect(md.indices.length).toBeGreaterThan(0);
    expect(md.positions.length).toBe(md.normals.length);
    let minY = Infinity;
    for (let i = 1; i < md.positions.length; i += 3) minY = Math.min(minY, md.positions[i]);
    expect(minY).toBeLessThan(0); // piers reach into the ground
    const low = bridgeStructures([{ pts: [[0, 0], [200, 0]], y0: 2, y1: 2, hump: 0, width: 12 }], () => 0, 40);
    let lowMin = Infinity;
    for (let i = 1; i < low.positions.length; i += 3) lowMin = Math.min(lowMin, low.positions[i]);
    expect(lowMin).toBeGreaterThan(-1); // no piers under a low deck
  });
});
