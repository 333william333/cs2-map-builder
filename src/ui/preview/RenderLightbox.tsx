import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Sun, X } from 'lucide-react';
import type { PreviewEngine } from './PreviewEngine';
import { RenderCancelled, type RenderJob } from './renderMode';
import { renderFileName } from './renderMath';
import { formatHour } from './sun';

const RESOLUTIONS: { w: number; h: number; label: string }[] = [
  { w: 1920, h: 1080, label: '1920 × 1080' },
  { w: 2560, h: 1440, label: '2560 × 1440' },
  { w: 3840, h: 2160, label: '3840 × 2160' },
];

interface Props {
  engine: PreviewEngine;
  zones: boolean;
  houses: boolean;
  lat: number;
  lon: number;
  onClose(): void;
}

type Phase = { kind: 'running'; fraction: number; message: string } | { kind: 'done'; seconds: number; samples: number } | { kind: 'error'; message: string };

/** Lightbox for "Render": progress, the image, resolution and time of day, save and close. */
export function RenderLightbox({ engine, zones, houses, lat, lon, onClose }: Props) {
  const [res, setRes] = useState(0);
  const [hour, setHour] = useState(() => engine.getHour());
  const [renderHour, setRenderHour] = useState(hour);
  const [phase, setPhase] = useState<Phase>({ kind: 'running', fraction: 0, message: 'Starting' });
  const [notes, setNotes] = useState<string[]>([]);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const jobRef = useRef<RenderJob | null>(null);

  // debounce the slider: re-render shortly after the user stops dragging
  useEffect(() => {
    if (hour === renderHour) return;
    const t = setTimeout(() => setRenderHour(hour), 450);
    return () => clearTimeout(t);
  }, [hour, renderHour]);

  useEffect(() => {
    const { w, h } = RESOLUTIONS[res];
    engine.setHour(renderHour);
    setPhase({ kind: 'running', fraction: 0, message: 'Starting' });
    setNotes([]);
    const job = engine.render({ width: w, height: h, hour: renderHour, zones, houses }, (p) => {
      setPhase((ph) => (ph.kind === 'running' ? { kind: 'running', fraction: p.fraction, message: p.message } : ph));
    });
    if (!job) {
      setPhase({ kind: 'error', message: 'There is no map to render, or graphics are not available right now.' });
      return;
    }
    jobRef.current = job;
    setCanvas(job.canvas);
    let alive = true;
    job.promise.then(
      (out) => {
        if (!alive) return;
        setNotes(out.notes);
        setPhase({ kind: 'done', seconds: out.ms / 1000, samples: out.samples });
      },
      (err: unknown) => {
        if (!alive || err instanceof RenderCancelled) return;
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      alive = false;
      job.cancel();
      if (jobRef.current === job) jobRef.current = null;
    };
  }, [engine, res, renderHour, zones, houses]);

  // show the live canvas
  useEffect(() => {
    const el = holder.current;
    if (!el || !canvas) return;
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '100%';
    canvas.style.width = 'auto';
    canvas.style.height = 'auto';
    canvas.style.display = 'block';
    canvas.style.borderRadius = '8px';
    el.replaceChildren(canvas);
    return () => {
      if (canvas.parentElement === el) el.removeChild(canvas);
    };
  }, [canvas]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = (): void => {
    if (!canvas) return;
    const { w, h } = RESOLUTIONS[res];
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = renderFileName(lat, lon, w, h, renderHour);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  };

  const running = phase.kind === 'running';
  const pct = running ? Math.round(phase.fraction * 100) : 100;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg/95 backdrop-blur-sm" role="dialog" aria-label="Rendered image">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <div className="text-sm font-medium text-text">Rendered view</div>
        <label className="flex items-center gap-2 text-xs text-muted">
          Resolution
          <select
            value={res}
            onChange={(e) => setRes(Number(e.target.value))}
            className="rounded-control border border-line bg-surface-2 px-2 py-1 text-xs text-text"
          >
            {RESOLUTIONS.map((r, i) => (
              <option key={r.label} value={i}>{r.label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted">
          <Sun size={14} />
          Time of day
          <input
            type="range"
            min={5}
            max={21}
            step={0.25}
            value={hour}
            onChange={(e) => setHour(Number(e.target.value))}
            className="w-40 accent-accent"
            aria-label="Time of day"
          />
          <span className="w-10 tabular-nums text-text">{formatHour(hour)}</span>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={phase.kind !== 'done'}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity disabled:opacity-40"
          >
            <Download size={14} />
            Save PNG
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-control border border-line bg-surface-2 px-3 py-1.5 text-xs text-text hover:bg-line"
          >
            <X size={14} />
            Close
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        <div ref={holder} className="flex h-full w-full items-center justify-center" />
        {running && (
          <div className="absolute bottom-6 left-1/2 w-80 -translate-x-1/2 rounded-panel border border-line bg-surface/90 px-3 py-2 backdrop-blur">
            <div className="flex items-center justify-between gap-2 text-xs text-muted">
              <span className="flex min-w-0 items-center gap-1.5">
                <LoaderCircle size={13} className="shrink-0 animate-spin text-accent" />
                <span className="truncate">{phase.message}</span>
              </span>
              <span className="tabular-nums text-text">{pct}%</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <button
              type="button"
              onClick={() => {
                jobRef.current?.cancel();
                setPhase({ kind: 'error', message: 'Rendering was cancelled. Change the resolution or time to render again.' });
              }}
              className="mt-2 w-full rounded-control border border-line px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
            >
              Cancel
            </button>
          </div>
        )}
        {phase.kind === 'error' && (
          <div className="absolute bottom-6 left-1/2 max-w-md -translate-x-1/2 rounded-panel border border-line bg-surface/95 px-4 py-3 text-center text-sm text-warn">{phase.message}</div>
        )}
      </div>

      <div className="border-t border-line bg-surface px-4 py-2 text-[11px] leading-relaxed text-muted">
        The image shows the map as it is imported into Cities: Skylines II: terrain, water, roads and trees.
        {(houses || zones) && ' Example houses and the zoning grid are only illustrations to show the scale and are not carried into the game.'}
        {phase.kind === 'done' && ` Finished in ${phase.seconds.toFixed(1)} s with ${phase.samples} samples per pixel.`}
        {notes.length > 0 && <span className="text-warn"> {notes.join(' ')}</span>}
      </div>
    </div>
  );
}
