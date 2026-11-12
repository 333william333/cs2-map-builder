import { useCallback, useRef, useState } from 'react';
import { TopBar } from './TopBar';
import { StatusBar } from './StatusBar';
import { MapView } from './map/MapView';
import { Preview3D } from './preview/Preview3D';
import { SettingsPanel } from './panel/SettingsPanel';

export function App() {
  const [mapFraction, setMapFraction] = useState(0.5);
  const areaRef = useRef<HTMLDivElement>(null);

  const onSplitDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = areaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const f = (ev.clientX - rect.left) / rect.width;
      setMapFraction(Math.min(0.85, Math.max(0.15, f)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <div ref={areaRef} className="flex min-w-0 flex-1">
          <div className="min-w-0 overflow-hidden" style={{ width: `${mapFraction * 100}%` }}>
            <MapView />
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={onSplitDown}
            className="w-1.5 shrink-0 cursor-col-resize bg-line hover:bg-accent"
          />
          <div className="min-w-0 flex-1 overflow-hidden">
            <Preview3D />
          </div>
        </div>
        <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-line bg-surface">
          <SettingsPanel />
        </aside>
      </div>
      <StatusBar />
    </div>
  );
}
