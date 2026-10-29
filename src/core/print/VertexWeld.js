/**
 * One index per distinct vertex record a writer emits. A UV seam splits a
 * vertex for its UVs, not its position. Formats that index UVs per corner
 * (3MF texture2dgroup p1-p3, OBJ v/vt) write each position once, so a slicer
 * sees one closed surface instead of open seam edges (L2-03). The record is
 * the emitted text, so only positions that are equal in the file merge.
 * @returns {{ records: string[], add: (record: string) => number }}
 */
export function createVertexWeld() {
  const indexOf = new Map();
  const records = [];
  return {
    records,
    add(record) {
      let i = indexOf.get(record);
      if (i === undefined) {
        i = records.length;
        indexOf.set(record, i);
        records.push(record);
      }
      return i;
    },
  };
}

/** True when a triangle's corners welded onto fewer than three vertices (no area in the file). */
export function isCollapsed(a, b, c) {
  return a === b || b === c || c === a;
}
