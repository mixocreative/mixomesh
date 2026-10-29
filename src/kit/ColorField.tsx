import { forwardRef, useEffect, useId, useImperativeHandle, useRef, type InputHTMLAttributes } from 'react';

export interface ColorFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'onInput'> {
  label: string;
  /** "#rrggbb" */
  value: string;
  /** Fires while the picker is dragged. */
  onInput?: (hex: string) => void;
  /** Fires when the picker closes / the value settles (the native `change` event). */
  onCommit: (hex: string) => void;
}

/**
 * Native colour input with a hex readout. `onInput` is live, `onCommit` is the native change
 * event. (React's onChange fires on every input event, so commit listens to the DOM directly.)
 */
export const ColorField = forwardRef<HTMLInputElement, ColorFieldProps>(function ColorField({ label, value, onInput, onCommit, ...rest }, ref) {
  const id = useId();
  const el = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => el.current as HTMLInputElement);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const h = () => commit.current(node.value);
    node.addEventListener('change', h);
    return () => node.removeEventListener('change', h);
  }, []);
  return (
    <div className="field-row">
      <label htmlFor={id}>{label}</label>
      <span className="number">
        <input
          ref={el} id={id} type="color" className="mx-color" value={value}
          onInput={(e) => onInput?.((e.target as HTMLInputElement).value)}
          onChange={() => {}}
          {...rest}
        />
        <small className="mx-hex">{value.toUpperCase()}</small>
      </span>
    </div>
  );
});
