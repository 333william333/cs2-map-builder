import { describe, expect, it } from 'vitest';
import {
  alignedWorldVertexCount,
  buildGridIndices,
  buildGridPositions,
  computeNormals,
  decimateHeightGrid,
  meshHeightAt,
  resampleNearest,
  resampleToVertices,
  type VertexGrid,
} from './terrainGrid';

function ramp(n: number, extent: number, f: (x: number, z: number) => number): VertexGrid {
  const d = extent / (n - 1);
  const data = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) data[r * n + c] = f(-extent / 2 + c * d, -extent / 2 + r * d);
  return { n, extentM: extent, data };
}

describe('decimation', () => {
  it('keeps constants constant and caps the vertex count', () => {
    const size = 64;
    const data = new Float32Array(size * size).fill(12.5);
    const v = decimateHeightGrid({ size, extentM: 1000, data }, 16);
    expect(v.n).toBe(16);
    expect(v.data.length).toBe(256);
    for (const x of v.data) expect(x).toBeCloseTo(12.5, 4);
  });

  it('does not upsample small grids beyond their size', () => {
    const v = decimateHeightGrid({ size: 8, extentM: 100, data: new Float32Array(64) }, 512);
    expect(v.n).toBe(8);
  });

  it('preserves a linear ramp across the extent (corners map to the edge)', () => {
    const size = 128;
    const extent = 1280;
    const cell = extent / size;
    const data = new Float32Array(size * size);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) data[r * size + c] = -extent / 2 + (c + 0.5) * cell;
    const v = decimateHeightGrid({ size, extentM: extent, data }, 33);
    // mid column is x = 0
    expect(v.data[16]).toBeCloseTo(0, 0);
    // monotonic along a row
    for (let c = 1; c < 33; c++) expect(v.data[c]).toBeGreaterThan(v.data[c - 1]);
  });

  it('max mode keeps thin features', () => {
    const size = 64;
    const m = new Uint8Array(size * size);
    m[10 * size + 37] = 1;
    const out = resampleToVertices(m, size, 9, 'max');
    expect(out.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
  });

  it('nearest resample picks class values', () => {
    const src = new Uint8Array([10, 20, 30, 40]);
    const out = resampleNearest(src, 2, 3);
    expect(out[0]).toBe(10);
    expect(out[2]).toBe(20);
    expect(out[6]).toBe(30);
    expect(out[8]).toBe(40);
  });

  it('aligns the world grid so the playable border is on a vertex line', () => {
    const n = alignedWorldVertexCount(57344, 14336, 256);
    expect(n).toBe(257);
    const d = 57344 / (n - 1);
    expect((7168 + 28672) / d).toBeCloseTo(Math.round((7168 + 28672) / d), 9);
  });
});

describe('normals', () => {
  it('points up on flat ground', () => {
    const v = ramp(5, 40, () => 3);
    const nrm = computeNormals(v);
    for (let i = 0; i < 25; i++) {
      expect(nrm[i * 3]).toBeCloseTo(0);
      expect(nrm[i * 3 + 1]).toBeCloseTo(1);
      expect(nrm[i * 3 + 2]).toBeCloseTo(0);
    }
  });

  it('tilts away from the uphill direction and is unit length', () => {
    const v = ramp(9, 80, (x) => x * 0.5); // rises towards +x
    const nrm = computeNormals(v);
    const i = 4 * 9 + 4;
    expect(nrm[i * 3]).toBeLessThan(0);
    expect(nrm[i * 3 + 2]).toBeCloseTo(0);
    expect(Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2])).toBeCloseTo(1);
    expect(nrm[i * 3]).toBeCloseTo(-0.5 / Math.hypot(0.5, 1), 5);
  });

  it('z follows the row direction (row 0 is north, z = -gz)', () => {
    const v = ramp(9, 80, (_x, z) => z * 0.25); // rises with z (towards the camera)
    const nrm = computeNormals(v);
    expect(nrm[(4 * 9 + 4) * 3 + 2]).toBeLessThan(0);
  });
});

describe('mesh height and indices', () => {
  it('reproduces vertex heights and planes exactly', () => {
    const v = ramp(11, 100, (x, z) => 2 + 0.1 * x - 0.05 * z);
    for (const [x, z] of [[-50, -50], [0, 0], [37.3, -12.1], [50, 50], [-9, 44]]) {
      expect(meshHeightAt(v, x, z)).toBeCloseTo(2 + 0.1 * x - 0.05 * z, 4);
    }
  });

  it('clamps outside the grid', () => {
    const v = ramp(3, 10, (x) => x);
    expect(meshHeightAt(v, 1000, 0)).toBeCloseTo(5);
    expect(meshHeightAt(v, -1000, 0)).toBeCloseTo(-5);
  });

  it('builds upward-facing triangles', () => {
    const v = ramp(4, 30, (x, z) => Math.sin(x * 0.05) * 2 + z * 0);
    const pos = buildGridPositions(v);
    const idx = buildGridIndices(4);
    expect(idx.length).toBe(3 * 3 * 6);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vz = pos[c + 2] - pos[a + 2];
      // y component of the cross product (u x v)
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
    }
  });

  it('skips quads on request', () => {
    const idx = buildGridIndices(4, (r, c) => r === 1 && c === 1);
    expect(idx.length).toBe((9 - 1) * 6);
  });

  it('positions use z = row direction and x = column direction', () => {
    const v = ramp(3, 20, () => 1);
    const pos = buildGridPositions(v, 0.5);
    expect(pos[0]).toBeCloseTo(-10);
    expect(pos[1]).toBeCloseTo(1.5);
    expect(pos[2]).toBeCloseTo(-10);
    expect(pos[(2 * 3 + 2) * 3]).toBeCloseTo(10);
    expect(pos[(2 * 3 + 2) * 3 + 2]).toBeCloseTo(10);
  });
});
