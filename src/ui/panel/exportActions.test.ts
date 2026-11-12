import { describe, expect, it, vi } from 'vitest';
import { exportHeightmaps, exportOverlay, exportPackage, packageFileUrl, sanitizeMapName, type FetchLike } from './exportActions';
import { DEFAULT_SETTINGS, type BuildResult } from '../../core/types';

function fakeResult(quality: 'draft' | 'full'): BuildResult {
  const grid = (size: number) => ({ size, extentM: 100, data: new Float32Array(size * size) });
  return {
    settings: { ...DEFAULT_SETTINGS, quality },
    terrain: { playable: grid(2), world: grid(2), heightScale: 1234 },
  } as unknown as BuildResult;
}

describe('sanitizeMapName', () => {
  it('keeps safe characters and strips the rest', () => {
    expect(sanitizeMapName('My Map!')).toBe('My_Map');
    expect(sanitizeMapName('Åre/../x-y_1')).toBe('Arex-y_1');
    expect(sanitizeMapName('   ')).toBe('MyMap');
    expect(sanitizeMapName('***')).toBe('MyMap');
  });
});

describe('exportHeightmaps', () => {
  it('makes two POSTs with the right urls', async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = vi.fn(async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ path: `C:/out/${url}` }) };
    });
    const encode = vi.fn((_g: unknown, _s: number) => new Uint8Array([1, 2, 3]));
    const r = await exportHeightmaps(fakeResult('full'), 'My Map', {
      fetchFn,
      encode,
      yieldToBrowser: async () => {},
    });
    expect(calls).toEqual([
      '/api/export?target=heightmaps&name=My_Map_heightmap.png',
      '/api/export?target=heightmaps&name=My_Map_worldmap.png',
    ]);
    expect(encode).toHaveBeenCalledTimes(2);
    expect(encode.mock.calls[0]![1]).toBe(1234);
    expect(r.heightmapPath).toContain('heightmap');
  });

  it('refuses drafts and reports server errors', async () => {
    await expect(exportHeightmaps(fakeResult('draft'), 'a')).rejects.toThrow();
    const fetchFn: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    await expect(
      exportHeightmaps(fakeResult('full'), 'a', { fetchFn, encode: () => new Uint8Array(1), yieldToBrowser: async () => {} }),
    ).rejects.toThrow('boom');
  });
});

describe('exportPackage', () => {
  const manifest = new TextEncoder().encode(
    JSON.stringify({ counts: { nodes: 5, edges: 4, trees: 300, waterSources: 2 } }),
  );
  const build = () => [
    { path: 'manifest.json', bytes: manifest },
    { path: 'heightmap.png', bytes: new Uint8Array([1]) },
    { path: 'resources/ore.png', bytes: new Uint8Array([2]) },
  ];

  it('uploads sequentially with the right urls and reports counts', async () => {
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn: FetchLike = async (url) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      calls.push(url);
      inFlight--;
      return { ok: true, status: 200, json: async () => ({ path: `C:\\pk\\My_Map\\${url.split('name=')[1]!.split('&')[0]}` }) };
    };
    const msgs: string[] = [];
    const r = await exportPackage(fakeResult('full'), 'My Map', {
      fetchFn, build, yieldToBrowser: async () => {}, onProgress: (m) => msgs.push(m),
    });
    expect(calls).toEqual([
      '/api/export?target=cs2package&pkg=My_Map&name=manifest.json',
      '/api/export?target=cs2package&pkg=My_Map&name=heightmap.png',
      '/api/export?target=cs2package&pkg=My_Map&name=ore.png&sub=resources',
    ]);
    expect(maxInFlight).toBe(1);
    expect(r.counts).toEqual({ nodes: 5, edges: 4, trees: 300, waterSources: 2 });
    expect(r.folder).toBe('C:\\pk\\My_Map');
    expect(msgs.some((m) => m.includes('resources/ore.png'))).toBe(true);
  });

  it('surfaces a failing upload with the file name and stops', async () => {
    let n = 0;
    const fetchFn: FetchLike = async () => {
      n++;
      return n === 2
        ? { ok: false, status: 500, json: async () => ({ error: 'disk full' }) }
        : { ok: true, status: 200, json: async () => ({ path: 'C:/x/a' }) };
    };
    await expect(
      exportPackage(fakeResult('full'), 'a', { fetchFn, build, yieldToBrowser: async () => {} }),
    ).rejects.toThrow('heightmap.png: disk full');
    expect(n).toBe(2);
  });

  it('refuses drafts', async () => {
    await expect(exportPackage(fakeResult('draft'), 'a', { build })).rejects.toThrow();
  });

  it('packageFileUrl only adds sub for resources', () => {
    expect(packageFileUrl('p', 'roads.json')).not.toContain('sub=');
    expect(packageFileUrl('p', 'resources/oil.png')).toContain('&sub=resources');
  });
});

describe('exportOverlay', () => {
  it('posts the rendered png to the overlay target', async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ path: 'C:/o.png' }) };
    };
    const p = await exportOverlay(fakeResult('draft'), 'My Map', {
      fetchFn, render: async () => new Uint8Array([9]), yieldToBrowser: async () => {},
    });
    expect(p).toBe('C:/o.png');
    expect(calls).toEqual(['/api/export?target=overlay&name=My_Map_overlay.png']);
  });
});
