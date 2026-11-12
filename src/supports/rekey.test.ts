// Plan P3.1: RegenerateRekey through the real engine (pkg via initSync, cube-overhang fixture):
// manual contacts stay as they are, removals and per-support settings move to the nearest new
// contact, and the whole landing is one undo step.
import './testEnv';
/* eslint-disable @typescript-eslint/no-explicit-any -- state.scene.objects is untyped JS state */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { configureGeometry, geometryReady } from '@mixo-geocore/host/workers/geometryClient';
import { placeGeneric } from '@mixo-geocore/host/supports/genericPlacement';
import { toPlacementSettings } from '@mixo-geocore/host/core/supports/settings';
import type { SupportPoint, TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { getState, setState } from '../core/StateManager.js';
import { clear, getUndoLabel, undo } from '../core/HistoryManager.js';
import { t } from '../i18n/index.js';
import { AddSupportCommand, ChangeSettingsCommand, DeleteSupportsCommand, RegenerateRekeyCommand, SetOverrideCommand, commitSupportEdits } from './commands';
import { meshFromEngine, partsToEngine } from './frame';
import { emptySupports, type ObjectSupports } from './model';
import { hashParts } from './sourceHash';
import { readSupports } from './store';
import { cachedPlacement } from './supportCache';
import { presetSettings, toLocal } from './supportJob';
import { cubeOverhang } from '../../tests/fixtures/support-cubes.mjs';

const VENDOR = fileURLToPath(new URL('../../public/vendor/mixo-geocore/', import.meta.url));

beforeAll(async () => {
  configureGeometry(pathToFileURL(VENDOR + 'mixo_geometry_wasm.js').href, readFileSync(VENDOR + 'mixo_geometry_wasm_bg.wasm'));
  await geometryReady();
});

const POSE = { rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
const part = () => {
  const { positions, indices } = meshFromEngine(cubeOverhang() as TriangleMesh, true);
  return { positions, indices, clockwise: true };
};

function place(spacing: number): SupportPoint[] {
  const local = toLocal(partsToEngine([part()]).mesh).local;
  return placeGeneric(local, toPlacementSettings({ ...presetSettings('MIDDLE'), scatterSpacing: spacing })).points;
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const nearest = (points: readonly SupportPoint[], at: readonly number[]) => points.reduce((best, p) => (dist(p.position, at) < dist(best.position, at) ? p : best));

describe('RegenerateRekey with the engine', () => {
  it('keeps manual contacts and moves removals and settings to the nearest new contact', () => {
    clear();
    setState((s: any) => ({ ...s, scene: { ...s.scene, objects: { cube: { id: 'cube', logicalObjectId: null } } } }), { silent: true });
    const hash = hashParts([part()]);

    // First generation (no hand work yet).
    const first = place(2);
    expect(first.length).toBeGreaterThan(10);
    commitSupportEdits([new RegenerateRekeyCommand('cube', { points: first, sourceHash: hash, pose: POSE })]);
    expect(cachedPlacement('cube')).toEqual(first);

    // The regeneration at the new spacing gives other contacts with other ids (placement is
    // deterministic, so it is worked out up front to pick hand work that has to MOVE).
    const second = place(2.3);
    const secondIds = new Set(second.map((p) => p.id));
    const radius = 2.3 / 2;
    const movers = first.filter((p) => !secondIds.has(p.id) && dist(nearest(second, p.position).position, p.position) <= radius);
    const picked: SupportPoint[] = [];
    for (const p of movers) if (!picked.some((q) => nearest(second, q.position).id === nearest(second, p.position).id)) picked.push(p);
    expect(picked.length).toBeGreaterThanOrEqual(3);
    const [gone1, gone2, custom] = picked as [SupportPoint, SupportPoint, SupportPoint];

    // Hand work: two removals, one setting, one manual tip far from every automatic one.
    commitSupportEdits([new DeleteSupportsCommand('cube', [gone1.id, gone2.id])]);
    commitSupportEdits([new SetOverrideCommand('cube', [custom.id], { neckDiameter: 0.55 })]);
    const add = new AddSupportCommand('cube', { point: [0, 0, 20], normal: [0, -1, 0], worldNormal: [0, -1, 0], overhangAngleDeg: 180, candidates: first, reach: 0.1, createId: () => 'manual-keep' });
    commitSupportEdits([add]);
    commitSupportEdits([new ChangeSettingsCommand('cube', { scatterSpacing: 2.3 })]);
    const before = structuredClone(readSupports('cube')!) as ObjectSupports;

    // Regenerate.
    const regen = new RegenerateRekeyCommand('cube', { points: second, sourceHash: hash, pose: POSE });
    commitSupportEdits([regen]);
    expect(getUndoLabel()).toBe(t('history.supportRegenerate'));
    const after = readSupports('cube')!;

    expect(after.manual).toEqual(before.manual);
    expect(before.settings.scatterSpacing / 2).toBe(radius);
    expect([...after.deleted].sort()).toEqual([nearest(second, gone1.position).id, nearest(second, gone2.position).id].sort());
    expect(after.deleted).not.toContain(gone1.id);
    expect(after.overrides).toEqual({ [nearest(second, custom.position).id]: { neckDiameter: 0.55 } });
    expect(regen.report).toMatchObject({ added: 1, removed: 2, reset: 0, customisedKept: 1, customisedReset: 0 });
    expect(after.placed?.scatterSpacing).toBe(2.3);
    expect(after.stale).toBeNull();
    expect(cachedPlacement('cube')).toEqual(second);

    // One step: undo restores the record and the placement.
    undo();
    expect(JSON.parse(JSON.stringify(getState().scene.objects.cube.supports))).toEqual(before);
    expect(cachedPlacement('cube')).toEqual(first);
  });

  it('a regeneration clears a stale verdict and records the new build', () => {
    clear();
    const stale: ObjectSupports = { ...emptySupports(), sourceHash: 'old', pose: { rotation: [0, 0.6, 0, 0.8], scale: [1, 1, 1] }, revision: 2, stale: 'pose' };
    setState((s: any) => ({ ...s, scene: { ...s.scene, objects: { cube: { id: 'cube', supports: stale } } } }), { silent: true });
    commitSupportEdits([new RegenerateRekeyCommand('cube', { points: place(2), sourceHash: 'new', pose: POSE })]);
    expect(readSupports('cube')).toMatchObject({ sourceHash: 'new', pose: POSE, stale: null });
    undo();
    expect(readSupports('cube')).toMatchObject({ sourceHash: 'old', stale: 'pose' });
  });
});
