import type { BuildResult } from '../../core/types';
import { encodeHeightmapPng } from '../../core/export/heightmap';
import { buildPackageFiles, type PackageFile } from '../../core/export/package';
import { renderOverlayPng } from './overlay';

export const DEFAULT_MAP_NAME = 'MyMap';

/** Keep letters, digits, dash and underscore so the name is safe as a file name. */
export function sanitizeMapName(raw: string): string {
  const cleaned = raw
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned || DEFAULT_MAP_NAME;
}

export type FetchLike = (
  url: string,
  init: { method: string; body: Uint8Array; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function exportUrl(target: 'heightmaps' | 'overlay', fileName: string): string {
  return `/api/export?target=${target}&name=${encodeURIComponent(fileName)}`;
}

/** URL for one file of a CS2 package; files under resources/ go to the resources subfolder. */
export function packageFileUrl(pkg: string, filePath: string): string {
  const parts = filePath.split('/');
  const base = parts[parts.length - 1]!;
  const sub = parts[0] === 'resources' && parts.length > 1 ? '&sub=resources' : '';
  return `/api/export?target=cs2package&pkg=${encodeURIComponent(pkg)}&name=${encodeURIComponent(base)}${sub}`;
}

async function postBinary(fetchFn: FetchLike, url: string, body: Uint8Array): Promise<string> {
  const res = await fetchFn(url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  let json: { path?: string; error?: string } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw new Error(json.error ?? `The server responded with error ${res.status}`);
  if (!json.path) throw new Error('The server returned no path');
  return json.path;
}

export interface ExportDeps {
  fetchFn?: FetchLike;
  encode?: (grid: BuildResult['terrain']['playable'], heightScale: number) => Uint8Array;
  /** awaited before the heavy encoding so the busy state can paint */
  yieldToBrowser?: () => Promise<void>;
}

const defaultYield = () => new Promise<void>((r) => setTimeout(r, 30));

export interface HeightmapExportResult {
  heightmapPath: string;
  worldmapPath: string;
}

export async function exportHeightmaps(
  result: BuildResult,
  rawName: string,
  deps: ExportDeps = {},
): Promise<HeightmapExportResult> {
  if (result.settings.quality !== 'full') throw new Error("Run 'Build map' first");
  const fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init as RequestInit));
  const encode = deps.encode ?? encodeHeightmapPng;
  await (deps.yieldToBrowser ?? defaultYield)();
  const name = sanitizeMapName(rawName);
  const { playable, world, heightScale } = result.terrain;
  const heightmapPath = await postBinary(
    fetchFn,
    exportUrl('heightmaps', `${name}_heightmap.png`),
    encode(playable, heightScale),
  );
  const worldmapPath = await postBinary(
    fetchFn,
    exportUrl('heightmaps', `${name}_worldmap.png`),
    encode(world, heightScale),
  );
  return { heightmapPath, worldmapPath };
}

export interface PackageCounts {
  nodes: number;
  edges: number;
  trees: number;
  waterSources: number;
}

export interface PackageExportResult {
  /** folder the package was written to */
  folder: string;
  counts: PackageCounts;
  files: number;
}

export interface PackageDeps extends ExportDeps {
  build?: (result: BuildResult, name: string) => PackageFile[];
  /** called before each file is written, with a description */
  onProgress?: (message: string) => void;
}

const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

export async function exportPackage(
  result: BuildResult,
  rawName: string,
  deps: PackageDeps = {},
): Promise<PackageExportResult> {
  if (result.settings.quality !== 'full') throw new Error("Run 'Build map' first");
  const fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init as RequestInit));
  const name = sanitizeMapName(rawName);
  deps.onProgress?.('Preparing the package (encoding heightmaps)…');
  await (deps.yieldToBrowser ?? defaultYield)();
  const files = (deps.build ?? buildPackageFiles)(result, name);
  let counts: PackageCounts = { nodes: 0, edges: 0, trees: 0, waterSources: 0 };
  const manifest = files.find((f) => f.path === 'manifest.json');
  if (manifest) {
    try {
      const m = JSON.parse(new TextDecoder().decode(manifest.bytes)) as { counts?: Partial<PackageCounts> };
      counts = { ...counts, ...m.counts };
    } catch {
      /* keep zero counts */
    }
  }
  let folder = '';
  let i = 0;
  for (const f of files) {
    i++;
    deps.onProgress?.(`Writing ${f.path} (${i} of ${files.length})`);
    let p: string;
    try {
      p = await postBinary(fetchFn, packageFileUrl(name, f.path), f.bytes);
    } catch (e) {
      throw new Error(`${f.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (f.path === 'manifest.json') folder = dirOf(p);
  }
  return { folder, counts, files: files.length };
}

export async function exportOverlay(
  result: BuildResult,
  rawName: string,
  deps: ExportDeps & { render?: (r: BuildResult) => Promise<Uint8Array> } = {},
): Promise<string> {
  const fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init as RequestInit));
  await (deps.yieldToBrowser ?? defaultYield)();
  const png = await (deps.render ?? ((r) => renderOverlayPng(r)))(result);
  return postBinary(fetchFn, exportUrl('overlay', `${sanitizeMapName(rawName)}_overlay.png`), png);
}
