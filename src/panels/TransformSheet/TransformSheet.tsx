// Numeric "Transform" sheet (overhaul 8.5), React twin. Precise Move / Rotate / Scale for touch,
// where typing into the G/R/S modal is not possible. One Apply = one TransformCommand (one undo
// step). It shows no live transform values, so it never re-renders while the gizmo drags; it
// renders only when opened, closed or edited.

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Button, NumberField } from '../../kit/index.ts';
import { mountPanel, useCommand, useT } from '../../react/index.ts';
import { Toast } from '../../ui/Toast.js';
import { icon } from '../../core/Icons.js';
import { escapeAttr } from '../../ui/renderSafe.js';
import { tr } from '../../ui/lib/tr.js';
import { SCALE_PERCENT_MAX, SCALE_PERCENT_MIN, SHEET_DEFAULTS, type SheetValues } from './sheetPlan.ts';
import { buildSheetCommand } from './buildSheetCommand.ts';

// ── open/closed state, outside React so the toolbar button can toggle it ──
let _open = false;
const _subs = new Set<() => void>();
const _set = (on: boolean) => { if (_open === on) return; _open = on; _subs.forEach((fn) => fn()); };
const _subscribe = (fn: () => void) => { _subs.add(fn); return () => { _subs.delete(fn); }; };

export function open() { _set(true); }
export function close() { _set(false); }
export function toggle() { _set(!_open); }
export function isOpen() { return _open; }

type Key = Exclude<keyof SheetValues, 'scalePct'>;
const GROUPS: { group: 'move' | 'rotate'; unit: 'mm' | 'deg'; keys: [Key, string][] }[] = [
  { group: 'move', unit: 'mm', keys: [['moveX', 'X'], ['moveY', 'Y'], ['moveZ', 'Z']] },
  { group: 'rotate', unit: 'deg', keys: [['rotX', 'X'], ['rotY', 'Y'], ['rotZ', 'Z']] },
];

function SheetView() {
  useT();
  const isOpenNow = useSyncExternalStore(_subscribe, () => _open, () => _open);
  const { run } = useCommand();
  const [values, setValues] = useState<SheetValues>({ ...SHEET_DEFAULTS });
  const latest = useRef<SheetValues>({ ...SHEET_DEFAULTS });
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpenNow) sheet.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [isOpenNow]);

  if (!isOpenNow) return null;

  const set = (key: keyof SheetValues, v: number) => {
    latest.current = { ...latest.current, [key]: v };
    setValues(latest.current);
  };

  const apply = () => {
    const r = buildSheetCommand(latest.current);
    if (r.status === 'nothing') Toast.show(tr('toast.nothingSelected', 'Nothing selected'), 'info', 2000);
    else if (r.status === 'locked') Toast.show(tr('toast.lockedNoTransform', 'Locked items cannot be transformed'), 'info', 2000);
    else if (r.status === 'applied') {
      run(r.command);
      latest.current = { ...SHEET_DEFAULTS };
      setValues(latest.current);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Typing must never reach the canvas shortcuts (G/R/S/X/Delete...).
    e.stopPropagation();
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); apply(); }
    else if (e.key === 'Escape') close();
  };

  const label = (g: 'move' | 'rotate' | 'scale') =>
    tr(`transformSheet.${g}`, g === 'move' ? 'Move' : g === 'rotate' ? 'Rotate' : 'Scale');
  const title = tr('transformSheet.title', 'Transform');

  return (
    <div ref={sheet} className="transform-sheet" role="dialog" aria-label={title} onKeyDown={onKeyDown}>
      <div className="ts-head">
        <b>{title}</b>
        <span className="ts-hint">{tr('transformSheet.hint', 'Relative to the pivot. 0 (scale 100%) = no change.')}</span>
        <Button variant="icon" className="ts-close" aria-label={tr('transformSheet.close', 'Close')} onClick={close}>×</Button>
      </div>
      {GROUPS.map(({ group, unit, keys }) => (
        <div key={group} className="ts-row" role="group" aria-label={label(group)}>
          <b>{label(group)}</b>
          {keys.map(([key, axis]) => (
            <NumberField key={key} label={axis} unit={unit} step={1} value={values[key]} onCommit={(v) => set(key, v)} />
          ))}
        </div>
      ))}
      <div className="ts-row" role="group" aria-label={label('scale')}>
        <b>{label('scale')}</b>
        <NumberField
          label="%" step={1} min={SCALE_PERCENT_MIN} max={SCALE_PERCENT_MAX}
          value={values.scalePct} onCommit={(v) => set('scalePct', v)}
        />
      </div>
      <div className="ts-actions">
        <Button variant="primary" className="ts-apply" onClick={apply}>{tr('transformSheet.apply', 'Apply')}</Button>
      </div>
    </div>
  );
}

let _unmount: (() => void) | null = null;

/** Mount the sheet into the viewport host. Idempotent. */
export function init(host: HTMLElement | null) {
  if (_unmount || !host) return;
  const root = document.createElement('div');
  root.id = 'transform-sheet-root';
  root.className = 'mx-kit';
  root.style.display = 'contents';
  host.appendChild(root);
  _unmount = mountPanel('transform-sheet-root', <SheetView />);
}

export function unmount() {
  _unmount?.();
  _unmount = null;
  document.getElementById('transform-sheet-root')?.remove();
  _set(false);
}

/** Toolbar button markup (visible only on touch via CSS). */
export function buttonHtml() {
  const title = tr('transformSheet.openTitle', 'Numeric transform (Move / Rotate / Scale)');
  return `<button class="vt-btn vt-touch-only" data-kind="transformSheet" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}">${icon('SlidersHorizontal', { width: 14, height: 14 })}</button>`;
}

export const TransformSheet = { init, unmount, open, close, toggle, isOpen, buttonHtml };
