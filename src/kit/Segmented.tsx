import { type ReactNode } from 'react';

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<V extends string> {
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the group. */
  label: string;
  disabled?: boolean;
}

/** One chosen option (aria-pressed, ink fill). Arrow keys move the choice; the group is one tab stop. */
export function Segmented<V extends string>({ options, value, onChange, label, disabled }: SegmentedProps<V>) {
  const enabled = options.filter((o) => !o.disabled);
  const move = (dir: 1 | -1) => {
    const i = enabled.findIndex((o) => o.value === value);
    const next = enabled[(i + dir + enabled.length) % enabled.length];
    if (next) onChange(next.value);
  };
  const hasValue = options.some((x) => x.value === value);
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          tabIndex={value === o.value || (!hasValue && i === 0) ? 0 : -1}
          title={o.title}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
          }}
        >{o.label}</button>
      ))}
    </div>
  );
}
