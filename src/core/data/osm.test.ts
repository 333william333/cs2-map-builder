import { describe, expect, it } from 'vitest';
import { createFrame } from '../geo/frame';
import { ALL_ROAD_CLASSES, DEFAULT_SELECTION, DEFAULT_SETTINGS, type BuildSettings, type FetchBytes } from '../types';
import { buildOverpassQuery, joinRings, loadVectors, OVERPASS_MIRROR, OVERPASS_URL, parseOverpass } from './osm';

const frame = createFrame(DEFAULT_SELECTION);
const LAT = DEFAULT_SELECTION.centerLat;
const LON = DEFAULT_SELECTION.centerLon;
const pt = (dLat: number, dLon: number) => ({ lat: LAT + dLat, lon: LON + dLon });

function settingsWith(fn: (s: BuildSettings) => void): BuildSettings {
  const s = structuredClone(DEFAULT_SETTINGS);
  fn(s);
  return s;
}

describe('buildOverpassQuery', () => {
  it('has the header, json output and inline geometry', () => {
    const q = buildOverpassQuery(frame, DEFAULT_SETTINGS);
    expect(q.startsWith('[out:json][timeout:120][maxsize:1073741824];')).toBe(true);
    expect(q.trim().endsWith('out geom;')).toBe(true);
    expect(q).toContain('"highway"~"^(motorway|motorway_link|trunk');
    expect(q).toContain('"railway"~"^(rail)$"');
    expect(q).toContain('["natural"="water"]["type"="multipolygon"]');
    expect(q).not.toContain('coastline');
  });

  it('only includes enabled classes', () => {
    const q = buildOverpassQuery(frame, DEFAULT_SETTINGS);
    expect(q).not.toContain('footway'); // pedestrian off by default
    expect(q).not.toContain('|service'); // service off by default
    const all = settingsWith((s) => {
      for (const c of ALL_ROAD_CLASSES) s.roads.classes[c] = true;
    });
    const qa = buildOverpassQuery(frame, all);
    expect(qa).toContain('footway');
    expect(qa).toContain('service');
    expect(qa).toContain('light_rail');
    expect(qa).toContain('subway');
  });

  it('fetches no highways or railways when roads are disabled', () => {
    const q = buildOverpassQuery(frame, settingsWith((s) => (s.roads.enabled = false)));
    expect(q).not.toContain('"highway"');
    expect(q).not.toContain('"railway"');
    expect(q).toContain('"natural"="water"');
  });

  it('drops small classes on large areas', () => {
    const all = settingsWith((s) => {
      for (const c of ALL_ROAD_CLASSES) s.roads.classes[c] = true;
    });
    const mid = buildOverpassQuery(createFrame({ ...DEFAULT_SELECTION, sizeMeters: 50_000 }), all); // 0.287
    expect(mid).not.toContain('living_street');
    expect(mid).not.toContain('footway');
    expect(mid).not.toContain('|service');
    expect(mid).toContain('tertiary');
    expect(mid).not.toContain('stream');
    expect(buildOverpassQuery(createFrame({ ...DEFAULT_SELECTION, sizeMeters: 30_000 }), all)).toContain('stream');

    const huge = buildOverpassQuery(createFrame({ ...DEFAULT_SELECTION, sizeMeters: 100_000 }), all); // 0.143
    expect(huge).not.toContain('tertiary');
    expect(huge).not.toContain('stream');
    expect(huge).toContain('secondary');
  });

  it('only fetches tree nodes at high scale', () => {
    expect(buildOverpassQuery(frame, DEFAULT_SETTINGS)).toContain('node["natural"="tree"]');
    const lowScale = createFrame({ ...DEFAULT_SELECTION, sizeMeters: 20_000 }); // 0.717
    expect(buildOverpassQuery(lowScale, DEFAULT_SETTINGS)).not.toContain('natural"="tree');
  });
});

describe('parseOverpass', () => {
  it('maps tags of a road', () => {
    const json = {
      elements: [
        {
          type: 'way', id: 11,
          tags: { highway: 'primary_link', lanes: '2', bridge: 'yes', layer: '1', name: 'Ramp', oneway: 'yes' },
          geometry: [pt(0, 0), pt(0.001, 0.001)],
        },
        {
          type: 'way', id: 12, tags: { highway: 'unclassified', junction: 'roundabout' },
          geometry: [pt(0, 0), pt(0.0005, 0), pt(0.0005, 0.0005)],
        },
        { type: 'way', id: 13, tags: { highway: 'motorway' }, geometry: [pt(0, 0), pt(0, 0.002)] },
        { type: 'way', id: 14, tags: { highway: 'tertiary', tunnel: 'yes', oneway: 'no' }, geometry: [pt(0, 0), pt(0, 0.002)] },
      ],
    };
    const v = parseOverpass(json as never, frame, DEFAULT_SETTINGS);
    expect(v.ways).toHaveLength(4);
    const [a, b, c, d] = v.ways;
    expect(a).toMatchObject({ id: 11, cls: 'primary', link: true, lanes: 2, bridge: true, tunnel: false, layer: 1, oneway: true, name: 'Ramp', roundabout: false });
    expect(b).toMatchObject({ cls: 'residential', roundabout: true, oneway: true });
    expect(c).toMatchObject({ cls: 'motorway', oneway: true });
    expect(d).toMatchObject({ cls: 'tertiary', tunnel: true, oneway: false });
    // game coordinates: first point is the centre, second is north-east of it
    expect(a.pts[0][0]).toBeCloseTo(0, 3);
    expect(a.pts[1][0]).toBeGreaterThan(0);
    expect(a.pts[1][1]).toBeGreaterThan(0);
  });

  it('reverses oneway=-1 ways', () => {
    const json = {
      elements: [{ type: 'way', id: 1, tags: { highway: 'residential', oneway: '-1' }, geometry: [pt(0, 0), pt(0, 0.001)] }],
    };
    const [w] = parseOverpass(json as never, frame, DEFAULT_SETTINGS).ways;
    expect(w.oneway).toBe(true);
    expect(w.pts[0][0]).toBeGreaterThan(w.pts[1][0]); // started at the east end
  });

  it('skips area, construction, proposed, abandoned and disabled classes', () => {
    const g = [pt(0, 0), pt(0, 0.001)];
    const json = {
      elements: [
        { type: 'way', id: 1, tags: { highway: 'residential', area: 'yes' }, geometry: g },
        { type: 'way', id: 2, tags: { highway: 'residential', construction: 'yes' }, geometry: g },
        { type: 'way', id: 3, tags: { highway: 'residential', proposed: 'yes' }, geometry: g },
        { type: 'way', id: 4, tags: { railway: 'abandoned' }, geometry: g },
        { type: 'way', id: 5, tags: { railway: 'disused' }, geometry: g },
        { type: 'way', id: 6, tags: { highway: 'service' }, geometry: g }, // service disabled by default
        { type: 'way', id: 7, tags: { railway: 'rail' }, geometry: g },
        { type: 'way', id: 8, tags: { highway: 'residential' }, geometry: [pt(1, 1), pt(1, 1.001)] }, // far away
      ],
    };
    const v = parseOverpass(json as never, frame, DEFAULT_SETTINGS);
    expect(v.ways.map((w) => w.id)).toEqual([7]);
  });

  it('simplifies rail yards to their through tracks (sidings always, spurs below scale 0.8)', () => {
    const json = {
      elements: [
        { type: 'way', id: 1, tags: { railway: 'rail', service: 'siding' }, geometry: [pt(0, 0), pt(0, 0.001)] },
        { type: 'way', id: 2, tags: { railway: 'rail' }, geometry: [pt(0, 0), pt(0, 0.001)] },
        { type: 'way', id: 3, tags: { railway: 'rail', service: 'spur' }, geometry: [pt(0, 0), pt(0, 0.001)] },
      ],
    };
    const small = createFrame({ ...DEFAULT_SELECTION, sizeMeters: 20_000 });
    expect(parseOverpass(json as never, small, DEFAULT_SETTINGS).ways.map((w) => w.id)).toEqual([2]);
    expect(parseOverpass(json as never, frame, DEFAULT_SETTINGS).ways.map((w) => w.id)).toEqual([2, 3]);
  });

  it('builds a multipolygon lake with a hole from several member ways', () => {
    const d = 0.004;
    const outerA = [pt(-d, -d), pt(-d, d), pt(d, d)];
    const outerB = [pt(d, d), pt(d, -d), pt(-d, -d)];
    const h = 0.001;
    const i1 = [pt(-h, -h), pt(-h, h)];
    const i2 = [pt(h, h), pt(-h, h)]; // reversed direction
    const i3 = [pt(h, h), pt(h, -h), pt(-h, -h)];
    const json = {
      elements: [
        {
          type: 'relation', id: 100, tags: { type: 'multipolygon', natural: 'water', water: 'reservoir' },
          members: [
            { type: 'way', ref: 1, role: 'outer', geometry: outerA },
            { type: 'way', ref: 2, role: 'outer', geometry: outerB },
            { type: 'way', ref: 3, role: 'inner', geometry: i1 },
            { type: 'way', ref: 4, role: 'inner', geometry: i2 },
            { type: 'way', ref: 5, role: 'inner', geometry: i3 },
          ],
        },
      ],
    };
    const v = parseOverpass(json as never, frame, DEFAULT_SETTINGS);
    expect(v.waterPolygons).toHaveLength(1);
    const wp = v.waterPolygons[0];
    expect(wp.kind).toBe('reservoir');
    expect(wp.rings).toHaveLength(2);
    const [outer, hole] = wp.rings;
    expect(outer[0]).toEqual(outer[outer.length - 1]);
    expect(hole[0]).toEqual(hole[hole.length - 1]);
    const span = (r: [number, number][]) => Math.max(...r.map((p) => p[0])) - Math.min(...r.map((p) => p[0]));
    expect(span(outer)).toBeGreaterThan(span(hole) * 3);
  });

  it('classifies water, waterways, areas and trees', () => {
    const sq = [pt(0, 0), pt(0, 0.001), pt(0.001, 0.001), pt(0.001, 0), pt(0, 0)];
    const json = {
      elements: [
        { type: 'way', id: 1, tags: { natural: 'water' }, geometry: sq },
        { type: 'way', id: 2, tags: { waterway: 'riverbank' }, geometry: sq },
        { type: 'way', id: 3, tags: { waterway: 'river', width: '12.5', name: 'Fyris' }, geometry: [pt(0, 0), pt(0, 0.002)] },
        { type: 'way', id: 4, tags: { waterway: 'stream', width: 'wide' }, geometry: [pt(0, 0), pt(0, 0.002)] },
        { type: 'way', id: 5, tags: { landuse: 'forest', leaf_type: 'needleleaved' }, geometry: sq },
        { type: 'way', id: 6, tags: { landuse: 'meadow' }, geometry: sq },
        { type: 'way', id: 7, tags: { industrial: 'port' }, geometry: sq },
        { type: 'way', id: 8, tags: { power: 'line' }, geometry: [pt(0, 0), pt(0, 0.003)] },
        { type: 'node', id: 9, lat: LAT, lon: LON, tags: { natural: 'tree' } },
        { type: 'node', id: 10, lat: LAT + 2, lon: LON, tags: { natural: 'tree' } },
      ],
    };
    const v = parseOverpass(json as never, frame, DEFAULT_SETTINGS);
    expect(v.waterPolygons.map((w) => w.kind)).toEqual(['lake', 'river']);
    expect(v.waterways).toHaveLength(2);
    expect(v.waterways[0]).toMatchObject({ kind: 'river', widthM: 12.5, name: 'Fyris' });
    expect(v.waterways[1].widthM).toBeUndefined();
    expect(v.areas.map((a) => a.kind)).toEqual(['forest', 'farmland', 'harbour']);
    expect(v.areas[0].leafType).toBe('needleleaved');
    expect(v.powerLines).toHaveLength(1);
    expect(v.treePoints).toHaveLength(1);
  });
});

describe('joinRings', () => {
  it('joins segments in any direction and drops unclosable ones', () => {
    const a = { lat: 0, lon: 0 }, b = { lat: 0, lon: 1 }, c = { lat: 1, lon: 1 }, d = { lat: 1, lon: 0 };
    const rings = joinRings([[a, b], [c, b], [c, d, a], [{ lat: 5, lon: 5 }, { lat: 6, lon: 6 }]]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(5);
  });
});

describe('loadVectors', () => {
  const body = new TextEncoder().encode(JSON.stringify({
    elements: [{ type: 'way', id: 7, tags: { railway: 'rail' }, geometry: [pt(0, 0), pt(0, 0.001)] }],
  }));

  it('POSTs data=<query> and parses', async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetch: FetchBytes = async (url, opts) => {
      calls.push({ url, body: opts?.body });
      return body;
    };
    const v = await loadVectors(frame, DEFAULT_SETTINGS, fetch);
    expect(v.ways).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OVERPASS_URL);
    expect(calls[0].body!.startsWith('data=')).toBe(true);
    expect(decodeURIComponent(calls[0].body!.slice(5))).toContain('out geom;');
  });

  it('retries once on the mirror', async () => {
    const urls: string[] = [];
    const fetch: FetchBytes = async (url) => {
      urls.push(url);
      if (url === OVERPASS_URL) throw new Error('HTTP 429');
      return body;
    };
    const v = await loadVectors(frame, DEFAULT_SETTINGS, fetch);
    expect(v.ways).toHaveLength(1);
    expect(urls).toEqual([OVERPASS_URL, OVERPASS_MIRROR]);
  });

  it('throws when both endpoints fail', async () => {
    const fetch: FetchBytes = async () => new TextEncoder().encode('<html>busy</html>');
    await expect(loadVectors(frame, DEFAULT_SETTINGS, fetch)).rejects.toThrow(/both endpoints/);
  });
});
