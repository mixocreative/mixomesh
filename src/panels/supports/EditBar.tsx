/**
 * Edit supports (plan P3.4): the tools Add | Select, how to select (Click | Drag over, circle size
 * 8 to 80 px, default 24), the Add | Remove switch for touch, Click reach in mm, and the actions on
 * the selected tips. The engaged tool is named with what a click does ("Click the model to add a
 * support"). Keys: A Add, S Select, Delete removes the selection, Esc clears it, then resets the
 * tool, then leaves the mode.
 *
 * The pointer work itself (picking, the ring, the ghost tip) is drawn and run by the viewport
 * layers (P3.3 / P3.5); this bar only holds the session they read.
 */
import { gesture, type Gesture } from '@mixo-geocore/editing/gesture';
import { settingLimits } from '@mixo-geocore/host/core/supports/settings';
import { Button, KeyCaps, NumberField, RangeField, Segmented, Toggle, useToasts } from '../../kit/index.ts';
import { useT } from '../../react/index.ts';
import { undo } from '../../core/HistoryManager.js';
import { TOOL_KEYS, chooseTool, supportSession, useSession } from './sessionStore';
import { commitDelete, commitSetting, useShapeScope } from './supportData';

/** The locale key naming what a click or drag does now. */
export function engagedKey(g: Gesture): string {
  switch (g.kind) {
    case 'add': return g.remove ? 'supportPanel.engaged.remove' : 'supportPanel.engaged.add';
    case 'pick': return 'supportPanel.engaged.pick';
    case 'drag': return g.brush.mode === 'unselect' ? 'supportPanel.engaged.dragUnselect' : 'supportPanel.engaged.drag';
    case 'zones': return g.brush.kind === 'paint' ? 'supportPanel.engaged.zonePaint' : 'supportPanel.engaged.zoneErase';
    default: return 'supportPanel.engaged.none';
  }
}

export const CIRCLE_RANGE = { min: 8, max: 80, step: 4 } as const;

export function EditBar({ objectId }: { objectId: string | undefined }) {
  const tt = useT();
  const session = useSession();
  const toasts = useToasts();
  const { scope } = useShapeScope(objectId, session.selection);
  const editing = session.mode === 'edit';
  const g = gesture(session);
  const selected = scope.selected;

  const reach = (v: number) => { if (objectId) commitSetting(objectId, scope, 'eraseRadius', v); };
  const deleteSelected = () => {
    if (!objectId || selected.length === 0) return;
    const ids = [...selected];
    commitDelete(objectId, ids);
    supportSession.send({ type: 'clearSelection' });
    toasts.push({ message: tt('supportPanel.toast.deleted', { n: ids.length }), action: { label: tt('supportPanel.undo'), onClick: () => undo() }, timeoutMs: 6000 });
  };

  return (
    <section className="sp-bar" aria-label={tt('supportPanel.edit.title')}>
      <Toggle pressed={editing} className="sp-mode" title={tt('supportPanel.edit.hint')}
        onChange={(next) => (next ? chooseTool(supportSession, session.tool === 'select' ? 'select' : 'add') : supportSession.send({ type: 'exit' }))}>
        {tt('supportPanel.edit.title')}
      </Toggle>
      {editing && (
        <>
          <p className="sp-engaged" role="status" data-testid="engaged-tool">{tt(engagedKey(g))}</p>
          <div className="field-row">
            <label>{tt('supportPanel.edit.tool')}</label>
            <Segmented label={tt('supportPanel.edit.tool')} value={session.tool === 'select' ? 'select' : 'add'}
              onChange={(tool) => chooseTool(supportSession, tool)}
              options={[
                { value: 'add', label: <>{tt('supportPanel.edit.add')} <kbd>{TOOL_KEYS.add}</kbd></>, title: tt('supportPanel.edit.addHint') },
                { value: 'select', label: <>{tt('supportPanel.edit.select')} <kbd>{TOOL_KEYS.select}</kbd></>, title: tt('supportPanel.edit.selectHint') },
              ]} />
          </div>

          {session.tool === 'add' && (
            <>
              <div className="field-row">
                <label>{tt('supportPanel.edit.click')}</label>
                <Segmented label={tt('supportPanel.edit.click')} value={session.addAction}
                  onChange={(action) => supportSession.send({ type: 'setAddAction', action })}
                  options={[
                    { value: 'add', label: tt('supportPanel.edit.clickAdd'), title: tt('supportPanel.edit.clickAddHint') },
                    { value: 'remove', label: tt('supportPanel.edit.clickRemove'), title: tt('supportPanel.edit.clickRemoveHint') },
                  ]} />
              </div>
              <NumberField label={tt('supportPanel.edit.reach')} unit="mm" step={0.1}
                min={settingLimits.eraseRadius.min} max={settingLimits.eraseRadius.max}
                value={scope.settings.eraseRadius} disabled={!objectId} onCommit={reach} />
            </>
          )}

          {session.tool === 'select' && (
            <>
              <div className="field-row">
                <label>{tt('supportPanel.edit.how')}</label>
                <Segmented label={tt('supportPanel.edit.how')} value={session.selectStyle}
                  onChange={(style) => supportSession.send({ type: 'setSelectStyle', style })}
                  options={[
                    { value: 'click', label: tt('supportPanel.edit.styleClick'), title: tt('supportPanel.edit.styleClickHint') },
                    { value: 'brush', label: tt('supportPanel.edit.styleDrag'), title: tt('supportPanel.edit.styleDragHint') },
                  ]} />
              </div>
              {session.selectStyle === 'brush' && (
                <>
                  <div className="field-row">
                    <label>{tt('supportPanel.edit.dragging')}</label>
                    <Segmented label={tt('supportPanel.edit.dragging')} value={session.brushMode}
                      onChange={(mode) => supportSession.send({ type: 'setBrushMode', mode })}
                      options={[
                        { value: 'select', label: tt('supportPanel.edit.dragSelect') },
                        { value: 'unselect', label: tt('supportPanel.edit.dragUnselect') },
                      ]} />
                  </div>
                  <p className="mx-hint">{tt(session.brushMode === 'select' ? 'supportPanel.edit.shiftUnselect' : 'supportPanel.edit.shiftSelect')}</p>
                  <RangeField label={tt('supportPanel.edit.circle')} unit="px" {...CIRCLE_RANGE} value={session.brushRadius}
                    onInput={(radius) => { supportSession.send({ type: 'setBrushSizing', sizing: true }); supportSession.send({ type: 'setBrushRadius', radius }); }}
                    onCommit={(radius) => { supportSession.send({ type: 'setBrushRadius', radius }); supportSession.send({ type: 'setBrushSizing', sizing: false }); }} />
                </>
              )}
            </>
          )}

          <p className="mx-hint">
            <kbd>{tt('supportPanel.edit.rightClick')}</kbd> {tt('supportPanel.edit.removes')} · <KeyCaps shortcut="Ctrl+Z" /> {tt('supportPanel.undo')}
          </p>
          {selected.length > 0 && (
            <div className="sp-selection">
              <span className="sp-count" role="status">{tt('supportPanel.edit.selected', { n: selected.length })}</span>
              <Button variant="danger" onClick={deleteSelected}>{tt('supportPanel.edit.delete')} <kbd>Del</kbd></Button>
              <Button onClick={() => supportSession.send({ type: 'clearSelection' })}>{tt('supportPanel.edit.clear')} <kbd>Esc</kbd></Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
