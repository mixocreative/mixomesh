import { useId, useRef, useState } from 'react';
import { clampNumber, decimalsOf, formatNumber, parseNumber } from './numberParse';

export interface RangeFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  /** Live, while the slider moves. No undo entry. */
  onInput?: (value: number) => void;
  /** Once: slider release / key up, or Enter / blur of the number. One undo step. */
  onCommit: (value: number) => void;
}

/** Slider + typed number. Slider drag: onInput per move, onCommit on release (or key up). */
export function RangeField({ label, value, min, max, step, unit, disabled, onInput, onCommit }: RangeFieldProps) {
  const id = useId();
  const dirty = useRef(false);
  const last = useRef(value);
  const [draft, setDraft] = useState<string>();
  const precision = decimalsOf(step);
  const settle = () => {
    if (dirty.current) { dirty.current = false; onCommit(last.current); }
  };
  const commitText = () => {
    const n = draft === undefined ? undefined : parseNumber(draft, unit);
    setDraft(undefined);
    if (n !== undefined) {
      const v = clampNumber(n, min, max);
      if (v !== value) onCommit(v);
    }
  };
  return (
    <div className="field-row mx-range">
      <label htmlFor={id}>{label}</label>
      <input
        id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => { const v = Number(e.target.value); last.current = v; dirty.current = true; onInput?.(v); }}
        onPointerUp={settle} onKeyUp={settle} onBlur={settle}
      />
      <span className="number">
        <input
          type="text" inputMode="decimal" aria-label={`${label} value`} disabled={disabled}
          value={draft ?? formatNumber(value, precision)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => { if (e.key === 'Enter') commitText(); else if (e.key === 'Escape') setDraft(undefined); }}
        />
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}
