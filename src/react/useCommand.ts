import { useMemo } from 'react';
import { push, beginBatch, endBatch } from '../core/HistoryManager.js';

export interface UndoableCommand {
  label: string;
  execute(): void;
  undo(): void;
}

export interface CommandApi {
  run(command: UndoableCommand): void;
  batch(label: string, fn: () => void): void;
}

/** The only write path for panels: commands through HistoryManager. */
export function useCommand(): CommandApi {
  return useMemo<CommandApi>(() => ({
    run: (command) => push(command),
    batch: (label, fn) => {
      beginBatch(label);
      try { fn(); } finally { endBatch(); }
    },
  }), []);
}
