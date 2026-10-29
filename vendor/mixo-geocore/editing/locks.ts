import type { StatusMessage } from './types';
import type { EditMode } from './types';
import { busyStatus } from './status';
import { modeExtension } from './modes';

/**
 * Which panel sections a mode locks (docs/design/ui-structure.md 4.4). A locked section is
 * `inert` and dimmed, one section at a time, so the live Exit button inside the left panel keeps
 * working. Support Edit Mode locks the left panel except Modes and Check, and leaves the right
 * panel live; zones locks both panels (its only live control is the left Exit button).
 */
export type PanelSection = 'import' | 'objects' | 'transform' | 'supports' | 'check' | 'settings' | 'export';
/** The two side panels of the app shell. */
export type Panel = 'left' | 'right';

const SECTIONS: Record<Panel, readonly PanelSection[]> = {
  left: ['import', 'objects', 'transform', 'supports', 'check'],
  right: ['settings', 'export'],
};

/** Whether `section` is locked (inert, dimmed) in `mode`; an app mode decides through its `locks`. */
export function sectionLocked(section: PanelSection, mode: EditMode): boolean {
  if (mode === 'off') return false;
  const extension = modeExtension(mode);
  if (extension?.locks) return extension.locks(section);
  if (section === 'check' || section === 'settings' || section === 'export') return mode === 'zones';
  return true;
}

/** The lock note at the top of a panel: why it is dimmed and how to get out; undefined when nothing in it is locked. */
export function lockNote(panel: Panel, mode: EditMode): StatusMessage | undefined {
  return mode !== 'off' && SECTIONS[panel].some((section) => sectionLocked(section, mode)) ? busyStatus(mode) : undefined;
}
