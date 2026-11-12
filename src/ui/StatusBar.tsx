import { AlertTriangle } from 'lucide-react';
import { useStore } from './store';
import { CS2 } from '../core/types';

const pct = (f: number) => `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;

export function StatusBar() {
  const status = useStore((s) => s.status);
  const selection = useStore((s) => s.selection);
  const quality = useStore((s) => s.result?.settings.quality);
  const warnings = useStore((s) => s.result?.warnings);
  const warnCount = warnings?.length ?? 0;

  const sideKm = (selection.sizeMeters / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const ratio = selection.sizeMeters / CS2.PLAYABLE_SIZE_M;
  const scale = ratio >= 1 ? `1:${ratio.toLocaleString('en-US', { maximumFractionDigits: 1 })}` : `${(1 / ratio).toLocaleString('en-US', { maximumFractionDigits: 1 })}:1`;

  let left;
  if (status.phase === 'building') {
    left = (
      <div className="flex min-w-0 items-center gap-2" role="status">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(status.fraction * 100)}
          className="h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-surface-2"
        >
          <div className="h-full bg-accent transition-[width]" style={{ width: pct(status.fraction) }} />
        </div>
        <span className="truncate text-text">
          {status.stage ?? 'Building'} · {pct(status.fraction)}
        </span>
      </div>
    );
  } else if (status.phase === 'error') {
    left = (
      <span role="alert" className="truncate text-danger" title={status.message}>
        {status.message ?? 'Something went wrong'}
      </span>
    );
  } else if (status.phase === 'done') {
    left = (
      <span className="truncate">
        <span className="text-text">Done</span>
        {quality && <span> · {quality === 'full' ? 'full build' : 'quick preview (draft)'}</span>}
        {warnCount > 0 && (
          <span className="ml-2 inline-flex items-center gap-1 text-warn" title={warnings?.join('\n')}>
            <AlertTriangle size={12} aria-hidden />
            {warnCount} {warnCount === 1 ? 'warning' : 'warnings'}
          </span>
        )}
      </span>
    );
  } else {
    left = <span>Ready</span>;
  }

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 text-xs text-muted">
      <div className="flex min-w-0 flex-1 items-center">{left}</div>
      <div className="shrink-0 tabular-nums">
        Side {sideKm} km · Scale {scale}
      </div>
      <div className="min-w-0 flex-1 truncate text-right text-[11px] opacity-80">
        © OpenStreetMap contributors · ESA WorldCover · Mapzen/AWS Terrain Tiles · Open-Meteo
      </div>
    </footer>
  );
}
