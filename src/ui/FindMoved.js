// Explicit "Find moved file…" action shared by the asset card and Properties.
// Calls the adapter's hash search (the only walk — load never scans) behind a
// progress overlay; on a hit repoints the asset's source, otherwise toasts.
import { t } from '../i18n/index.js';
import { Toast } from './Toast.js';
import { Status } from './Status.js';
import { getState } from '../core/StateManager.js';
import { findMovedForAsset, applyFoundSource } from '../core/persist/AssetResolver.js';

/** @returns {Promise<boolean>} true when the asset was relinked */
export function runFindMoved(assetId) {
  const name = getState().scene.assetLibrary[assetId]?.filename ?? assetId;
  return Status.guard(async () => {
    const result = await Status.runTask(t('asset.findMoved.searching', { name }), (onProgress) =>
      findMovedForAsset(assetId, { onProgress: p => onProgress(0, t('asset.findMoved.scanned', { n: p?.scanned ?? 0 })) }),
    { overlay: true });
    if (result?.source && applyFoundSource(assetId, result)) {
      Toast.show(t('asset.findMoved.found', { name, path: result.source.path }), 'success');
      return true;
    }
    Toast.show(t('asset.findMoved.notFound', { name }), 'info');
    return false;
  }, { title: t('asset.findMoved.action') });
}
