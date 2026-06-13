import { Toast, safeAsync } from '../ui/Toast.js';
import { StatusBar } from '../ui/StatusBar.js';
import { SceneManager } from '../core/SceneManager.js';
import { InputManager } from '../core/InputManager.js';
import { AssetPanel } from '../ui/AssetPanel.js';
import { ViewportDrop } from '../ui/ViewportDrop.js';
import { Outliner } from '../ui/Outliner.js';
import { PropertiesPanel } from '../ui/PropertiesPanel.js';
import { ShaderPanel } from '../ui/ShaderPanel.js';
import { ScenePanel } from '../ui/ScenePanel.js';
import { PrintPanel } from '../ui/PrintPanel.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { Modal } from '../ui/Modal.js';
import { ImportError } from '../ui/ImportError.js';
import { ViewportToolbar } from '../ui/ViewportToolbar.js';
import { ViewportToggles } from '../ui/ViewportToggles.js';
import { MeshStats } from '../ui/MeshStats.js';
import { NavCube } from '../ui/NavCube.js';
import { push, TransformCommand } from '../core/HistoryManager.js';
import { MeshValidator } from '../core/MeshValidator.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { SettingsStore } from '../core/SettingsStore.js';
import { ProjectMenu } from '../ui/ProjectMenu.js';
import { AppShell } from '../ui/AppShell.js';
import { Workspace } from '../ui/Workspace.js';
import { NumberScrub } from '../ui/NumberScrub.js';
import { CursorPanel } from '../ui/CursorPanel.js';
import { CopyPaste } from '../ui/CopyPaste.js';

type TransformCommit = {
  prev: unknown;
  next: unknown;
  alreadyApplied?: boolean;
};

type ContextMenuInfo = Parameters<typeof ContextMenu.open>[0];

if (!('showDirectoryPicker' in window)) {
  renderBlockingMessage(
    'Browser not supported',
    'MIXOMESH requires Chrome or Edge (File System Access API).',
  );
  throw new Error('Unsupported browser - Chrome/Edge required');
}

async function bootstrap() {
  Toast.init();
  StatusBar.init();

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
  Outliner.init();
  PropertiesPanel.init();
  ShaderPanel.init();
  ScenePanel.init();
  PrintPanel.init();
  ContextMenu.init();
  AssetPanel.init();
  ViewportToolbar.init();
  ViewportToggles.init();
  MeshStats.init();       // live mesh stats in the status-bar centre segment
  NavCube.init();
  PersistenceManager.init();
  ProjectMenu.init();
  AppShell.init();
  Workspace.init();   // after AppShell — applies workspace layout over the shell defaults
  NumberScrub.init(); // wheel-scrub on number inputs (panel never scrolls under them)
  CursorPanel.init(); // 3D-cursor N-panel (Shift+N) — mounts into #viewport
  CopyPaste.init();   // Ctrl+C / Ctrl+V with aspect chooser
  SettingsStore.init(); // autosave hooks on the Scene/Print panel bodies (now mounted)

  const viewport = document.getElementById('viewport');
  if (!viewport) throw new Error('Viewport root missing');
  ViewportDrop.attach(viewport, SceneManager.getScene());

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
  safeAsync(() => AssetPanel.promptRemount());
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

bootstrap().catch((err: unknown) => {
  console.error('Bootstrap failed:', err);
  const viewport = document.getElementById('viewport');
  if (!viewport) return;
  const errEl = document.createElement('div');
  errEl.className = 'boot-status boot-status-error boot-status-overlay';
  const message = err instanceof Error ? err.message : String(err);
  errEl.textContent = `Failed to initialise: ${message}`;
  viewport.appendChild(errEl);
});
