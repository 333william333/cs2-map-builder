import { describe, expect, it } from 'vitest';
import { writeArrayBuffer } from 'geotiff';
import { createFrame } from '../geo/frame';
import { DEFAULT_SELECTION, LC, type FetchBytes } from '../types';
import { loadLandcover, worldCoverTileName, worldCoverUrl } from './landcover';

describe('worldCoverTileName', () => {
  it('names tiles by the south-west corner on a 3 degree grid', () => {
    expect(worldCoverTileName(58, 13)).toBe('N57E012');
    expect(worldCoverTileName(57, 12)).toBe('N57E012');
    expect(worldCoverTileName(59.86, 17.64)).toBe('N57E015');
    expect(worldCoverTileName(-2.5, -59.9)).toBe('S03W060');
    expect(worldCoverTileName(0.1, 0.1)).toBe('N00E000');
    expect(worldCoverTileName(-0.1, -0.1)).toBe('S03W003');
    expect(worldCoverTileName(-33.9, 151.2)).toBe('S36E150');
  });

  it('builds the S3 url', () => {
    expect(worldCoverUrl('N57E012')).toBe(
      'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N57E012_Map.tif',
    );
  });
});

describe('loadLandcover', () => {
  const frame = createFrame(DEFAULT_SELECTION);

  it('treats a missing (404) tile as water', async () => {
    const fetch: FetchBytes = async () => {
      throw new Error('proxyFetch GET x failed: HTTP 404 Not Found');
    };
    const grid = await loadLandcover(frame, 14336, 16, fetch);
    expect(grid.size).toBe(16);
    expect(grid.data.every((v) => v === LC.Water)).toBe(true);
  });

  it('throws on other failures', async () => {
    const fetch: FetchBytes = async () => {
      throw new Error('network down');
    };
    await expect(loadLandcover(frame, 14336, 16, fetch)).rejects.toThrow(/failed/);
  });

  it('reads a window through HTTP range requests', async () => {
    // Synthetic 3x3 degree tile (N57E015) of 90x90 px: left half Tree, right half Crop.
    const W = 90;
    const H = 90;
    const px = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = x < W / 2 ? LC.Tree : LC.Crop;
    const tiff = new Uint8Array(
      writeArrayBuffer(px, {
        width: W, height: H, SamplesPerPixel: 1, BitsPerSample: [8], SampleFormat: [1],
        PhotometricInterpretation: 1, ModelPixelScale: [3 / W, 3 / H, 0], ModelTiepoint: [0, 0, 0, 15, 60, 0],
        GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeographicTypeGeoKey: 4326,
      } as never),
    );
    const ranges: string[] = [];
    const fetch: FetchBytes = async (url, opts) => {
      expect(url).toContain('N57E015');
      const m = /bytes=(\d+)-(\d+)/.exec(opts?.headers?.Range ?? '');
      expect(m).not.toBeNull();
      ranges.push(opts!.headers!.Range);
      return tiff.subarray(+m![1], +m![2] + 1);
    };
    // The tile spans lon 15..18, so its middle is lon 16.5.
    const f2 = createFrame({ ...DEFAULT_SELECTION, centerLon: 16.5 });
    const grid = await loadLandcover(f2, 14336, 32, fetch);
    expect(grid.data[16 * 32 + 2]).toBe(LC.Tree);
    expect(grid.data[16 * 32 + 29]).toBe(LC.Crop);
    expect(ranges.length).toBeGreaterThan(0);
  });
});
