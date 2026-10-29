import { Button } from './Button';

export interface ProgressRowProps {
  label: string;
  /** 0..1 determinate; omit for indeterminate. */
  value?: number;
  onCancel?: () => void;
  cancelLabel?: string;
}

export function ProgressRow({ label, value, onCancel, cancelLabel = 'Cancel' }: ProgressRowProps) {
  const det = value !== undefined;
  const v = det ? Math.min(1, Math.max(0, value)) : 0;
  return (
    <div className="mx-progress">
      <div className="field-row">
        <span>{label}</span>
        {det && <small className="mx-progress-pct">{Math.round(v * 100)}%</small>}
        {onCancel && <Button onClick={onCancel}>{cancelLabel}</Button>}
      </div>
      <div className={`progress-track${det ? '' : ' mx-indeterminate'}`} role="progressbar" aria-label={label}
        aria-valuemin={0} aria-valuemax={1} {...(det ? { 'aria-valuenow': v } : {})}>
        <div className="progress-fill" style={det ? { width: `${v * 100}%` } : undefined} />
      </div>
    </div>
  );
}
