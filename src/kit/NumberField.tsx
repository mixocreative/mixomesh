import { useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { clampNumber, decimalsOf, formatNumber, parseNumber, type NumberUnit } from './numberParse';

export interface NumberFieldProps {
  label: string;
  value: number;
  /** mm, deg or × (multiplier); shown after the value, accepted when typed. */
  unit?: NumberUnit;
  min?: number;
  max?: number;
  /** Arrow-key step and scrub granularity (one step per 4 px). Shift x10, Alt /10. */
  step?: number;
  disabled?: boolean;
  /** Live while label-scrubbing. No undo entry. */
  onInput?: (value: number) => void;
  /** Once: scrub release, Enter, blur, or an arrow step. One undo step. */
  onCommit: (value: number) => void;
}

const PX_PER_STEP = 4;

/**
 * Number field. Drag the label sideways to scrub (like Blender): onInput per move, onCommit on
 * release. Typed text ("2mm", "2,5", "1.5x") is clamped to min/max and commits on Enter or blur;
 * Esc reverts; ArrowUp/Down step and commit.
 */
export function NumberField({ label, value, unit, min, max, step = 1, disabled, onInput, onCommit }: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string>();
  const [scrubbing, setScrubbing] = useState(false);
  const drag = useRef<{ x: number; start: number; cur: number; moved: boolean } | null>(null);
  const precision = Math.min(decimalsOf(step) + 1, 6);
  const show = (n: number) => formatNumber(n, precision);

  const commitText = () => {
    const n = draft === undefined ? undefined : parseNumber(draft, unit);
    setDraft(undefined);
    if (n === undefined) return;
    const v = clampNumber(n, min, max);
    if (v !== value) onCommit(v);
  };
  const stepBy = (dir: 1 | -1, e: { shiftKey: boolean; altKey: boolean }) => {
    const s = step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    onCommit(clampNumber(Number((value + dir * s).toFixed(precision)), min, max));
    setDraft(undefined);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (disabled || e.button !== 0) return;
    drag.current = { x: e.clientX, start: value, cur: value, moved: false };
    setScrubbing(true);
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = ev.clientX - d.x;
      if (!d.moved && Math.abs(dx) < 2) return;
      d.moved = true;
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      d.cur = clampNumber(Number((d.start + (dx / PX_PER_STEP) * step * mult).toFixed(precision)), min, max);
      onInput?.(d.cur);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      const d = drag.current;
      drag.current = null;
      setScrubbing(false);
      if (d?.moved) onCommit(d.cur);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  };

  return (
    <div className="field-row mx-number">
      <label htmlFor={id} className={`mx-scrub${scrubbing ? ' scrubbing' : ''}`} onPointerDown={onPointerDown}>{label}</label>
      <span className="number">
        <input
          id={id} type="text" inputMode="decimal" spellCheck={false} disabled={disabled}
          value={draft ?? show(value)}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText();
            else if (e.key === 'Escape') setDraft(undefined);
            else if (e.key === 'ArrowUp') { e.preventDefault(); stepBy(1, e); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); stepBy(-1, e); }
          }}
        />
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}
