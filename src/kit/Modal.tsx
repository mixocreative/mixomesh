import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button';

export interface ModalAction {
  label: string;
  onClick: () => void;
  /** At most one `primary` is honoured; extra primaries render as plain. */
  variant?: 'primary' | 'danger' | 'plain';
  disabled?: boolean;
}

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
  actions?: readonly ModalAction[];
}

const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** Accessible dialog: focus trapped, Esc closes, focus returns to the opener. Rendered in place
 *  (inside .mx-kit) so the scoped tokens apply. */
export function Modal({ open, title, onClose, children, actions = [] }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const dlg = dialogRef.current;
    const first = dlg?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dlg)?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) { e.preventDefault(); return; }
    const a = document.activeElement;
    const firstEl = items[0] as HTMLElement;
    const lastEl = items[items.length - 1] as HTMLElement;
    if (e.shiftKey && (a === firstEl || a === dialogRef.current)) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && a === lastEl) { e.preventDefault(); firstEl.focus(); }
  };

  let primarySeen = false;
  return (
    <div className="mx-modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="mx-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id={titleId} className="mx-modal-title">{title}</h2>
        <div className="mx-modal-body">{children}</div>
        {actions.length > 0 && (
          <div className="mx-modal-actions">
            {actions.map((a) => {
              let v = a.variant ?? 'plain';
              if (v === 'primary') { if (primarySeen) v = 'plain'; primarySeen = true; }
              return <Button key={a.label} variant={v} disabled={a.disabled} onClick={a.onClick}>{a.label}</Button>;
            })}
          </div>
        )}
      </div>
    </div>
  );
}
