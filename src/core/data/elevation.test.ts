import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { createFrame } from '../geo/frame';
import { DEFAULT_SELECTION, type FetchBytes } from '../types';
import { loadElevation, planElevation } from './elevation';

const frame = createFrame(DEFAULT_SELECTION);

function worldPx(lat: number, lon: number, z: number): [number, number] {
  const n = 256 * 2 ** z;
  const phi = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n];
}

/** terrarium tile whose elevation is a linear function of the global pixel x: 0.001 * gx */
function linearTile(tx: number): Uint8Array {
  const data = new Uint8Array(256 * 256 * 3);
  for (let j = 0; j < 256; j++) {
    for (let i = 0; i < 256; i++) {
      const v = 0.001 * (tx * 256 + i) + 32768;
      const iv = Math.floor(v);
      const o = (j * 256 + i) * 3;
      data[o] = iv >> 8;
      data[o + 1] = iv & 255;
      data[o + 2] = Math.floor((v - iv) * 256);
    }
  }
  return encode({ width: 256, height: 256, data, channels: 3, depth: 8 });
}

function fakeFetch(opts: { fail?: (z: number, x: number, y: number) => boolean } = {}) {
  const urls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fn: FetchBytes = async (url) => {
    const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url);
    if (!m) throw new Error('unexpected url ' + url);
    urls.push(url);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const [z, x, y] = [+m[1], +m[2], +m[3]];
    if (opts.fail?.(z, x, y)) throw new Error('HTTP 404');
    return linearTile(x);
  };
  return { fn, urls, stats: () => maxInFlight };
}

describe('planElevation', () => {
  it('picks the lowest zoom that is fine enough', () => {
    // needed = 14336 / 1024 = 14 m; z13 pixel = 9.6 m, z12 = 19.2 m
    expect(planElevation(frame, 14336, 1024).z).toBe(13);
    // needed 3.5 m -> clamped to 14
    expect(planElevation(frame, 14336, 4096).z).toBe(14);
    // very coarse -> low zoom
    expect(planElevation(frame, 14336, 16).z).toBeLessThanOrEqual(8);
  });

  it('caps the tile count at 256 by lowering the zoom', () => {
    const unconstrained = planElevation(frame, 14336, 4096);
    expect(unconstrained.count).toBeLessThanOrEqual(256);
    const world = planElevation(frame, 57344, 4096);
    expect(world.count).toBeLessThanOrEqual(256);
    expect(world.z).toBeLessThan(13);
  });
});

describe('loadElevation', () => {
  it('decodes terrarium tiles and samples bilinearly', async () => {
    const f = fakeFetch();
    const progress: number[] = [];
    const elev = await loadElevation(frame, 14336, 512, f.fn, (_s, fr) => progress.push(fr));
    expect(f.urls.length).toBe(elev.tileCount);
    expect(f.stats()).toBeLessThanOrEqual(8);
    expect(progress[progress.length - 1]).toBe(1);

    const z = elev.zoom;
    for (const [lat, lon] of [
      [59.8586, 17.6389],
      [59.87, 17.62],
      [59.84, 17.66],
    ]) {
      const [gx] = worldPx(lat, lon, z);
      const expected = 0.001 * (gx - 0.5);
      expect(elev.sample(lat, lon)).toBeCloseTo(expected, 2);
    }
  });

  it('clamps at the mosaic edge', async () => {
    const elev = await loadElevation(frame, 14336, 512, fakeFetch().fn);
    const far = elev.sample(59.8586, 17.6389 + 5);
    const farWest = elev.sample(59.8586, 17.6389 - 5);
    expect(Number.isFinite(far)).toBe(true);
    expect(far).toBeGreaterThan(farWest);
  });

  it('treats a failed tile as 0 but fails when more than a third fail', async () => {
    const plan = planElevation(frame, 14336, 512);
    expect(plan.count).toBeGreaterThan(3);
    const elev = await loadElevation(
      frame, 14336, 512,
      fakeFetch({ fail: (_z, x, y) => x === plan.x0 && y === plan.y0 }).fn,
    );
    expect(elev.tileCount).toBe(plan.count);

    await expect(
      loadElevation(frame, 14336, 512, fakeFetch({ fail: () => true }).fn),
    ).rejects.toThrow(/tiles failed/);
  });
});
