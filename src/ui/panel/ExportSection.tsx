import { useState } from 'react';
import { CheckCircle2, Download, ImageIcon, Loader2, Package } from 'lucide-react';
import { useStore } from '../store';
import { Help, Section, TextField } from './controls';
import {
  DEFAULT_MAP_NAME,
  exportHeightmaps,
  exportOverlay,
  exportPackage,
  sanitizeMapName,
  type PackageExportResult,
} from './exportActions';

const nf = (v: number, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d });

const primaryBtn =
  'inline-flex w-full items-center justify-center gap-2 rounded-control bg-accent px-3 py-2 text-sm font-medium text-bg hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50';
const secondaryBtn =
  'inline-flex w-full items-center justify-center gap-2 rounded-control border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-text hover:bg-line focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50';

type Job = 'package' | 'heightmap' | 'overlay';

export function ExportSection() {
  const result = useStore((s) => s.result);
  const [name, setName] = useState(DEFAULT_MAP_NAME);
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [paths, setPaths] = useState<{ heightmapPath: string; worldmapPath: string } | null>(null);
  const [pkg, setPkg] = useState<PackageExportResult | null>(null);
  const [overlayPath, setOverlayPath] = useState<string | null>(null);

  const busy = job !== null;
  const full = result?.settings.quality === 'full';
  const safeName = sanitizeMapName(name);
  const tr = result?.terrain;

  const run = async (which: Job) => {
    if (!result || busy) return;
    setJob(which);
    setError(null);
    setProgress('');
    if (which === 'package') setPkg(null);
    if (which === 'heightmap') setPaths(null);
    if (which === 'overlay') setOverlayPath(null);
    try {
      if (which === 'package') setPkg(await exportPackage(result, name, { onProgress: setProgress }));
      else if (which === 'heightmap') setPaths(await exportHeightmaps(result, name));
      else setOverlayPath(await exportOverlay(result, name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setJob(null);
      setProgress('');
    }
  };

  return (
    <Section id="export" title="Export">
      <TextField
        label="Map name"
        value={name}
        onChange={(v) => {
          setName(v);
          setPaths(null);
          setPkg(null);
          setOverlayPath(null);
        }}
        help={
          safeName !== name
            ? `The files will be named ${safeName} (letters, digits, - and _ only).`
            : 'Used in the file names. Letters, digits, - and _ only.'
        }
      />

      <div>
        <button type="button" disabled={!full || busy} onClick={() => void run('package')} className={primaryBtn}>
          {job === 'package' ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Package size={15} aria-hidden />}
          {job === 'package' ? 'Exporting…' : 'Export complete map to CS2'}
        </button>
        {job === 'package' && progress && (
          <p role="status" className="mt-1 text-xs text-muted">
            {progress}
          </p>
        )}
        {!full && <Help>Run &apos;Build map&apos; first</Help>}
        {full && job !== 'package' && (
          <Help>Writes roads, trees, water and climate for the CS2 import mod. This takes a moment.</Help>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-danger">
          Export failed: {error}
        </p>
      )}

      {pkg && (
        <div className="space-y-3" role="status">
          <div className="rounded-control bg-surface-2 p-3 text-xs">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-accent">
              <CheckCircle2 size={14} aria-hidden /> Package saved
            </div>
            <div className="break-all text-muted">{pkg.folder}</div>
            <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
              <dt className="text-muted">Intersections</dt>
              <dd className="tabular-nums">{nf(pkg.counts.nodes)}</dd>
              <dt className="text-muted">Road segments</dt>
              <dd className="tabular-nums">{nf(pkg.counts.edges)}</dd>
              <dt className="text-muted">Trees</dt>
              <dd className="tabular-nums">{nf(pkg.counts.trees)}</dd>
              <dt className="text-muted">Water sources</dt>
              <dd className="tabular-nums">{nf(pkg.counts.waterSources)}</dd>
            </dl>
          </div>
          <div className="text-xs">
            <div className="mb-1 font-medium">Turn it into a playable map</div>
            <p className="mb-1.5 leading-snug text-muted">
              The package is not a map yet. The importer mod builds and saves the map inside the game, and only
              then does it appear under New Game.
            </p>
            <ol className="list-decimal space-y-1 pl-5 leading-snug text-muted">
              <li>Start Cities: Skylines II (with the CS2 Map Builder mod installed).</li>
              <li>In the main menu, open Options, then the &quot;CS2 Map Builder&quot; page.</li>
              <li>Select the package {safeName} and click &quot;Create playable map&quot;.</li>
              <li>Wait while the game opens the editor, imports and saves the map.</li>
              <li>Start a New Game and pick the map {safeName}.</li>
            </ol>
          </div>
        </div>
      )}

      <hr className="border-line" />

      <div>
        <button type="button" disabled={!full || busy} onClick={() => void run('heightmap')} className={secondaryBtn}>
          {job === 'heightmap' ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Download size={15} aria-hidden />}
          {job === 'heightmap' ? 'Creating images…' : 'Export heightmap only'}
        </button>
        <Help>For use without the import mod: the terrain as images to load into the editor by hand.</Help>
      </div>

      {result && tr && (
        <div className="rounded-panel border border-line bg-surface-2 p-3 text-xs">
          <div className="mb-1.5 text-muted">Values to enter in the CS2 editor</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">Height scale in CS2</dt>
            <dd className="text-right font-semibold tabular-nums text-accent">{nf(tr.heightScale, 1)} m</dd>
            <dt className="text-muted">Sea level</dt>
            <dd className="text-right tabular-nums">{nf(tr.seaLevel, 1)} m</dd>
            <dt className="text-muted">Horizontal scale</dt>
            <dd className="text-right tabular-nums">{nf(tr.scale.horizontal, 3)}</dd>
            <dt className="text-muted">Vertical scale</dt>
            <dd className="text-right tabular-nums">{nf(tr.scale.vertical, 3)}</dd>
            <dt className="text-muted">Lowest elevation</dt>
            <dd className="text-right tabular-nums">{nf(tr.minHeight, 1)} m</dd>
            <dt className="text-muted">Highest elevation</dt>
            <dd className="text-right tabular-nums">{nf(tr.maxHeight, 1)} m</dd>
          </dl>
        </div>
      )}

      {paths && (
        <div className="space-y-3" role="status">
          <div className="rounded-control bg-surface-2 p-3 text-xs">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-accent">
              <CheckCircle2 size={14} aria-hidden /> Saved
            </div>
            <div className="break-all text-muted">{paths.heightmapPath}</div>
            <div className="break-all text-muted">{paths.worldmapPath}</div>
          </div>
          <div className="text-xs">
            <div className="mb-1 font-medium">How to import into CS2</div>
            <ol className="list-decimal space-y-1 pl-5 leading-snug text-muted">
              <li>Start Cities: Skylines II and open the Editor.</li>
              <li>Choose to create a new map.</li>
              <li>Choose to import a heightmap and select {safeName}_heightmap.png.</li>
              <li>Then import the world map {safeName}_worldmap.png.</li>
              <li>
                Set the height scale to{' '}
                <span className="font-semibold text-text">{result ? nf(result.terrain.heightScale, 1) : ''} m</span>.
              </li>
              <li>Set a start area, add a road to the map edge and save the map. It then appears under New Game.</li>
            </ol>
          </div>
        </div>
      )}

      <hr className="border-line" />

      <div>
        <button type="button" disabled={!result || busy} onClick={() => void run('overlay')} className={secondaryBtn}>
          {job === 'overlay' ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <ImageIcon size={15} aria-hidden />}
          {job === 'overlay' ? 'Drawing image…' : 'Export reference image (Image Overlay)'}
        </button>
        <Help>
          For the free Image Overlay mod: a transparent image with water, forest and roads to trace by hand.
          Works for both drafts and full builds.
        </Help>
        {!result && <Help>Build a map first.</Help>}
      </div>

      {overlayPath && (
        <div className="rounded-control bg-surface-2 p-3 text-xs" role="status">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-accent">
            <CheckCircle2 size={14} aria-hidden /> Saved
          </div>
          <div className="break-all text-muted">{overlayPath}</div>
        </div>
      )}
    </Section>
  );
}
