import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'danger' | 'plain' | 'icon';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** primary = the one red action per view; danger = outline, never filled; icon needs `aria-label`. */
  variant?: ButtonVariant;
  type?: 'button' | 'submit' | 'reset';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'plain', type = 'button', className, ...rest }, ref,
) {
  const cls = [variant === 'primary' ? 'primary' : variant === 'danger' ? 'danger' : variant === 'icon' ? 'mx-icon' : '', className].filter(Boolean).join(' ');
  return <button ref={ref} type={type} {...(cls ? { className: cls } : {})} {...rest} />;
});
