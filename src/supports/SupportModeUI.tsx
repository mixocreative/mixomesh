/**
 * Support Mode chrome (plan P3.2): the header entry button "Supports" (next to the workspace tabs;
 * enabled with at least one selected object), the "Support Mode — N objects" label with Done while
 * the mode is open, and the kit toast host the mode's messages use. Key Shift+S toggles the mode.
 * Support panels are P3.4.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { Button, ToastProvider, useToasts } from '../kit/index.ts';
import { mountPanel, useStore, useT } from '../react/index.ts';
import { EVENTS } from '../core/events.js';
import { InputManager } from '../core/InputManager.js';
import { supportMode, setSupportModeToast, supportTargets, type SupportModeInfo } from './SupportMode';

let current: SupportModeInfo = { active: false, objectIds: [] };
const subscribeMode = (fn: () => void) => supportMode.onChange((info) => { current = info; fn(); });
const getMode = () => current;

const SELECTION_EVENTS = [
  EVENTS.SELECTION_CHANGED, EVENTS.OBJECT_REMOVED, EVENTS.OBJECT_RESTORED, EVENTS.ASSET_INSTANTIATED,
  EVENTS.GROUP_CREATED, EVENTS.GROUP_DISSOLVED, EVENTS.PROJECT_NEW, EVENTS.PROJECT_LOADED,
];

function HeaderControl() {
  const t = useT();
  const mode = useSyncExternalStore(subscribeMode, getMode, getMode);
  const targets = useStore(SELECTION_EVENTS, (s) => supportTargets(s.scene, s.selection.selectedIds).length);
  if (mode.active) {
    return (
      <>
        <span className="sm-label" role="status" id="support-mode-label">
          {t('supportMode.title')} — {t('supportMode.objectCount', { n: mode.objectIds.length })}
        </span>
        <Button variant="primary" id="support-mode-done" title={t('supportMode.doneTitle')} onClick={() => supportMode.exit()}>
          {t('supportMode.done')}
        </Button>
      </>
    );
  }
  return (
    <Button
      id="support-mode-enter"
      disabled={targets === 0}
      title={targets === 0 ? t('supportMode.needSelection') : t('supportMode.enterTitle')}
      onClick={() => supportMode.enter()}
    >
      {t('supportMode.enter')}
    </Button>
  );
}

function ToastBridge() {
  const toasts = useToasts();
  useEffect(() => {
    setSupportModeToast((message) => { toasts.push({ message, timeoutMs: 6000 }); });
    return () => setSupportModeToast(null);
  }, [toasts]);
  return null;
}

let started = false;

/** Mount the header control and toast host, register Shift+S. Call after Workspace.init. */
export function init(): void {
  if (started) return;
  const header = document.getElementById('header');
  if (!header) return;
  started = true;

  const control = document.createElement('div');
  control.id = 'support-mode-root';
  control.className = 'mx-kit sm-root';
  const pill = header.querySelector('.ws-switcher');
  if (pill?.nextSibling) header.insertBefore(control, pill.nextSibling); else header.appendChild(control);
  mountPanel('support-mode-root', <HeaderControl />);

  const toastRoot = document.createElement('div');
  toastRoot.id = 'support-mode-toast-root';
  toastRoot.className = 'mx-kit';
  document.body.appendChild(toastRoot);
  mountPanel('support-mode-toast-root', <ToastProvider><ToastBridge /></ToastProvider>);

  InputManager.register('Shift+S', 'global', () => {
    if (supportMode.isActive()) supportMode.exit();
    else if (!supportMode.enter()) supportMode.toastNeedSelection();
  });
}

export const SupportModeUI = { init };
