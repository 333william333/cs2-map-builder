import { AlertTriangle, CheckCircle2, Download, ImageIcon, Loader2, Package, XCircle } from 'lucide-react';
import { useStore } from '../store';
import type { BuildSettings, CheckStatus, OutsideConnection, RoadClass, TreeSet, TreeSpecies } from '../../core/types';
import {
  NumberField,
  Section,
  SelectField,
  Segmented,
  Slider,
  Toggle,
  Help,
} from './controls';
import { ExportSection } from './ExportSection';
import { ManualEditorLauncher } from './ManualEditor';

const ROAD_LABELS: [RoadClass, string][] = [
  ['motorway', 'Motorway'],
  ['trunk', 'Trunk road'],
  ['primary', 'Primary road'],
  ['secondary', 'Secondary road'],
  ['tertiary', 'Tertiary road'],
  ['residential', 'Local streets'],
  ['service', 'Service roads'],
  ['pedestrian', 'Footpaths'],
  ['rail', 'Railway'],
  ['tram', 'Tram'],
  ['subway', 'Subway'],
];

const CONNECTION_LABELS: Record<OutsideConnection['kind'], string> = {
  road: 'Road',
  rail: 'Rail',
  ship: 'Ship',
  air: 'Air',
  power: 'Power',
  water: 'Water',
};

const SPECIES_LABELS: Record<TreeSpecies, string> = {
  birch: 'birch',
  oak: 'oak',
  linden: 'linden',
  chestnut: 'chestnut',
  poplar: 'poplar',
  alder: 'alder',
  apple: 'apple',
  hickory: 'hickory',
  plane: 'plane',
  pine: 'pine',
  spruce: 'spruce',
  bush: 'bush',
  palm: 'palm',
  eucalyptus: 'eucalyptus',
};

/** Outside connections grouped by kind, in display order, with how many were synthesised. */
export function groupConnections(list: OutsideConnection[]): { kind: OutsideConnection['kind']; count: number; synthetic: number }[] {
  return (Object.keys(CONNECTION_LABELS) as OutsideConnection['kind'][])
    .map((kind) => {
      const of = list.filter((c) => c.kind === kind);
      return { kind, count: of.length, synthetic: of.filter((c) => c.synthetic).length };
    })
    .filter((g) => g.count > 0);
}

/** The most common tree species, with display names. */
export function topSpecies(trees: TreeSet, n = 3): { name: string; count: number }[] {
  const counts = new Array<number>(trees.speciesTable.length).fill(0);
  for (let i = 0; i < trees.count; i++) {
    const k = trees.species[i]!;
    if (k < counts.length) counts[k]!++;
  }
  return counts
    .map((count, i) => ({ name: SPECIES_LABELS[trees.speciesTable[i]!] ?? String(trees.speciesTable[i]), count }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

const TREE_BUDGETS = [100_000, 250_000, 400_000, 800_000];
const pct = (v: number) => `${Math.round(v * 100)}%`;
const nf = (v: number, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d });

function useSettings() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const update = (fn: (draft: BuildSettings) => void) =>
    setSettings((s) => {
      const next = structuredClone(s);
      fn(next);
      return next;
    });
  return { settings, update };
}

const CHECK_ICON: Record<CheckStatus, { Icon: typeof XCircle; cls: string; label: string }> = {
  ok: { Icon: CheckCircle2, cls: 'text-accent', label: 'OK' },
  warn: { Icon: AlertTriangle, cls: 'text-warn', label: 'Warning' },
  fail: { Icon: XCircle, cls: 'text-danger', label: 'Error' },
};

export function SettingsPanel() {
  const { settings, update } = useSettings();
  const result = useStore((s) => s.result);
  const t = settings.terrain;

  const climate = result?.climate;
  const play = result?.playability;
  const warnings = result?.warnings ?? [];
  const autoPreview = useStore((s) => s.autoPreview);
  const setAutoPreview = useStore((s) => s.setAutoPreview);

  return (
    <div className="text-text">
      {warnings.length > 0 && (
        <div
          role="status"
          aria-label="Warnings"
          className="m-4 mb-0 rounded-panel border border-warn/40 bg-warn/10 p-3 text-xs"
        >
          <div className="mb-1.5 flex items-center gap-1.5 font-medium text-warn">
            <AlertTriangle size={14} aria-hidden /> Things to note ({warnings.length})
          </div>
          <ul className="space-y-1 leading-snug">
            {warnings.map((w, i) => (
              <li key={i} className="text-text">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-b border-line px-4 py-3">
        <Toggle
          label="Automatic preview"
          checked={autoPreview}
          help="A quick terrain-only preview is rebuilt when you move the square."
          onChange={setAutoPreview}
        />
      </div>

      <Section id="terrain" title="Terrain">
        <Segmented
          label="Height mode"
          value={t.verticalMode}
          options={[
            { value: 'proportional', label: 'Proportional' },
            { value: 'true', label: 'True height' },
            { value: 'custom', label: 'Custom' },
          ]}
          onChange={(v) => update((s) => void (s.terrain.verticalMode = v))}
        />
        <Help>
          {t.verticalMode === 'proportional' && 'Heights scale with the width of the map, so hills look the same as in reality.'}
          {t.verticalMode === 'true' && 'Real elevation meters are used without scaling. Large maps become flat.'}
          {t.verticalMode === 'custom' && 'You set how many game meters each real meter of elevation becomes.'}
        </Help>
        {t.verticalMode === 'custom' && (
          <NumberField
            label="Height factor"
            value={t.verticalFactor}
            min={0.01}
            max={100}
            step={0.1}
            unit="game m per m"
            onChange={(v) => update((s) => void (s.terrain.verticalFactor = v))}
          />
        )}
        <Slider
          label="Exaggeration"
          value={t.exaggeration}
          min={0.5}
          max={3}
          step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
          help="Makes the landscape steeper or flatter on top of the height mode."
          onChange={(v) => update((s) => void (s.terrain.exaggeration = v))}
        />
        <NumberField
          label="Sea level in game"
          value={t.seaLevelGame}
          min={0}
          max={500}
          step={1}
          unit="m"
          help="The height the sea ends up at. Leaves room for sea depth below."
          onChange={(v) => update((s) => void (s.terrain.seaLevelGame = v))}
        />
        <Slider
          label="Smoothing"
          value={t.smoothing}
          min={0}
          max={1}
          step={0.05}
          format={pct}
          help="Softens small bumps so the ground is easier to build on."
          onChange={(v) => update((s) => void (s.terrain.smoothing = v))}
        />
        <Toggle
          label="Carve out lakes and rivers"
          checked={t.carveWater}
          onChange={(v) => update((s) => void (s.terrain.carveWater = v))}
        />
      </Section>

      <Section id="water" title="Water">
        <Toggle
          label="Create water"
          checked={settings.water.enabled}
          help="Sea, lakes and rivers as water sources in the game."
          onChange={(v) => update((s) => void (s.water.enabled = v))}
        />
        <Toggle
          label="Streams and ditches"
          checked={settings.water.streams}
          disabled={!settings.water.enabled}
          help="Small streams create many small water sources in the game. Off by default."
          onChange={(v) => update((s) => void (s.water.streams = v))}
        />
      </Section>

      <Section id="roads" title="Roads and rail">
        <Toggle
          label="Create roads and rail"
          checked={settings.roads.enabled}
          onChange={(v) => update((s) => void (s.roads.enabled = v))}
        />
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          {ROAD_LABELS.map(([cls, label]) => (
            <Toggle
              key={cls}
              compact
              label={label}
              disabled={!settings.roads.enabled}
              checked={settings.roads.classes[cls]}
              onChange={(v) => update((s) => void (s.roads.classes[cls] = v))}
            />
          ))}
        </div>
        <Slider
          label="Level of detail"
          value={settings.roads.detail}
          min={0}
          max={1}
          step={0.05}
          format={pct}
          disabled={!settings.roads.enabled}
          help="Large areas cannot fit every street. A lower value keeps only the biggest roads."
          onChange={(v) => update((s) => void (s.roads.detail = v))}
        />
        <Toggle
          label="Street names"
          disabled={!settings.roads.enabled}
          checked={settings.roads.names}
          onChange={(v) => update((s) => void (s.roads.names = v))}
        />
      </Section>

      <Section id="trees" title="Trees">
        <Toggle
          label="Place trees"
          checked={settings.trees.enabled}
          onChange={(v) => update((s) => void (s.trees.enabled = v))}
        />
        <Slider
          label="Density"
          value={settings.trees.density}
          min={0}
          max={1}
          step={0.05}
          format={pct}
          disabled={!settings.trees.enabled}
          onChange={(v) => update((s) => void (s.trees.density = v))}
        />
        <SelectField
          label="Tree budget"
          value={settings.trees.budget}
          options={(TREE_BUDGETS.includes(settings.trees.budget)
            ? TREE_BUDGETS
            : [...TREE_BUDGETS, settings.trees.budget].sort((a, b) => a - b)
          ).map((n) => ({ value: n, label: nf(n) }))}
          help="Maximum number of trees. More trees make the map lusher but hurt performance in the game."
          onChange={(v) => update((s) => void (s.trees.budget = v))}
        />
      </Section>

      <Section id="climate" title="Climate">
        <Toggle
          label="Fetch climate"
          checked={settings.climate.enabled}
          help="Picks the climate zone and temperatures based on the location."
          onChange={(v) => update((s) => void (s.climate.enabled = v))}
        />
        {climate && climate.monthlyMeanC.length > 0 && (
          <p className="rounded-control bg-surface-2 px-3 py-2 text-xs text-muted">
            Köppen <span className="font-semibold text-text">{climate.koppen}</span>
            {' · '}coldest month {nf(Math.min(...climate.monthlyMeanC), 1)} °C
            {' · '}warmest {nf(Math.max(...climate.monthlyMeanC), 1)} °C
          </p>
        )}
      </Section>

      <Section id="resources" title="Natural resources">
        <Toggle
          label="Calculate natural resources"
          checked={settings.resources.enabled}
          help="Fertile land, forest, ore, oil and groundwater."
          onChange={(v) => update((s) => void (s.resources.enabled = v))}
        />
      </Section>

      <Section id="playability" title="Playability">
        {play ? (
          <>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">Buildable land</dt>
              <dd className="tabular-nums">{pct(play.buildableFraction)}</dd>
              <dt className="text-muted">Water</dt>
              <dd className="tabular-nums">{pct(play.waterFraction)}</dd>
            </dl>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">Start tile</dt>
              <dd className="tabular-nums">
                column {play.startTile.col + 1}, row {play.startTile.row + 1}
                {settings.manual.startTile ? ' (custom)' : ''}
              </dd>
              {result?.trees && (
                <>
                  <dt className="text-muted">Trees</dt>
                  <dd className="tabular-nums">{nf(result.trees.count)}</dd>
                </>
              )}
            </dl>
            {result?.trees && result.trees.count > 0 && (
              <p className="text-xs text-muted">
                Most common:{' '}
                {topSpecies(result.trees)
                  .map((x) => `${x.name} (${nf(x.count)})`)
                  .join(', ')}
              </p>
            )}
            {play.outsideConnections.length > 0 && (
              <div className="text-xs">
                <div className="mb-1 text-muted">Outside connections</div>
                <ul className="space-y-0.5">
                  {groupConnections(play.outsideConnections).map((g) => (
                    <li key={g.kind} className="flex justify-between gap-3">
                      <span>{CONNECTION_LABELS[g.kind]}</span>
                      <span className="tabular-nums text-muted">
                        {g.count}
                        {g.synthetic > 0 && ` (${g.synthetic} added)`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ul className="space-y-2">
              {play.checks.map((c) => {
                const { Icon, cls, label } = CHECK_ICON[c.status];
                return (
                  <li key={c.id} className="flex items-start gap-2 text-xs leading-snug">
                    <Icon size={15} className={`mt-px shrink-0 ${cls}`} aria-label={label} />
                    <span>{c.message}</span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="text-xs text-muted">The report appears after you build a map.</p>
        )}
        <ManualEditorLauncher />
      </Section>

      <ExportSection />
    </div>
  );
}
