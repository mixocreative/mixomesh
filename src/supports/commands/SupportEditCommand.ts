/**
 * Base of every support edit (plan P3.1, D21: HistoryManager is the one undo stack). An edit is
 * a pure transition `prev -> next` of one lead's `object.supports`, worked out on its FIRST execute
 * from the record as it stands then (so several edits of one object in one batch chain correctly),
 * and replayed verbatim on redo. Undo writes `prev` back (absent stays absent). Every `next` gets a
 * fresh revision, so the runtime caches drop whatever they built for the old one.
 *
 * `supportsCommand` marks the entry for the mode-scoped undo of Support Mode (P3.2).
 */
import { markDirty } from '../../core/StateManager.js';
import { emptySupports, nextRevision, type ObjectSupports } from '../model';
import { readSupports, supportsOwner, writeSupports } from '../store';

export abstract class SupportEditCommand {
  readonly supportsCommand = true;
  readonly objectId: string;
  label: string;
  private prev: ObjectSupports | undefined;
  private next: ObjectSupports | undefined;
  private applied = false;

  protected constructor(objectId: string, label: string) {
    this.objectId = supportsOwner(objectId);
    this.label = label;
  }

  /** The record after this edit, from the record before it (a fresh one when the object had none). */
  protected abstract transition(prev: ObjectSupports): ObjectSupports;

  execute(): void {
    if (!this.applied) {
      this.prev = readSupports(this.objectId);
      const changed = this.transition(structuredClone(this.prev ?? emptySupports()));
      this.next = { ...changed, revision: nextRevision(this.prev?.revision ?? 0) };
      this.applied = true;
    }
    writeSupports(this.objectId, this.next);
    this.afterWrite('execute');
    markDirty();
  }

  undo(): void {
    writeSupports(this.objectId, this.prev);
    this.afterWrite('undo');
  }

  /** Runtime side effects that follow the state (caches); state itself is written already. */
  protected afterWrite(_side: 'execute' | 'undo'): void {}
}
