// Pure statistics snapshot over state + the mesh registry (no DOM): what the HUD counts.
import { getState } from '../../core/StateManager.js';
import { canonicalObjectId } from '../../core/LogicalObjects.js';
import { displayedCounts, sceneObjectMeshes } from '../../core/scene/TriangleCount.js';
import { selectionMeshes } from '../../ui/MeshStats.js';

export interface StatsSnapshot {
  kind: 'selection' | 'scene';
  key: string;
  selected: number;
  total: number;
  tris: number;
  verts: number;
}

export function snapshot(): StatsSnapshot {
  const state = getState();
  const objects: Record<string, { isGhost?: boolean }> = state.scene?.objects ?? {};
  const sel: string[] = state.selection?.selectedIds ?? [];
  const leads = new Set(Object.keys(objects).filter((id) => !objects[id]?.isGhost).map((id) => canonicalObjectId(id, objects)));
  const total = leads.size;
  const meshes = sel.length ? selectionMeshes(sel) : sceneObjectMeshes(objects);
  const { tris, verts } = displayedCounts(meshes, { objects });
  return {
    kind: sel.length ? 'selection' : 'scene',
    key: sel.length ? [...sel].sort().join('|') : 'scene',
    selected: sel.length, total, tris, verts,
  };
}
