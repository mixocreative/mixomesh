// Which object ids an edit to one mesh must actually reach.
//
// One job, and it exists because of the invariant that catches everyone: a logical object is
// SEVERAL meshes, and they are not parented in Babylon -- each part carries its own absolute
// transform. So an edit aimed at one mesh has to be applied to every part of its logical object,
// or three of four parts silently keep the old value. A single-mesh object answers with itself.
//
// Shared by the scale rows and the shader slots in ./  -- both had to expand the same way, which
// is why this is a module and not a private helper in either.

import { getState } from '../../core/StateManager.js';
import { logicalObjectPartIds } from '../../core/LogicalObjects.js';

/** @param {string} meshId @returns {string[]} every part id of meshId's logical object */
export function logicalTargetIds(meshId) {
  const ids = logicalObjectPartIds(meshId, getState().scene.objects);
  return ids.length ? ids : [meshId];
}
