import { meshBounds } from '../host/core/supports/meshQuery';
import type { PrintUnit, SceneCommand } from '../host/state/projectTypes';
import { applyTransform } from '../host/state/transform';
import { resolveSettings } from '../host/supports/unitSupports';

/** Free space kept between two objects' footprints, mm. */
export const ARRANGE_GAP = 6;
/** Objects wrap to a new row beyond this width, mm. */
export const ARRANGE_ROW_WIDTH = 240;

/** An object's footprint on the plate (x, z), supports and raft included. */
export interface Footprint { id: string; minX: number; maxX: number; minZ: number; maxZ: number }

/** The footprint of a unit as it stands: its model's box on the plate, widened by the raft and feet that spread beyond it. */
export function footprintOf(unit: PrintUnit): Footprint {
  const box = meshBounds(applyTransform(unit.source, unit.transform));
  const settings = resolveSettings(unit.settings);
  const pad = unit.supports ? (settings.raftEnabled ? settings.raftExpandWidth : 0) + settings.baseDiameter / 2 + 1 : 0;
  return { id: unit.id, minX: box.min[0] - pad, maxX: box.max[0] + pad, minZ: box.min[2] - pad, maxZ: box.max[2] + pad };
}

/**
 * Lays footprints in rows, left to right in the given order, a new row when the next would pass
 * `rowWidth`. Returns how far each moves in x and z. Rows start at `startX` (default: centred on
 * the plate origin); the first row's top edge sits at z = 0 minus half the layout's depth.
 */
export function arrangeFootprints(items: readonly Footprint[], options: { gap?: number; rowWidth?: number; startX?: number } = {}): Map<string, { dx: number; dz: number }> {
  const gap = options.gap ?? ARRANGE_GAP;
  const rowWidth = options.rowWidth ?? ARRANGE_ROW_WIDTH;
  const rows: Footprint[][] = [[]];
  let used = 0;
  for (const item of items) {
    const width = item.maxX - item.minX;
    const row = rows[rows.length - 1]!;
    if (row.length > 0 && used + gap + width > rowWidth) { rows.push([item]); used = width; } else { row.push(item); used += (row.length > 1 ? gap : 0) + width; }
  }
  const widths = rows.map((row) => row.reduce((sum, item, index) => sum + (item.maxX - item.minX) + (index > 0 ? gap : 0), 0));
  const depths = rows.map((row) => Math.max(...row.map((item) => item.maxZ - item.minZ), 0));
  const startX = options.startX ?? -Math.max(...widths) / 2;
  let z = -(depths.reduce((sum, depth) => sum + depth, 0) + gap * (rows.length - 1)) / 2;
  const moves = new Map<string, { dx: number; dz: number }>();
  rows.forEach((row, index) => {
    let x = startX;
    for (const item of row) {
      moves.set(item.id, { dx: x - item.minX, dz: z - item.minZ });
      x += item.maxX - item.minX + gap;
    }
    z += depths[index]! + gap;
  });
  return moves;
}

/**
 * The listed objects on the plate without overlap: one move per object (supports and raft ride
 * along with it). Other objects on the plate keep their place; the listed ones start to their right.
 */
export function arrangeCommands(units: readonly PrintUnit[], ids: readonly string[]): SceneCommand[] {
  const listed = ids.map((id) => units.find((unit) => unit.id === id)).filter((unit): unit is PrintUnit => unit !== undefined);
  if (listed.length === 0) return [];
  const others = units.filter((unit) => !ids.includes(unit.id)).map(footprintOf);
  const moves = arrangeFootprints(listed.map(footprintOf), others.length > 0 ? { startX: Math.max(...others.map((item) => item.maxX)) + ARRANGE_GAP } : {});
  const commands: SceneCommand[] = [];
  for (const unit of listed) {
    const move = moves.get(unit.id)!;
    if (Math.abs(move.dx) < 1e-6 && Math.abs(move.dz) < 1e-6) continue;
    const [x, y, z] = unit.transform.position;
    commands.push({ type: 'transform/set', unitId: unit.id, transform: { position: [x + move.dx, y, z + move.dz], rotation: [...unit.transform.rotation] } });
  }
  return commands;
}
