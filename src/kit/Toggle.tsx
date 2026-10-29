import { forwardRef, type ButtonHTMLAttributes } from 'react';

export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type'> {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
}

/** Toggle button for a feature / mode / visibility (a sub-option is a Check). Pressed = ink fill. */
export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle({ pressed, onChange, onClick, ...rest }, ref) {
  return <button ref={ref} type="button" aria-pressed={pressed} onClick={(e) => { onClick?.(e); if (!e.defaultPrevented) onChange(!pressed); }} {...rest} />;
});
