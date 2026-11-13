// What the keyboard shortcuts actually do: frame, hide, unhide, lock, delete, duplicate, group,
// ungroup.
//
// MEASURED CLEAN, which is why it could move while the rest of InputManager could not. This block
// touches NONE of that file's mutable module state -- not `_modal`, `_mode`, `_readOnly`,
// `_handlers`, `_scene` or `_canvas` -- it only calls commands and reads Selection. Every other
// candidate block there failed: the keymap needs 11 of those names, the touch handling 16
// (thirteen references to one object), and the modal G/R/S block reads `_modal` 33 times while the
// dispatcher, the pointer observable and the touch path all read it too, so moving it would hand
// the module its own state back. `../../docs/size-debt.md` carries the numbers.
//
// THE RULE THESE ALL SHARE, and the reason `_refuseInsideObject` stays private below: inside an
// object's part scope, Selection holds PART ids rather than displayable ones, so delete, duplicate
// and hide have no sensible meaning and refuse with a toast instead of acting on the wrong thing.
// A new destructive shortcut added here needs the same guard.

import { EVENTS } from '../events.js';
import { dispatch, getState } from '../StateManager.js';
import { t } from '../../i18n/index.js';
import { Selection } from '../Selection.js';
import { logicalObjectCommandIds } from '../LogicalObjects.js';
import { SceneManager } from '../SceneManager.js';
import { Toast } from '../../ui/Toast.js';
import {
  push, DeleteCommand, DuplicateCommand, GroupCommand, LockCommand, UngroupCommand,
  VisibilityCommand,
} from '../HistoryManager.js';

export function _frameSelection() {
  const meshes = Selection.getSelectedResolved().map(r => r.mesh);
  if (!meshes.length) return;
  SceneManager.frameSelected(meshes);
}

export function _hideSelected() {
  // Hiding the object you are INSIDE leaves the depth meaningless: isolation has hidden everything
  // else, so the viewport goes blank while the notice still says which meshes are picked.
  if (_refuseInsideObject()) return;
  const objects = getState().scene.objects;
  const ids = logicalObjectCommandIds(Selection.getSelectedIds(), objects);
  if (!ids.length) return;
  const prev = {};
  for (const id of ids) prev[id] = !!objects[id]?.visible;
  // Toggle: if all visible → hide; if any hidden → show all.
  const anyVisible = ids.some(id => objects[id]?.visible);
  push(new VisibilityCommand(ids, prev, !anyVisible));
}

export function _unhideAll() {
  const objects = getState().scene.objects;
  const hidden = Object.values(objects).filter(o => o.visible === false).map(o => o.id);
  if (!hidden.length) return;
  const prev = {};
  for (const id of hidden) prev[id] = false;
  push(new VisibilityCommand(hidden, prev, true));
}

export function _lockToggleSelected() {
  const objects = getState().scene.objects;
  const groups = getState().scene.groups;
  const sel = Selection.getSelectedIds();
  // Objects (expanded to all parts) AND selected groups toggle together.
  const ids = [...logicalObjectCommandIds(sel, objects), ...sel.filter(id => !objects[id] && groups[id])];
  if (!ids.length) return;
  const isLocked = id => !!(objects[id] ?? groups[id])?.locked;
  const prev = {};
  for (const id of ids) prev[id] = isLocked(id);
  const anyUnlocked = ids.some(id => !isLocked(id));
  push(new LockCommand(ids, prev, anyUnlocked));
}

/**
 * Refuse a whole-object command while the operator is INSIDE an object (U5), and say so.
 *
 * Inside the part scope the selection is the object's PARTS, and these commands act on whole
 * objects: `_expandedCommandIds` turns one part id into every part of its logical object. So Delete
 * with one mesh picked removed ALL of them -- the notice read "1 of 3 meshes picked" and the object
 * vanished. Undoable, but nothing warned, and the screen had just said the opposite.
 *
 * Refused rather than reinterpreted: deleting one mesh OUT of a logical object is a real edit with
 * a separate's hazards (the union repair and the supports were built against the whole object), and
 * minting that from a keypress is worse than the surprise it replaces. If the owner wants it, it is
 * a command with its own warnings, not a key that quietly means something new.
 *
 * This follows the depth's own decision to turn the gizmo off rather than move one part
 * (`Selection.getTransformTargets`) -- and unlike the gizmo it SAYS so, because a key that silently
 * does nothing is its own defect. Duplicate is routed here too: it already did nothing at all.
 */
function _refuseInsideObject() {
  if (!Selection.inPartScope()) return false;
  Toast.show(t('toast.insideObjectPickOnly'), 'warning', 6000);
  return true;
}

export function _deleteSelected() {
  if (_refuseInsideObject()) return;
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  // Lock = transform-lock; Delete ASKS (Decision 9): a selection that holds a
  // locked object/group (or anything inside a locked group) needs a confirm.
  if (ids.some(id => Selection.isEffectivelyLocked(id))) {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'confirmAction',
      title: t('context.deleteLockedTitle'),
      body: t('context.deleteLockedBody'),
      confirmLabel: t('context.deleteLockedConfirm'),
      danger: true,
      onClose: (r) => { if (r === 'confirm') push(new DeleteCommand(ids)); },
    });
    return;
  }
  push(new DeleteCommand(ids));
}

export function _duplicateSelected() {
  if (_refuseInsideObject()) return;
  const ids = Selection.getSelectedIds();
  if (!ids.length) return;
  push(new DuplicateCommand(ids));
}

export function _groupSelected() {
  const ids = Selection.getSelectedIds();
  if (ids.length < 1) return;
  const cmd = new GroupCommand(ids);
  push(cmd);
  // Groups are selectable (2.1): select the new group so one click/drag moves everything.
  if (getState().scene.groups[cmd.groupId]) Selection.set([cmd.groupId], cmd.groupId);
}

export function _ungroupSelected() {
  // Selected groups dissolve; selected objects ungroup their parent group.
  const groupIds = UngroupCommand.targetsFor(Selection.getSelectedIds());
  if (!groupIds.length) return;
  push(new UngroupCommand(groupIds));
}
