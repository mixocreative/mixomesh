import { EVENTS } from '../core/events.js';
import { getState, subscribe } from '../core/StateManager.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { ViewportDrop } from './ViewportDrop.js';
import { safeAsync } from './Toast.js';
import { icon } from '../core/Icons.js';
import { applyTranslations } from '../i18n/index.js';

let root = null;

function render() {
  if (!root) return;
  root.hidden = Object.keys(getState().scene.objects).length > 0;
}

export function init() {
  const viewport = document.getElementById('viewport');
  if (!viewport) return;
  root = document.createElement('div');
  root.className = 'viewport-empty-state';
  root.innerHTML = `
    ${icon('Box', { width: 30, height: 30 })}
    <strong data-i18n-key="empty.title">Start your print assembly</strong>
    <span data-i18n-key="empty.body">Import a model or open a MIXOMESH project.</span>
    <div class="viewport-empty-actions">
      <button class="btn btn-primary" data-empty-action="import">${icon('FilePlus', { class: 'inline' })}<span data-i18n-key="empty.import">Import Model</span></button>
      <button class="btn" data-empty-action="open">${icon('FolderOpen', { class: 'inline' })}<span data-i18n-key="empty.open">Open Project</span></button>
    </div>`;
  viewport.appendChild(root);
  root.querySelector('[data-empty-action="import"]')?.addEventListener('click', () =>
    safeAsync(() => ViewportDrop.promptImport()));
  root.querySelector('[data-empty-action="open"]')?.addEventListener('click', () =>
    safeAsync(() => PersistenceManager.open()));
  for (const event of [EVENTS.ASSET_INSTANTIATED, EVENTS.OBJECT_REMOVED,
    EVENTS.OBJECT_RESTORED, EVENTS.PROJECT_NEW, EVENTS.PROJECT_LOADED]) {
    subscribe(event, render);
  }
  subscribe(EVENTS.LOCALE_CHANGED, () => applyTranslations(root));
  applyTranslations(root);
  render();
}

export const ViewportEmptyState = { init };
