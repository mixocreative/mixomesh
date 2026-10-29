import type { SupportComponent } from '../host/core/supports/mesh';

/**
 * Drag over's cheap selection highlight (framework-free; the viewport wires it): the selected
 * supports are recoloured in place (their vertex ranges) instead of rebuilding a mesh.
 */

/** What changed between the selection drawn and the one to draw. */
export function selectionDelta(applied: ReadonlySet<string>, next: ReadonlySet<string>): { on: string[]; off: string[] } {
  const on: string[] = [];
  const off: string[] = [];
  for (const id of next) if (!applied.has(id)) on.push(id);
  for (const id of applied) if (!next.has(id)) off.push(id);
  return { on, off };
}

/**
 * Vertex ranges [start, end) of each contact's support parts (a part's vertices are contiguous:
 * the builder appends them per part), touching ranges merged. Parts of no contact are skipped.
 */
export function contactVertexRuns(mesh: { indices: Uint32Array; components: readonly SupportComponent[] }): Map<string, [number, number][]> {
  const runs = new Map<string, [number, number][]>();
  for (const component of mesh.components) {
    if (!component.contactId || component.count === 0) continue;
    let low = Infinity;
    let high = -Infinity;
    for (let i = component.start; i < component.start + component.count; i++) {
      const vertex = mesh.indices[i]!;
      if (vertex < low) low = vertex;
      if (vertex > high) high = vertex;
    }
    let list = runs.get(component.contactId);
    if (!list) runs.set(component.contactId, (list = []));
    const last = list[list.length - 1];
    if (last && low <= last[1] && high + 1 >= last[0]) {
      last[0] = Math.min(last[0], low);
      last[1] = Math.max(last[1], high + 1);
    } else {
      list.push([low, high + 1]);
    }
  }
  return runs;
}
