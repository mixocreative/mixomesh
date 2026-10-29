/**
 * Support Mode's panel stack (plan P3.4), mounted over the dimmed right panel while the mode is open:
 * the object picker (several selected objects each have their own supports), Generate, the edit
 * tools, the support area brush, view toggles, problem list and settings. Undo toasts use the kit
 * toast host of this root.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { Select, ToastProvider } from '../../kit/index.ts';
import { EVENTS } from '../../core/events.js';
import { useStore, useT } from '../../react/index.ts';
import { supportMode, type SupportModeInfo } from '../../supports/SupportMode';
import { EditBar } from './EditBar';
import { GenerateRow } from './GenerateRow';
import { ProblemList } from './ProblemList';
import { SupportPanel } from './SupportPanel';
import { ViewToggles } from './ViewToggles';
import { ZonesBar } from './ZonesBar';
import { supportSession } from './sessionStore';
import { supportUi, useSupportUi } from './supportUi';

/** The object the panel edits: the chosen one when it is still in the mode, else the first. */
export function resolveTarget(objectIds: readonly string[], chosen: string | undefined): string | undefined {
  return chosen && objectIds.includes(chosen) ? chosen : objectIds[0];
}

export function SupportsPanel({ objectIds }: { objectIds: readonly string[] }) {
  const tt = useT();
  const ui = useSupportUi();
  const target = resolveTarget(objectIds, ui.targetId);
  const names = useStore([EVENTS.OBJECT_RENAMED, EVENTS.PROJECT_LOADED, EVENTS.PROJECT_NEW], (s) =>
    Object.fromEntries(objectIds.map((id) => [id, (s.scene.objects[id]?.name as string | undefined) ?? id])) as Record<string, string>,
  (a, b) => objectIds.every((id) => a[id] === b[id]));

  useEffect(() => {
    if (supportSession.get().activeUnitId !== target) supportSession.send({ type: 'activeUnitChanged', id: target });
    if (supportUi.get().targetId !== target) supportUi.set({ targetId: target });
  }, [target]);

  return (
    <ToastProvider>
      <div className="sp-stack" data-testid="supports-panel">
        {objectIds.length > 1 && (
          <Select label={tt('supportPanel.object')} value={target ?? ''}
            options={objectIds.map((id) => ({ value: id, label: names[id] ?? id }))}
            onChange={(id) => supportUi.set({ targetId: id })} />
        )}
        <GenerateRow objectIds={objectIds} objectId={target} />
        <ProblemList unitName={(id) => names[id] ?? id} />
        <EditBar objectId={target} />
        <ZonesBar />
        <ViewToggles objectId={target} />
        <SupportPanel objectId={target} />
      </div>
    </ToastProvider>
  );
}

let current: SupportModeInfo = { active: false, objectIds: [] };
const subscribeMode = (fn: () => void) => supportMode.onChange((info) => { current = info; fn(); });
const getMode = () => current;

/** Connected root: renders the stack only while Support Mode is open. */
export function SupportsRoot() {
  const mode = useSyncExternalStore(subscribeMode, getMode, getMode);
  return mode.active ? <SupportsPanel objectIds={mode.objectIds} /> : null;
}
