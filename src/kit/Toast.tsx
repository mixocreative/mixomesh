import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';

export interface ToastSpec {
  message: string;
  /** Optional action button, e.g. Undo. Runs, then the toast is dismissed. */
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss delay in ms; 0 = stays until dismissed. Default 5000. */
  timeoutMs?: number;
}

interface ToastItem extends ToastSpec { id: number }

export interface ToastApi {
  push: (t: ToastSpec) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToasts(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToasts needs a <ToastProvider>');
  return api;
}

export interface ToastProps extends ToastSpec { onDismiss: () => void }

/** One toast (presentational). Owns its auto-dismiss timer. */
export function Toast({ message, action, timeoutMs = 5000, onDismiss }: ToastProps) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (timeoutMs <= 0) return;
    const t = setTimeout(() => dismissRef.current(), timeoutMs);
    return () => clearTimeout(t);
  }, [timeoutMs]);
  return (
    <div className="mx-toast" role="status">
      <span className="mx-toast-msg">{message}</span>
      {action && <Button onClick={() => { action.onClick(); onDismiss(); }}>{action.label}</Button>}
      <Button variant="icon" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>×</Button>
    </div>
  );
}

/** Stacks toasts, newest last. */
export function ToastHost({ toasts, dismiss }: { toasts: readonly (ToastSpec & { id: number })[]; dismiss: (id: number) => void }) {
  return (
    <div className="mx-toasts" aria-live="polite">
      {toasts.map((t) => <Toast key={t.id} message={t.message} {...(t.action ? { action: t.action } : {})} {...(t.timeoutMs !== undefined ? { timeoutMs: t.timeoutMs } : {})} onDismiss={() => dismiss(t.id)} />)}
    </div>
  );
}

/** Context only (no global singleton): provides push/dismiss and renders the host. */
export function ToastProvider({ children }: { children?: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback((t: ToastSpec) => {
    const id = nextId.current++;
    setToasts((l) => [...l, { ...t, id }]);
    return id;
  }, []);
  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastHost toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}
