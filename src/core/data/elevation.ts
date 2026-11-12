import { decode } from 'fast-png';
import type { Frame } from '../geo/frame';
import type { ElevationSampler, FetchBytes, Progress } from '../types';
import { runPool } from './util';

const TILE = 256;
const MAX_TILES = 256;
const MAX_ZOOM = 14;
const CONCURRENCY = 8;
const MAX_LAT = 85.0511287798;

export const TERRARIUM_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export interface ElevationPlan {
  z: number;
  /** inclusive tile ranges */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  count: number;
}

function clampLat(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

/** Web Mercator world pixel (256 px tiles) at zoom z. */
function worldPx(lat: number, lon: number, z: number): [number, number] {
  const n = TILE * 2 ** z;
  const phi = (clampLat(lat) * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n;
  return [x, y];
}

function tileRange(bbox: [number, number, number, number], z: number) {
  const [s, w, n, e] = bbox;
  const [pxW, pyN] = worldPx(n, w, z);
  const [pxE, pyS] = worldPx(s, e, z);
  const max = 2 ** z - 1;
  const cl = (v: number) => Math.max(0, Math.min(max, v));
  // 1 px of padding so bilinear sampling at the border has real neighbours
  const x0 = cl(Math.floor((pxW - 1) / TILE));
  const x1 = cl(Math.floor((pxE + 1) / TILE));
  const y0 = cl(Math.floor((pyN - 1) / TILE));
  const y1 = cl(Math.floor((pyS + 1) / TILE));
  return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

/** Pure planning step: zoom choice and tile range. Exported for tests. */
export function planElevation(frame: Frame, extentGameM: number, samplesAcross: number): ElevationPlan {
  const bbox = frame.bbox(extentGameM);
  const needed = extentGameM / frame.scale / samplesAcross; // real m per sample
  const midLat = (bbox[0] + bbox[2]) / 2;
  const cosLat = Math.max(0.01, Math.cos((midLat * Math.PI) / 180));
  let z = Math.ceil(Math.log2((156543.03 * cosLat) / Math.max(needed, 1e-6)));
  z = Math.max(0, Math.min(MAX_ZOOM, z));
  let r = tileRange(bbox, z);
  while (r.count > MAX_TILES && z > 0) {
    z--;
    r = tileRange(bbox, z);
  }
  return { z, ...r };
}

async function fetchTile(fetch: FetchBytes, url: string): Promise<Uint8Array> {
  try {
    return await fetch(url);
  } catch {
    return await fetch(url); // one retry
  }
}

export async function loadElevation(
  frame: Frame,
  extentGameM: number,
  samplesAcross: number,
  fetch: FetchBytes,
  progress?: Progress,
): Promise<ElevationSampler & { zoom: number; tileCount: number }> {
  const plan = planElevation(frame, extentGameM, samplesAcross);
  const { z, x0, y0 } = plan;
  const tilesX = plan.x1 - plan.x0 + 1;
  const tilesY = plan.y1 - plan.y0 + 1;
  const W = tilesX * TILE;
  const H = tilesY * TILE;
  const mosaic = new Float32Array(W * H); // missing tiles stay 0

  const jobs: { tx: number; ty: number }[] = [];
  for (let ty = plan.y0; ty <= plan.y1; ty++) for (let tx = plan.x0; tx <= plan.x1; tx++) jobs.push({ tx, ty });

  let done = 0;
  let failed = 0;
  const stage = 'Elevation';
  progress?.(stage, 0, `0 / ${jobs.length} tiles`);

  await runPool(jobs, CONCURRENCY, async ({ tx, ty }) => {
    try {
      const bytes = await fetchTile(fetch, TERRARIUM_URL(z, tx, ty));
      const png = decode(bytes);
      if (png.width !== TILE || png.height !== TILE) throw new Error('unexpected tile size');
      if (png.depth !== 8 || png.channels < 3) throw new Error('unexpected tile format');
      const src = png.data as ArrayLike<number>;
      const ch = png.channels;
      const ox = (tx - x0) * TILE;
      const oy = (ty - y0) * TILE;
      for (let j = 0; j < TILE; j++) {
        let dst = (oy + j) * W + ox;
        let s = j * TILE * ch;
        for (let i = 0; i < TILE; i++, s += ch) {
          mosaic[dst++] = src[s] * 256 + src[s + 1] + src[s + 2] / 256 - 32768;
        }
      }
    } catch {
      failed++;
    }
    done++;
    progress?.(stage, done / jobs.length, `${done} / ${jobs.length} tiles`);
  });

  if (failed * 3 > jobs.length) {
    throw new Error(`Elevation: ${failed} of ${jobs.length} tiles failed to load`);
  }

  const originX = x0 * TILE;
  const originY = y0 * TILE;

  function sample(lat: number, lon: number): number {
    const [gx, gy] = worldPx(lat, lon, z);
    // pixel centres sit at +0.5
    let fx = gx - originX - 0.5;
    let fy = gy - originY - 0.5;
    if (fx < 0) fx = 0; else if (fx > W - 1) fx = W - 1;
    if (fy < 0) fy = 0; else if (fy > H - 1) fy = H - 1;
    const ix = Math.min(W - 2, Math.floor(fx));
    const iy = Math.min(H - 2, Math.floor(fy));
    const tx = fx - Math.max(0, ix);
    const ty = fy - Math.max(0, iy);
    const ixc = Math.max(0, ix);
    const iyc = Math.max(0, iy);
    const ix1 = Math.min(W - 1, ixc + 1);
    const iy1 = Math.min(H - 1, iyc + 1);
    const a = mosaic[iyc * W + ixc];
    const b = mosaic[iyc * W + ix1];
    const c = mosaic[iy1 * W + ixc];
    const d = mosaic[iy1 * W + ix1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  return { sample, zoom: z, tileCount: jobs.length };
}
