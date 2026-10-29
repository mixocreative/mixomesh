/**
 * `sourceHash` of a logical object (plan P3.1): a cheap stable hash of the welded engine copy
 * (`frame.ts` `partsToEngine`: engine frame, welded by position, snapped to 1 um) of its parts in
 * the LEAD's local frame, so neither translation nor rotation nor scale changes it (pose covers
 * those). Two 32-bit lanes over the counts, positions and indices: 16 hex chars.
 */
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { partsToEngine, type BabylonPart } from './frame';

function mix(h: number, word: number, prime: number): number {
  return Math.imul(h ^ word, prime) >>> 0;
}

export function hashEngineMesh(mesh: TriangleMesh): string {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  const pa = 0x01000193;
  const pb = 0x5bd1e995;
  const words = (view: Uint32Array) => {
    for (let i = 0; i < view.length; i++) {
      a = mix(a, view[i]!, pa);
      b = mix(b, view[i]! + i, pb);
    }
  };
  words(Uint32Array.of(mesh.positions.length, mesh.indices.length));
  const p = mesh.positions instanceof Float32Array ? mesh.positions : Float32Array.from(mesh.positions);
  words(new Uint32Array(p.buffer, p.byteOffset, p.length));
  const ix = mesh.indices instanceof Uint32Array ? mesh.indices : Uint32Array.from(mesh.indices);
  words(ix);
  b ^= b >>> 13;
  b = Math.imul(b, pb) >>> 0;
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Hash of the parts (lead-local, Babylon units) as the engine would receive them. */
export function hashParts(parts: readonly BabylonPart[]): string {
  return hashEngineMesh(partsToEngine(parts).mesh);
}

/**
 * Lazy per-object cache: the hash is worked out once per geometry version (`versionKey`, e.g. the
 * parts' GeometryStore revisions plus the refinement level) and reused until the key changes.
 */
export class SourceHashCache {
  private readonly entries = new Map<string, { key: string; hash: string }>();

  get(objectId: string, versionKey: string, parts: () => readonly BabylonPart[]): string {
    const hit = this.entries.get(objectId);
    if (hit && hit.key === versionKey) return hit.hash;
    const hash = hashParts(parts());
    this.entries.set(objectId, { key: versionKey, hash });
    return hash;
  }

  forget(objectId?: string): void {
    if (objectId === undefined) this.entries.clear();
    else this.entries.delete(objectId);
  }
}
