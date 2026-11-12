import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, CheckCircle2, Droplet, Eraser, Flag, Plane, RotateCcw, Route, Ship, SlidersHorizontal,
  TrainFront, X, XCircle, Zap,
} from 'lucide-react';
import { useStore } from '../store';
import type { CheckStatus, OutsideConnection, Pt } from '../../core/types';
import { PERIMETER, borderParam, borderPointAt, sideOf, snapToBorder } from '../../core/manual/border';
import { MANUAL_WARNING_PREFIX } from '../../core/manual/applyManualCore';
import {
  SIDE_NAMES, canvasToGame, cornerMargin, fitSquare, hitTestMarkers, moveTile, snapPointerToBorder, tileAt,
  type EditorView, type Tile,
} from './editorGeometry';
import { KIND_COLOR, KIND_LABEL, ORIGIN_LABEL, buildMarkers, groupMarkers, type EditorMarker } from './editorModel';
import { renderBackdrop } from './editorRender';
import { drawEditor, type ToolId } from './editorDraw';
import { Help } from './controls';

const PAD = 30;
const ring = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent';

const CHECK_ICON: Record<CheckStatus, { Icon: typeof XCircle; cls: string; label: string }> = {
  ok: { Icon: CheckCircle2, cls: 'text-accent', label: 'OK' },
  warn: { Icon: AlertTriangle, cls: 'text-warn', label: 'Warning' },
  fail: { Icon: XCircle, cls: 'text-danger', label: 'Error' },
};

const KIND_ICON: Record<OutsideConnection['kind'], typeof Route> = {
  road: Route, rail: TrainFront, ship: Ship, air: Plane, power: Zap, water: Droplet,
};

const TOOLS: { id: ToolId; label: string; Icon: typeof Route }[] = [
  { id: 'start', label: 'Start tile', Icon: Flag },
  { id: 'road', label: 'Road', Icon: Route },
  { id: 'rail', label: 'Rail', Icon: TrainFront },
  { id: 'ship', label: 'Ship', Icon: Ship },
  { id: 'air', label: 'Air', Icon: Plane },
  { id: 'power', label: 'Power', Icon: Zap },
  { id: 'water', label: 'Water', Icon: Droplet },
  { id: 'remove', label: 'Remove', Icon: Eraser },
];

const START_CHECKS = ['startTile', 'startRoad', 'freshWater'];
const KEY_STEP_M = 200;

function toolHint(tool: ToolId): string {
  if (tool === 'start') return 'Click a tile to set the start tile, or move it with the arrow keys.';
  if (tool === 'remove') {
    return 'Click a connection you added yourself, or its cross, to remove it. Automatic connections cannot be removed.';
  }
  const extra = tool === 'road' || tool === 'rail' ? ' The road or track is built from the edge to the nearest suitable road.' : '';
  return `Click near the map edge to add a ${KIND_LABEL[tool].toLowerCase()} connection. The point snaps to the nearest edge point.${extra} With the keyboard, the arrow keys move the cursor along the edge and Enter adds it.`;
}

function stripPrefix(w: string): string {
  return w.startsWith(MANUAL_WARNING_PREFIX) ? w.slice(MANUAL_WARNING_PREFIX.length) : w;
}

/** The "Adjust by hand" button for the Playability section, with its dialog. */
export function ManualEditorLauncher() {
  const result = useStore((s) => s.result);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const disabled = !result;
  return (
    <div>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-describedby={hintId}
        onClick={() => setOpen(true)}
        className={`flex w-full items-center justify-center gap-2 rounded-control border border-line bg-surface-2 px-3 py-2 text-sm font-medium hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line ${ring}`}
      >
        <SlidersHorizontal size={15} aria-hidden /> Adjust by hand
      </button>
      <Help id={hintId}>
        {disabled
          ? 'Preview or build the map first. Then you can choose the start tile and add connections by hand.'
          : 'Choose the start tile and add or remove connections to the outside world on a map.'}
      </Help>
      {open && result && (
        <ManualEditorDialog
          onClose={() => {
            setOpen(false);
            requestAnimationFrame(() => btnRef.current?.focus());
          }}
        />
      )}
    </div>
  );
}

function ManualEditorDialog({ onClose }: { onClose: () => void }) {
  const result = useStore((s) => s.result);
  const manual = useStore((s) => s.settings.manual);
  const setManual = useStore((s) => s.setManual);
  const titleId = useId();
  const hintId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [tool, setTool] = useState<ToolId>('start');
  const [size, setSize] = useState(560);
  const [dpr, setDpr] = useState(1);
  const [backdrop, setBackdrop] = useState<HTMLCanvasElement | null>(null);
  const [hoverPx, setHoverPx] = useState<Pt | null>(null);
  const [kbd, setKbd] = useState<{ on: boolean; t: number }>({ on: false, t: PERIMETER / 8 });
  const [note, setNote] = useState('');

  const view: EditorView = useMemo(() => ({ size, pad: PAD }), [size]);
  const play = result?.playability;
  const added = manual.added;
  const markers = useMemo(() => buildMarkers(play, added), [play, added]);

  // compute the report once if the loaded result has none yet
  useEffect(() => {
    if (result && !result.playability) setManual((m) => ({ ...m }));
  }, [result, setManual]);

  // focus the dialog, restore nothing here (the launcher restores focus)
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // canvas size follows the available area
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => {
      setSize(fitSquare(el.clientWidth, el.clientHeight));
      setDpr(Math.min(2, window.devicePixelRatio || 1));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // terrain backdrop (only when the terrain, land cover or size change)
  const terrain = result?.terrain;
  const landcover = result?.landcover;
  useEffect(() => {
    if (!terrain) return;
    const bsz = Math.max(64, Math.min(1024, Math.round((size - 2 * PAD) * dpr)));
    const px = renderBackdrop({ terrain, landcover }, bsz);
    const c = document.createElement('canvas');
    c.width = bsz;
    c.height = bsz;
    const cx = c.getContext('2d');
    if (!cx) return;
    const img = cx.createImageData(bsz, bsz);
    img.data.set(px);
    cx.putImageData(img, 0, 0);
    setBackdrop(c);
  }, [terrain, landcover, size, dpr]);

  const connTool: OutsideConnection['kind'] | null = tool !== 'start' && tool !== 'remove' ? tool : null;

  const hoverTile: Tile | null = useMemo(
    () => (tool === 'start' && hoverPx ? tileAt(canvasToGame(hoverPx, view)) : null),
    [tool, hoverPx, view],
  );

  const preview = useMemo(() => {
    if (!connTool) return null;
    if (kbd.on) return { kind: connTool, p: snapToBorder(borderPointAt(kbd.t), cornerMargin(connTool)) };
    if (!hoverPx) return null;
    const p = snapPointerToBorder(hoverPx, view, connTool);
    return p ? { kind: connTool, p } : null;
  }, [connTool, hoverPx, view, kbd]);

  // draw
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    drawEditor(ctx, {
      view, dpr, backdrop, roads: result?.roads, markers,
      startTile: play?.startTile ?? null,
      manualStart: !!manual.startTile,
      hoverTile, preview,
    });
  }, [view, dpr, backdrop, result?.roads, markers, play?.startTile, manual.startTile, hoverTile, preview]);

  const manualWarnings = useMemo(
    () => (result?.warnings ?? []).filter((w) => w.startsWith(MANUAL_WARNING_PREFIX)),
    [result?.warnings],
  );

  const chooseTool = (t: ToolId) => {
    setTool(t);
    setNote('');
    if (t === 'start' || t === 'remove') setKbd((k) => ({ ...k, on: false }));
  };

  const removeAdded = useCallback((index: number) => {
    setManual((m) => ({ ...m, added: m.added.filter((_, i) => i !== index) }));
    setNote('The connection was removed.');
  }, [setManual]);

  const addConnection = (kind: OutsideConnection['kind'], p: Pt) => {
    const dup = added.some((a) => a.kind === kind && Math.hypot(a.p[0] - p[0], a.p[1] - p[1]) < 60);
    if (dup) {
      setNote(`There is already a ${KIND_LABEL[kind].toLowerCase()} connection here.`);
      return;
    }
    const prevWarn = (useStore.getState().result?.warnings ?? []).filter((w) => w.startsWith(MANUAL_WARNING_PREFIX)).length;
    setManual((m) => ({ ...m, added: [...m.added, { kind, p }] }));
    const w = (useStore.getState().result?.warnings ?? []).filter((x) => x.startsWith(MANUAL_WARNING_PREFIX));
    setNote(
      w.length > prevWarn
        ? stripPrefix(w[w.length - 1])
        : `${KIND_LABEL[kind]} connection added at the ${SIDE_NAMES[sideOf(p)]}.`,
    );
  };

  const localPx = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onClick = (e: React.MouseEvent) => {
    const px = localPx(e);
    setKbd((k) => ({ ...k, on: false }));
    const hit = hitTestMarkers(markers, px, view, (m) => m.addedIndex !== undefined);
    if (hit) {
      const idx = hit.marker.addedIndex;
      if (idx !== undefined && (tool === 'remove' || hit.badge)) { removeAdded(idx); return; }
      if (tool === 'remove') {
        setNote('Automatic connections cannot be removed. Add a connection of your own instead.');
        return;
      }
    }
    if (tool === 'remove') {
      setNote('No connection here. Click a connection you added yourself.');
      return;
    }
    if (tool === 'start') {
      const t = tileAt(canvasToGame(px, view));
      if (!t) { setNote('Pick a tile inside the map.'); return; }
      setManual((m) => ({ ...m, startTile: t }));
      setNote(`Start tile: column ${t.col + 1}, row ${t.row + 1}.`);
      return;
    }
    const p = snapPointerToBorder(px, view, tool);
    if (!p) { setNote('Click closer to the map edge to add a connection.'); return; }
    addConnection(tool, p);
  };

  const onCanvasKey = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const d = arrows[e.key];
    if (tool === 'start') {
      if (!d || !play) return;
      e.preventDefault();
      const t = moveTile(play.startTile, d[0], d[1]);
      setManual((m) => ({ ...m, startTile: t }));
      setNote(`Start tile: column ${t.col + 1}, row ${t.row + 1}.`);
      return;
    }
    if (!connTool) return;
    if (d) {
      e.preventDefault();
      const dir = d[0] + d[1] > 0 ? 1 : -1; // right/down = clockwise along the border
      const step = (e.shiftKey ? 5 : 1) * KEY_STEP_M * dir;
      setKbd((k) => ({ on: true, t: (k.on ? k.t : borderParam(preview?.p ?? borderPointAt(k.t))) + step }));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const t = kbd.on ? kbd.t : PERIMETER / 8;
      if (!kbd.on) setKbd({ on: true, t });
      addConnection(connTool, snapToBorder(borderPointAt(t), cornerMargin(connTool)));
    }
  };

  // Esc closes, Tab stays inside the dialog
  const onDialogKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const items = Array.from(
      root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    else if (!root.contains(active)) { e.preventDefault(); first.focus(); }
  };

  const groups = useMemo(() => groupMarkers(markers), [markers]);
  const startChecks = play?.checks.filter((c) => START_CHECKS.includes(c.id)) ?? [];
  const otherChecks = play?.checks.filter((c) => !START_CHECKS.includes(c.id)) ?? [];

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onDialogKey}
        className="flex h-[min(920px,96vh)] w-[min(1320px,98vw)] flex-col rounded-panel border border-line bg-surface text-text shadow-2xl outline-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="m-0 text-base font-semibold">Adjust by hand</h2>
            <p className="mt-1 max-w-4xl text-xs leading-snug text-muted">
              To be playable, a map needs a start tile with buildable land and preferably water nearby, and at least one
              road out to the map edge. Road and rail connections are built as real roads and tracks from the edge to the
              nearest suitable road.
            </p>
            {result?.settings.quality === 'draft' && (
              <p className="mt-1 text-xs text-warn">
                This is a draft. Positions are refined when you build the map at full quality.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`shrink-0 rounded-control p-1.5 text-muted hover:bg-surface-2 hover:text-text ${ring}`}
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        {!result ? (
          <p className="p-5 text-sm text-muted">No map is loaded. Preview or build the map first.</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              <div role="toolbar" aria-label="Tools" className="flex flex-wrap gap-1.5">
                {TOOLS.map(({ id, label, Icon }) => {
                  const on = tool === id;
                  const color = id !== 'start' && id !== 'remove' ? KIND_COLOR[id] : undefined;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => chooseTool(id)}
                      className={`flex items-center gap-1.5 rounded-control border px-2.5 py-1.5 text-xs font-medium ${ring} ${
                        on ? 'border-accent bg-accent text-bg' : 'border-line bg-surface-2 text-text hover:border-muted'
                      }`}
                    >
                      <Icon size={14} aria-hidden style={on || !color ? undefined : { color }} />
                      {label}
                    </button>
                  );
                })}
              </div>
              <p id={hintId} className="text-xs leading-snug text-muted">{toolHint(tool)}</p>

              <div ref={areaRef} className="relative min-h-[240px] flex-1 overflow-hidden">
                <canvas
                  ref={canvasRef}
                  width={Math.round(size * dpr)}
                  height={Math.round(size * dpr)}
                  style={{ width: size, height: size, cursor: tool === 'remove' ? 'pointer' : 'crosshair' }}
                  tabIndex={0}
                  role="application"
                  aria-label="Map of the playable area, north up"
                  aria-describedby={hintId}
                  onClick={onClick}
                  onPointerMove={(e) => { setHoverPx(localPx(e)); setKbd((k) => (k.on ? { ...k, on: false } : k)); }}
                  onPointerLeave={() => setHoverPx(null)}
                  onKeyDown={onCanvasKey}
                  className={`absolute left-0 top-0 rounded-control border border-line ${ring}`}
                />
              </div>
              <p role="status" aria-live="polite" className="min-h-[1.25rem] text-xs text-accent">{note}</p>
            </div>

            <aside aria-label="Summary" className="min-h-0 w-full shrink-0 space-y-5 overflow-y-auto lg:w-[340px]">
              <section aria-labelledby={`${titleId}-start`}>
                <h3 id={`${titleId}-start`} className="mb-1.5 text-sm font-semibold">Start tile</h3>
                {play && (
                  <p className="text-sm">
                    Column {play.startTile.col + 1}, row {play.startTile.row + 1}{' '}
                    <span className="text-xs text-muted">({manual.startTile ? 'chosen by hand' : 'automatic choice'})</span>
                  </p>
                )}
                <button
                  type="button"
                  disabled={!manual.startTile}
                  onClick={() => { setManual(({ startTile: _t, ...rest }) => rest); setNote('The start tile is chosen automatically again.'); }}
                  className={`mt-2 flex items-center gap-1.5 rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-xs hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line ${ring}`}
                >
                  <RotateCcw size={13} aria-hidden /> Reset to automatic choice
                </button>
                <ul className="mt-3 space-y-2">
                  {startChecks.map((c) => <CheckRow key={c.id} status={c.status} message={c.message} />)}
                </ul>
              </section>

              <section aria-labelledby={`${titleId}-conn`}>
                <h3 id={`${titleId}-conn`} className="mb-1.5 text-sm font-semibold">Connections</h3>
                {groups.length === 0 && <p className="text-xs text-muted">No connections yet.</p>}
                <div className="space-y-3">
                  {groups.map((g) => {
                    const Icon = KIND_ICON[g.kind];
                    return (
                      <div key={g.kind}>
                        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                          <Icon size={14} aria-hidden style={{ color: KIND_COLOR[g.kind] }} />
                          {KIND_LABEL[g.kind]} <span className="text-muted">({g.items.length})</span>
                        </div>
                        <ul className="space-y-1">
                          {g.items.map((m, i) => (
                            <ConnectionRow key={m.key} marker={m} n={i + 1} onRemove={removeAdded} />
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs leading-snug text-muted">
                  Automatic connections cannot be removed, but you can add your own.
                </p>
              </section>

              {manualWarnings.length > 0 && (
                <section aria-labelledby={`${titleId}-warn`}>
                  <h3 id={`${titleId}-warn`} className="mb-1.5 text-sm font-semibold">Things to note</h3>
                  <ul className="space-y-2">
                    {manualWarnings.map((w) => <CheckRow key={w} status="warn" message={stripPrefix(w)} />)}
                  </ul>
                </section>
              )}

              <section aria-labelledby={`${titleId}-checks`}>
                <h3 id={`${titleId}-checks`} className="mb-1.5 text-sm font-semibold">Checks</h3>
                <ul className="space-y-2">
                  {otherChecks.map((c) => <CheckRow key={c.id} status={c.status} message={c.message} />)}
                </ul>
              </section>
            </aside>
          </div>
        )}

        <footer className="flex justify-end border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className={`rounded-control bg-accent px-4 py-1.5 text-sm font-semibold text-bg hover:brightness-110 ${ring}`}
          >
            Done
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function CheckRow({ status, message }: { status: CheckStatus; message: string }) {
  const { Icon, cls, label } = CHECK_ICON[status];
  return (
    <li className="flex items-start gap-2 text-xs leading-snug">
      <Icon size={15} className={`mt-px shrink-0 ${cls}`} aria-label={label} />
      <span>{message}</span>
    </li>
  );
}

function ConnectionRow({ marker, n, onRemove }: { marker: EditorMarker; n: number; onRemove: (index: number) => void }) {
  const name = `${KIND_LABEL[marker.kind]} ${n}`;
  const where = SIDE_NAMES[sideOf(marker.p)];
  const removable = marker.addedIndex !== undefined;
  return (
    <li className="flex items-center justify-between gap-2 rounded-control bg-surface-2 px-2.5 py-1.5 text-xs">
      <span className="min-w-0">
        <span className="block truncate">{where}</span>
        <span className={`block ${marker.failed ? 'text-danger' : 'text-muted'}`}>
          {marker.failed ? 'could not be built' : ORIGIN_LABEL[marker.origin]}
        </span>
      </span>
      {removable && (
        <button
          type="button"
          aria-label={`Remove ${name} at ${where}`}
          onClick={() => onRemove(marker.addedIndex!)}
          className={`shrink-0 rounded-control border border-line px-2 py-1 text-xs text-muted hover:border-danger hover:text-danger ${ring}`}
        >
          Remove
        </button>
      )}
    </li>
  );
}
