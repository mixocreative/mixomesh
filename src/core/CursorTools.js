// 3D-cursor snap operations (Blender's Object ▸ Snap subset).
//
// Two ops cover most workflows (user spec): Selection → Cursor and
// Cursor → Selection, plus a Cursor → World Origin reset. Selection → Cursor is
// undoable (it moves geometry); cursor moves are not in the undo stack, the
// same as Blender (the cursor is a tool, not scene content).

import { SceneManager } from './SceneManager.js';
import { Selection } from './Selection.js';
import { push, TransformCommand } from './HistoryManager.js';
import { captureWorld } from './commands/support.js';
import { Toast } from '../ui/Toast.js';

const BABYLON = window.BABYLON;

/** Median of the selected meshes' absolute positions, or null if empty. */
function _selectionMedian() {
  const resolved = Selection.getSelectedResolved();
  if (!resolved.length) return null;
  const acc = new BABYLON.Vector3(0, 0, 0);
  for (const { mesh } of resolved) {
    mesh.computeWorldMatrix(true);
    acc.addInPlace(mesh.getAbsolutePosition());
  }
  return acc.scaleInPlace(1 / resolved.length);
}

/**
 * Move the whole selection rigidly so its median lands on the cursor
 * (offsets between objects are preserved). One undoable step.
 */
export function selectionToCursor() {
  const resolved = Selection.getSelectedResolved();
  if (!resolved.length) { Toast.show('Nothing selected', 'info', 2000); return; }
  const median = _selectionMedian();
  const cursor = SceneManager.getCursor();
  const dx = cursor.x - median.x, dy = cursor.y - median.y, dz = cursor.z - median.z;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9 && Math.abs(dz) < 1e-9) return;

  const prev = {}, next = {};
  for (const { id, mesh } of resolved) {
    const w = captureWorld(mesh);
    prev[id] = w;
    next[id] = {
      position: { x: w.position.x + dx, y: w.position.y + dy, z: w.position.z + dz },
      rotation: { ...w.rotation },
      scaling:  { ...w.scaling },
    };
  }
  push(new TransformCommand(prev, next));
}

/** Move the cursor to the selection median (shows it for feedback). */
export function cursorToSelection() {
  const median = _selectionMedian();
  if (!median) { Toast.show('Nothing selected', 'info', 2000); return; }
  SceneManager.setCursor(median);
  SceneManager.setCursorVisible(true);
}

/** Reset the cursor to the world origin (shows it for feedback). */
export function cursorToWorldOrigin() {
  SceneManager.setCursor(new BABYLON.Vector3(0, 0, 0));
  SceneManager.setCursorVisible(true);
}

export const CursorTools = { selectionToCursor, cursorToSelection, cursorToWorldOrigin };
