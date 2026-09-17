/**
 * engineDiagnose — the ONE guarded call into the repair engine's diagnose().
 *
 * Shared by the validator (which turns the answer into `holes` results) and
 * by RepairSession (which uses it to skip healthy parts), so both classify a
 * non-answer the same way and neither swallows one (review I5).
 */

import { diagnoseMesh } from './MeshRepair.js';

// Repeated "engine unavailable" / "too large" diagnoses are logged ONCE per
// mesh+reason (they recur on every re-validation and would otherwise bury the
// console); a REAL failure is logged every time.
const _logged = new Set();

/**
 * Diagnose a mesh, or a raw positions+indices pair (a group union has no mesh
 * object — diagnoseMesh only ever calls getVerticesData/getIndices, so a
 * duck-typed wrapper is enough).
 *
 * Never throws and never swallows: the failure is CLASSIFIED so the caller
 * can tell "no engine" / "too large to diagnose" — both meaning *cannot
 * answer*, which is not a geometry verdict — from a real engine failure, and
 * every case reaches the console with the mesh name.
 *
 * @param {object|ArrayLike<number>} meshOrPositions
 * @param {ArrayLike<number>|null} [indices] present ⇒ the first argument is a position buffer
 * @param {string} [name] label for the log line when there is no mesh
 * @returns {Promise<{diag: object|null, reason: null|'no-engine'|'too-large'|'failed'}>}
 */
export async function engineDiagnose(meshOrPositions, indices = null, name = 'mesh') {
  const target = indices
    ? { name, getVerticesData: () => meshOrPositions, getIndices: () => indices }
    : meshOrPositions;
  try {
    return { diag: await diagnoseMesh(target), reason: null };
  } catch (err) {
    const message = err?.message ?? String(err);
    const reason = /no engine/i.test(message) ? 'no-engine'
      : /too large/i.test(message) ? 'too-large'
      : 'failed';
    const label = target?.name ?? name;
    const key = `${label}:${reason}`;
    if (reason === 'failed' || !_logged.has(key)) {
      _logged.add(key);
      console.error(reason === 'failed'
        ? `Repair engine: diagnose FAILED for "${label}":`
        : `Repair engine: diagnose unavailable (${reason}) for "${label}":`, message);
    }
    return { diag: null, reason };
  }
}
