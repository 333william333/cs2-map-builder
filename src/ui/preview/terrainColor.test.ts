import { describe, expect, it } from 'vitest';
import { LC, type ClimateProfile } from '../../core/types';
import { buildVertexColors, snowLineGame, srgbToLinear, terrainColorSrgb } from './terrainColor';
import { computeNormals, type VertexGrid } from './terrainGrid';

function col(h: number, ny: number, lc = 0, depth = 0, snow = Infinity, noise = 0.5): number[] {
  const out = [0, 0, 0];
  terrainColorSrgb(out, 0, h, ny, lc, noise, 0.5, depth, 64, snow);
  return out;
}
const lum = (c: number[]): number => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;

describe('terrain colour ramp', () => {
  it('is green on flat grass', () => {
    const c = col(120, 1);
    expect(c[1]).toBeGreaterThan(c[0]);
    expect(c[1]).toBeGreaterThan(c[2]);
  });

  it('is greyer on steep slopes', () => {
    const flat = col(120, 1);
    const steep = col(120, 0.6);
    const sat = (c: number[]): number => Math.max(...c) - Math.min(...c);
    expect(sat(steep)).toBeLessThan(sat(flat));
  });

  it('is sandy close to the water line and not far above it', () => {
    const beach = col(64.6, 1);
    const inland = col(90, 1);
    expect(beach[0]).toBeGreaterThan(inland[0]);
    expect(beach[2]).toBeGreaterThan(inland[2]);
  });

  it('turns white above the snow line only', () => {
    const below = col(500, 1, 0, 0, 900);
    const above = col(1100, 1, 0, 0, 900);
    expect(lum(above)).toBeGreaterThan(0.8);
    expect(lum(below)).toBeLessThan(0.6);
  });

  it('tints landcover classes', () => {
    const forest = col(100, 1, LC.Tree);
    const crop = col(100, 1, LC.Crop);
    const built = col(100, 1, LC.Built);
    const bare = col(100, 1, LC.Bare);
    expect(lum(forest)).toBeLessThan(lum(crop));
    expect(crop[0]).toBeGreaterThan(forest[0]);
    expect(Math.abs(built[0] - built[2])).toBeLessThan(0.2);
    expect(bare[0]).toBeGreaterThan(bare[2] + 0.1);
  });

  it('is darker and bluish under water', () => {
    const dry = col(70, 1);
    const wet = col(40, 1, 0, 24);
    expect(lum(wet)).toBeLessThan(lum(dry));
    expect(wet[2]).toBeGreaterThan(wet[0]);
  });

  it('computes the snow line from the climate', () => {
    const climate = { monthlyMeanC: [-10, 0, 5, 6.5, 6.5, 0, -3, 1, 2, 0, -5, -9] } as unknown as ClimateProfile;
    expect(snowLineGame(climate, 64, 1)).toBeCloseTo(1064, 3);
    expect(snowLineGame(climate, 64, 2)).toBeCloseTo(2064, 3);
    expect(snowLineGame(undefined, 64, 1)).toBe(Infinity);
  });

  it('converts sRGB to linear', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.2140, 3);
  });

  it('fills a whole grid with linear colours and subdues the backdrop', () => {
    const n = 9;
    const v: VertexGrid = { n, extentM: 800, data: new Float32Array(n * n).fill(100) };
    const normals = computeNormals(v);
    const a = buildVertexColors({ v, normals, seaLevel: 64, snowLine: Infinity });
    const b = buildVertexColors({ v, normals, seaLevel: 64, snowLine: Infinity, subdue: 1 });
    expect(a.length).toBe(n * n * 3);
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBeGreaterThanOrEqual(0);
      expect(a[i]).toBeLessThanOrEqual(1);
      sa += a[i];
      sb += b[i];
    }
    expect(sb).toBeLessThan(sa);
  });
});
