import { useId, type ReactNode } from 'react';

export interface FieldRowProps {
  label: ReactNode;
  /** The control; a render function receives the id the label is bound to. */
  children: ReactNode | ((controlId: string) => ReactNode);
  hint?: ReactNode;
}

/** Label left, control right, optional hint line beneath (.field-row layout). */
export function FieldRow({ label, children, hint }: FieldRowProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="mx-fieldrow">
      <div className="field-row">
        <label htmlFor={id}>{label}</label>
        <div className="mx-fieldrow-ctl" {...(hint ? { 'aria-describedby': hintId } : {})}>
          {typeof children === 'function' ? children(id) : children}
        </div>
      </div>
      {hint && <div id={hintId} className="mx-hint">{hint}</div>}
    </div>
  );
}
