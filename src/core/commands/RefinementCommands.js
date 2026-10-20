import { EVENTS } from '../events.js';
import { dispatch, getState, setState, markDirty } from '../StateManager.js';
import { canonicalObjectId } from '../LogicalObjects.js';

export const DEFAULT_REFINEMENT = Object.freeze({ requestedLevel: 0, preview: 'original', status: 'idle', error: null });

/** Read the complete setting of a Mixo logical-object lead. */
export function refinementSetting(object) {
  return { ...DEFAULT_REFINEMENT, ...object?.printRefinement };
}

function writeSetting(id, setting) {
  setState(s => {
    const object = s.scene.objects[id];
    if (!object) return s;
    return { ...s, scene: { ...s.scene, objects: {
      ...s.scene.objects, [id]: { ...object, printRefinement: setting },
    } } };
  }, { silent: true });
  dispatch(EVENTS.REFINEMENT_CHANGED, { objectId: id });
}

/** Undoable user choice. Worker status and derived meshes are controller-owned. */
export class SetPrintRefinementCommand {
  constructor(objectId, patch) {
    const objects = getState().scene.objects;
    this.objectId = canonicalObjectId(objectId, objects);
    const object = objects[this.objectId];
    if (!object?.mixoProvenance) throw new Error('Print refinement requires a Mixo object');
    const prior = refinementSetting(object);
    const level = patch?.requestedLevel ?? prior.requestedLevel;
    const preview = patch?.preview ?? prior.preview;
    if (![0, 1, 2].includes(level) || !['original', 'refined'].includes(preview) || (level === 0 && preview === 'refined')) throw new Error('Invalid print refinement choice');
    this.label = 'Print refinement';
    this.previous = prior;
    this.next = {
      ...prior, requestedLevel: level, preview,
      status: level === 0 ? 'idle' : level !== prior.requestedLevel ? 'stale' : prior.status,
      error: level !== prior.requestedLevel ? null : prior.error,
    };
  }
  execute() { writeSetting(this.objectId, this.next); markDirty(); }
  undo() { writeSetting(this.objectId, this.previous); }
}
