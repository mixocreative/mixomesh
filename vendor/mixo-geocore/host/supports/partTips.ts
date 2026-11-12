import type { PlacementSettings, TriangleMesh } from '../core/analysis/types';
import type { PartRole } from '../dental/dentureParts';
import { supportEngine } from './supportEngine';
import { packPlacementSettings } from './genericPlacement';
import { packRules, type GenerateRules } from './generateRules';

/*
 * Host adapter of the Rust `part_tips` call (engine 65): the parts of a file, which of its faces are
 * buried inside another part, and tips on every non-debris part's EXPOSED faces only.
 *
 * This is what lets a GENERIC policy do what the dental one has done since engine 50 - support each
 * part on the faces that can actually be reached - so two meshes of one object get no support where
 * they overlap. Decoded here once so neither consuming app writes the decode twice.
 *
 * Typed arrays in once, out once. Every array's stride is part of the ABI and is asserted on the
 * Rust side (`crates/geometry-wasm/src/part_tips.rs`), because a host reading flat numbers cannot
 * tell a stride of 6 from 7 by looking.
 */

/** Numbers per part row: id, role, triangles, volume mm3, area mm2, tips. */
const PART_ROW = 6;

/** Index = the Rust `Role` discriminant. `unknown` is the fallback for a role this build predates. */
const ROLES: readonly PartRole[] = ['target', 'addOn', 'debris', 'fused'];

/** One part of the file, as the engine reports it. */
export interface FilePart {
  id: number;
  role: PartRole;
  triangles: number;
  volumeMm3: number;
  areaMm2: number;
  /** How many tips this part got. 0 for debris, and 0 for a part whose every face is buried. */
  tips: number;
}

/**
 * One tip on one part. Deliberately NOT a `SupportPoint`: that type carries a `regionId`, and a tip
 * placed on a part's sub-mesh has a region in THAT mesh, not in the file. Inventing a file region id
 * here would be a number that looks meaningful and is not. The host assigns one when it has one.
 */
export interface PartTip {
  id: string;
  position: [number, number, number];
  normal: [number, number, number];
  /** Which part the tip belongs to. */
  part: number;
  /** The file face it stands on. */
  face: number;
}

/** Tips per part, and what the operator has to be shown to understand them. */
export interface PartTips {
  /** Every tip, in part order. `position` and `normal` are in the frame `mesh` was already in. */
  tips: PartTip[];
  parts: FilePart[];
  /** Part id of each file face. */
  faceParts: Uint32Array;
  /**
   * True where a file face is buried inside another part. This is what the viewport tints, and the
   * only way to tell an operator WHY a face got no tip — which is the half a technician cares about.
   *
   * Empty for a single-part file. And note `inside_other` is a parity test that needs a CLOSED
   * part, so an OPEN scan gets no mask: the UI must say so rather than imply the overlap was
   * handled.
   */
  hidden: Uint8Array;
}

interface PartTipsEngine {
  part_tips(positions: Float32Array, indices: Uint32Array, settings: Float64Array, rules: Float64Array, debrisMm: number, target: number): {
    take_ids(): string[]; take_positions(): Float64Array; take_normals(): Float64Array;
    take_tip_parts(): Uint32Array; take_tip_faces(): Uint32Array;
    take_part_list(): Float64Array; take_face_parts(): Uint32Array; take_hidden(): Uint8Array; free(): void;
  };
}

/**
 * Tips on every non-debris part's exposed faces.
 *
 * `target` is the host's own declared target part, and it outranks the engine's pick in the roles
 * that come back. Leave it undefined to take the engine's, which is the largest part by volume —
 * not necessarily the operator's "main body", which is exactly why this argument exists.
 *
 * `debrisMm` is the part rule: a part whose bounding-box diagonal is under it is debris and gets no
 * tips. That is a DENTAL judgement about scan noise, so a generic caller that wants every part
 * supported passes 0.
 *
 * The caller does not have to weld (engine 68, see `contactsBuried`); face ids in the result are the
 * caller's own either way, because the weld keeps face order and count.
 */
export function partTips(
  mesh: TriangleMesh,
  settings: PlacementSettings,
  options: { rules?: GenerateRules; debrisMm?: number; target?: number } = {},
): PartTips {
  // `part_tips` is a free export, not a method on `GeometrySession`: it owns no mesh across calls,
  // so there is no session to open or free. Only the result object needs freeing.
  const engine = supportEngine() as unknown as PartTipsEngine;
  {
    const result = engine.part_tips(
      mesh.positions,
      mesh.indices,
      packPlacementSettings(settings),
      packRules(options.rules),
      options.debrisMm ?? 0,
      options.target ?? -1,
    );
    try {
      const ids = result.take_ids();
      const points = result.take_positions();
      const normals = result.take_normals();
      const tipParts = result.take_tip_parts();
      const tipFaces = result.take_tip_faces();
      const rows = result.take_part_list();
      const faceParts = result.take_face_parts();
      const hidden = result.take_hidden();

      const tips = ids.map((id, k) => ({
        id,
        position: [points[k * 3]!, points[k * 3 + 1]!, points[k * 3 + 2]!] as [number, number, number],
        normal: [normals[k * 3]!, normals[k * 3 + 1]!, normals[k * 3 + 2]!] as [number, number, number],
        part: tipParts[k]!,
        face: tipFaces[k]!,
      }));

      const parts: FilePart[] = [];
      for (let at = 0; at + PART_ROW <= rows.length; at += PART_ROW) {
        parts.push({
          id: rows[at]!,
          // A role this build does not know becomes `unknown` rather than throwing: the engine may
          // add one, and a code table must never be narrower than its Rust enum (GEO-005/006).
          role: ROLES[rows[at + 1]!] ?? 'unknown',
          triangles: rows[at + 2]!,
          volumeMm3: rows[at + 3]!,
          areaMm2: rows[at + 4]!,
          tips: rows[at + 5]!,
        });
      }
      return { tips, parts, faceParts, hidden };
    } finally {
      result.free();
    }
  }
}

interface BuriedEngine {
  contacts_buried(positions: Float32Array, indices: Uint32Array, points: Float64Array, radius: number, debrisMm: number): Uint8Array;
}

/**
 * Which of `contacts` are buried inside (or against) another part of the same object.
 *
 * This is what lets a generic policy stop supporting a face it cannot reach WITHOUT renaming a
 * single contact: place as always, then drop what this marks. The alternative - taking the tips from
 * `partTips` - renames every contact to `part<N>-…`, and contact ids are the keys of every saved
 * record's `deleted`, `overrides` and manual list.
 *
 * `radius` is the contact's own radius in mm, so a tip whose BODY touches another part counts, not
 * only one whose centre does. `debrisMm` is the part rule; 0 means nothing is debris, which is what
 * a generic caller wants. A single-part file returns all false.
 *
 * `mesh` and the contact positions must be in the same frame.
 *
 * The caller does NOT have to weld: the binding welds duplicate corners itself (engine 68), because
 * the parts split reads the mesh as imported and a render mesh - vertices split along every UV seam -
 * would otherwise arrive as one part per face and mark its whole underside.
 */
export function contactsBuried(
  mesh: TriangleMesh,
  contacts: readonly { position: readonly [number, number, number] }[],
  options: { radius?: number; debrisMm?: number } = {},
): boolean[] {
  if (contacts.length === 0) return [];
  const points = new Float64Array(contacts.length * 3);
  contacts.forEach((c, k) => points.set(c.position, k * 3));
  const engine = supportEngine() as unknown as BuriedEngine;
  const out = engine.contacts_buried(mesh.positions, mesh.indices, points, options.radius ?? 0, options.debrisMm ?? 0);
  return Array.from(out, (v) => v === 1);
}
