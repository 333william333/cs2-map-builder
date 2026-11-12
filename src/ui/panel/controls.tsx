import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

const ring = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const field = `rounded-control border border-line bg-surface-2 px-2 py-1.5 text-sm ${ring} focus:border-accent`;

export function Help({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1 text-xs leading-snug text-muted">
      {children}
    </p>
  );
}

function readOpen(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(`cs2mb.section.${key}`);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

export function Section({
  id,
  title,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const bodyId = useId();
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(`cs2mb.section.${id}`, next ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <section className="border-b border-line">
      <h2 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
          className={`flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold hover:bg-surface-2 ${ring}`}
        >
          {title}
          <ChevronDown
            size={16}
            aria-hidden
            className={`text-muted transition-transform ${open ? '' : '-rotate-90'}`}
          />
        </button>
      </h2>
      <div id={bodyId} hidden={!open} className="space-y-4 px-4 pb-4 pt-1">
        {children}
      </div>
    </section>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
  help,
  compact,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  help?: string;
  compact?: boolean;
}) {
  const id = useId();
  const helpId = `${id}-h`;
  return (
    <div>
      <label
        htmlFor={id}
        className={`flex items-center justify-between gap-3 text-sm ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
      >
        <span className={compact ? 'text-[13px]' : ''}>{label}</span>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-describedby={help ? helpId : undefined}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className="relative h-5 w-9 shrink-0 rounded-full border border-line bg-surface-2 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3.5 after:w-3.5 after:rounded-full after:bg-muted after:transition-all peer-checked:border-accent peer-checked:bg-accent/30 peer-checked:after:translate-x-4 peer-checked:after:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent"
        />
      </label>
      {help && <Help id={helpId}>{help}</Help>}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  help,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  help?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const helpId = `${id}-h`;
  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <label htmlFor={id}>{label}</label>
        <span className="tabular-nums text-muted">{format ? format(value) : value}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={help ? helpId : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`h-2 w-full cursor-pointer accent-accent ${ring}`}
      />
      {help && <Help id={helpId}>{help}</Help>}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const id = useId();
  const move = (dir: number, i: number) => {
    const next = options[(i + dir + options.length) % options.length]!;
    onChange(next.value);
    requestAnimationFrame(() => document.getElementById(`${id}-${next.value}`)?.focus());
  };
  return (
    <div>
      <div id={id} className="mb-1 text-sm">
        {label}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={id}
        className="flex rounded-control border border-line bg-surface-2 p-0.5"
      >
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              id={`${id}-${o.value}`}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  move(1, i);
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  move(-1, i);
                }
              }}
              className={`flex-1 rounded-[6px] px-2 py-1 text-xs font-medium ${ring} ${
                on ? 'bg-accent text-bg' : 'text-muted hover:text-text'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  help,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  help?: string;
}) {
  const id = useId();
  const helpId = `${id}-h`;
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string) => {
    setDraft(null);
    let n = Number(text.replace(',', '.'));
    if (text.trim() === '' || !Number.isFinite(n)) return;
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    onChange(n);
  };
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={draft ?? String(value)}
          aria-describedby={help ? helpId : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
          className={`w-28 tabular-nums ${field}`}
        />
        {unit && <span className="text-sm text-muted">{unit}</span>}
      </div>
      {help && <Help id={helpId}>{help}</Help>}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  help?: string;
}) {
  const id = useId();
  const helpId = `${id}-h`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        aria-describedby={help ? helpId : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full ${field}`}
      />
      {help && <Help id={helpId}>{help}</Help>}
    </div>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  help,
}: {
  label: string;
  value: number;
  options: { value: number; label: string }[];
  onChange: (v: number) => void;
  help?: string;
}) {
  const id = useId();
  const helpId = `${id}-h`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm">
        {label}
      </label>
      <select
        id={id}
        value={value}
        aria-describedby={help ? helpId : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`w-full ${field}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {help && <Help id={helpId}>{help}</Help>}
    </div>
  );
}
