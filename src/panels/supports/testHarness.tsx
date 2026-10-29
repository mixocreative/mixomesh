// Test-only helpers for the Support Mode panel tests (not imported by the app).
import '../../supports/testEnv';
/* eslint-disable @typescript-eslint/no-explicit-any -- state.scene.objects is untyped JS state */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { SupportPoint } from '@mixo-geocore/host/core/analysis/types';
import { StateManager, getState, setState } from '../../core/StateManager.js';
import { clear } from '../../core/HistoryManager.js';
import { ToastProvider } from '../../kit/index.ts';
import { emptySupports, type ObjectSupports } from '../../supports/model';
import { cachePlacement, forgetSupportCaches } from '../../supports/supportCache';
import { supportSession } from './sessionStore';
import { supportUi, handlers } from './supportUi';

export const auto = (id: string, x: number): SupportPoint => ({ id, regionId: 0, position: [x, -5, 0], normal: [0, -1, 0], source: 'interior' });

/** One logical object `obj` carrying `supports` (or a fresh record), with three automatic tips in the placement cache. */
export function resetWorld(supports: ObjectSupports | undefined = emptySupports()) {
  StateManager.replaceState(StateManager.freshState());
  clear();
  forgetSupportCaches();
  supportSession.reset();
  supportUi.reset();
  for (const key of Object.keys(handlers)) delete (handlers as Record<string, unknown>)[key];
  setState((s: any) => ({
    ...s,
    scene: { ...s.scene, objects: { obj: { id: 'obj', name: 'Crown', visible: true, logicalObjectId: 'obj', isInternalPart: false, ...(supports ? { supports } : {}) } } },
  }), { silent: true });
  cachePlacement('obj', [auto('auto-a', 0), auto('auto-b', 3), auto('auto-c', 6)]);
}

export const record = (): ObjectSupports => (getState().scene.objects.obj as any).supports;

export function renderPanel(ui: ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

/** Start the session as Support Mode does: Edit open on obj. */
export function openEdit() {
  supportSession.send({ type: 'activeUnitChanged', id: 'obj' });
  supportSession.send({ type: 'enterEdit' });
}
