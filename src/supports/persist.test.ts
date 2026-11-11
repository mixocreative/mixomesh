import { describe, expect, it } from 'vitest';
import { emptySupports, packStamps, readStamps, PACK_LIMIT } from './model';
import { isSupportsRecord, restoreSupports, serialiseSupports } from '../core/persist/SupportsPersist.js';

function rich() {
  const s = emptySupports();
  s.deleted = ['auto-1_2_3'];
  s.manual = [{ id: 'man-1', position: [1, 2, 3], normal: [0, 1, 0] } as never];
  s.overrides = { 'auto-4_5_6': { tipRadius: 0.3 } as never };
  s.sourceHash = 'abc';
  s.pose = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  s.placed = { a: 1 };
  s.revision = 7;
  return s;
}

describe('supports persistence record', () => {
  it('round-trips through a JSON document unchanged', () => {
    const object = { supports: rich() };
    const saved = serialiseSupports(object);
    expect(saved).toEqual(object.supports);
    expect(saved).not.toBe(object.supports);
    const back = restoreSupports({ supports: JSON.parse(JSON.stringify(saved)) });
    expect(back.dropped).toBeNull();
    expect(back.supports).toEqual(object.supports);
  });

  it('round-trips a large stamps list on the base64 path', () => {
    const stamps = Array.from({ length: 2500 }, (_, i) => ({
      kind: (i % 2 ? 'paint' : 'erase') as 'paint' | 'erase',
      center: [i * 0.1, -i * 0.25, i / 7] as [number, number, number],
      radius: 1.5 + (i % 5),
      normal: [0, 0, 1] as [number, number, number],
    }));
    const s = rich();
    s.stamps = packStamps(stamps);
    expect(typeof s.stamps.data).toBe('string');
    expect(stamps.length * 7).toBeGreaterThan(PACK_LIMIT);
    const back = restoreSupports({ supports: JSON.parse(JSON.stringify(serialiseSupports({ supports: s }))) })
      .supports as ReturnType<typeof emptySupports>;
    expect(back.stamps).toEqual(s.stamps);
    expect(readStamps(back.stamps)).toEqual(stamps);
  });

  it('an object without supports saves and loads none', () => {
    expect(serialiseSupports({})).toBeUndefined();
    expect(restoreSupports({ id: 'o' })).toEqual({ supports: undefined, dropped: null });
  });

  // MX-03: dropped AND reported. `dropped` carries the object's name so the
  // loader can toast whose hand work it lost (ProjectLoader) instead of ending
  // the load on a green "Loaded".
  it('a damaged record is dropped, not half-applied, and names the object', () => {
    const bad = { ...rich(), deleted: 'nope' };
    expect(isSupportsRecord(bad)).toBe(false);
    expect(restoreSupports({ name: 'Dragon', supports: bad })).toEqual({ supports: undefined, dropped: 'Dragon' });
    expect(restoreSupports({ id: 'o_7', supports: bad }).dropped).toBe('o_7');
    expect(serialiseSupports({ supports: bad })).toBeUndefined();
  });
});
