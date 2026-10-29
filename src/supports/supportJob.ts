/**
 * Engine-frame support job of one logical object (spike P2.1; P3 grows it into the object model).
 * Everything here is in the engine frame (mm, right-handed, Y up); `frame.ts` is the only way in
 * and out. Pure apart from the engine calls the caller makes (placement, `generate`).
 *
 * The model is sent object-local: centred on its own bounding box, with `frame.position` saying
 * where that centre stands. Moving an object therefore never changes its contacts (contacts are
 * object-local; only rotation and scale make supports stale, plan P3 "Stale supports").
 */
import type { PlacementResult, TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import type { SupportJob } from '@mixo-geocore/host/core/jobs';
import type { GeneratedSupportMesh } from '@mixo-geocore/host/core/supports/mesh';
import { applyPreset, defaultSupportSettings, type LiveSupportSettings, type PresetName } from '@mixo-geocore/host/core/supports/settings';
import type { Vec3 } from './frame';

/** Settings of a preset with every other key at its default. */
export function presetSettings(name: PresetName = 'MIDDLE'): LiveSupportSettings {
  return applyPreset(name, { ...defaultSupportSettings, roofSeededModes: [] });
}

/** An engine-frame model split into its object-local mesh and where its box centre stands. */
export interface LocalModel {
  local: TriangleMesh;
  center: Vec3;
  /** Lowest point of the model, engine frame. */
  minY: number;
}

export function toLocal(world: TriangleMesh): LocalModel {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const p = world.positions;
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  const center: Vec3 = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
  const positions = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) positions[i] = p[i]! - center[i % 3]!;
  return { local: { positions, indices: world.indices }, center, minY: min[1]! };
}

/**
 * The preview (or export) job for a model and its automatic placement. The plate sits `liftHeight`
 * under the model's lowest point (the engine's own first-placement rule), in plate space (where
 * `frame` puts the model).
 */
export function supportJob(model: LocalModel, settings: LiveSupportSettings, placement: Pick<PlacementResult, 'points'>, mode: SupportJob['mode'] = 'preview'): SupportJob {
  const frame = { position: [...model.center] as Vec3, rotation: [0, 0, 0] as Vec3 };
  return {
    mesh: model.local,
    frame,
    plate: model.minY - settings.liftHeight,
    settings,
    contacts: { points: placement.points, manual: [], deleted: [], zones: [], contactSettings: {} },
    labelText: '',
    mode,
  };
}

/** A support mesh the job runner returned (object-local) moved back to the engine world frame. */
export function supportsToWorld(mesh: GeneratedSupportMesh, center: Readonly<Vec3>): GeneratedSupportMesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = mesh.positions[i]! + center[i % 3]!;
  return { ...mesh, positions };
}

/** Distinct contacts the built supports carry (one per tip). */
export function tipCount(mesh: Pick<GeneratedSupportMesh, 'components'>): number {
  return new Set(mesh.components.flatMap((c) => (c.contactId ? [c.contactId] : []))).size;
}
