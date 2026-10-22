// Re-import dedupe (Decision 16, §4.4 rule 2): find the asset whose source
// bytes a new file repeats, and the "already in this project" prompt.

import { dispatch, getState } from '../StateManager.js';
import { EVENTS } from '../events.js';
import { getBlobUrl } from './BlobUrls.js';

/** Choices of the "already in this project" prompt. */
export const DUPLICATE_CHOICE = Object.freeze({ COPY: 'copy', SEPARATE: 'separate' });

/**
 * In-project dedupe: the first instantiable mesh asset whose source bytes hash
 * to `contentHash`, in library order. Library-pack items (one file → many
 * assets) and assets without cached bytes (ghosts) never match — "add another
 * copy" must be able to re-instantiate what it found.
 * @param {string|null|undefined} contentHash  sha256 hex
 * @param {object} [state]
 * @returns {string|null} assetId
 */
export function findByHash(contentHash, state = getState()) {
  if (!contentHash) return null;
  for (const a of Object.values(state.scene?.assetLibrary ?? {})) {
    if (!a || a.contentHash !== contentHash) continue;
    if ((a.kind ?? 'mesh') !== 'mesh' || a.libraryItem || a.isGhost) continue;
    if (!getBlobUrl(a.id)) continue;
    return a.id;
  }
  return null;
}

/**
 * Decision 16 prompt — the designed "already in this project" dialog
 * (`duplicateImport`, rendered by AssetPanel): [Import as separate asset]
 * [Add another copy]. "Add another copy" is the primary, focused default;
 * × / Esc / backdrop = cancel the import.
 * @param {{ filename: string, existingName: string }} info
 * @returns {Promise<'copy'|'separate'|null>}
 */
export function askDuplicateImport({ filename, existingName }) {
  return new Promise(resolve => {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'duplicateImport',
      filename,
      existingName,
      onClose: (r) => resolve(r === 'copy' ? DUPLICATE_CHOICE.COPY
        : r === 'separate' ? DUPLICATE_CHOICE.SEPARATE : null),
    });
  });
}
