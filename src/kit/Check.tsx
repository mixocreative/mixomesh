import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export interface CheckProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
}

/** Checkbox for a sub-option (a feature/mode is a Toggle). */
export const Check = forwardRef<HTMLInputElement, CheckProps>(function Check({ checked, onChange, label, ...rest }, ref) {
  return (
    <label className="check">
      <input ref={ref} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} {...rest} />
      <span>{label}</span>
    </label>
  );
});
