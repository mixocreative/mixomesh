// Split to parts / Join: the two commands that break a multi-material import into
// separate objects and put it back together. Owner decision 2026-09-18.
//
// Cut out of ParentCommands.js on 2026-11-14 at that file's own section comment: parenting and
// grouping above it, these three commands below, and nothing above needed anything below. The
// dependency still runs one way -- this module uses ReparentCommand, CreateGroupCommand and
// DissolveGroupUnit from there, and ParentCommands.js imports nothing from here.
//
// A multi-material import is ONE logical object made of several SceneObject parts (a lead plus
// `isInternalPart` siblings linked by `logicalObjectId`). Separation is an explicit, undoable user
// action, never automatic. Geometry, shaders and geometryFixes are untouched by both commands;
// only the linkage flags, the names and (for Split) the Outliner parent change.
//
// The trap this file carries: a part does NOT inherit its lead's transform through Babylon
// parenting -- each carries its own absolute transform -- so the scale triple (ratio, bakedRatio,
// ratioSource) must be set on every part a Split produces and every part a Join swallows. Moving
// the label without the anchor made a separated object come back at DOUBLE size on reload.

import { EVENTS } from '../events.js';
import { dispatch, setState, getState, markDirty } from '../StateManager.js';
import { t } from '../../i18n/index.js';
import {
  logicalObjectCommandIds, canonicalObjectId, logicalObjectPartIds,
} from '../LogicalObjects.js';
import { objectRatio, bakedRatioOf, anchorUnlessLabel } from '../scale/ScaleMath.js';
import { SILENT } from './support.js';
import { ReparentCommand, CreateGroupCommand, DissolveGroupUnit } from './ParentCommands.js';

/**
 * Does `name` look like a name this app derived from `leadName`?
 *
 * The import names a multi-material part after its lead (`Bowl_primitive1`),
 * and a split names them `Bowl.001`, so both are names to replace. A name the
 * OPERATOR chose is not: a "hook" merged into a "denture" must come back as
 * "hook", not as "denture.001". Only the lead's own prefix counts, so an
 * unrelated name is never mistaken for a derived one.
 */
function _isDerivedName(name, leadName) {
  if (!name || !leadName) return true;
  if (name === leadName) return true;
  const prefix = leadName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${prefix}[._ ]`).test(name);
}

function _uniqueNameIn(baseName, objects) {
  const taken = new Set(Object.values(objects).map(o => o?.name));
  if (!taken.has(baseName)) return baseName;
  const m = baseName.match(/^(.*)\.(\d{3,})$/);
  const stem = m ? m[1] : baseName;
  for (let i = 1; i < 999; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName}.dup`;
}

/*
 * `ratio` is here because both split commands now WRITE it (see `sourceRatio` below): it is the only
 * field in this list that is not a link, and it is snapshotted for exactly the same reason the links
 * are -- a patch that undo cannot reverse is worse than the defect it fixed. Widening the SNAPSHOT
 * is safe for the commands that do not write it: `_applyLinkPatches` only applies the keys each
 * patch actually carries, so for Join this restores a ratio to the value it already had.
 */
const LINK_FIELDS = ['name', 'isInternalPart', 'logicalObjectId', 'sourceGroupId', 'isPrintPart', 'ratio', 'bakedRatio', 'ratioSource'];

/**
 * The scale fields a part needs to KEEP PRINTING at `ratio` when it becomes an object.
 *
 * Moving the label alone was a regression worse than the defect it fixed, and the reload is what
 * catches it: `ProjectLoader` re-bakes each object's vertices by `bakedRatioOf`, so handing a part
 * printed at 1:1 a body baked at 1:2 and no anchor made it come back DOUBLE the size -- the exact
 * shape of gap 2, reintroduced by a one-field fix. The anchor records where the vertices actually
 * are, which is what "Set scale" has always done when it relabels without resizing
 * (`ScaleMath.anchorUnlessLabel`), and `ratioSource` follows the label it describes so the
 * provenance is not left claiming a ratio the object no longer has.
 *
 * Together: a separate changes NOTHING -- not position, not size on screen, not size after a
 * reload, not what gets printed. That is U5's own invariant, applied to scale.
 */
function _scaleFieldsFor(part, ratio, source) {
  return {
    ratio,
    bakedRatio: anchorUnlessLabel(bakedRatioOf(part), ratio),
    ratioSource: source.ratioSource,
  };
}

function _snapshotLink(obj) {
  const out = {};
  for (const k of LINK_FIELDS) out[k] = obj[k];
  return out;
}

/**
 * Support records of the leads a Join swallows.
 *
 * Supports live on the LEAD of a logical object and every read redirects there
 * (`src/supports/store.ts`), so after a merge the other object's record is
 * unreachable while still sitting in the save file: the operator is told
 * nothing, export is not blocked, and if the new lead had no supports **the
 * print goes out unsupported**. So the Join drops them and says so. Undo puts
 * them back, which is why they are snapshotted rather than simply deleted.
 *
 * Read straight off `state.scene.objects` on purpose: a command in core must
 * not import the support modules, and the record is only a field.
 */
function _supportsToDrop(leads, leadId, objects) {
  const dropped = {};
  for (const other of leads) {
    if (other === leadId) continue;
    if (objects[other]?.supports) dropped[other] = objects[other].supports;
  }
  return dropped;
}

/**
 * Objects a Join swallows whose print RATIO differs from the lead's.
 *
 * Each object carries its own `ratio` and it is already baked into its vertices, so a merge does not
 * resize anything — but the export reads the LEAD's ratio as the reference for a target size
 * (`PrintPipeline` -> `ExportContext.referenceRatio`), and the swallowed object's own `ratio` becomes
 * a field nothing reads. Ask for "print at 1:1" afterwards and the factor is computed from the
 * lead's provenance and applied to geometry that came from another, which lands at a size that is
 * right only if the two agreed.
 *
 * Reported, not corrected: re-baking vertices is exactly what Join must never do (it moves link
 * fields only, so nothing shifts in world space). The operator is told, and can undo and scale
 * first.
 */
function _ratioMismatches(leads, leadId, objects) {
  const lead = Number(objects[leadId]?.ratio ?? objects[leadId]?.modelRatio ?? 1);
  const out = [];
  for (const other of leads) {
    if (other === leadId) continue;
    const ratio = Number(objects[other]?.ratio ?? objects[other]?.modelRatio ?? 1);
    // Both fall back to 1 the way `objectRatio` does, so a missing field never reads as a mismatch.
    if (Number.isFinite(ratio) && Number.isFinite(lead) && Math.abs(ratio - lead) > 1e-9) {
      out.push({ name: objects[other]?.name ?? other, ratio, lead });
    }
  }
  return out;
}

/**
 * The `groupRepair` record cannot survive a separate, and this drops it.
 *
 * A multi-part object is repaired as ONE solid on the welded union of its parts
 * (`RepairSession._repairGroupParts`), and the record is written on EVERY part so a reload replays
 * it once for the whole object (`ProjectLoader`). Separate those parts and that promise cannot be
 * kept: the reload walks each object, finds `groupRepair`, and replays it on THAT OBJECT ALONE — a
 * per-part repair of a union that no longer exists, which is the internal-wall result
 * `GroupRepair` was written to avoid. The project would reload as different geometry from the one
 * on screen, silently.
 *
 * So the record goes, and the operator is told: after a reload those objects come back UNREPAIRED,
 * which the validator reports, rather than repaired in a way nobody chose. Undo puts it back with
 * the link fields. The alternative — refusing the separate until the repair is undone — was
 * rejected because it blocks an edit the operator is entitled to make, and the plan sanctioned
 * either (U5 gap 2: "block or invalidate; do not leave it to chance").
 *
 * Only `groupRepair` is union-specific. Every other fix type replays correctly per object and stays.
 */
const UNION_FIX = 'groupRepair';

function _unionFixesToDrop(ids, objects) {
  const found = {};
  for (const id of ids) {
    const fixes = objects[id]?.geometryFixes;
    if (Array.isArray(fixes) && fixes.includes(UNION_FIX)) found[id] = [...fixes];
  }
  return found;
}

function _setGeometryFixes(records, keep) {
  const ids = Object.keys(records);
  if (ids.length === 0) return;
  setState(state => {
    const objects = { ...state.scene.objects };
    for (const id of ids) {
      if (!objects[id]) continue;
      const fixes = keep ? records[id] : records[id].filter(fix => fix !== UNION_FIX);
      objects[id] = { ...objects[id], geometryFixes: fixes };
    }
    return { scene: { ...state.scene, objects } };
  });
}

/** Warn once, naming the objects whose union repair was dropped. */
function _warnUnionFixDropped(records) {
  const ids = Object.keys(records);
  if (ids.length === 0) return;
  const objects = getState().scene.objects;
  const names = [...new Set(ids.map(id => objects[id]?.name).filter(Boolean))];
  dispatch(EVENTS.TOAST, { message: t('toast.splitDroppedGroupRepair', { names: names.join(', ') }), type: 'warning', duration: 8000 });
}

function _setSupports(records, keep) {
  const ids = Object.keys(records);
  if (ids.length === 0) return;
  setState(state => {
    const objects = { ...state.scene.objects };
    for (const id of ids) {
      if (!objects[id]) continue;
      const next = { ...objects[id] };
      if (keep) next.supports = records[id];
      else delete next.supports;
      objects[id] = next;
    }
    return { scene: { ...state.scene, objects } };
  });
  dispatch(EVENTS.SUPPORTS_CHANGED, { objectIds: ids });
}

function _applyLinkPatches(patches) {
  setState(state => {
    const objects = { ...state.scene.objects };
    for (const [id, patch] of Object.entries(patches)) {
      if (!objects[id]) continue;
      objects[id] = { ...objects[id], ...patch };
    }
    return { ...state, scene: { ...state.scene, objects } };
  }, SILENT);
  for (const id of Object.keys(patches)) dispatch(EVENTS.OBJECT_UPDATED, { meshId: id });
}

/**
 * Turn the internal parts of ONE logical object into independent objects
 * under a new group named after the lead. No-op (`applied === false`) on a
 * single-part object.
 */
export class SplitToPartsCommand {
  constructor(leadId) {
    this._leadId = leadId;
    this._before = null;        // id → link snapshot
    this._after = null;         // id → link patch
    this._group = null;         // CreateGroupCommand
    this._reparent = null;      // ReparentCommand (group under the lead's old parent)
    this.applied = false;
    this.label = t('history.separateByMaterial');
  }
  _plan() {
    if (this._before) return true;
    const objects = getState().scene.objects;
    const ids = logicalObjectCommandIds([this._leadId], objects);
    if (ids.length < 2) return false;
    const leadId = ids[0];
    const lead = objects[leadId];
    if (!lead || lead.isGhost) return false;
    const before = {}, after = {};
    const draft = { ...objects };
    ids.forEach((id, i) => {
      const obj = objects[id];
      before[id] = _snapshotLink(obj);
      // A part that carries a name of its own keeps it; one named after the lead
      // (an import part, or a name a previous split derived) gets a fresh one.
      const name = i === 0 || !_isDerivedName(obj.name, lead.name)
        ? obj.name
        : _uniqueNameIn(`${lead.name}.${String(i).padStart(3, '0')}`, draft);
      // Every id here becomes its own object, so every one of them needs the lead's scale for the
      // reason `sourceRatio` gives in the separate above: a part's own `ratio` was a field nothing
      // read, and promoting it to a lead would make a stale one authoritative.
      after[id] = { name, isInternalPart: false, logicalObjectId: null, sourceGroupId: null, isPrintPart: !!lead.isPrintPart, ..._scaleFieldsFor(obj, objectRatio(lead), lead) };
      draft[id] = { ...obj, ...after[id] };
    });
    this._ids = ids;
    this._before = before;
    this._after = after;
    this._leadParentId = lead.parentId ?? null;
    this._unionFixes = _unionFixesToDrop(ids, objects);
    return true;
  }
  execute() {
    if (!this._plan()) { this.applied = false; return; }
    _applyLinkPatches(this._after);
    _setGeometryFixes(this._unionFixes, false);
    _warnUnionFixDropped(this._unionFixes);
    // Group AFTER the flags are cleared so the group command sees N plain
    // objects (its id expansion would otherwise re-collapse them).
    this._group ??= new CreateGroupCommand(this._ids, `${getState().scene.objects[this._ids[0]].name} parts`);
    this._group.execute();
    if (this._leadParentId) {
      this._reparent ??= new ReparentCommand(this._group._groupId, this._leadParentId);
      this._reparent.execute();
    }
    this.applied = true;
    markDirty();
  }
  undo() {
    if (!this.applied) return;
    this._reparent?.undo();
    this._group?.undo();
    _applyLinkPatches(this._before);
    _setGeometryFixes(this._unionFixes ?? {}, true);
    this.applied = false;
  }
}

/**
 * Separate the PICKED parts of one logical object into ONE new object (U5, the
 * owner's "pick the meshes and separate them"). Link fields only — geometry,
 * shaders and transforms are untouched, exactly as Join and SplitToParts leave
 * them, so nothing moves in world space and the plate position is preserved.
 *
 * No-op (`applied === false`) unless the picked ids are parts of ONE logical
 * object and leave at least one part behind: separating every part is
 * `SplitToPartsCommand`, and separating nothing is not an edit.
 *
 * Two cases, and the second is the one worth knowing about:
 *   - the picked set does not include the object's lead → the first picked part
 *     leads the new object, the rest follow it;
 *   - it DOES include the lead → the object left behind needs a new lead, so
 *     the first REMAINING part takes that job and the others re-point at it.
 *     Nothing about the geometry changes; `logicalObjectId` is a pointer.
 */
export class SeparateSelectionCommand {
  constructor(partIds) {
    this._requested = partIds ?? [];
    this._before = null;
    this._after = null;
    this._reparent = undefined;   // undefined = not decided yet; null = decided, none needed
    this.applied = false;
    this.label = t('history.separateSelection');
  }
  _plan() {
    if (this._before) return true;
    const objects = getState().scene.objects;
    const picked = [...new Set(this._requested)].filter(id => objects[id] && !objects[id].isGhost);
    const leads = new Set(picked.map(id => canonicalObjectId(id, objects)));
    if (picked.length === 0 || leads.size !== 1) return false;
    const sourceLead = [...leads][0];
    const all = logicalObjectPartIds(sourceLead, objects).filter(id => !objects[id]?.isGhost);
    const taken = all.filter(id => picked.includes(id));
    const left = all.filter(id => !picked.includes(id));
    if (taken.length === 0 || left.length === 0) return false;

    const source = objects[sourceLead];
    /*
     * The print scale the object was ACTUALLY being printed at, inherited by BOTH leads this edit
     * produces. Found 2026-11-13 by walking merge-then-separate.
     *
     * `objectRatio` reads the LEAD's `ratio` -- the scale term for an object at import, display and
     * export (`scale/ScaleMath.js`). A part that is not the lead keeps a `ratio` field nothing
     * reads, and a merge deliberately leaves it there while warning that the lead's scale now
     * applies (gap 6). Separating that part out again made it a lead, which PROMOTED the stale field
     * back into the reference: merge an object printed at 1:2 into one printed at 1:1, separate it
     * out, and its declared scale silently returned to 1:2 -- nothing said, geometry untouched.
     *
     * Inherited rather than warned about, because a separate has only ONE scale in play: the one the
     * operator has been looking at. A join warns because it must genuinely drop one of two. This is
     * the same inheritance `isPrintPart` already takes from `source`, one field over.
     *
     * BOTH sides, for the reason the union repair is dropped on both: when the lead itself is taken,
     * the object left behind gets a new lead, and ITS ratio becomes authoritative too.
     */
    const sourceRatio = objectRatio(source);
    const before = {}, after = {};
    const draft = { ...objects };
    const newLead = taken[0];
    // A part that carries a name of its own keeps it; one named after the
    // object it came from gets a fresh derived name (`_isDerivedName`).
    const name = _isDerivedName(objects[newLead].name, source.name)
      ? _uniqueNameIn(`${source.name}.${String(all.indexOf(newLead)).padStart(3, '0')}`, draft)
      : objects[newLead].name;
    for (const id of taken) {
      before[id] = _snapshotLink(objects[id]);
      after[id] = id === newLead
        ? { name, isInternalPart: false, logicalObjectId: newLead, sourceGroupId: null, isPrintPart: !!source.isPrintPart, ..._scaleFieldsFor(objects[id], sourceRatio, source) }
        : { isInternalPart: true, logicalObjectId: newLead, sourceGroupId: null, isPrintPart: !!source.isPrintPart };
      draft[id] = { ...objects[id], ...after[id] };
    }
    // The object left behind: its lead stays its lead unless it was taken, in
    // which case the first remaining part takes over.
    const keptLead = left.includes(sourceLead) ? sourceLead : left[0];
    for (const id of left) {
      before[id] ??= _snapshotLink(objects[id]);
      after[id] = id === keptLead
        ? { name: objects[keptLead].name, isInternalPart: false, logicalObjectId: keptLead, sourceGroupId: null, isPrintPart: !!source.isPrintPart, ..._scaleFieldsFor(objects[keptLead], sourceRatio, source) }
        : { isInternalPart: true, logicalObjectId: keptLead, sourceGroupId: null, isPrintPart: !!source.isPrintPart };
    }
    this._newLeadId = newLead;
    this._keptLeadId = keptLead;
    this._sourceLeadId = sourceLead;
    // BOTH sides, not only the parts that leave: the object left behind is a different union now,
    // so replaying a repair computed over the old one is just as wrong there.
    this._unionFixes = _unionFixesToDrop(all, objects);
    this._before = before;
    this._after = after;
    this._parentId = source.parentId ?? null;
    return true;
  }
  execute() {
    if (!this._plan()) { this.applied = false; return; }
    _applyLinkPatches(this._after);
    _setGeometryFixes(this._unionFixes, false);
    _warnUnionFixDropped(this._unionFixes);
    // The new object lives where the object it came from lives: a separate must
    // not move anything, in world space or in the outliner.
    if (this._reparent === undefined) {
      const now = getState().scene.objects;
      this._reparent = (now[this._newLeadId]?.parentId ?? null) === this._parentId
        ? null
        : new ReparentCommand(this._newLeadId, this._parentId);
    }
    this._reparent?.execute();
    // The supports of the object it came from were built against geometry that
    // has just lost parts: `_applyLinkPatches` dispatches OBJECT_UPDATED per id,
    // which is what marks them stale (src/supports/stale.ts).
    //
    // What is SELECTED afterwards is the caller's call, as it is for Join and
    // SplitToParts: a command that also drove the selection would make its own
    // undo depend on a selection the user may have changed since.
    this.applied = true;
    markDirty();
  }
  undo() {
    if (!this.applied) return;
    this._reparent?.undo();
    _applyLinkPatches(this._before);
    _setGeometryFixes(this._unionFixes ?? {}, true);
    this.applied = false;
  }

  /** The new object's id, once planned: what a caller selects after the edit. */
  get newObjectId() {
    return this._plan() ? this._newLeadId : null;
  }
}

/**
 * Merge two or more displayable objects into ONE logical object: the first
 * (or `opts.leadId`) becomes the lead, every other object — and each of its
 * existing parts — becomes an internal part. Meshes keep their transforms
 * and Babylon parents. No-op (`applied === false`) with fewer than two
 * distinct objects.
 */
export class JoinCommand {
  constructor(ids, opts = {}) {
    this._requested = ids ?? [];
    this._leadHint = opts.leadId ?? null;
    this._before = null;
    this._after = null;
    this._reparent = null;      // ReparentCommand (parts → lead's parent)
    this._dissolves = [];       // emptied `<lead> parts` groups removed
    this.applied = false;
    this.label = t('history.join');
  }
  _plan() {
    if (this._before) return true;
    const objects = getState().scene.objects;
    const leads = [...new Set(this._requested.map(id => canonicalObjectId(id, objects)))]
      .filter(id => objects[id] && !objects[id].isGhost && !objects[id].isInternalPart);
    if (leads.length < 2) return false;
    const leadId = this._leadHint && leads.includes(canonicalObjectId(this._leadHint, objects))
      ? canonicalObjectId(this._leadHint, objects) : leads[0];
    const lead = objects[leadId];
    const before = {}, after = {};
    before[leadId] = _snapshotLink(lead);
    after[leadId] = { isInternalPart: false, logicalObjectId: leadId, sourceGroupId: null, isPrintPart: !!lead.isPrintPart };
    // The lead's own existing parts stay parts, re-pointed at the lead id.
    for (const id of logicalObjectPartIds(leadId, objects)) {
      if (id === leadId) continue;
      before[id] = _snapshotLink(objects[id]);
      after[id] = { isInternalPart: true, logicalObjectId: leadId, sourceGroupId: null, isPrintPart: !!lead.isPrintPart };
    }
    /*
     * The scale every swallowed part now carries, and WHY a merge writes it instead of leaving it.
     *
     * A merge already tells the operator that the lead's scale applies from here (`_ratioMismatch`,
     * gap 6) -- but it only SAID so, and left each swallowed part's own `ratio` sitting in the data
     * as a field nothing reads. Two documented steps then turned that into damage:
     *
     *   merge an object printed at 1:2 into one printed at 1:1, then convert the merged object to
     *   1:2 -- and `_rescaleObject` scales each part from its OWN previous ratio, so the body
     *   scaled x0.5 and the arm x0.25. **One object, two factors: deformed, silently.**
     *
     * Healed at the source rather than compensated for in every consumer: after this, no part of a
     * logical object disagrees with its lead about scale, so a rescale cannot derive two factors and
     * a later separate (`_scaleFieldsFor`) has no stale field to promote. `bakedRatio` records where
     * each part's vertices actually are, because a merge must never re-bake them -- which is the
     * same reason a separate records it, and the same helper.
     *
     * Undo restores all three fields: `ratio`, `bakedRatio` and `ratioSource` are in `LINK_FIELDS`,
     * so `_snapshotLink` above captured them before this patch.
     */
    const leadRatio = objectRatio(lead);
    for (const other of leads) {
      if (other === leadId) continue;
      for (const id of logicalObjectPartIds(other, objects)) {
        before[id] = _snapshotLink(objects[id]);
        after[id] = {
          isInternalPart: true, logicalObjectId: leadId, sourceGroupId: null, isPrintPart: !!lead.isPrintPart,
          ..._scaleFieldsFor(objects[id], leadRatio, lead),
        };
      }
    }
    this._leadId = leadId;
    this._before = before;
    this._after = after;
    this._droppedSupports = _supportsToDrop(leads, leadId, objects);
    this._ratioMismatch = _ratioMismatches(leads, leadId, objects);
    return true;
  }
  execute() {
    if (!this._plan()) { this.applied = false; return; }
    _applyLinkPatches(this._after);
    _setSupports(this._droppedSupports, false);
    const names = Object.keys(this._droppedSupports).map(id => getState().scene.objects[id]?.name).filter(Boolean);
    if (names.length > 0) {
      dispatch(EVENTS.TOAST, { message: t('toast.joinDroppedSupports', { names: names.join(', ') }), type: 'warning', duration: 8000 });
    }
    if (this._ratioMismatch.length > 0) {
      const lead = getState().scene.objects[this._leadId]?.name ?? this._leadId;
      dispatch(EVENTS.TOAST, {
        message: t('toast.joinRatioMismatch', { names: this._ratioMismatch.map(entry => entry.name).join(', '), name: lead }),
        type: 'warning',
        duration: 8000,
      });
    }
    // Parts live where their lead lives. First dissolve any `<lead> parts`
    // group that holds only members of this join (its children rise to the
    // group's parent), then reparent stragglers next to the lead.
    if (this._reparent === null) {
      const joined = new Set(Object.keys(this._after));
      const { groups, objects } = getState().scene;
      const candidates = new Set([...joined].map(id => objects[id]?.parentId).filter(Boolean));
      for (const gid of candidates) {
        const g = groups[gid];
        if (!g || !/ parts(\.\d+)?$/.test(g.name ?? '')) continue;
        const objKids = Object.values(objects).filter(o => o.parentId === gid);
        const hasGroupKids = Object.values(groups).some(x => x.parentId === gid);
        if (!hasGroupKids && objKids.every(o => joined.has(o.id))) this._dissolves.push(new DissolveGroupUnit(gid));
      }
      for (const d of this._dissolves) d.execute();
      const now = getState().scene.objects;
      const leadParent = now[this._leadId]?.parentId ?? null;
      const moving = [...joined].some(id => id !== this._leadId && (now[id]?.parentId ?? null) !== leadParent);
      this._reparent = moving ? new ReparentCommand(this._leadId, leadParent) : false;
      if (this._reparent) this._reparent.execute();
    } else {
      for (const d of this._dissolves) d.execute();
      if (this._reparent) this._reparent.execute();
    }
    this.applied = true;
    markDirty();
  }
  undo() {
    if (!this.applied) return;
    if (this._reparent) this._reparent.undo();
    for (let i = this._dissolves.length - 1; i >= 0; i--) this._dissolves[i].undo();
    _applyLinkPatches(this._before);
    _setSupports(this._droppedSupports ?? {}, true);
    this.applied = false;
  }
}
