import type { GeneratedSupportMesh } from '../core/supports/mesh';
import { inverseTransformDirection, inverseTransformMesh, inverseTransformPoint, type ModelTransform } from '../state/transform';

/** Convert the built support mesh and its spatial provenance into unit-local coordinates. */
export function supportMeshToUnitLocal(mesh: GeneratedSupportMesh, frame: ModelTransform): GeneratedSupportMesh {
  const local = inverseTransformMesh(mesh, frame);
  return {
    ...local,
    components: mesh.components.map((component) => ({
      ...component,
      ...(component.contactIntent ? { contactIntent: component.contactIntent.map((intent) => ({
        ...intent, point: inverseTransformPoint(frame, intent.point), normal: inverseTransformDirection(frame, intent.normal),
      })) } : {}),
    })),
  };
}
