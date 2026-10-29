/**
 * Live support generation wiring (plan P3.5): registers the handlers the Support Mode panels call
 * (Generate, Cancel, Show / Fix, Bottom view, Fit view, Remove all, Apply to all) and starts the
 * pointer gestures. Loaded lazily from app/main.ts (it pulls the worker entries).
 */
import { t } from '../../i18n/index.js';
import { supportUi, type PanelProblem } from '../../panels/supports/supportUi';
import { supportMode } from '../SupportMode';
import { commitSupportEdits, LiftForSupportsCommand, RemoveSupportsCommand, SetSettingsCommand } from '../commands';
import { isBuilt } from '../model';
import { readSupports } from '../store';
import { installLiveGeneration, liftObject } from './liveGeneration';
import { clearFixSpot, setFixSpot } from './fixSpot';
import { fitView, resetCamera, setBottomView, showProblem } from './supportCamera';
import { installSupportInteraction } from './supportInteraction';
import { notify } from './notices';

function removeAll(ids: readonly string[]): void {
  const built = ids.filter((id) => isBuilt(readSupports(id)));
  if (built.length === 0) return;
  commitSupportEdits(built.map((id) => new RemoveSupportsCommand(id)), t('history.supportRemoveAll'));
  notify({
    message: t('supportLive.removedAll', { n: built.length }),
    action: {
      label: t('supportLive.dropToBed'),
      onClick: () => commitSupportEdits(built.flatMap((id) => {
        const lift = new LiftForSupportsCommand(id, 0);
        return lift.moves ? [lift] : [];
      }), t('history.liftForSupports')),
    },
  });
}

function applyToAll(from: string, ids: readonly string[]): void {
  const source = readSupports(from);
  if (!source) return;
  const commands = ids.filter((id) => id !== from).flatMap((id) => {
    const set = new SetSettingsCommand(id, source.settings);
    const record = readSupports(id);
    const lift = record && isBuilt(record) && record.settings.liftHeight !== source.settings.liftHeight ? new LiftForSupportsCommand(id, source.settings.liftHeight) : undefined;
    return lift?.moves ? [set, lift] : [set];
  });
  if (commands.length > 0) commitSupportEdits(commands, t('history.supportSettings'));
}

export function installLive(): void {
  installLiveGeneration();
  installSupportInteraction();
  supportUi.register({
    showProblem: (problem: PanelProblem) => showProblem(problem),
    fixProblem: (problem: PanelProblem) => {
      showProblem(problem);
      setFixSpot(problem.unitId, problem.position, problem.area);
    },
    setBottomView,
    fitView,
    removeAll,
    applyToAll,
  });
  supportMode.onChange((info) => {
    if (!info.active) { resetCamera(); clearFixSpot(); }
  });
}

export { liftObject };
