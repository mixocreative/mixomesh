/**
 * Shared controls of a model-surface painter: a kind switch and a brush radius in mm. The caller
 * supplies the kinds and says what they mean (here Paint | Erase of the support area); this
 * component does not know whether a mark denies or permits support.
 */
import type { ReactNode } from 'react';
import { RangeField, Segmented, type SegmentedOption } from '../../kit/index.ts';

export const BRUSH_RADIUS_RANGE = { min: 0.5, max: 10, step: 0.5 } as const;

export function SurfaceBrushBar<K extends string>({ label, kind, options, radius, radiusLabel, onKindChange, onRadiusInput, onRadiusCommit, children }: {
  label: string;
  kind: K;
  options: readonly SegmentedOption<K>[];
  radius: number;
  radiusLabel: string;
  onKindChange: (kind: K) => void;
  onRadiusInput?: (radius: number) => void;
  onRadiusCommit: (radius: number) => void;
  children?: ReactNode;
}) {
  return (
    <div className="sp-brush">
      <div className="field-row">
        <label>{label}</label>
        <Segmented label={label} value={kind} options={options} onChange={onKindChange} />
      </div>
      <RangeField label={radiusLabel} unit="mm" {...BRUSH_RADIUS_RANGE} value={radius}
        {...(onRadiusInput ? { onInput: onRadiusInput } : {})} onCommit={onRadiusCommit} />
      {children}
    </div>
  );
}
