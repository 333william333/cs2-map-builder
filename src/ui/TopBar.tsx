import { useEffect, useRef, useState } from 'react';
import { Hammer, Loader2, MapPin, Search, Zap } from 'lucide-react';
import { useStore } from './store';
import { flyToSelection } from './map/mapBus';

interface Place {
  name: string;
  lat: number;
  lon: number;
}

const DEBOUNCE_MS = 500;
const MIN_INTERVAL_MS = 1000;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=';

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Nominatim usage policy: at most one request per second, serialised across the whole app. */
function searchPlaces(query: string): Promise<Place[]> {
  const run = async (): Promise<Place[]> => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    const url = `/api/fetch?url=${encodeURIComponent(NOMINATIM + encodeURIComponent(query))}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { display_name?: string; lat?: string; lon?: string }[];
    return json
      .map((r) => ({ name: r.display_name ?? '', lat: Number(r.lat), lon: Number(r.lon) }))
      .filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

export function TopBar() {
  const status = useStore((s) => s.status);
  const build = useStore((s) => s.build);
  const building = status.phase === 'building';

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchedFor = useRef('');
  const reqId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const runSearch = async (q: string): Promise<Place[]> => {
    const id = ++reqId.current;
    setBusy(true);
    setError(null);
    try {
      const found = await searchPlaces(q);
      if (id !== reqId.current) return [];
      searchedFor.current = q;
      setResults(found);
      setOpen(true);
      return found;
    } catch {
      if (id === reqId.current) {
        setError('Search failed');
        setResults([]);
        setOpen(true);
      }
      return [];
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  };

  const onChange = (value: string) => {
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);
    const q = value.trim();
    if (q.length < 2) {
      reqId.current++;
      setBusy(false);
      setResults([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
  };

  const pick = (p: Place) => {
    const s = useStore.getState();
    const next = { ...s.selection, centerLat: p.lat, centerLon: p.lon };
    s.setSelection({ centerLat: p.lat, centerLon: p.lon });
    flyToSelection(next);
    setQuery(p.name.split(',')[0] ?? p.name);
    setOpen(false);
  };

  const onEnter = async () => {
    const q = query.trim();
    if (q.length < 2) return;
    if (timer.current) clearTimeout(timer.current);
    let list = results;
    if (searchedFor.current !== q) list = await runSearch(q);
    if (list[0]) pick(list[0]);
  };

  useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const base =
    'inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent';

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-surface px-3">
      <div className="flex shrink-0 items-center gap-2 text-sm font-semibold">
        <MapPin size={18} className="text-accent" aria-hidden />
        <span>CS2 Map Builder</span>
      </div>

      <div ref={boxRef} className="relative mx-auto w-full max-w-md">
        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
        <input
          type="text"
          value={query}
          placeholder="Search for a place, e.g. Uppsala"
          aria-label="Search for a place"
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void onEnter();
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          className="w-full rounded-control border border-line bg-surface-2 py-1.5 pl-8 pr-8 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {busy && (
          <Loader2 size={15} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted" aria-hidden />
        )}
        {open && (
          <ul
            role="listbox"
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-panel border border-line bg-surface py-1 shadow-lg"
          >
            {error && <li className="px-3 py-2 text-sm text-danger">{error}</li>}
            {!error && results.length === 0 && <li className="px-3 py-2 text-sm text-muted">No results</li>}
            {results.map((p, i) => (
              <li key={`${p.lat},${p.lon},${i}`} role="option" aria-selected={false}>
                <button
                  type="button"
                  onClick={() => pick(p)}
                  className="block w-full truncate px-3 py-1.5 text-left text-sm text-text hover:bg-surface-2"
                  title={p.name}
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={building}
          onClick={() => build('draft')}
          className={`${base} border border-line bg-surface-2 text-text hover:bg-line`}
        >
          <Zap size={15} aria-hidden />
          Quick preview
        </button>
        <button
          type="button"
          disabled={building}
          onClick={() => build('full')}
          className={`${base} bg-accent text-bg hover:brightness-110`}
        >
          <Hammer size={15} aria-hidden />
          Build map
        </button>
      </div>
    </header>
  );
}
