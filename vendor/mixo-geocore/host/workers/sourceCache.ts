import type { TriangleMesh } from '../core/analysis/types';

/** Bytes a mesh's arrays take. */
export function meshBytes(mesh: TriangleMesh): number {
  return mesh.positions.byteLength + mesh.indices.byteLength;
}

/**
 * The support-mesh worker's models, one per unit under the token of the source it came from, so
 * a later job need not send the model again (the WASM side of a unit, its build session, is in
 * `buildSessions`). Freed explicitly when the unit is removed (`delete`), and kept under a total
 * byte cap (`trim` evicts the least recently used models a running job does not need; the client
 * sends an evicted model again when a later job asks for it).
 */
export class SourceCache {
  /** Insertion order is use order: the first entry is the least recently used. */
  private readonly entries = new Map<string, { token: number; mesh: TriangleMesh; bytes: number }>();
  bytes = 0;

  constructor(readonly capBytes: number) {}

  /** Stores the unit's model under `token`, replacing any older one, as the most recently used. */
  put(unitId: string, token: number, mesh: TriangleMesh): void {
    this.delete(unitId);
    const bytes = meshBytes(mesh);
    this.entries.set(unitId, { token, mesh, bytes });
    this.bytes += bytes;
  }

  /** The unit's model if it is the one for `token`; marks it as just used. */
  get(unitId: string, token: number): TriangleMesh | undefined {
    const entry = this.entries.get(unitId);
    if (!entry || entry.token !== token) return undefined;
    this.entries.delete(unitId);
    this.entries.set(unitId, entry);
    return entry.mesh;
  }

  /** Drops the unit's model (no-op when absent). */
  delete(unitId: string): void {
    const entry = this.entries.get(unitId);
    if (!entry) return;
    this.entries.delete(unitId);
    this.bytes -= entry.bytes;
  }

  /** Evicts least recently used models not in `keep` until under the cap; returns the evicted unit ids. */
  trim(keep: ReadonlySet<string>): string[] {
    const evicted: string[] = [];
    for (const unitId of [...this.entries.keys()]) {
      if (this.bytes <= this.capBytes) break;
      if (keep.has(unitId)) continue;
      this.delete(unitId);
      evicted.push(unitId);
    }
    return evicted;
  }
}
