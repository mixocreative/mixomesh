/**
 * The support area (plan P3.4): Paint | Erase and a brush radius in mm (default 2). Paint marks a
 * no-support zone, Erase clears it (the engine's generic policy; the "allowed area" meaning is
 * P5.10). Keys P / E choose the kind. Turning it on leaves the edit tools; the Done/Esc order
 * returns to Edit (sessionStore).
 */
import { Toggle } from '../../kit/index.ts';
import { useT } from '../../react/index.ts';
import { KeyCaps } from '../../kit/index.ts';
import { SurfaceBrushBar } from './SurfaceBrushBar';
import { TOOL_KEYS, chooseZoneKind, supportSession, useSession } from './sessionStore';
import { useSupportUi } from './supportUi';

export function ZonesBar() {
  const tt = useT();
  const session = useSession();
  const ui = useSupportUi();
  const on = session.mode === 'zones';
  return (
    <section className="sp-bar" aria-label={tt('supportPanel.zones.title')}>
      <Toggle pressed={on} className="sp-mode" title={tt('supportPanel.zones.hint')}
        onChange={(next) => (next ? chooseZoneKind(supportSession, session.zoneKind) : (supportSession.send({ type: 'exit' }), supportSession.send({ type: 'enterEdit' })))}>
        {tt('supportPanel.zones.title')}
      </Toggle>
      {on && (
        <>
          <p className="sp-engaged" role="status">
            {tt(session.zoneKind === 'paint' ? 'supportPanel.engaged.zonePaint' : 'supportPanel.engaged.zoneErase')}
          </p>
          <SurfaceBrushBar
            label={tt('supportPanel.zones.brush')}
            kind={session.zoneKind}
            options={[
              { value: 'paint', label: tt('supportPanel.zones.paint'), title: tt('supportPanel.zones.paintHint') },
              { value: 'erase', label: tt('supportPanel.zones.erase'), title: tt('supportPanel.zones.eraseHint') },
            ]}
            radius={session.zoneRadius}
            radiusLabel={tt('supportPanel.zones.radius')}
            onKindChange={(kind) => supportSession.send({ type: 'setZoneKind', kind })}
            onRadiusInput={(radius) => supportSession.send({ type: 'setZoneRadius', radius })}
            onRadiusCommit={(radius) => supportSession.send({ type: 'setZoneRadius', radius })}
          >
            <p className="mx-hint">
              <KeyCaps shortcut={TOOL_KEYS.paint} /> {tt('supportPanel.zones.paint')} · <KeyCaps shortcut={TOOL_KEYS.erase} /> {tt('supportPanel.zones.erase')}
            </p>
            {!ui.bottomView && <p className="mx-hint" role="note">{tt('supportPanel.zones.bottomNote')}</p>}
          </SurfaceBrushBar>
        </>
      )}
    </section>
  );
}
