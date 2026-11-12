import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, LoaderCircle, Sun, X } from 'lucide-react';
import type { BuildResult } from '../../core/types';
import { useStore } from '../store';
import { StillCancelled } from './accumulate';
import { CONNECTION_UI } from './connectionUi';
import { DEFAULT_GAME_LAYERS, GameEngine, type GameLayers, type GameStats, type GameViewInfo } from './GameEngine';
import { renderFileName } from './renderMath';
import { formatDistance, niceScaleBar } from './scaleBar';
import { formatHour } from './sun';

const RESOLUTIONS = [
  { w: 1920, h: 1080, label: '1920 x 1080' },
  { w: 2560, h: 1440, label: '2560 x 1440' },
  { w: 3840, h: 2160, label: '3840 x 2160' },
];

const TOGGLES: { key: keyof GameLayers; label: string; title: string }[] = [
  { key: 'trees', label: 'Trees', title: 'Every tree of the map at its exact position' },
  { key: 'roads', label: 'Roads', title: 'Roads and rail at their game widths' },
  { key: 'water', label: 'Water', title: 'Sea, lakes and rivers at their exported levels' },
  { key: 'tunnels', label: 'Tunnels', title: 'Show underground stretches as dashed lines' },
  { key: 'names', label: 'Road names', title: 'Names kept on the road segments' },
  { key: 'startTiles', label: 'Start tiles', title: 'The 3 x 3 tiles unlocked at the start' },
  { key: 'tileGrid', label: 'Tile grid', title: 'The 23 x 23 purchasable tiles' },
  { key: 'connections', label: 'Connections', title: 'Outside connections at the map border' },
  { key: 'zones', label: 'Zoning grid', title: 'Illustration only: the zoning grid is not part of the exported map' },
  { key: 'houses', label: 'Example houses', title: 'Illustration only: buildings are not part of the exported map' },
];

function isFull(r: BuildResult | null): r is BuildResult {
  return !!r && (r.terrain.playable.size >= 4096 || r.settings.quality === 'full');
}

type Phase =
  | { kind: 'building'; fraction: number; message: string }
  | { kind: 'scene'; fraction: number; message: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

/** Full-window game view of the complete map, with its own engine and a still-image export. */
export function GameView({ onClose }: { onClose(): void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const markerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [engine, setEngine] = useState<GameEngine | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'scene', fraction: 0, message: 'Starting' });
  const [result, setResult] = useState<BuildResult | null>(null);
  const [layers, setLayers] = useState<GameLayers>({ ...DEFAULT_GAME_LAYERS });
  const [hour, setHour] = useState(15.5);
  const [view, setView] = useState<GameViewInfo | null>(null);
  const [stats, setStats] = useState<GameStats | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [res, setRes] = useState(0);
  const [still, setStill] = useState<{ fraction: number; message: string } | null>(null);
  const [stillNote, setStillNote] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const stillCancel = useRef(false);

  // 1. make sure a full build is loaded (start one when needed)
  useEffect(() => {
    const cur = useStore.getState().result;
    if (isFull(cur)) {
      setResult(cur);
      return;
    }
    let alive = true;
    let unsub = (): void => {};
    const startFull = (): void => {
      if (!alive) return;
      setPhase({ kind: 'building', fraction: 0, message: 'Starting a full build' });
      useStore.getState().build('full');
      unsub = useStore.subscribe((s) => {
        if (s.status.phase === 'building') {
          setPhase({ kind: 'building', fraction: s.status.fraction, message: s.status.stage ?? 'Building' });
        } else if (s.status.phase === 'error') {
          setPhase({ kind: 'error', message: s.status.message ?? 'The full build failed.' });
        } else if (s.status.phase === 'done' && isFull(s.result)) {
          setResult(s.result);
        }
      });
    };
    startFull();
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  // 2. build the scene for that result
  useEffect(() => {
    const el = mountRef.current;
    if (!el || !result) return;
    let eng: GameEngine;
    try {
      eng = new GameEngine(el, result);
    } catch (err) {
      setPhase({ kind: 'error', message: `The game view could not start WebGL: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    if (import.meta.env.DEV) (window as unknown as { __game?: GameEngine }).__game = eng;
    let alive = true;
    let lastView: GameViewInfo | null = null;
    eng.onView = (v) => {
      if (lastView && Math.abs(v.metresPerPx / lastView.metresPerPx - 1) < 0.01 && Math.abs(v.heightAboveGround - lastView.heightAboveGround) < 1) return;
      lastView = v;
      setView(v);
    };
    eng.onContext = (l) => setLost(l);
    setPhase({ kind: 'scene', fraction: 0, message: 'Preparing the scene' });
    eng.build((f, message) => alive && setPhase({ kind: 'scene', fraction: f, message })).then(
      () => {
        if (!alive) return;
        setEngine(eng);
        setStats(eng.stats);
        setNotes([...eng.notes]);
        setPhase({ kind: 'ready' });
      },
      (err: unknown) => {
        if (alive) setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      alive = false;
      eng.dispose();
      setEngine((cur) => (cur === eng ? null : cur));
    };
  }, [result]);

  useEffect(() => { engine?.setLayers(layers); }, [engine, layers]);
  useEffect(() => { engine?.setHour(hour); }, [engine, hour]);

  // connection labels follow the camera
  const connections = useMemo(() => result?.playability?.outsideConnections ?? [], [result]);
  useEffect(() => {
    if (!engine) return;
    const pt = { x: 0, y: 0 };
    const update = (): void => {
      const anchors = engine.connectionAnchors();
      const show = engine.connectionsVisible();
      markerRefs.current.forEach((el, i) => {
        if (!el) return;
        const a = anchors[i];
        if (!show || !a) { el.style.display = 'none'; return; }
        const top = a.clone();
        top.y += 160;
        if (!engine.project(top, pt)) { el.style.display = 'none'; return; }
        el.style.display = '';
        el.style.transform = `translate(${Math.round(pt.x)}px, ${Math.round(pt.y)}px) translate(-50%, -100%)`;
      });
    };
    engine.onFrame = update;
    return () => { if (engine.onFrame === update) engine.onFrame = null; };
  }, [engine, connections]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (still) stillCancel.current = true;
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, still]);

  const saveImage = async (): Promise<void> => {
    if (!engine || still || !result) return;
    const { w, h } = RESOLUTIONS[res];
    stillCancel.current = false;
    setStillNote(null);
    setStill({ fraction: 0, message: 'Starting' });
    try {
      const out = await engine.saveImage(w, h, (fraction, message) => setStill({ fraction, message }), () => stillCancel.current);
      const blob = await new Promise<Blob | null>((ok) => out.canvas.toBlob(ok, 'image/png'));
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = renderFileName(result.selection.centerLat, result.selection.centerLon, w, h, hour);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
      setStillNote(`Saved ${w} x ${h} in ${(out.ms / 1000).toFixed(1)} s (${out.samples} samples per pixel).${out.notes.length ? ` ${out.notes.join(' ')}` : ''}`);
    } catch (err) {
      setStillNote(err instanceof StillCancelled ? 'Image cancelled.' : err instanceof Error ? err.message : String(err));
    } finally {
      setStill(null);
    }
  };

  const bar = view ? niceScaleBar(view.metresPerPx, 110) : null;
  const busy = phase.kind === 'building' || phase.kind === 'scene';
  const pct = busy ? Math.round(Math.min(1, Math.max(0, phase.fraction)) * 100) : 100;
  const n = (x: number): string => x.toLocaleString('en-US');

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg" role="dialog" aria-label="Game view">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <div className="mr-1 text-sm font-medium text-text">Game view</div>
        <div className="flex flex-wrap gap-1 rounded-panel border border-line bg-surface-2/50 p-0.5">
          {TOGGLES.map(({ key, label, title }) => {
            const on = layers[key];
            const illustrative = key === 'zones' || key === 'houses';
            return (
              <button
                key={key}
                type="button"
                title={title}
                aria-pressed={on}
                onClick={() => setLayers((l) => ({ ...l, [key]: !l[key] }))}
                className={
                  'rounded-control px-2 py-1 text-xs transition-colors ' +
                  (on ? 'bg-surface-2 text-accent' : 'text-muted hover:bg-surface-2 hover:text-text') +
                  (illustrative ? ' italic' : '')
                }
              >
                {label}
              </button>
            );
          })}
        </div>
        <label className="ml-1 flex items-center gap-2 text-xs text-muted">
          <Sun size={14} />
          <input
            type="range" min={5} max={21} step={0.25} value={hour}
            onChange={(e) => setHour(Number(e.target.value))}
            className="w-32 accent-accent" aria-label="Time of day"
          />
          <span className="w-10 tabular-nums text-text">{formatHour(hour)}</span>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={res}
            onChange={(e) => setRes(Number(e.target.value))}
            className="rounded-control border border-line bg-surface-2 px-2 py-1 text-xs text-text"
            aria-label="Image resolution"
          >
            {RESOLUTIONS.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
          </select>
          <button
            type="button" onClick={() => void saveImage()} disabled={!engine || !!still || lost}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-40"
          >
            <Camera size={14} />
            Save image
          </button>
          <button
            type="button" onClick={onClose} title="Close (Esc)"
            className="flex items-center gap-1.5 rounded-control border border-line bg-surface-2 px-3 py-1.5 text-xs text-text hover:bg-line"
          >
            <X size={14} />
            Close
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={mountRef} className="absolute inset-0" />

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
              >
                <Icon size={11} style={{ color }} />
                {ui.label}
                {c.synthetic && <span className="text-warn">auto</span>}
                {c.manual && <span className="text-accent">manual</span>}
              </div>
            );
          })}
        </div>

        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/70">
            <div className="w-80 rounded-panel border border-line bg-surface px-4 py-3">
              <div className="flex items-center justify-between gap-2 text-xs text-muted">
                <span className="flex min-w-0 items-center gap-1.5">
                  <LoaderCircle size={13} className="shrink-0 animate-spin text-accent" />
                  <span className="truncate">{phase.kind === 'building' ? `Full build: ${phase.message}` : phase.message}</span>
                </span>
                <span className="tabular-nums text-text">{pct} %</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
              </div>
              {phase.kind === 'building' && (
                <p className="mt-2 text-[11px] leading-snug text-muted">The game view needs the full 4096 height map, so a full build runs first.</p>
              )}
            </div>
          </div>
        )}
        {phase.kind === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="max-w-md rounded-panel border border-line bg-surface px-4 py-3 text-sm text-danger">{phase.message}</div>
          </div>
        )}
        {lost && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/70 text-sm text-warn">
            The graphics card dropped the 3D view. It comes back when the graphics are available again.
          </div>
        )}
        {still && (
          <div className="absolute bottom-16 left-1/2 w-80 -translate-x-1/2 rounded-panel border border-line bg-surface/95 px-3 py-2">
            <div className="flex items-center justify-between text-xs text-muted">
              <span className="truncate">{still.message}</span>
              <span className="tabular-nums text-text">{Math.round(still.fraction * 100)} %</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(still.fraction * 100)}%` }} />
            </div>
            <button type="button" onClick={() => { stillCancel.current = true; }} className="mt-2 w-full rounded-control border border-line px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text">
              Cancel
            </button>
          </div>
        )}

        {phase.kind === 'ready' && bar && view && (
          <div className="pointer-events-none absolute bottom-2 left-3 rounded-control bg-surface/75 px-2 py-1 text-[11px] text-text backdrop-blur">
            <div className="flex items-end gap-2">
              <div>
                <div className="tabular-nums">{bar.label}</div>
                <div className="mt-0.5 h-1.5 border-x border-b border-text/80" style={{ width: `${Math.round(bar.px)}px` }} />
              </div>
              <div className="text-muted">Camera height {formatDistance(Math.max(0, view.heightAboveGround))}</div>
            </div>
          </div>
        )}
        {phase.kind === 'ready' && stats && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 max-w-[60%] -translate-x-1/2 rounded-control bg-surface/75 px-2 py-1 text-center text-[11px] text-muted backdrop-blur">
            {n(stats.trees)} trees · {n(stats.segments)} road segments ({n(stats.bridges)} bridges, {n(stats.tunnels)} underground) · {n(stats.waterSources)} water sources
            {stats.dryAreas > 0 && ` · ${n(stats.dryAreas)} mapped water areas without a source stay dry`}
            {(layers.zones || layers.houses) && ' · zoning grid and houses are illustrations, not exported'}
            {notes.length > 0 && <span className="text-warn"> · {notes.join(' ')}</span>}
            {stillNote && <span className="text-text"> · {stillNote}</span>}
          </div>
        )}
        {phase.kind === 'ready' && (
          <div className="pointer-events-none absolute bottom-2 right-3 text-right text-[11px] text-text/60">
            WASD / arrows: move · Q / E: rotate · wheel: zoom
            <br />
            right or middle drag: orbit · left drag: pan
          </div>
        )}
      </div>
    </div>
  );
}
