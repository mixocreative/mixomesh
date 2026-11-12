/**
 * Support Mode controller (plan 2026-10-29 P3.2): the isolated mode in which supports are edited.
 *
 * Entering works on the selected LOGICAL objects (a multi-shader object is one; a selected group
 * stands for the objects under it):
 *  - isolation: a runtime `isolationMask` (a Babylon layer mask on the non-selected parts) hides
 *    every other object. It is not object visibility: never saved, never exported (exports read the
 *    scene state and the geometry, not the render mask), invisible to the Outliner and no undo step.
 *  - shell: `data-mode="supports"` on `#app` dims and makes `inert` the panels the mode does not use.
 *  - gizmo detached, InputManager mode context `supports` (shadowed keys inert, selection / body
 *    drag / marquee / cursor / context-menu pointer paths off).
 *  - undo/redo only step over support commands (HistoryManager scope; a batch counts when every
 *    command in it is one). An older non-support step stays put and a toast says why.
 * Exit (Done, Esc, Shift+S) restores all of it; supports stay. Esc order: support selection, then
 * the active tool, then leave the mode; P3.4 registers the first two through `addEscapeHook`.
 *
 * The controller takes its environment as `Deps` so its logic runs in vitest without a scene;
 * `supportMode` (below) is the instance wired to the app.
 */
import { EVENTS } from '../core/events.js';
import { getState, subscribe, dispatch } from '../core/StateManager.js';
import { cascadeObjectIds } from '../core/hierarchy/GroupCascade.js';
import { canonicalObjectId, shouldDisplayObject } from '../core/LogicalObjects.js';
import { createIsolation } from '../ui/isolation';
import { AssetLoader } from '../core/AssetLoader.js';
import { Selection } from '../core/Selection.js';
import { SceneManager } from '../core/SceneManager.js';
import { InputManager } from '../core/InputManager.js';
import { HistoryManager } from '../core/HistoryManager.js';
import { t } from '../i18n/index.js';

/** Mesh layer bit that no camera renders (cameras default to 0x0FFFFFFF). */
export { ISOLATION_LAYER } from '../ui/isolation';

/** Panels the mode does not use: dimmed (CSS on `[data-mode]`) and made `inert`. */
export const INERT_SELECTORS = ['#outliner', '#right-panel', '#asset-panel', '#viewport-toolbar', '.ws-switcher'] as const;

interface SceneLike { objects: Record<string, any>; groups: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any

/** The lead ids of the logical objects a selection stands for, in selection order, ghosts and parts out. */
export function supportTargets(scene: SceneLike, selectedIds: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of cascadeObjectIds(selectedIds as string[], scene)) {
    const lead = canonicalObjectId(part, scene.objects) as string;
    const obj = scene.objects[lead];
    if (!obj || obj.isGhost || !shouldDisplayObject(obj) || seen.has(lead)) continue;
    seen.add(lead);
    out.push(lead);
  }
  return out;
}

/** True for support edit commands, and for batches made only of them. */
export function isSupportsCommand(cmd: unknown): boolean {
  return (cmd as { supportsCommand?: unknown } | null)?.supportsCommand === true;
}

export type EscapeStage = 'selection' | 'tool';
export interface SupportModeInfo { active: boolean; objectIds: readonly string[] }

export interface SupportModeDeps {
  scene(): SceneLike;
  selection(): { ids: string[]; activeId: string | null };
  setSelection(ids: string[], activeId: string | null): void;
  /** Babylon meshes (part + children) of one object part id; [] when it has none. */
  meshesOf(partId: string): { layerMask: number }[];
  /** Gizmo off (true) / back to what the selection wants (false). */
  setGizmoOff(off: boolean): void;
  readOnly(): boolean;
  input: {
    setMode(mode: 'supports' | null): void;
    register(key: string, context: string, fn: () => void): void;
    unregister(key: string, context: string): void;
  };
  history: { setScope(scope: { accepts(cmd: unknown): boolean; onBlocked?(dir: 'undo' | 'redo', cmd: unknown): void } | null): void };
  /** Shell attribute + inert panels. */
  shell: { apply(on: boolean, count: number): void };
  toast(message: string): void;
  subscribe(event: string, fn: () => void): () => void;
  emit(event: string, detail: SupportModeInfo): void;
  t(key: string, params?: Record<string, unknown>): string;
}

export interface SupportModeController {
  isActive(): boolean;
  getObjectIds(): readonly string[];
  /** Objects a click on "Supports" would work on right now (0 = the button is disabled). */
  targetCount(): number;
  enter(): boolean;
  exit(): boolean;
  toggle(): void;
  /** Tell the user why Shift+S did nothing (no selected object). */
  toastNeedSelection(): void;
  /** Esc: support selection, then the active tool, then leave the mode. */
  escape(): void;
  /** P3.4 hooks: return true when Esc was consumed. Stage order is fixed: selection, then tool. */
  addEscapeHook(stage: EscapeStage, fn: () => boolean): () => void;
  /** Re-apply the mask after the scene changed under the mode. */
  refresh(): void;
  onChange(fn: (info: SupportModeInfo) => void): () => void;
}

export function createSupportMode(deps: SupportModeDeps): SupportModeController {
  let active = false;
  let ids: string[] = [];
  let saved: { ids: string[]; activeId: string | null } | null = null;
  let offs: Array<() => void> = [];
  const hooks: Record<EscapeStage, Array<() => boolean>> = { selection: [], tool: [] };
  const listeners = new Set<(info: SupportModeInfo) => void>();

  const info = (): SupportModeInfo => ({ active, objectIds: ids });
  const announce = () => {
    const snapshot = info();
    listeners.forEach((fn) => fn(snapshot));
    deps.emit(EVENTS.SUPPORT_MODE_CHANGED, snapshot);
  };

  // The mask itself lives in `src/ui/isolation.ts`, because the separator mode (U5) needs the same
  // behaviour. Nothing about it changed in the move.
  const isolation = createIsolation(deps);
  const applyMask = () => isolation.apply(ids);
  const clearMask = () => isolation.clear();

  function onSceneChange() {
    if (!active) return;
    const scene = deps.scene();
    ids = ids.filter((id) => scene.objects[id] && !scene.objects[id].isGhost);
    if (ids.length === 0) { exit(); return; }
    applyMask();
    deps.shell.apply(true, ids.length);
    announce();
  }

  function enter(): boolean {
    if (active || deps.readOnly()) return false;
    const sel = deps.selection();
    const targets = supportTargets(deps.scene(), sel.ids);
    if (targets.length === 0) return false;
    active = true;
    ids = targets;
    saved = { ids: [...sel.ids], activeId: sel.activeId };
    applyMask();
    deps.setGizmoOff(true);
    deps.input.setMode('supports');
    deps.input.register('Escape', 'supports', escape);
    deps.input.register('Shift+S', 'supports', () => { exit(); });
    deps.history.setScope({
      accepts: isSupportsCommand,
      onBlocked: (dir) => deps.toast(deps.t(dir === 'undo' ? 'supportMode.undoBlocked' : 'supportMode.redoBlocked')),
    });
    deps.shell.apply(true, ids.length);
    offs = [
      deps.subscribe(EVENTS.PROJECT_NEW, () => { exit(); }),
      deps.subscribe(EVENTS.PROJECT_LOADED, () => { exit(); }),
      deps.subscribe(EVENTS.OBJECT_REMOVED, onSceneChange),
      deps.subscribe(EVENTS.OBJECT_RESTORED, onSceneChange),
      deps.subscribe(EVENTS.ASSET_INSTANTIATED, onSceneChange),
    ];
    announce();
    return true;
  }

  function exit(): boolean {
    if (!active) return false;
    active = false;
    offs.forEach((off) => off());
    offs = [];
    deps.history.setScope(null);
    deps.input.unregister('Escape', 'supports');
    deps.input.unregister('Shift+S', 'supports');
    deps.input.setMode(null);
    clearMask();
    deps.shell.apply(false, 0);
    deps.setGizmoOff(false);
    const before = saved;
    saved = null;
    ids = [];
    if (before) {
      const now = deps.selection();
      const same = now.activeId === before.activeId && now.ids.length === before.ids.length && now.ids.every((id, i) => id === before.ids[i]);
      if (!same) deps.setSelection(before.ids, before.activeId);
    }
    announce();
    return true;
  }

  function escape() {
    for (const stage of ['selection', 'tool'] as const) {
      for (const hook of [...hooks[stage]].reverse()) if (hook()) return;
    }
    exit();
  }

  return {
    isActive: () => active,
    getObjectIds: () => ids,
    targetCount: () => supportTargets(deps.scene(), deps.selection().ids).length,
    enter,
    exit,
    toggle() { if (active) exit(); else enter(); },
    toastNeedSelection() { deps.toast(deps.t('supportMode.needSelection')); },
    escape,
    addEscapeHook(stage, fn) {
      hooks[stage].push(fn);
      return () => { hooks[stage] = hooks[stage].filter((h) => h !== fn); };
    },
    refresh: onSceneChange,
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

// ── The app instance ─────────────────────────────────────────────────────────────────────────────

const inertBefore = new Map<HTMLElement, boolean>();

function applyShell(on: boolean, count: number): void {
  if (typeof document === 'undefined') return;
  const app = document.getElementById('app');
  if (app) {
    if (on) { app.dataset.mode = 'supports'; app.dataset.modeCount = String(count); }
    else { delete app.dataset.mode; delete app.dataset.modeCount; }
  }
  if (on) {
    for (const el of document.querySelectorAll<HTMLElement>(INERT_SELECTORS.join(','))) {
      if (!inertBefore.has(el)) inertBefore.set(el, el.inert);
      el.inert = true;
    }
    // Focus inside a panel that just went inert would otherwise keep swallowing keys.
    const focused = document.activeElement as HTMLElement | null;
    if (focused && focused !== document.body && focused.closest('[inert]')) focused.blur();
  } else {
    for (const [el, was] of inertBefore) el.inert = was;
    inertBefore.clear();
  }
}

let toastSink: (message: string) => void = (message) => dispatch(EVENTS.TOAST, { message, type: 'info', duration: 6000 });
/** The kit toast host (SupportModeUI) installs itself here. */
export function setSupportModeToast(fn: ((message: string) => void) | null): void {
  toastSink = fn ?? ((message) => dispatch(EVENTS.TOAST, { message, type: 'info', duration: 6000 }));
}

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy JS modules are untyped */
export const supportMode = createSupportMode({
  scene: () => getState().scene,
  selection: () => ({ ids: [...Selection.getSelectedIds()], activeId: Selection.getActiveId() }),
  setSelection: (ids, activeId) => (Selection as any).set(ids, activeId),
  meshesOf: (partId) => {
    const mesh = (AssetLoader as any).getBabylonMesh?.(partId);
    return mesh ? [mesh, ...mesh.getChildMeshes(false)] : [];
  },
  setGizmoOff: (off) => (SceneManager as any).setViewOnly(off),
  readOnly: () => (InputManager as any).isReadOnly(),
  input: InputManager as any,
  history: HistoryManager as any,
  shell: { apply: applyShell },
  toast: (message) => toastSink(message),
  subscribe: (event, fn) => subscribe(event, fn) as () => void,
  emit: (event, detail) => dispatch(event, detail),
  t,
});
