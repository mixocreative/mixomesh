import { useId, useState, type InputHTMLAttributes } from 'react';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onInput' | 'type'> {
  label: string;
  value: string;
  /** Maps typed text to what the field accepts (e.g. uppercase, drop other characters). */
  filter?: (text: string) => string;
  /** Shown under the field while the last edit had characters the filter removed. */
  rejectedHint?: string;
  /** Once: Enter or blur with a changed text. One undo step. */
  onCommit: (value: string) => void;
}

/**
 * Single-line text field. `filter` runs on every keystroke; when it removes characters the field
 * shows `rejectedHint` (aria-live) until the next accepted edit. Enter / blur commit, Esc reverts.
 */
export function TextField({ label, value, filter, rejectedHint, onCommit, disabled, ...rest }: TextFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string>();
  const [rejected, setRejected] = useState(false);
  const shown = draft ?? value;
  const commit = () => {
    const v = draft;
    setDraft(undefined);
    setRejected(false);
    if (v !== undefined && v !== value) onCommit(v);
  };
  return (
    <>
    <div className="field-row">
      <label htmlFor={id}>{label}</label>
      <span className="number mx-text">
        <input
          id={id} type="text" value={shown} disabled={disabled} aria-invalid={rejected || undefined}
          onChange={(e) => {
            const raw = e.target.value;
            const next = filter ? filter(raw) : raw;
            // Case changes are not rejections; losing characters is.
            setRejected(next.length < raw.length && rejectedHint !== undefined);
            setDraft(next);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape' && draft !== undefined) { e.preventDefault(); e.stopPropagation(); setDraft(undefined); setRejected(false); }
          }}
          {...rest}
        />
      </span>
    </div>
    {rejected && <small className="mx-hint" role="status">{rejectedHint}</small>}
    </>
  );
}
