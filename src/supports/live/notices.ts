/**
 * Notices of the live support code that are shown as toasts in the Support Mode panel (plan P3.5).
 * The panel's toast host subscribes; with no host mounted (the mode is closed) a notice is dropped.
 */
export interface SupportNotice {
  message: string;
  action?: { label: string; onClick: () => void };
}

const listeners = new Set<(notice: SupportNotice) => void>();

export function notify(notice: SupportNotice): void {
  listeners.forEach((fn) => fn(notice));
}

export function onNotice(fn: (notice: SupportNotice) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
