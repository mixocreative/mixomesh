import { forwardRef, useId, type ForwardedRef, type Ref, type SelectHTMLAttributes } from 'react';

export interface SelectOption<V extends string> { value: V; label: string; disabled?: boolean }

export interface SelectProps<V extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  label: string;
  options: readonly SelectOption<V>[];
  value: V;
  onChange: (value: V) => void;
}

function SelectInner<V extends string>({ label, options, value, onChange, ...rest }: SelectProps<V>, ref: ForwardedRef<HTMLSelectElement>) {
  const id = useId();
  return (
    <div className="field-row">
      <label htmlFor={id}>{label}</label>
      <select ref={ref} id={id} className="mx-select" value={value} onChange={(e) => onChange(e.target.value as V)} {...rest}>
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
    </div>
  );
}

export const Select = forwardRef(SelectInner) as <V extends string>(p: SelectProps<V> & { ref?: Ref<HTMLSelectElement> }) => ReturnType<typeof SelectInner>;
