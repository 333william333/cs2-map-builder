import { PbfWriter } from 'pbf';
import { describe, expect, it } from 'vitest';
import { createFrame } from '../geo/frame';
import { DEFAULT_SELECTION, DEFAULT_SETTINGS, type BuildSettings, type FetchBytes, type Selection } from '../types';
import {
  buildVectorsFromTiles,
  chooseZoom,
  loadVectorsFromTiles,
  MAX_TILES,
  TILEJSON_URL,
  tileRange,
  type RawTile,
} from './vectortiles';

// ---------------------------------------------------------------- tiny MVT encoder

type Props = Record<string, string | number>;
interface TFeature {
  type: 2 | 3;
  props: Props;
  /** lines or rings in tile pixels (rings are closed implicitly) */
  geom: [number, number][][];
}
interface TLayer {
  name: string;
  features: TFeature[];
  extent?: number;
}

const zz = (n: number) => (n << 1) ^ (n >> 31);

function encodeGeometry(f: TFeature): number[] {
  const out: number[] = [];
  let cx = 0, cy = 0;
  for (const part of f.geom) {
    out.push((1 << 3) | 1, zz(part[0][0] - cx), zz(part[0][1] - cy));
    cx = part[0][0];
    cy = part[0][1];
    out.push(((part.length - 1) << 3) | 2);
    for (let i = 1; i < part.length; i++) {
      out.push(zz(part[i][0] - cx), zz(part[i][1] - cy));
      cx = part[i][0];
      cy = part[i][1];
    }
    if (f.type === 3) out.push((1 << 3) | 7);
  }
  return out;
}

function encodeTile(layers: TLayer[]): Uint8Array {
  const pbf = new PbfWriter();
  for (const layer of layers) {
    pbf.writeMessage(
      3,
      (l: TLayer, p: PbfWriter) => {
        p.writeVarintField(15, 2);
        p.writeStringField(1, l.name);
        const keys: string[] = [];
        const values: (string | number)[] = [];
        for (const f of l.features) {
          const tags: number[] = [];
          for (const [k, v] of Object.entries(f.props)) {
            let ki = keys.indexOf(k);
            if (ki < 0) ki = keys.push(k) - 1;
            let vi = values.indexOf(v);
            if (vi < 0) vi = values.push(v) - 1;
            tags.push(ki, vi);
          }
          p.writeMessage(
            2,
            (ff: TFeature, pp: PbfWriter) => {
              pp.writePackedVarint(2, tags);
              pp.writeVarintField(3, ff.type);
              pp.writePackedVarint(4, encodeGeometry(ff));
            },
            f,
          );
        }
        for (const k of keys) p.writeStringField(3, k);
        for (const v of values) {
          p.writeMessage(
            4,
            (vv: string | number, pp: PbfWriter) => {
              if (typeof vv === 'string') pp.writeStringField(1, vv);
              else pp.writeSVarintField(6, vv);
            },
            v,
          );
        }
        p.writeVarintField(5, l.extent ?? 4096);
      },
      layer,
    );
  }
  return pbf.finish();
}

const line = (props: Props, ...pts: [number, number][]): TFeature => ({ type: 2, props, geom: [pts] });
const rect = (props: Props, x0: number, y0: number, x1: number, y1: number): TFeature => ({
  type: 3,
  props,
  geom: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]],
});

// ---------------------------------------------------------------- helpers

const Z = 14;
const frame = createFrame(DEFAULT_SELECTION);

function centerTile(sel: Selection, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const s = Math.sin((sel.centerLat * Math.PI) / 180);
  return {
    x: Math.floor(((sel.centerLon + 180) / 360) * n),
    y: Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n),
  };
}
const c0 = centerTile(DEFAULT_SELECTION, Z);
const tile = (dx: number, dy: number, layers: TLayer[]): RawTile => ({
  x: c0.x + dx,
  y: c0.y + dy,
  bytes: encodeTile(layers),
});

function settings(patch: Partial<BuildSettings['roads']> = {}): BuildSettings {
  return {
    ...DEFAULT_SETTINGS,
    roads: {
      ...DEFAULT_SETTINGS.roads,
      ...patch,
      classes: { ...DEFAULT_SETTINGS.roads.classes, service: true, pedestrian: true, tram: true, subway: true },
    },
  };
}

// ---------------------------------------------------------------- tests

describe('class mapping', () => {
  it('maps classes, ramp, brunnel, layer and skips unwanted features', () => {
    const t = tile(0, 0, [
      {
        name: 'transportation',
        features: [
          line({ class: 'motorway' }, [100, 100], [900, 100]),
          line({ class: 'primary', ramp: 1 }, [100, 200], [900, 200]),
          line({ class: 'minor', brunnel: 'bridge', layer: 1 }, [100, 300], [900, 300]),
          line({ class: 'minor', brunnel: 'tunnel', layer: -1 }, [100, 400], [900, 400]),
          line({ class: 'path', subclass: 'footway' }, [100, 500], [900, 500]),
          line({ class: 'path', subclass: 'steps' }, [100, 550], [900, 550]),
          line({ class: 'transit', subclass: 'subway' }, [100, 600], [900, 600]),
          line({ class: 'transit', subclass: 'tram' }, [100, 700], [900, 700]),
          line({ class: 'rail', subclass: 'rail' }, [100, 800], [900, 800]),
          line({ class: 'ferry' }, [100, 900], [900, 900]),
          line({ class: 'track' }, [100, 1000], [900, 1000]),
          line({ class: 'service' }, [100, 1100], [900, 1100]),
          { type: 3, props: { class: 'path' }, geom: [[[10, 10], [60, 10], [60, 60]]] },
        ],
      },
    ]);
    const { data } = buildVectorsFromTiles([t], Z, frame, settings());
    const by = (cls: string) => data.ways.filter((w) => w.cls === cls);
    expect(by('motorway')[0].oneway).toBe(true);
    expect(by('primary')[0].link).toBe(true);
    expect(by('primary')[0].oneway).toBe(false);
    const res = data.ways.filter((w) => w.cls === 'residential');
    expect(res.find((w) => w.bridge)?.layer).toBe(1);
    expect(res.find((w) => w.tunnel)?.layer).toBe(-1);
    expect(by('pedestrian')).toHaveLength(1);
    expect(by('subway')).toHaveLength(1);
    expect(by('tram')).toHaveLength(1);
    expect(by('rail')).toHaveLength(1);
    expect(by('service')).toHaveLength(1);
    expect(data.ways).toHaveLength(9);
    expect(data.ways.every((w) => w.lanes === undefined && w.id > 0)).toBe(true);
    expect(new Set(data.ways.map((w) => w.id)).size).toBe(data.ways.length);
    expect(data.treePoints).toEqual([]);
    expect(data.powerLines).toEqual([]);
  });

  it('reverses oneway=-1 and keeps oneway=1', () => {
    const mk = (ow: number) =>
      buildVectorsFromTiles(
        [tile(0, 0, [{ name: 'transportation', features: [line({ class: 'minor', oneway: ow }, [500, 500], [1500, 500])] }])],
        Z, frame, settings(),
      ).data.ways[0];
    const fwd = mk(1);
    const rev = mk(-1);
    expect(fwd.oneway).toBe(true);
    expect(rev.oneway).toBe(true);
    // same geometry, opposite order
    expect(rev.pts[0][0]).toBeCloseTo(fwd.pts[fwd.pts.length - 1][0], 6);
    expect(rev.pts[rev.pts.length - 1][0]).toBeCloseTo(fwd.pts[0][0], 6);
    expect(fwd.pts[0][0]).toBeLessThan(fwd.pts[1][0]);
  });

  it('maps water polygons, waterways and land cover / land use', () => {
    const t = tile(0, 0, [
      {
        name: 'water',
        features: [
          rect({ class: 'lake' }, 100, 100, 600, 600),
          rect({ class: 'river' }, 700, 100, 900, 600),
          rect({ class: 'ocean' }, 1000, 100, 1500, 600),
        ],
      },
      {
        name: 'waterway',
        features: [
          line({ class: 'river', name: 'Fyrisån' }, [100, 2000], [3000, 2000]),
          line({ class: 'stream' }, [100, 2100], [3000, 2100]),
          line({ class: 'ditch' }, [100, 2200], [3000, 2200]),
        ],
      },
      {
        name: 'landcover',
        features: [
          rect({ class: 'wood', subclass: 'wood' }, 100, 3000, 500, 3500),
          rect({ class: 'farmland', subclass: 'farmland' }, 600, 3000, 900, 3500),
          rect({ class: 'grass', subclass: 'meadow' }, 1000, 3000, 1300, 3500),
          rect({ class: 'grass', subclass: 'grass' }, 1400, 3000, 1700, 3500),
          rect({ class: 'grass', subclass: 'park' }, 2400, 3000, 2700, 3500),
          rect({ class: 'sand', subclass: 'beach' }, 1800, 3000, 2000, 3500),
          rect({ class: 'ice', subclass: 'glacier' }, 2100, 3000, 2300, 3500),
        ],
      },
      {
        name: 'landuse',
        features: [
          rect({ class: 'residential' }, 100, 3600, 400, 3900),
          rect({ class: 'retail' }, 500, 3600, 800, 3900),
          rect({ class: 'cemetery' }, 900, 3600, 1200, 3900),
        ],
      },
      { name: 'aeroway', features: [rect({ class: 'aerodrome' }, 1300, 3600, 1700, 3900)] },
    ]);
    const { data } = buildVectorsFromTiles([t], Z, frame, settings());
    expect(data.waterPolygons.map((w) => w.kind).sort()).toEqual(['lake', 'river']);
    expect(data.waterways.map((w) => w.kind).sort()).toEqual(['river', 'stream']);
    expect(data.waterways.find((w) => w.kind === 'river')?.name).toBe('Fyrisån');
    expect(data.areas.map((a) => a.kind).sort()).toEqual(
      ['airport', 'beach', 'commercial', 'farmland', 'farmland', 'forest', 'park', 'residential'],
    );
  });
});

describe('scale based class filtering', () => {
  const feats = (): TLayer[] => [
    {
      name: 'transportation',
      features: [
        line({ class: 'motorway' }, [100, 100], [900, 100]),
        line({ class: 'tertiary' }, [100, 200], [900, 200]),
        line({ class: 'minor' }, [100, 300], [900, 300]),
        line({ class: 'service' }, [100, 400], [900, 400]),
        line({ class: 'path', subclass: 'path' }, [100, 500], [900, 500]),
        line({ class: 'rail', subclass: 'rail' }, [100, 600], [900, 600]),
      ],
    },
    {
      name: 'waterway',
      features: [line({ class: 'river' }, [100, 2000], [900, 2000]), line({ class: 'stream' }, [100, 2100], [900, 2100])],
    },
  ];
  const classesAt = (sizeMeters: number) => {
    const sel = { ...DEFAULT_SELECTION, sizeMeters };
    const f = createFrame(sel);
    const c = centerTile(sel, Z);
    const t: RawTile = { x: c.x, y: c.y, bytes: encodeTile(feats()) };
    const { data } = buildVectorsFromTiles([t], Z, f, settings());
    return { cls: [...new Set(data.ways.map((w) => w.cls))].sort(), streams: data.waterways.filter((w) => w.kind === 'stream').length };
  };

  it('keeps everything at scale 1', () => {
    expect(classesAt(14336).cls).toEqual(['motorway', 'pedestrian', 'rail', 'residential', 'service', 'tertiary']);
    expect(classesAt(14336).streams).toBe(1);
  });
  it('drops minor roads and streams below scale 0.4', () => {
    const r = classesAt(40000); // scale 0.358
    expect(r.cls).toEqual(['motorway', 'rail', 'tertiary']);
    expect(r.streams).toBe(0);
  });
  it('drops tertiary below scale 0.2', () => {
    expect(classesAt(100000).cls).toEqual(['motorway', 'rail']);
  });
  it('honours disabled classes', () => {
    const s = settings();
    s.roads.classes.rail = false;
    const { data } = buildVectorsFromTiles([tile(0, 0, feats())], Z, frame, s);
    expect(data.ways.some((w) => w.cls === 'rail')).toBe(false);
    const off = settings();
    off.roads.enabled = false;
    expect(buildVectorsFromTiles([tile(0, 0, feats())], Z, frame, off).data.ways).toHaveLength(0);
  });
});

describe('stitching', () => {
  it('joins a road crossing a tile border into one way with shared coordinates', () => {
    // tile A: road runs to the right, 64 px into the buffer; tile B: starts 64 px before its edge.
    // The second tile's clipped edge point differs by one pixel (rounding).
    const a = tile(0, 0, [{ name: 'transportation', features: [line({ class: 'minor' }, [3000, 2000], [4160, 2000])] }]);
    const b = tile(1, 0, [{ name: 'transportation', features: [line({ class: 'minor' }, [-64, 2001], [1000, 2001])] }]);
    const { data, info } = buildVectorsFromTiles([a, b], Z, frame, settings());
    expect(info.waysBefore.residential).toBe(2);
    expect(data.ways).toHaveLength(1);
    const pts = data.ways[0].pts;
    expect(pts).toHaveLength(3); // start, one shared border point, end
    expect(pts[0][0]).toBeLessThan(pts[1][0]);
    expect(pts[1][0]).toBeLessThan(pts[2][0]);
    expect(new Set(pts.map((p) => `${p[0]},${p[1]}`)).size).toBe(3);
  });

  it('joins pieces regardless of the order the tiles arrive in', () => {
    const a = tile(0, 0, [{ name: 'transportation', features: [line({ class: 'minor' }, [3000, 2000], [4160, 2000])] }]);
    const b = tile(1, 0, [{ name: 'transportation', features: [line({ class: 'minor' }, [-64, 2000], [1000, 2000])] }]);
    const w1 = buildVectorsFromTiles([a, b], Z, frame, settings()).data.ways;
    const w2 = buildVectorsFromTiles([b, a], Z, frame, settings()).data.ways;
    expect(w1).toHaveLength(1);
    expect(w2).toEqual(w1);
  });

  it('does not join different classes or opposite oneway directions', () => {
    const a = tile(0, 0, [
      {
        name: 'transportation',
        features: [
          line({ class: 'minor' }, [3000, 2000], [4160, 2000]),
          line({ class: 'minor', oneway: 1 }, [3000, 3000], [4160, 3000]),
        ],
      },
    ]);
    const b = tile(1, 0, [
      {
        name: 'transportation',
        features: [
          line({ class: 'tertiary' }, [-64, 2000], [1000, 2000]),
          line({ class: 'minor', oneway: -1 }, [-64, 3000], [1000, 3000]),
        ],
      },
    ]);
    const { data } = buildVectorsFromTiles([a, b], Z, frame, settings());
    expect(data.ways).toHaveLength(4);
  });

  it('joins a oneway chain end to start across three tiles', () => {
    const mk = (dx: number, x0: number, x1: number) =>
      tile(dx, 0, [{ name: 'transportation', features: [line({ class: 'primary', oneway: 1 }, [x0, 1000], [x1, 1000])] }]);
    const { data } = buildVectorsFromTiles([mk(2, -64, 4160), mk(0, 1000, 4160), mk(1, -64, 4160)], Z, frame, settings());
    expect(data.ways).toHaveLength(1);
    const p = data.ways[0].pts;
    expect(p[0][0]).toBeLessThan(p[p.length - 1][0]);
  });

  it('merges a lake that spans two tiles into one polygon', () => {
    const a = tile(0, 0, [{ name: 'water', features: [rect({ class: 'lake' }, 3000, 1000, 4160, 3000)] }]);
    const b = tile(1, 0, [{ name: 'water', features: [rect({ class: 'lake' }, -64, 1000, 1000, 3000)] }]);
    const { data, info } = buildVectorsFromTiles([a, b], Z, frame, settings());
    expect(info.polygonPiecesBefore).toBe(2);
    expect(data.waterPolygons).toHaveLength(1);
    const poly = data.waterPolygons[0];
    expect(poly.kind).toBe('lake');
    expect(poly.rings).toHaveLength(1);
    // closed ring spanning both tiles
    const r = poly.rings[0];
    expect(r[0]).toEqual(r[r.length - 1]);
    const xs = r.map((p) => p[0]);
    // 3000 -> 1000+4096 px at ~0.3 m/px in real metres, scale 1: about 2096 px wide
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(400);
  });

  it('keeps separate lakes separate', () => {
    const a = tile(0, 0, [{ name: 'water', features: [rect({ class: 'lake' }, 3000, 1000, 4160, 3000)] }]);
    const b = tile(1, 0, [{ name: 'water', features: [rect({ class: 'lake' }, 1500, 1000, 2500, 3000)] }]);
    expect(buildVectorsFromTiles([a, b], Z, frame, settings()).data.waterPolygons).toHaveLength(2);
  });

  it('joins a river waterway across tiles', () => {
    const a = tile(0, 0, [{ name: 'waterway', features: [line({ class: 'river', name: 'Å' }, [3000, 500], [4160, 500])] }]);
    const b = tile(1, 0, [{ name: 'waterway', features: [line({ class: 'river', name: 'Å' }, [-64, 500], [900, 500])] }]);
    const { data } = buildVectorsFromTiles([a, b], Z, frame, settings());
    expect(data.waterways).toHaveLength(1);
    expect(data.waterways[0].pts).toHaveLength(3);
  });
});

describe('names', () => {
  const roadTile = (nameFeatures: TFeature[]) =>
    tile(0, 0, [
      {
        name: 'transportation',
        features: [
          line({ class: 'minor' }, [500, 500], [1500, 500], [2500, 900]),
          line({ class: 'minor' }, [500, 2500], [2500, 2500]),
        ],
      },
      { name: 'transportation_name', features: nameFeatures },
    ]);

  it('attaches the name of a same-class feature that runs along the way', () => {
    const t = roadTile([
      line({ class: 'minor', name: 'Drottninggatan' }, [500, 501], [1500, 499], [2500, 900]),
      line({ class: 'tertiary', name: 'Wrong class' }, [500, 2500], [2500, 2500]),
    ]);
    const { data, info } = buildVectorsFromTiles([t], Z, frame, settings());
    const first = data.ways.find((w) => w.pts[0][1] > data.ways.find((o) => o !== w)!.pts[0][1])!; // upper pixel row = larger gz
    const named = data.ways.filter((w) => w.name);
    expect(named).toHaveLength(1);
    expect(named[0].name).toBe('Drottninggatan');
    expect(first).toBeDefined();
    expect(info.namedWays).toBe(1);
  });

  it('does not attach a name from a parallel road far away', () => {
    const t = roadTile([line({ class: 'minor', name: 'Other road' }, [500, 1500], [2500, 1500])]);
    expect(buildVectorsFromTiles([t], Z, frame, settings()).data.ways.every((w) => w.name === undefined)).toBe(true);
  });

  it('omits names when settings.roads.names is false', () => {
    const t = roadTile([line({ class: 'minor', name: 'Drottninggatan' }, [500, 500], [1500, 500], [2500, 900])]);
    const { data } = buildVectorsFromTiles([t], Z, frame, settings({ names: false }));
    expect(data.ways.every((w) => w.name === undefined)).toBe(true);
  });

  it('names a stitched way that spans tiles', () => {
    const a = tile(0, 0, [
      { name: 'transportation', features: [line({ class: 'minor' }, [500, 2000], [4160, 2000])] },
      { name: 'transportation_name', features: [line({ class: 'minor', name: 'Långgatan' }, [500, 2000], [4160, 2000])] },
    ]);
    const b = tile(1, 0, [{ name: 'transportation', features: [line({ class: 'minor' }, [-64, 2000], [3000, 2000])] }]);
    const { data } = buildVectorsFromTiles([a, b], Z, frame, settings());
    expect(data.ways).toHaveLength(1);
    expect(data.ways[0].name).toBe('Långgatan');
  });
});

describe('zoom choice and loading', () => {
  it('uses zoom 14 for the default selection', () => {
    const r = chooseZoom(frame.bbox(14336 * 1.05));
    expect(r.zoom).toBe(14);
    expect(r.count).toBeLessThanOrEqual(MAX_TILES);
    expect(r.count).toBeGreaterThan(100);
  });

  it('lowers the zoom for large areas to keep the tile count under the cap', () => {
    const big = createFrame({ ...DEFAULT_SELECTION, sizeMeters: 57000 });
    const r = chooseZoom(big.bbox(14336 * 1.05));
    expect(r.zoom).toBeLessThan(14);
    expect(r.count).toBeLessThanOrEqual(MAX_TILES);
    const next = tileRange(big.bbox(14336 * 1.05), r.zoom + 1);
    expect(next.count).toBeGreaterThan(MAX_TILES);
  });

  function fakeFetch(opts: { fail?: (x: number, y: number) => boolean; log?: string[]; maxzoom?: number } = {}): FetchBytes {
    return async (url) => {
      if (url === TILEJSON_URL) {
        return new TextEncoder().encode(
          JSON.stringify({ tiles: ['https://tiles.example.org/planet/v1/{z}/{x}/{y}.pbf'], maxzoom: opts.maxzoom ?? 14 }),
        );
      }
      const m = /v1\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url);
      if (!m) throw new Error(`unexpected url ${url}`);
      opts.log?.push(url);
      if (opts.fail?.(+m[2], +m[3])) throw new Error('HTTP 500');
      return new Uint8Array(0);
    };
  }

  it('fetches the tilejson template and every tile once, at the chosen zoom', async () => {
    const log: string[] = [];
    const progress: number[] = [];
    const data = await loadVectorsFromTiles(frame, DEFAULT_SETTINGS, fakeFetch({ log }), (_s, f) => progress.push(f));
    const expected = chooseZoom(frame.bbox(14336 * 1.05));
    expect(log).toHaveLength(expected.count);
    expect(new Set(log).size).toBe(expected.count);
    expect(log.every((u) => u.includes('/14/'))).toBe(true);
    expect(data.ways).toEqual([]);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('uses a lower zoom for a large area and respects the tilejson maxzoom', async () => {
    const big = createFrame({ ...DEFAULT_SELECTION, sizeMeters: 57000 });
    const log: string[] = [];
    await loadVectorsFromTiles(big, DEFAULT_SETTINGS, fakeFetch({ log }));
    expect(log.length).toBeLessThanOrEqual(MAX_TILES);
    expect(log.length).toBeGreaterThan(0);
    const log2: string[] = [];
    await loadVectorsFromTiles(frame, DEFAULT_SETTINGS, fakeFetch({ log: log2, maxzoom: 12 }));
    expect(log2.every((u) => u.includes('/12/'))).toBe(true);
  });

  it('tolerates a few failed tiles but fails when more than a quarter fail', async () => {
    const r = chooseZoom(frame.bbox(14336 * 1.05));
    await expect(loadVectorsFromTiles(frame, DEFAULT_SETTINGS, fakeFetch({ fail: (x, y) => x === r.x0 && y === r.y0 }))).resolves.toBeDefined();
    await expect(
      loadVectorsFromTiles(frame, DEFAULT_SETTINGS, fakeFetch({ fail: (x) => x < r.x0 + (r.x1 - r.x0) / 2 })),
    ).rejects.toThrow(/tiles failed/);
  });

  it('decodes gzip-compressed tiles', async () => {
    const { gzipSync } = await import('fflate');
    const raw = encodeTile([{ name: 'transportation', features: [line({ class: 'primary' }, [100, 100], [900, 100])] }]);
    const t: RawTile = { x: c0.x, y: c0.y, bytes: gzipSync(raw) };
    expect(buildVectorsFromTiles([t], Z, frame, settings()).data.ways).toHaveLength(1);
  });
});
