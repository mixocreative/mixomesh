import type { PlacementResult, PlacementSettings, SupportPoint, TriangleMesh } from '../core/analysis/types';
import { withSession } from './supportEngine';

/*
 * Host adapter of the Rust generic placement (`crates/geometry-core/src/generic/placement`): the
 * automatic contacts of a model (already turned into the frame they are wanted in), with their
 * deterministic IDs, plus the downward regions. Typed arrays in once, out once.
 */

const SOURCES: readonly SupportPoint['source'][] = ['interior', 'physical-boundary', 'sharp-ridge', 'island'];

interface PlacementSession {
  load_mesh(positions: Float32Array, indices: Uint32Array): number;
  generic_place(model: number, settings: Float64Array): {
    take_positions(): Float64Array; take_normals(): Float64Array; take_sources(): Uint8Array; take_ids(): string[];
    take_region_faces(): Uint32Array; take_region_starts(): Uint32Array; free(): void;
  };
}

/** Order of the placement settings array (Rust `generic_place`). */
export function packPlacementSettings(s: PlacementSettings): Float64Array {
  return Float64Array.of(s.overhangAngleDegrees, s.spacing, s.edgeInset, s.sharpEdgeAngleDegrees, s.includeIslands ? 1 : 0, s.includeDownward === false ? 0 : 1, s.reinforceEdges === false ? 0 : 1);
}

export function placeGeneric(mesh: TriangleMesh, settings: PlacementSettings): PlacementResult {
  return withSession((raw) => {
    const session = raw as unknown as PlacementSession;
    const result = session.generic_place(session.load_mesh(Float32Array.from(mesh.positions), Uint32Array.from(mesh.indices)), packPlacementSettings(settings));
    try {
      const ids = result.take_ids();
      const positions = result.take_positions();
      const normals = result.take_normals();
      const sources = result.take_sources();
      const points = ids.map((id, k): SupportPoint => ({
        id,
        regionId: -1,
        position: [positions[k * 3]!, positions[k * 3 + 1]!, positions[k * 3 + 2]!],
        normal: [normals[k * 3]!, normals[k * 3 + 1]!, normals[k * 3 + 2]!],
        source: SOURCES[sources[k]!]!,
      }));
      const faces = result.take_region_faces();
      const starts = result.take_region_starts();
      const regions = Array.from({ length: Math.max(0, starts.length - 1) }, (_, id) => ({ id, faceIndices: Array.from(faces.subarray(starts[id]!, starts[id + 1]!)) }));
      return {
        points,
        regions,
        contactPositions: new Float32Array(points.flatMap((point) => point.position)),
        contactNormals: new Float32Array(points.flatMap((point) => point.normal)),
      };
    } finally {
      result.free();
    }
  });
}
