import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Crosshair, Hand, Mountain } from 'lucide-react';
import { useStore, type AppState } from '../store';
import { CONNECTION_UI } from './connectionUi';
import { devFileName, devOpenGame, loadDevFile } from './devCache';
import { GameView } from './GameView';
import { PreviewEngine, type ExtraLayers, type ViewInfo } from './PreviewEngine';
import { formatDistance, niceScaleBar } from './scaleBar';

type LayerKey = keyof AppState['layers'];

const LAYER_BUTTONS: { key: LayerKey; label: string }[] = [
  { key: 'water', label: 'Water' },
  { key: 'roads', label: 'Roads' },
  { key: 'trees', label: 'Trees' },
  { key: 'grid', label: 'Tile grid' },
  { key: 'world', label: 'Surroundings' },
  { key: 'startTile', label: 'Start tile' },
];

export function Preview3D() {
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const markerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [engine, setEngine] = useState<PreviewEngine | null>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [extra, setExtra] = useState<ExtraLayers>({ zones: false, houses: false, landcover: false, names: false });
  const [view, setView] = useState<ViewInfo | null>(null);
  const [renderOpen, setRenderOpen] = useState(false);

  const status = useStore((s) => s.status);
  const result = useStore((s) => s.result);
  const layers = useStore((s) => s.layers);
  const setLayer = useStore((s) => s.setLayer);
  const hasResult = result !== null;
  const zones = result?.zones;
  const zonesAvailable = !!zones && zones.cellCount > 0;
  const lotsAvailable = !!zones && zones.lotCount > 0;
  const connections = useMemo(() => result?.playability?.outsideConnections ?? [], [result]);

  // engine lifetime: one WebGL context per mount (StrictMode mounts twice, the first is disposed)
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    let eng: PreviewEngine;
    try {
      eng = new PreviewEngine(el);
    } catch (err) {
      setWebglError(err instanceof Error ? err.message : String(err));
      return;
    }
    engineRef.current = eng;
    setEngine(eng);
    if (import.meta.env.DEV) (window as unknown as { __preview?: PreviewEngine }).__preview = eng;
    const initial = useStore.getState();
    eng.setLayers(initial.layers);
    eng.setResult(initial.result);
    let lastView: ViewInfo | null = null;
    eng.onView = (v) => {
      // only re-render React when the numbers change noticeably
      if (lastView && Math.abs(v.metresPerPx / lastView.metresPerPx - 1) < 0.01 && Math.abs(v.heightAboveGround - lastView.heightAboveGround) < 1) return;
      lastView = v;
      setView(v);
    };
    eng.onContextChange = (lost) => setContextLost(lost);
    const unsub = useStore.subscribe((s, prev) => {
      if (s.layers !== prev.layers) eng.setLayers(s.layers);
      if (s.result !== prev.result) eng.setResult(s.result);
    });
    return () => {
      unsub();
      eng.dispose();
      if (engineRef.current === eng) engineRef.current = null;
      setEngine((cur) => (cur === eng ? null : cur));
    };
  }, []);

  // preview-only layers; switch them off when the new result has no zones
  useEffect(() => {
    engine?.setExtraLayers({ ...extra, zones: extra.zones && zonesAvailable, houses: extra.houses && lotsAvailable });
  }, [engine, extra, zonesAvailable, lotsAvailable]);

  // outside-connection labels follow the camera (positions are written straight to the DOM)
  useEffect(() => {
    if (!engine) return;
    const pt = { x: 0, y: 0 };
    const update = (): void => {
      const anchors = engine.connectionAnchors();
      const show = engine.connectionsVisible();
      markerRefs.current.forEach((el, i) => {
        if (!el) return;
        const a = anchors[i];
        if (!show || !a) {
          el.style.display = 'none';
          return;
        }
        const top = a.clone();
        top.y += 160;
        if (!engine.project(top, pt)) {
          el.style.display = 'none';
          return;
        }
        el.style.display = '';
        el.style.transform = `translate(${Math.round(pt.x)}px, ${Math.round(pt.y)}px) translate(-50%, -100%)`;
      });
    };
    engine.onFrame = update;
    update();
    return () => {
      if (engine.onFrame === update) engine.onFrame = null;
    };
  }, [engine, connections]);

  // development: ?devfile=<name> loads a prebuilt full result (and &game=1 opens the game view)
  useEffect(() => {
    const name = devFileName();
    if (!name || !engine) return;
    let cancelled = false;
    void loadDevFile(name).then(async (r) => {
      // let the automatic preview of the start-up selection finish first so it does not replace the file
      for (let i = 0; i < 60 && !cancelled && useStore.getState().status.phase === 'building'; i++) {
        await new Promise((ok) => setTimeout(ok, 500));
      }
      if (cancelled || !r) return;
      useStore.setState({ result: r, status: { phase: 'done', fraction: 1 } });
      if (devOpenGame()) {
        engine.suspend();
        setRenderOpen(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [engine]);

  // ?demo=1 loads the synthetic map
  useEffect(() => {
    let cancelled = false;
    let demo = false;
    try {
      demo = new URLSearchParams(window.location.search).get('demo') === '1';
    } catch {
      demo = false;
    }
    if (!demo || useStore.getState().result) return;
    void import('./demoResult').then(({ makeDemoResult }) => {
      if (cancelled || useStore.getState().result) return;
      useStore.setState({ result: makeDemoResult(), status: { phase: 'done', fraction: 1 } });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const building = status.phase === 'building';
  const pct = Math.round(Math.min(1, Math.max(0, status.fraction)) * 100);
  const bar = view ? niceScaleBar(view.metresPerPx, 110) : null;
  const zonesNote = !hasResult
    ? 'Build a map first.'
    : 'This result has no zoning grid. Rebuild the map to see it.';

  const toggleBtn = (on: boolean, disabled: boolean): string =>
    'rounded-control px-2 py-1 text-xs transition-colors ' +
    (disabled
      ? 'cursor-not-allowed text-muted/40'
      : on
        ? 'bg-surface-2 text-accent'
        : 'text-muted hover:bg-surface-2 hover:text-text');

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      <div ref={mountRef} className="absolute inset-0" />

      {/* outside connection labels */}
      {hasResult && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {connections.map((c, i) => {
            const ui = CONNECTION_UI[c.kind];
            const Icon = ui.icon;
            const color = c.manual ? '#4fd1b5' : c.synthetic ? '#e5b454' : ui.color;
            return (
              <div
                key={`${c.kind}-${i}-${c.p[0]}-${c.p[1]}`}
                ref={(el) => { markerRefs.current[i] = el; }}
                className="absolute left-0 top-0 flex items-center gap-1 whitespace-nowrap rounded-full bg-surface/85 px-1.5 py-0.5 text-[10px] text-text shadow"
                style={{ display: 'none', border: `1px ${c.synthetic ? 'dashed' : 'solid'} ${color}` }}
                title={
                  c.manual
                    ? `${ui.label}: added by hand`
                    : c.synthetic
                      ? `${ui.label}: created automatically (no real connection existed)`
                      : `${ui.label}: connection to the outside world`
                }
              >
                <Icon size={11} style={{ color }} />
                {ui.label}
                {c.manual && <Hand size={10} className="text-accent" />}
                {c.synthetic && <span className="text-warn">auto</span>}
              </div>
            );
          })}
        </div>
      )}

      {webglError && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg p-6 text-center text-sm text-danger">
          The 3D preview could not start (WebGL is missing or disabled).
        </div>
      )}
      {contextLost && !webglError && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/80 p-6 text-center text-sm text-warn">
          The graphics card lost the 3D view. It will be restored automatically when graphics are available again.
        </div>
      )}

      {!hasResult && !webglError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-xs rounded-panel border border-line bg-surface/80 px-5 py-4 text-center backdrop-blur">
            <Mountain className="mx-auto mb-2 text-accent" size={26} strokeWidth={1.6} />
            <div className="text-sm font-medium text-text">Your map appears here in 3D</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Select an area on the world map and click &quot;Quick preview&quot; to see terrain, water,
              roads and trees here, just as they will look in Cities: Skylines II.
            </p>
          </div>
        </div>
      )}

      {/* layer toggles */}
      <div className="absolute left-3 right-40 top-3 flex flex-col items-start gap-1.5">
        <div className="flex flex-wrap gap-1 rounded-panel border border-line bg-surface/80 p-1 backdrop-blur">
          {LAYER_BUTTONS.map(({ key, label }) => {
            const on = layers[key];
            return (
              <button key={key} type="button" aria-pressed={on} onClick={() => setLayer(key, !on)} className={toggleBtn(on, false)}>
                {label}
              </button>
            );
          })}
          <span className="mx-0.5 w-px self-stretch bg-line" />
          <button
            type="button"
            aria-pressed={extra.zones && zonesAvailable}
            disabled={!zonesAvailable}
            title={zonesAvailable ? "The game's zoning grid, 8 × 8 m cells along the roads" : zonesNote}
            onClick={() => setExtra((e) => ({ ...e, zones: !e.zones }))}
            className={toggleBtn(extra.zones && zonesAvailable, !zonesAvailable)}
          >
            Zoning grid
          </button>
          <button
            type="button"
            aria-pressed={extra.houses && lotsAvailable}
            disabled={!lotsAvailable}
            title={lotsAvailable ? 'Example houses that show the scale' : zonesNote}
            onClick={() => setExtra((e) => ({ ...e, houses: !e.houses }))}
            className={toggleBtn(extra.houses && lotsAvailable, !lotsAvailable)}
          >
            Example houses
          </button>
          <button
            type="button"
            aria-pressed={extra.names}
            title="Road names kept on the segments"
            onClick={() => setExtra((e) => ({ ...e, names: !e.names }))}
            className={toggleBtn(extra.names, false)}
          >
            Road names
          </button>
          <button
            type="button"
            aria-pressed={extra.landcover}
            title="Reference only: tints the ground by land cover. The game does not receive this data."
            onClick={() => setExtra((e) => ({ ...e, landcover: !e.landcover }))}
            className={toggleBtn(extra.landcover, false) + ' italic'}
          >
            Land cover
          </button>
        </div>
        {hasResult && !zonesAvailable && (
          <div className="max-w-xs rounded-control bg-surface/80 px-2 py-1 text-[11px] text-muted backdrop-blur">{zonesNote}</div>
        )}
        {(extra.zones && zonesAvailable) || (extra.houses && lotsAvailable) ? (
          <div className="max-w-xs rounded-control bg-surface/80 px-2 py-1 text-[11px] leading-snug text-muted backdrop-blur">
            Zoning cells are 8 × 8 m, as in the game. Example houses only show the scale and are not exported.
          </div>
        ) : null}
        {extra.landcover && (
          <div className="max-w-xs rounded-control bg-surface/80 px-2 py-1 text-[11px] leading-snug text-muted backdrop-blur">
            Land cover tint is for reference only. The game paints the ground itself and does not get this data.
          </div>
        )}
      </div>

      <div className="absolute right-3 top-3 flex flex-col items-end gap-1.5">
        <button
          type="button"
          onClick={() => {
            engine?.suspend();
            setRenderOpen(true);
          }}
          disabled={!hasResult || !engine || contextLost}
          title="Open the game view: the whole map as it will look in Cities: Skylines II"
          className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-xs font-medium text-bg shadow transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <Camera size={14} />
          Render
        </button>
        <button
          type="button"
          onClick={() => engineRef.current?.resetView()}
          title="Reset the view"
          className="flex items-center gap-1.5 rounded-control border border-line bg-surface/80 px-2.5 py-1.5 text-xs text-muted backdrop-blur transition-colors hover:bg-surface-2 hover:text-text"
        >
          <Crosshair size={14} />
          Reset view
        </button>
      </div>

      {hasResult && bar && view && (
        <div className="pointer-events-none absolute bottom-2 left-3 rounded-control bg-surface/70 px-2 py-1 text-[11px] text-text backdrop-blur">
          <div className="flex items-end gap-2">
            <div>
              <div className="tabular-nums">{bar.label}</div>
              <div className="mt-0.5 h-1.5 border-x border-b border-text/80" style={{ width: `${Math.round(bar.px)}px` }} />
            </div>
            <div className="text-muted">Camera height {formatDistance(Math.max(0, view.heightAboveGround))}</div>
          </div>
        </div>
      )}

      {hasResult && (
        <div className="pointer-events-none absolute bottom-2 right-3 text-[11px] text-text/50">
          Drag: rotate · Right-click: pan · Scroll: zoom
        </div>
      )}

      {building && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 w-64 -translate-x-1/2 rounded-panel border border-line bg-surface/85 px-3 py-2 backdrop-blur">
          <div className="flex items-center justify-between text-xs text-muted">
            <span className="truncate">{status.stage ?? 'Building'}</span>
            <span className="ml-2 tabular-nums text-text">{pct}%</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {renderOpen && (
        <GameView
          onClose={() => {
            setRenderOpen(false);
            engineRef.current?.resume();
          }}
        />
      )}
    </div>
  );
}
