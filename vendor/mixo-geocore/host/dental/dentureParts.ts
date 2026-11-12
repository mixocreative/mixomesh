/*
 * The parts of a denture file (Rust `dental::denture::parts`, engine 50). The engine splits a file into its parts before
 * anything else (faces joined by their edges; shells that only touch stay apart; nothing welded or merged): the largest part is
 * the target and gets the dental tips, a smaller part (hook, attachment) is an add-on and gets generic tips on its own faces,
 * a part smaller across than the rule `partDebrisMm` is debris and gets none. Every part is an obstacle to every support.
 * The policy handle (`part_list()`, `face_parts()`) and the review (`part_list()`, `face_parts()`) carry them; this decodes them.
 * Engine 56 (aligners too, Rust `dental::aligner_parts`, and dentures): a part that overlaps or touches the target is `fused`
 * (the slicer prints the two as one solid; still its own shell and an obstacle): its faces inside or against another part get no
 * tips, its exposed faces get generic tips where they overhang. The aligner policy handle carries the list (`placement.ts`).
 */

/** Numbers per part in the flat list (Rust `FileParts::list`). */
export const PART_STRIDE = 6;

export type PartRole = 'target' | 'addOn' | 'debris' | 'fused' | 'unknown';

const ROLES: readonly PartRole[] = ['target', 'addOn', 'debris', 'fused'];

/** The parts of a file as a policy or review reports them: the part list and the part id of every face. */
export interface FileParts {
  parts: DenturePart[];
  faceParts: Uint32Array;
}

/** One part of a file. */
export interface DenturePart {
  /** Part id: the value of `faceParts` on its faces (parts are numbered by their lowest face). */
  id: number;
  role: PartRole;
  triangles: number;
  /** Enclosed volume (mm3); approximate for an open part. */
  volumeMm3: number;
  areaMm2: number;
  /** Tips placed on it (policy: candidates; review: the review's tips, target only). */
  tips: number;
}

/** The part list from its flat numbers. */
export function decodeParts(flat: ArrayLike<number>): DenturePart[] {
  return Array.from({ length: Math.floor(flat.length / PART_STRIDE) }, (_, k) => {
    const at = k * PART_STRIDE;
    return { id: flat[at]!, role: ROLES[flat[at + 1]!] ?? 'unknown', triangles: flat[at + 2]!, volumeMm3: flat[at + 3]!, areaMm2: flat[at + 4]!, tips: flat[at + 5]! };
  });
}

/** The parts a handle or review result reports, with the part id of every face (`faceParts`, the layer "Parts"); empty before engine 50. */
export function partsOf(source: { part_list?(): Float64Array; face_parts?(): Uint32Array }): FileParts {
  return { parts: decodeParts(source.part_list?.() ?? new Float64Array()), faceParts: source.face_parts?.() ?? new Uint32Array() };
}
