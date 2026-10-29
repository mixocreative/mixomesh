/** The contact a remove click at `point` takes: the nearest one within `reach` (Click reach), if any. */
export function contactToRemove<T extends { id: string; position: readonly number[] }>(contacts: readonly T[], point: readonly number[], reach: number): T | undefined {
  let nearest: T | undefined;
  let best = reach * reach;
  for (const contact of contacts) {
    const d = (contact.position[0]! - point[0]!) ** 2 + (contact.position[1]! - point[1]!) ** 2 + (contact.position[2]! - point[2]!) ** 2;
    if (d <= best) { nearest = contact; best = d; }
  }
  return nearest;
}
