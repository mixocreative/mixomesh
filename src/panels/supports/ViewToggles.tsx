/**
 * View toggles of Support Mode (plan P3.4): Tips only (the object's preview mode, so the contact
 * tips alone are built and drawn), Bottom view (the camera looks up at the contacts; the grid and
 * floor disc are hidden) and Fit view. The camera moves are P3.5 seams (`handlers`).
 */
import { Button, Toggle } from '../../kit/index.ts';
import { useT } from '../../react/index.ts';
import { handlers, supportUi, useSupportUi } from './supportUi';
import { commitSetting, useShapeScope } from './supportData';
import { useSession } from './sessionStore';

export function ViewToggles({ objectId }: { objectId: string | undefined }) {
  const tt = useT();
  const session = useSession();
  const ui = useSupportUi();
  const { scope } = useShapeScope(objectId, session.selection);
  const tipsOnly = scope.settings.previewMode === 'ONLY_TIP';
  return (
    <section className="sp-views" aria-label={tt('supportPanel.view.title')}>
      <Toggle pressed={tipsOnly} disabled={!objectId} title={tt('supportPanel.view.tipsOnlyHint')}
        onChange={(on) => { if (objectId) commitSetting(objectId, scope, 'previewMode', on ? 'ONLY_TIP' : 'FULL'); }}>
        {tt('supportPanel.view.tipsOnly')}
      </Toggle>
      <Toggle pressed={ui.bottomView} title={tt('supportPanel.view.bottomHint')}
        onChange={(on) => { supportUi.set({ bottomView: on }); handlers.setBottomView?.(on); }}>
        {tt('supportPanel.view.bottom')}
      </Toggle>
      <Button title={tt('supportPanel.view.fitHint')} onClick={() => handlers.fitView?.()}>{tt('supportPanel.view.fit')}</Button>
    </section>
  );
}
