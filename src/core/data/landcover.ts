import { GeoTIFF } from 'geotiff';
import type { Frame } from '../geo/frame';
import { LC, type FetchBytes, type LandcoverGrid, type Progress } from '../types';
import { isNotFound } from './util';

const TILE_DEG = 3;
const BLOCK = 64 * 1024;
const MAX_RUN_BLOCKS = 16;

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/** WorldCover tile name (south-west corner on a 3 degree grid), e.g. N57E012, S03W060. */
export function worldCoverTileName(lat: number, lon: number): string {
  const lat0 = Math.floor(lat / TILE_DEG) * TILE_DEG;
  const lon0 = Math.floor(lon / TILE_DEG) * TILE_DEG;
  return `${lat0 >= 0 ? 'N' : 'S'}${pad(Math.abs(lat0), 2)}${lon0 >= 0 ? 'E' : 'W'}${pad(Math.abs(lon0), 3)}`;
}

export function worldCoverUrl(tileName: string): string {
  return `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${tileName}_Map.tif`;
}

/**
 * Minimal geotiff "source" that performs HTTP Range requests through FetchBytes, with a block cache.
 * Duck-typed against geotiff's BaseSource (fetch / fetchSlice / fileSize / close).
 */
class RangeSource {
  private blocks = new Map<number, Promise<Uint8Array>>();
  constructor(private url: string, private fetchBytes: FetchBytes) {}

  get fileSize(): number | null {
    return null;
  }

  async close(): Promise<void> {}

  private requestRun(first: number, last: number): void {
    const start = first * BLOCK;
    const len = (last - first + 1) * BLOCK;
    const run = this.fetchBytes(this.url, { headers: { Range: `bytes=${start}-${start + len - 1}` } }).then(
      (bytes) => {
        // A server that ignores Range returns the whole file: cut out our part.
        if (bytes.length > len) return bytes.subarray(start, start + len);
        return bytes;
      },
    );
    for (let b = first; b <= last; b++) {
      const off = (b - first) * BLOCK;
      const p = run.then((bytes) => bytes.subarray(off, off + BLOCK));
      p.catch(() => this.blocks.delete(b)); // allow retry after failure
      this.blocks.set(b, p);
    }
  }

  async fetch(slices: { offset: number; length: number }[]): Promise<ArrayBuffer[]> {
    const need = new Set<number>();
    for (const s of slices) {
      const b0 = Math.floor(s.offset / BLOCK);
      const b1 = Math.floor((s.offset + Math.max(1, s.length) - 1) / BLOCK);
      for (let b = b0; b <= b1; b++) if (!this.blocks.has(b)) need.add(b);
    }
    const sorted = [...need].sort((a, b) => a - b);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1 && j + 1 - i < MAX_RUN_BLOCKS) j++;
      this.requestRun(sorted[i], sorted[j]);
      i = j + 1;
    }
    return Promise.all(slices.map((s) => this.assemble(s)));
  }

  async fetchSlice(slice: { offset: number; length: number }) {
    const [data] = await this.fetch([slice]);
    return { ...slice, data };
  }

  private async assemble(s: { offset: number; length: number }): Promise<ArrayBuffer> {
    const out = new Uint8Array(s.length);
    let filled = 0;
    const b0 = Math.floor(s.offset / BLOCK);
    const b1 = Math.floor((s.offset + Math.max(1, s.length) - 1) / BLOCK);
    for (let b = b0; b <= b1; b++) {
      const data = await this.blocks.get(b)!;
      const blockStart = b * BLOCK;
      const from = Math.max(s.offset, blockStart) - blockStart;
      const to = Math.min(s.offset + s.length, blockStart + BLOCK) - blockStart;
      if (from >= data.length) break; // past end of file
      const piece = data.subarray(from, Math.min(to, data.length));
      out.set(piece, blockStart + from - s.offset);
      filled += piece.length;
      if (data.length < BLOCK) break;
    }
    return filled === s.length ? out.buffer : out.buffer.slice(0, filled);
  }
}

interface TileJob {
  name: string;
  lat0: number;
  lon0: number;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

interface TileRaster {
  /** window origin and size in level pixels */
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** full level size in pixels */
  W: number;
  H: number;
  data: ArrayLike<number>;
}

export async function loadLandcover(
  frame: Frame,
  extentGameM: number,
  size: number,
  fetch: FetchBytes,
  progress?: Progress,
): Promise<LandcoverGrid> {
  const stage = 'Land cover';
  const cellGameM = extentGameM / size;
  const cellRealM = cellGameM / frame.scale;
  const cellX = (c: number) => -extentGameM / 2 + (c + 0.5) * cellGameM;
  const cellZ = (r: number) => extentGameM / 2 - (r + 0.5) * cellGameM;

  // pass 1: which tiles are needed, and their lat/lon extent (coarse sampling is enough)
  const stride = Math.max(1, Math.floor(size / 128));
  const jobs = new Map<string, TileJob>();
  const visit = (r: number, c: number) => {
    const [lat, lon] = frame.gameToGeo(cellX(c), cellZ(r));
    const name = worldCoverTileName(lat, lon);
    let j = jobs.get(name);
    if (!j) {
      j = {
        name,
        lat0: Math.floor(lat / TILE_DEG) * TILE_DEG,
        lon0: Math.floor(lon / TILE_DEG) * TILE_DEG,
        minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity,
      };
      jobs.set(name, j);
    }
    if (lat < j.minLat) j.minLat = lat;
    if (lat > j.maxLat) j.maxLat = lat;
    if (lon < j.minLon) j.minLon = lon;
    if (lon > j.maxLon) j.maxLon = lon;
  };
  for (let r = 0; r < size; r += stride) {
    for (let c = 0; c < size; c += stride) visit(r, c);
    visit(r, size - 1);
  }
  for (let c = 0; c < size; c += stride) visit(size - 1, c);
  visit(size - 1, size - 1);

  progress?.(stage, 0, `0 / ${jobs.size} tiles`);

  // pass 2: read each tile's window once
  const rasters = new Map<string, TileRaster | 'missing'>();
  let done = 0;
  for (const job of jobs.values()) {
    const url = worldCoverUrl(job.name);
    let result: TileRaster | 'missing' | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        result = await readTile(url, job, cellRealM, fetch);
      } catch (e) {
        if (isNotFound(e)) result = 'missing';
        else lastErr = e;
      }
    }
    if (!result) throw new Error(`Landcover: tile ${job.name} failed: ${(lastErr as Error)?.message ?? lastErr}`);
    rasters.set(job.name, result);
    done++;
    progress?.(stage, (done / jobs.size) * 0.9, `${done} / ${jobs.size} tiles`);
  }

  // pass 3: nearest-neighbour fill
  const data = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) {
    const gz = cellZ(r);
    for (let c = 0; c < size; c++) {
      const [lat, lon] = frame.gameToGeo(cellX(c), gz);
      const name = worldCoverTileName(lat, lon);
      const ras = rasters.get(name);
      let v: number = LC.Water;
      if (ras && ras !== 'missing') {
        const lat0 = Math.floor(lat / TILE_DEG) * TILE_DEG;
        const lon0 = Math.floor(lon / TILE_DEG) * TILE_DEG;
        const px = Math.floor(((lon - lon0) / TILE_DEG) * ras.W);
        const py = Math.floor(((lat0 + TILE_DEG - lat) / TILE_DEG) * ras.H);
        const x = Math.min(ras.x0 + ras.w - 1, Math.max(ras.x0, px)) - ras.x0;
        const y = Math.min(ras.y0 + ras.h - 1, Math.max(ras.y0, py)) - ras.y0;
        v = ras.data[y * ras.w + x];
      } else if (!ras) {
        v = LC.None; // sampled cell outside the coarse pass bbox of any tile: should not happen
      }
      data[r * size + c] = v;
    }
  }
  progress?.(stage, 1);
  return { size, extentM: extentGameM, data };
}

async function readTile(url: string, job: TileJob, cellRealM: number, fetch: FetchBytes): Promise<TileRaster> {
  const source = new RangeSource(url, fetch);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tiff = await GeoTIFF.fromSource(source as any);
  const count = await tiff.getImageCount();

  // pick the coarsest level whose pixel size is still at or below the needed resolution
  const dims: { i: number; W: number; H: number }[] = [];
  for (let i = 0; i < count; i++) {
    const img = await tiff.getImage(i);
    dims.push({ i, W: img.getWidth(), H: img.getHeight() });
  }
  dims.sort((a, b) => b.W - a.W);
  let level = dims[0];
  // dims is sorted fine to coarse: the last qualifying entry is the coarsest one
  for (const d of dims) {
    const pixM = (TILE_DEG / d.H) * 111320;
    if (pixM <= cellRealM) level = d;
  }

  const { W, H } = level;
  const pad = 2;
  const x0 = Math.max(0, Math.floor(((job.minLon - job.lon0) / TILE_DEG) * W) - pad);
  const x1 = Math.min(W, Math.ceil(((job.maxLon - job.lon0) / TILE_DEG) * W) + 1 + pad);
  const y0 = Math.max(0, Math.floor(((job.lat0 + TILE_DEG - job.maxLat) / TILE_DEG) * H) - pad);
  const y1 = Math.min(H, Math.ceil(((job.lat0 + TILE_DEG - job.minLat) / TILE_DEG) * H) + 1 + pad);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);

  const img = await tiff.getImage(level.i);
  const raster = (await img.readRasters({
    window: [x0, y0, x0 + w, y0 + h],
    samples: [0],
    interleave: true,
  })) as unknown as ArrayLike<number>;
  return { x0, y0, w, h, W, H, data: raster };
}
