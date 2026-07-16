// Interval autosave to idb (skipEmbed — arch A9) + boot-time crash recovery.

import { EVENTS } from '../events.js';
import { getState, dispatch } from '../StateManager.js';
import { kvSet, kvGet, kvDelete, kvKeys } from '../idb.js';
import { reportError } from '../../ui/Status.js';
import { t } from '../../i18n/index.js';
import { buildDocument } from './ProjectSerializer.js';
import { loadProject } from './ProjectLoader.js';
import { isDirty } from './DirtyTracker.js';
import { AUTOSAVE_PREFIX } from './constants.js';

let _autosaveTimer  = null;
let _autosaveWarned = false;   // warn once per session, not every 60 s tick

export function startAutosave(ms = 60000) {
  stopAutosave();
  _autosaveTimer = setInterval(async () => {
    if (!isDirty()) return;
    try {
      const doc = await buildDocument({ skipEmbed: true });   // A9
      await kvSet(`${AUTOSAVE_PREFIX}${getState().project.name}`, {
        savedAt: new Date().toISOString(), doc,
      });
      dispatch(EVENTS.AUTOSAVE_WRITTEN, {});
      _autosaveWarned = false;
    } catch (err) {
      if (_autosaveWarned) {
        console.error('Autosave failed:', err);
      } else {
        _autosaveWarned = true;
        reportError(err, { title: t('toast.autosaveFailed') });
      }
    }
  }, ms);
}

export function stopAutosave() {
  if (_autosaveTimer) { clearInterval(_autosaveTimer); _autosaveTimer = null; }
}

/**
 * On boot, offer to recover the newest autosave if one exists.
 * @returns {Promise<boolean>} true if a project was recovered
 */
export async function recoverAutosave() {
  let keys;
  try { keys = await kvKeys(); } catch { return false; }
  const auto = (keys || []).filter(k => typeof k === 'string' && k.startsWith(AUTOSAVE_PREFIX));
  if (!auto.length) return false;

  let newest = null;
  for (const k of auto) {
    const v = await kvGet(k);
    if (v?.savedAt && (!newest || v.savedAt > newest.savedAt)) newest = { key: k, ...v };
  }
  if (!newest) return false;

  const choice = await new Promise(resolve => {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'recoverAutosave',
      savedAt: newest.savedAt,
      onClose: (r) => resolve(r || 'discard'),
    });
  });
  if (choice === 'recover') {
    await loadProject(newest.doc);
    return true;
  }
  await kvDelete(newest.key);
  return false;
}
