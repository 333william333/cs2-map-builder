import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  AttributionControl,
  Map as MlMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type MapMouseEvent,
  type MapTouchEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { createFrame } from '../../core/geo/frame';
import { CS2, type Selection } from '../../core/types';
import { useStore } from '../store';
import {
  clampSize,
  distanceM,
  formatKm,
  formatScale,
  placeSizeFromWidth,
  pointInPolygon,
  ringGeo,
  rotationFromPointer,
  sizeFromCornerDistance,
} from './geometry';
import { fitSelection, getMap, registerMap } from './mapBus';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const SAT_TILES = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg';
const ACCENT = '#4fd1b5';
const BG = '#0e1317';
const HANDLE_HIT_PX = 13;
const ROTATE_OFFSET_PX = 34;

const SHAPE_SRC = 'cs2-shape';
const HANDLE_SRC = 'cs2-handles';
const SAT_SRC = 'cs2-sat';

type Base = 'map' | 'sat';
type EvtPt = MapMouseEvent | MapTouchEvent;
type Hit =
  | { kind: 'rotate' }
  | { kind: 'corner'; index: number }
  | { kind: 'inside' };

interface Drag {
  hit: Hit;
  startPt: { x: number; y: number };
  startCenterPx: { x: number; y: number };
  startSel: Selection;
  live: Selection;
}

type LL = [number, number]; // [lon, lat]

/** Geo positions of the handles. The rotation handle sits a fixed pixel distance above the top edge. */
function handleGeo(map: MlMap, sel: Selection): { corners: LL[]; topMid: LL; rot: LL } {
  const frame = createFrame(sel);
  const corners = frame.corners(CS2.PLAYABLE_SIZE_M).map(([lat, lon]) => [lon, lat] as LL);
  const [tmLat, tmLon] = frame.gameToGeo(0, CS2.PLAYABLE_SIZE_M / 2);
  const topMid: LL = [tmLon, tmLat];
  const c = map.project([sel.centerLon, sel.centerLat]);
  const t = map.project(topMid);
  let dx = t.x - c.x;
  let dy = t.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    dx = 0;
    dy = -1;
  } else {
    dx /= len;
    dy /= len;
  }
  const r = map.unproject([t.x + dx * ROTATE_OFFSET_PX, t.y + dy * ROTATE_OFFSET_PX]);
  return { corners, topMid, rot: [r.lng, r.lat] };
}

function shapeData(sel: Selection): FeatureCollection {
  const features: Feature<Geometry>[] = [
    {
      type: 'Feature',
      properties: { kind: 'world', label: 'Surroundings (not playable)' },
      geometry: { type: 'LineString', coordinates: ringGeo(sel, CS2.WORLD_SIZE_M, 32) },
    },
    {
      type: 'Feature',
      properties: { kind: 'sel' },
      geometry: { type: 'Polygon', coordinates: [ringGeo(sel, CS2.PLAYABLE_SIZE_M, 16)] },
    },
  ];
  return { type: 'FeatureCollection', features };
}

function handleData(map: MlMap, sel: Selection): FeatureCollection {
  const h = handleGeo(map, sel);
  const features: Feature<Geometry>[] = [
    {
      type: 'Feature',
      properties: { kind: 'stem' },
      geometry: { type: 'LineString', coordinates: [h.topMid, h.rot] },
    },
    ...h.corners.map(
      (p): Feature<Geometry> => ({
        type: 'Feature',
        properties: { kind: 'corner' },
        geometry: { type: 'Point', coordinates: p },
      }),
    ),
    {
      type: 'Feature',
      properties: { kind: 'rotate' },
      geometry: { type: 'Point', coordinates: h.rot },
    },
  ];
  return { type: 'FeatureCollection', features };
}

function hitTest(map: MlMap, sel: Selection, pt: { x: number; y: number }): Hit | null {
  const h = handleGeo(map, sel);
  const near = (p: LL) => {
    const s = map.project(p);
    return Math.hypot(s.x - pt.x, s.y - pt.y) <= HANDLE_HIT_PX;
  };
  if (near(h.rot)) return { kind: 'rotate' };
  for (let i = 0; i < h.corners.length; i++) {
    if (near(h.corners[i]!)) return { kind: 'corner', index: i };
  }
  const poly = ringGeo(sel, CS2.PLAYABLE_SIZE_M, 8).map((p) => {
    const s = map.project(p);
    return [s.x, s.y] as [number, number];
  });
  if (pointInPolygon(pt.x, pt.y, poly)) return { kind: 'inside' };
  return null;
}

function cursorFor(hit: Hit | null): string {
  if (!hit) return '';
  if (hit.kind === 'rotate') return 'grab';
  if (hit.kind === 'corner') return hit.index % 2 === 0 ? 'nwse-resize' : 'nesw-resize';
  return 'move';
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [base, setBase] = useState<Base>('map');
  const [readoutOpen, setReadoutOpen] = useState(true);
  const baseRef = useRef<Base>('map');
  const selection = useStore((s) => s.selection);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initial = useStore.getState().selection;
    const map = new MlMap({
      container,
      style: STYLE_URL,
      center: [initial.centerLon, initial.centerLat],
      zoom: 10,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 0,
      doubleClickZoom: true,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.addControl(new AttributionControl({ compact: false }), 'bottom-right');
    registerMap(map);
    fitSelection(initial, false);

    let disposed = false;
    let drag: Drag | null = null;
    let raf = 0;

    const setSource = (id: string, data: FeatureCollection) => {
      const src = map.getSource(id) as GeoJSONSource | undefined;
      if (src) src.setData(data);
    };
    const renderShape = (sel: Selection) => setSource(SHAPE_SRC, shapeData(sel));
    const renderHandles = (sel: Selection) => setSource(HANDLE_SRC, handleData(map, sel));
    const currentSel = () => (drag ? drag.live : useStore.getState().selection);

    const applyBase = () => {
      if (!map.getLayer(SAT_SRC)) return;
      map.setLayoutProperty(SAT_SRC, 'visibility', baseRef.current === 'sat' ? 'visible' : 'none');
    };

    const setup = () => {
      if (disposed || map.getSource(SHAPE_SRC)) return;
      const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
      map.addSource(SAT_SRC, {
        type: 'raster',
        tiles: [SAT_TILES],
        tileSize: 256,
        maxzoom: 13,
        attribution:
          '<a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless</a> by EOX (modified Copernicus Sentinel data 2020)',
      });
      map.addLayer(
        { id: SAT_SRC, type: 'raster', source: SAT_SRC, layout: { visibility: 'none' } },
        firstSymbol,
      );
      const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
      map.addSource(SHAPE_SRC, { type: 'geojson', data: empty });
      map.addSource(HANDLE_SRC, { type: 'geojson', data: empty });
      map.addLayer({
        id: 'cs2-world-line',
        type: 'line',
        source: SHAPE_SRC,
        filter: ['==', ['get', 'kind'], 'world'],
        paint: { 'line-color': ACCENT, 'line-width': 1.2, 'line-dasharray': [3, 3], 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'cs2-world-label',
        type: 'symbol',
        source: SHAPE_SRC,
        filter: ['==', ['get', 'kind'], 'world'],
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 700,
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-letter-spacing': 0.05,
        },
        paint: { 'text-color': ACCENT, 'text-halo-color': BG, 'text-halo-width': 1.6 },
      });
      map.addLayer({
        id: 'cs2-sel-fill',
        type: 'fill',
        source: SHAPE_SRC,
        filter: ['==', ['get', 'kind'], 'sel'],
        paint: { 'fill-color': ACCENT, 'fill-opacity': 0.14 },
      });
      map.addLayer({
        id: 'cs2-sel-line',
        type: 'line',
        source: SHAPE_SRC,
        filter: ['==', ['get', 'kind'], 'sel'],
        paint: { 'line-color': ACCENT, 'line-width': 2.5 },
      });
      map.addLayer({
        id: 'cs2-stem',
        type: 'line',
        source: HANDLE_SRC,
        filter: ['==', ['get', 'kind'], 'stem'],
        paint: { 'line-color': ACCENT, 'line-width': 1.5 },
      });
      map.addLayer({
        id: 'cs2-handles',
        type: 'circle',
        source: HANDLE_SRC,
        filter: ['!=', ['get', 'kind'], 'stem'],
        paint: {
          'circle-radius': ['match', ['get', 'kind'], 'rotate', 7, 6],
          'circle-color': ['match', ['get', 'kind'], 'rotate', ACCENT, '#ffffff'],
          'circle-stroke-color': ACCENT,
          'circle-stroke-width': 2,
        },
      });
      applyBase();
      const sel = currentSel();
      renderShape(sel);
      renderHandles(sel);
    };
    map.on('style.load', setup);
    if (map.isStyleLoaded()) setup();

    // ---- direct manipulation ----
    const commit = () => {
      raf = 0;
      if (!drag) return;
      const { live, startSel } = drag;
      const patch: Partial<Selection> = {};
      (Object.keys(live) as (keyof Selection)[]).forEach((k) => {
        if (live[k] !== startSel[k]) patch[k] = live[k];
      });
      useStore.getState().setSelection(patch);
    };
    const endDrag = () => {
      if (!drag) return;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      commit();
      drag = null;
      map.getCanvas().style.cursor = '';
    };

    const onDown = (e: EvtPt) => {
      if ('touches' in e.originalEvent && e.originalEvent.touches.length > 1) return;
      if (e.type === 'mousedown' && (e.originalEvent as MouseEvent).button !== 0) return;
      const sel = useStore.getState().selection;
      const hit = hitTest(map, sel, e.point);
      if (!hit) return;
      e.preventDefault(); // stops map panning for this gesture
      const c = map.project([sel.centerLon, sel.centerLat]);
      drag = {
        hit,
        startPt: { x: e.point.x, y: e.point.y },
        startCenterPx: { x: c.x, y: c.y },
        startSel: sel,
        live: sel,
      };
      map.getCanvas().style.cursor = hit.kind === 'inside' ? 'grabbing' : cursorFor(hit);
    };

    const onMove = (e: EvtPt) => {
      if (!drag) {
        if (e.type === 'mousemove') {
          map.getCanvas().style.cursor = cursorFor(hitTest(map, useStore.getState().selection, e.point));
        }
        return;
      }
      const d = drag;
      const s = d.startSel;
      let live: Selection = s;
      if (d.hit.kind === 'inside') {
        const px = d.startCenterPx.x + (e.point.x - d.startPt.x);
        const py = d.startCenterPx.y + (e.point.y - d.startPt.y);
        const ll = map.unproject([px, py]);
        live = { ...s, centerLat: Math.max(-85, Math.min(85, ll.lat)), centerLon: ll.lng };
      } else if (d.hit.kind === 'corner') {
        const dist = distanceM(s.centerLat, s.centerLon, e.lngLat.lat, e.lngLat.lng);
        live = { ...s, sizeMeters: sizeFromCornerDistance(dist) };
      } else {
        live = { ...s, rotationDeg: rotationFromPointer(s, e.lngLat.lat, e.lngLat.lng) };
      }
      d.live = live;
      renderShape(live);
      renderHandles(live);
      if (!raf) raf = requestAnimationFrame(commit);
    };

    const onDbl = (e: MapMouseEvent) => {
      const sel = useStore.getState().selection;
      const hit = hitTest(map, sel, e.point);
      if (hit?.kind === 'rotate') {
        e.preventDefault(); // no zoom
        drag = null;
        useStore.getState().setSelection({ rotationDeg: 0 });
      }
    };

    map.on('mousedown', onDown);
    map.on('touchstart', onDown);
    map.on('mousemove', onMove);
    map.on('touchmove', onMove);
    map.on('mouseup', endDrag);
    map.on('touchend', endDrag);
    map.on('touchcancel', endDrag);
    map.on('dblclick', onDbl);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);

    // keep rotation handle at a constant pixel offset while zooming / resizing
    const onView = () => renderHandles(currentSel());
    map.on('zoom', onView);
    map.on('resize', onView);

    const unsub = useStore.subscribe((s, prev) => {
      if (drag || s.selection === prev.selection) return;
      renderShape(s.selection);
      renderHandles(s.selection);
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container);

    return () => {
      disposed = true;
      unsub();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('blur', endDrag);
      registerMap(null);
      map.remove();
    };
  }, []);

  // basemap switch
  useEffect(() => {
    baseRef.current = base;
    const map = getMap();
    if (map && map.getLayer(SAT_SRC)) {
      map.setLayoutProperty(SAT_SRC, 'visibility', base === 'sat' ? 'visible' : 'none');
    }
  }, [base]);

  const setSelection = useStore((s) => s.setSelection);

  const placeHere = () => {
    const map = getMap();
    if (!map) return;
    const c = map.getCenter();
    const { width, height } = map.getCanvas().getBoundingClientRect();
    const l = map.unproject([0, height / 2]);
    const r = map.unproject([width, height / 2]);
    const widthM = distanceM(l.lat, l.lng, r.lat, r.lng);
    setSelection({ centerLat: c.lat, centerLon: c.lng, sizeMeters: placeSizeFromWidth(widthM) });
  };

  const btn =
    'rounded-control bg-surface-2 px-2.5 py-1.5 text-xs text-text hover:bg-line focus:outline-none focus-visible:ring-1 focus-visible:ring-accent';

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[calc(100%-70px)] flex-col gap-2">
        <div
          role="group"
          aria-label="Map layers"
          className="pointer-events-auto inline-flex w-fit overflow-hidden rounded-control border border-line bg-surface/90 text-xs backdrop-blur"
        >
          {(['map', 'sat'] as const).map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={base === b}
              onClick={() => setBase(b)}
              className={`px-3 py-1.5 ${base === b ? 'bg-accent text-bg' : 'text-text hover:bg-surface-2'}`}
            >
              {b === 'map' ? 'Map' : 'Satellite'}
            </button>
          ))}
        </div>
      </div>

      <div className="pointer-events-auto absolute bottom-14 left-3 w-[212px] max-w-[calc(100%-24px)] rounded-panel border border-line bg-surface/90 p-2 text-xs backdrop-blur">
        <button
          type="button"
          aria-expanded={readoutOpen}
          aria-controls="map-readout"
          onClick={() => setReadoutOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-control px-1 py-0.5 text-left font-medium hover:bg-surface-2 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <span>
            {formatKm(selection.sizeMeters)} km · {formatScale(selection.sizeMeters)}
          </span>
          {readoutOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}
          <span className="sr-only">{readoutOpen ? 'Hide map values' : 'Show map values'}</span>
        </button>
        <div id="map-readout" hidden={!readoutOpen} className="px-1 pt-1.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-muted">Side</dt>
            <dd className="text-right tabular-nums">{formatKm(selection.sizeMeters)} km</dd>
            <dt className="text-muted">Scale</dt>
            <dd className="text-right tabular-nums">{formatScale(selection.sizeMeters)}</dd>
            <dt className="text-muted">Rotation</dt>
            <dd className="text-right tabular-nums">{Math.round(selection.rotationDeg * 10) / 10}°</dd>
            <dt className="text-muted">Center</dt>
            <dd className="text-right tabular-nums">
              {selection.centerLat.toFixed(4)}, {selection.centerLon.toFixed(4)}
            </dd>
          </dl>
          <div className="mt-2 flex flex-wrap gap-1">
            <button type="button" className={btn} onClick={() => setSelection({ sizeMeters: clampSize(CS2.PLAYABLE_SIZE_M) })}>
              1:1 (14.3 km)
            </button>
            <button type="button" className={btn} onClick={placeHere}>
              Place here
            </button>
            <button type="button" className={btn} onClick={() => setSelection({ rotationDeg: 0 })}>
              Reset rotation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
