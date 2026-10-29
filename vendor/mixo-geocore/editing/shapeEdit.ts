import { SHAPE_KEYS, withShape, type LiveSupportSettings, type ShapeKey, type ShapeOverride, type ShapeSettings } from '../host/core/supports/settings';

/**
 * The support shape region's rules: what its fields show for the supports in scope, and what an
 * edit writes. Pure, so the Babylon host reads the same rules.
 */

/** Per key, the value every support in scope has, or undefined where their values differ ("mixed"). */
export type ShapeView = { [K in ShapeKey]: ShapeSettings[K] | undefined };

/** One support's per-support settings, by contact id (a unit's `contactSettings`). */
export type ShapeOverrides = Readonly<Record<string, ShapeOverride>>;

/**
 * What the region shows. With no `ids` it shows the object's defaults. With ids, each key reads the
 * support's own value over the default, and a key whose values differ across the supports is undefined.
 */
export function shapeView(defaults: Readonly<LiveSupportSettings>, overrides: ShapeOverrides, ids: readonly string[]): ShapeView {
  const effective = (id: string) => withShape(defaults, overrides[id]);
  const view: Record<string, unknown> = {};
  for (const key of SHAPE_KEYS) {
    const first = ids.length === 0 ? defaults[key] : effective(ids[0]!)[key];
    view[key] = ids.every((id) => effective(id)[key] === first) ? first : undefined;
  }
  return view as ShapeView;
}

/**
 * The patch one committed field value writes, or undefined when it writes nothing: the key already
 * shows exactly that value for every support in scope (a field never written to stays untouched).
 */
export function shapePatch<K extends ShapeKey>(view: ShapeView, key: K, value: ShapeSettings[K]): ShapeOverride | undefined {
  return view[key] === value ? undefined : { [key]: value };
}

/** The selected supports that still exist: the ids the region shows and every edit writes to. */
export function liveSelection(selection: ReadonlySet<string>, live: readonly string[]): string[] {
  return live.filter((id) => selection.has(id));
}

/** The ids among `ids` that have settings of their own. */
export function customisedAmong(overrides: ShapeOverrides, ids: readonly string[]): string[] {
  return ids.filter((id) => (overrides[id] ? Object.keys(overrides[id]!).length > 0 : false));
}

/** How many supports the defaults reach in `scope`, and how many of those have settings of their own. */
export function scopeCounts(scope: readonly { ids: readonly string[]; overrides: ShapeOverrides }[]): { supports: number; customised: number } {
  let supports = 0;
  let customised = 0;
  for (const unit of scope) {
    supports += unit.ids.length;
    customised += customisedAmong(unit.overrides, unit.ids).length;
  }
  return { supports, customised };
}

/** Region header: the defaults, or the supports selected in Support Edit Mode. */
export function shapeHeading(selected: number): { key: string; vars?: { n: number } } {
  return selected > 0 ? { key: 'Support shape · {n} selected', vars: { n: selected } } : { key: 'Support shape · defaults' };
}
