import { useId, type ReactNode } from 'react';
import { Button } from './Button';

export interface SectionProps {
  title: ReactNode;
  /** Tri-state: true = collapsed, false = expanded, undefined = defer to `defaultCollapsed`. */
  collapsed?: boolean | undefined;
  /** Used while `collapsed` is undefined (the workspace / caller default). Falls back to expanded. */
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Shows the reset button when given. */
  onReset?: () => void;
  /** Shows the copy-from-active button when given. */
  onCopyFromActive?: () => void;
  resetLabel?: string;
  copyLabel?: string;
  children?: ReactNode;
}

export function Section({
  title, collapsed, defaultCollapsed = false, onCollapsedChange, onReset, onCopyFromActive,
  resetLabel = 'Reset section', copyLabel = 'Copy from active', children,
}: SectionProps) {
  const bodyId = useId();
  const isCollapsed = collapsed ?? defaultCollapsed;
  return (
    <section className={`mx-section${isCollapsed ? ' is-collapsed' : ''}`}>
      <header className="mx-section-head" onClick={() => onCollapsedChange?.(!isCollapsed)}>
        <button type="button" className="mx-section-toggle" aria-expanded={!isCollapsed} aria-controls={bodyId}>
          <span className="mx-chevron" aria-hidden="true" />
          <span>{title}</span>
        </button>
        {onCopyFromActive && (
          <Button variant="icon" aria-label={copyLabel} title={copyLabel}
            onClick={(e) => { e.stopPropagation(); onCopyFromActive(); }}>↧</Button>
        )}
        {onReset && (
          <Button variant="icon" aria-label={resetLabel} title={resetLabel}
            onClick={(e) => { e.stopPropagation(); onReset(); }}>↺</Button>
        )}
      </header>
      <div id={bodyId} className="mx-section-body" hidden={isCollapsed}>{children}</div>
    </section>
  );
}
