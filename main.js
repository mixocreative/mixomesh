import { Toast } from './ui/Toast.js';
import { StatusBar } from './ui/StatusBar.js';
import { SceneManager } from './core/SceneManager.js';
import { InputManager } from './core/InputManager.js';
import { AssetPanel } from './ui/AssetPanel.js';
import { ViewportDrop } from './ui/ViewportDrop.js';
import { Outliner } from './ui/Outliner.js';
import { PropertiesPanel } from './ui/PropertiesPanel.js';
import { ContextMenu } from './ui/ContextMenu.js';
import { push, TransformCommand } from './core/HistoryManager.js';

// ── Browser gate ─────────────────────────────────────────
if (!('showDirectoryPicker' in window)) {
  document.body.innerHTML = `
    <div style="
      display:flex;align-items:center;justify-content:center;
      height:100vh;font-family:system-ui;color:#ededf0;
      background:#0a0a0b;text-align:center;padding:2rem;
    ">
      <div>
        <p style="font-size:1.2rem;margin-bottom:.5rem">Browser not supported</p>
        <p style="color:#a1a1ab;font-size:.9rem">MIXOMESH requires Chrome or Edge (File System Access API).</p>
      </div>
    </div>`;
  throw new Error('Unsupported browser — Chrome/Edge required');
}

// ── Bootstrap ─────────────────────────────────────────────
async function bootstrap() {
  Toast.init();
  StatusBar.init();

  const canvas = document.getElementById('renderCanvas');
  SceneManager.init(canvas);
  InputManager.init(SceneManager.getScene());

  // After-gizmo-drag → push TransformCommand. Injected here to avoid a
  // SceneManager → HistoryManager dependency cycle.
  SceneManager.setTransformCommitHandler(({ prev, next, alreadyApplied }) => {
    push(new TransformCommand(prev, next, { alreadyApplied }));
  });

  Outliner.init();
  PropertiesPanel.init();
  ContextMenu.init();
  AssetPanel.init();
  ViewportDrop.attach(document.getElementById('viewport'), SceneManager.getScene());

  // Both viewport RMB and outliner RMB route to the same context menu.
  InputManager.setContextMenuHandler((info) => ContextMenu.open(info));
  Outliner.setContextMenuHandler((info)     => ContextMenu.open(info));

  canvas.focus();
}

bootstrap().catch(err => {
  console.error('Bootstrap failed:', err);
  document.getElementById('viewport')?.insertAdjacentHTML('beforeend', `
    <div style="
      position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      background:rgba(10,10,11,.9);color:#ef4444;font-family:system-ui;font-size:.9rem;
    ">Failed to initialise: ${err.message}</div>
  `);
});
