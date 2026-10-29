/**
 * Support Mode panels (plan P3.4): `init()` mounts the stack over the dimmed right panel and binds
 * the edit session to the Support Mode controller (Esc stages, plain tool keys).
 */
import { mountPanel } from '../../react/index.ts';
import { InputManager } from '../../core/InputManager.js';
import { t } from '../../i18n/index.js';
import { supportMode } from '../../supports/SupportMode';
import { SupportsRoot } from './SupportsPanel';
import { bindSupportSession } from './sessionStore';
import { supportUi } from './supportUi';

let started = false;

export function init(): void {
  if (started) return;
  const app = document.getElementById('app');
  if (!app) return;
  started = true;
  const root = document.createElement('aside');
  root.id = 'support-panel-root';
  root.className = 'mx-kit';
  root.setAttribute('aria-label', t('supportMode.title'));
  app.appendChild(root);
  mountPanel('support-panel-root', <SupportsRoot />);
  bindSupportSession({
    mode: supportMode,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- legacy JS module
    input: InputManager as any,
    target: (ids) => (supportUi.get().targetId && ids.includes(supportUi.get().targetId!) ? supportUi.get().targetId : ids[0]),
  });
  supportMode.onChange((info) => { if (!info.active) supportUi.reset(); });
}

export const SupportPanels = { init };
