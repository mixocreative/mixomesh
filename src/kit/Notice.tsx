import type { ReactNode } from 'react';
import { Button } from './Button';

export type NoticeSeverity = 'info' | 'warn' | 'error';

export interface NoticeAction { label: string; onClick: () => void }

export interface NoticeProps {
  severity?: NoticeSeverity;
  children: ReactNode;
  /** Rendered on their own row below the text. */
  actions?: readonly NoticeAction[];
}

/** Problem notice at full panel width; actions never share the text row. */
export function Notice({ severity = 'info', children, actions = [] }: NoticeProps) {
  return (
    <div className={`mx-notice mx-notice-${severity}`} role={severity === 'error' ? 'alert' : 'status'}>
      <div className="mx-notice-text">{children}</div>
      {actions.length > 0 && (
        <div className="mx-notice-actions">
          {actions.map((a) => <Button key={a.label} onClick={a.onClick}>{a.label}</Button>)}
        </div>
      )}
    </div>
  );
}
