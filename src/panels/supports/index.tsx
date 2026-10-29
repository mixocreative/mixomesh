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
import { deleteSelectedSupports } from './supportData';
import { supportSession } from './sessionStore';
import { notify } from '../../supports/live/notices';
import { undo } from '../../core/HistoryManager.js';

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
    deleteSelection: () => {
      const id = supportSession.get().activeUnitId;
      const n = id ? deleteSelectedSupports(id, supportSession.get().selection) : 0;
      if (n > 0) {
        supportSession.send({ type: 'clearSelection' });
        notify({ message: t('supportPanel.toast.deleted', { n }), action: { label: t('supportPanel.undo'), onClick: () => undo() } });
      }
    },
  });
  supportMode.onChange((info) => { if (!info.active) supportUi.reset(); });
}

export const SupportPanels = { init };
