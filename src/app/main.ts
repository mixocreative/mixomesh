import { Toast, safeAsync } from '../ui/Toast.js';
import { StatusBar } from '../ui/StatusBar.js';
import { JobActivityPanel } from '../ui/JobActivity.js';
import { SceneManager } from '../core/SceneManager.js';
import { InputManager } from '../core/InputManager.js';
import { AssetPanel } from '../ui/AssetPanel.js';
import { BootBanner } from '../ui/BootBanner.js';
import { ViewportDrop } from '../ui/ViewportDrop.js';
import { Outliner } from '../ui/Outliner.js';
import { PropertiesPanel } from '../ui/PropertiesPanel.js';
import { RefinementController } from '../core/refinement/RefinementController.js';
import { ShaderPanel } from '../ui/ShaderPanel.js';
import { ScenePanel } from '../ui/ScenePanel.js';
import { PrintPanel } from '../ui/PrintPanel.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { Modal } from '../ui/Modal.js';
import { ImportError } from '../ui/ImportError.js';
import { ViewportToolbar } from '../ui/ViewportToolbar.js';
import { ViewportToggles } from '../ui/ViewportToggles.js';
import { StatsHud } from '../ui/StatsHud.js';
import { MeshStats } from '../ui/MeshStats.js';
import { NavCube } from '../ui/NavCube.js';
import { push, TransformCommand } from '../core/HistoryManager.js';
import { MeshValidator } from '../core/MeshValidator.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { shouldGuardUnload } from '../core/UnloadGuard.js';
import { SettingsStore } from '../core/SettingsStore.js';
import { loadMaterialPresets } from '../core/print/MaterialPresets.js';
import { ProjectMenu } from '../ui/ProjectMenu.js';
import { AppShell } from '../ui/AppShell.js';
import { PanelSheets } from '../ui/PanelSheets.js';
import { LaunchRequests } from '../core/LaunchRequests.js';
import { ApiBridge } from '../core/api/ApiBridge.js';
import { ViewerMode } from '../ui/ViewerMode.js';
import { Workspace } from '../ui/Workspace.js';
import { NumberScrub } from '../ui/NumberScrub.js';
import { CursorPanel } from '../ui/CursorPanel.js';
import { CopyPaste } from '../ui/CopyPaste.js';
import { ViewportEmptyState } from '../ui/ViewportEmptyState.js';
import * as i18n from '../i18n/index.js';
import { storage } from '../core/storage/StorageAdapter.js';
import { reportKvDamage } from '../core/persist/KvDamage.js';
import { engine, engineGate } from '../core/storage/capabilities.js';

type TransformCommit = {
  prev: unknown;
  next: unknown;
  alreadyApplied?: boolean;
};

type ContextMenuInfo = Parameters<typeof ContextMenu.open>[0];

// Boot gate (task 4.4): nothing touches storage — and no UI initialises —
// until the engine is supported and the active adapter says it is usable.
// Engine (task 8.1, AGENTS rule 5): chromium + webkit pass, Firefox/other are
// blocked with a message naming the supported browsers. Adapter: Chrome/Edge
// File System Access or the Safari OPFS tier + IndexedDB probe (non-blocking);
// desktop: the preload bridge is complete and main answers `storage:ready`.
// Failure = one blocking screen naming the problem, never a half-booted app.
async function gateStorage(): Promise<boolean> {
  i18n.init();    // detect locale, set _locale, apply <html lang>, fire LOCALE_CHANGED; the gate's messages read it
  const blocked = engineGate(engine);
  if (blocked) {
    renderBlockingMessage(blocked.title, blocked.message);
    return false;
  }
  try {
    await storage.ready();
    return true;
  } catch (err) {
    const e = err as { title?: string; message?: string; textKey?: string } | null;
    console.error('Storage unavailable:', err);
    renderBlockingMessage(
      (e?.textKey && i18n.t(`${e.textKey}.title`)) || e?.title || 'Storage unavailable',
      (e?.textKey && i18n.t(`${e.textKey}.body`)) || e?.message || 'MIXOMESH could not initialise its file storage.',
    );
    return false;
  }
}

async function bootstrap() {
  Toast.init();
  void reportKvDamage(storage);
  StatusBar.init();
  JobActivityPanel.init();   // every worker job shows up here (heavy-mesh spec §5)

  const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('Viewport canvas missing');

  await SceneManager.init(canvas);
  // Diagnostic: which render backend won (WebGPU preferred, WebGL fallback).
  // Read by the browser smoke and handy in live DevTools / the status bar.
  (window as unknown as { __MX_ENGINE?: string }).__MX_ENGINE =
    SceneManager.isWebGPU() ? 'webgpu' : 'webgl';
  InputManager.init(SceneManager.getScene());

  // Seed per-user panel settings (render look, grid, overlays, print, gizmo,
  // pivot) onto the factory boot state BEFORE panels render. File-wins: this
  // only affects the empty boot / New scene; opening a .mixo overrides it.
  SettingsStore.seedBootState();

  SceneManager.setTransformCommitHandler(({ prev, next, alreadyApplied }: TransformCommit) => {
    push(new TransformCommand(prev, next, { alreadyApplied }));
  });

  Modal.init();
  ImportError.init();     // registers the import-failure detail modal
  MeshValidator.init();   // validation-cache invalidation hooks (A6)
  RefinementController.init();
  Outliner.init();
  PropertiesPanel.init();
  ShaderPanel.init();
  ScenePanel.init();
  // Material presets come from an editable file (public/config/materials.json
  // on the web, <userData>/config/materials.json on desktop) — loaded before
  // the Print panel first renders its Cost block.
  await loadMaterialPresets();
  PrintPanel.init();
  ContextMenu.init();
  AssetPanel.init();
  ViewportToolbar.init();
  ViewportToggles.init();
  StatsHud.init();   // viewport statistics, bottom-left
  MeshStats.init();       // live mesh stats in the status-bar centre segment
  NavCube.init();
  PersistenceManager.init();
  wireCloseFlow();
  ProjectMenu.init();
  AppShell.init();
  Workspace.init();   // after AppShell — applies workspace layout over the shell defaults
  NumberScrub.init(); // wheel-scrub on number inputs (panel never scrolls under them)
  CursorPanel.init(); // 3D-cursor N-panel (Shift+N) — mounts into #viewport
  CopyPaste.init();   // Ctrl+C / Ctrl+V with aspect chooser
  SettingsStore.init(); // autosave hooks on the Scene/Print panel bodies (now mounted)
  PanelSheets.init(); // < 1280 px: edge tabs + slide-over sheets (8.3)
  ViewerMode.init();  // < 768 px: read-only phone viewer (8.6)

  const viewport = document.getElementById('viewport');
  if (!viewport) throw new Error('Viewport root missing');
  ViewportDrop.attach(viewport, SceneManager.getScene());
  ViewportEmptyState.init();

  InputManager.setContextMenuHandler((info: ContextMenuInfo) => ContextMenu.open(info));
  Outliner.setContextMenuHandler((info: ContextMenuInfo) => ContextMenu.open(info));

  InputManager.register('Ctrl+S', 'global', () => safeAsync(() => PersistenceManager.save()));
  InputManager.register('Ctrl+Shift+S', 'global', () => safeAsync(() => PersistenceManager.saveAs()));
  InputManager.register('Ctrl+O', 'global', () => safeAsync(() => PersistenceManager.open()));
  InputManager.register('Ctrl+N', 'global', () => safeAsync(() => PersistenceManager.newProject()));

  // Push the seeded settings (render look, grid, display overlays, bed, gizmo
  // space, pivot) to the engine. Inspection overlays sit factory-off here.
  SettingsStore.applyToScene();

  PersistenceManager.startAutosave();
  canvas.focus();
  // One non-blocking boot banner (task 4.7, Decision 4): offers re-mounting
  // the last folder and/or recovering the newest autosave that is newer than
  // its project's last save. Recover re-mounts first (handle-backed assets
  // resolve through the folder — autosave skips their bytes, A9).
  safeAsync(() => BootBanner.runBootChecks());
  // Desktop launch args (LI.4): pull the queued batch + subscribe — AFTER the boot
  // checks are kicked off, same tick (plan D5). No-op without the bridge.
  safeAsync(() => LaunchRequests.init());
  // Automation API (API.6): answer requests from other apps. No-op without the bridge.
  safeAsync(() => ApiBridge.init());
}

function wireCloseFlow() {
  const api = (window as unknown as {
    electronAPI?: {
      onCloseRequested?: (callback: () => void) => void;
      respondToClose?: (result: { action: 'save' | 'discard' | 'cancel'; saved?: boolean }) => void;
    };
  }).electronAPI;
  window.addEventListener('beforeunload', event => {
    if (!shouldGuardUnload({
      isElectron: !!api,
      dirty: PersistenceManager.isDirty(),
      smoke: false, // smoke runs bypass in electron/main.cjs (will-prevent-unload), non-prod only
      isProd: !!(import.meta as { env?: { PROD?: boolean } }).env?.PROD,
    })) return;
    event.preventDefault();
    event.returnValue = '';
  });
  api?.onCloseRequested?.(() => {
    safeAsync(async () => {
      const result = await PersistenceManager.requestClose();
      api.respondToClose?.(result);
    });
  });
}

function renderBlockingMessage(title: string, message: string) {
  document.body.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'boot-status boot-status-error boot-status-fullscreen';
  const titleEl = document.createElement('p');
  titleEl.className = 'boot-status-title';
  titleEl.textContent = title;
  const msgEl = document.createElement('p');
  msgEl.textContent = message;
  wrap.append(titleEl, msgEl);
  document.body.appendChild(wrap);
}

gateStorage().then(ok => (ok ? bootstrap() : undefined)).catch((err: unknown) => {
  console.error('Bootstrap failed:', err);
  const viewport = document.getElementById('viewport');
  if (!viewport) return;
  const errEl = document.createElement('div');
  errEl.className = 'boot-status boot-status-error boot-status-overlay';
  const message = err instanceof Error ? err.message : String(err);
  errEl.textContent = `Failed to initialise: ${message}`;
  viewport.appendChild(errEl);
});
