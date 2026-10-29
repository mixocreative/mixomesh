/**
 * Support edit commands (plan P3.1): one class per edit, each one HistoryManager step.
 * `commitSupportEdits` pushes one command, or several (a gesture over several objects) as one batch.
 */
import { beginBatch, endBatch, push } from '../../core/HistoryManager.js';

export { SupportEditCommand } from './SupportEditCommand';
export { AddSupportCommand, type AddSupportInput } from './AddSupportCommand';
export { DeleteSupportsCommand } from './DeleteSupportsCommand';
export { StampStrokeCommand } from './StampStrokeCommand';
export { SetOverrideCommand, ResetOverrideCommand } from './OverrideCommands';
export { ChangeSettingsCommand, ApplyPresetCommand, type SettingsPatch } from './SettingsCommands';
export { LiftForSupportsCommand, liftDelta, babylonLiftScene, type LiftScene, type WorldTransform } from './LiftForSupportsCommand';
export { RegenerateRekeyCommand, type RegenerateInput } from './RegenerateRekeyCommand';

interface Command { label: string; execute(): void; undo(): void }

/** Push `commands` as one undo step: the command itself, or a batch under `label` (default: the first's). */
export function commitSupportEdits(commands: readonly Command[], label = commands[0]?.label ?? ''): void {
  if (commands.length === 0) return;
  if (commands.length === 1) {
    push(commands[0]);
    return;
  }
  beginBatch(label);
  try {
    for (const command of commands) push(command);
  } finally {
    endBatch();
  }
}
