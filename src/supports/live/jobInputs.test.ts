import '../testEnv';
import { describe, expect, it } from 'vitest';
import { landedStatus, regeneratedStatus } from '@mixo-geocore/editing/regenerate';
import { recheckStatus } from '@mixo-geocore/editing/check';
import { t } from '../../i18n/index.js';
import { emptySupports, placementSignature } from '../model';
import { buildJob, contactOfTriangle, needsPlacement, placementChanged, scaledJobInputs } from './jobInputs';
import { STATUS_KEYS, statusText } from './statusText';

describe('needsPlacement', () => {
  const placed = () => ({ ...emptySupports(), sourceHash: 'h', pose: { rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as never });
  it('places when nothing was placed, the geometry changed or the supports are stale', () => {
    const record = placed();
    record.placed = placementSignature(record.settings);
    expect(needsPlacement(record, 'h', true)).toBe(false);
    expect(needsPlacement(record, 'other', true)).toBe(true);
    expect(needsPlacement(record, 'h', false)).toBe(true);
    expect(needsPlacement({ ...record, stale: 'pose' }, 'h', true)).toBe(true);
  });
  it('a placement setting re-places, the lift height and a shape setting do not', () => {
    const record = placed();
    record.placed = placementSignature(record.settings);
    expect(placementChanged({ ...record, settings: { ...record.settings, scatterSpacing: record.settings.scatterSpacing + 1 } })).toBe(true);
    expect(placementChanged({ ...record, settings: { ...record.settings, liftHeight: record.settings.liftHeight + 3 } })).toBe(false);
    expect(placementChanged({ ...record, settings: { ...record.settings, neckLength: record.settings.neckLength + 1 } })).toBe(false);
  });
});

describe('buildJob', () => {
  it('puts the plate liftHeight under the model and sends the record contacts', () => {
    const record = emptySupports();
    const model = { local: { positions: new Float32Array(9), indices: new Uint32Array(3) }, center: [1, 2, 3] as [number, number, number], minY: 7 };
    const job = buildJob(model, record, { points: [], manual: [], deleted: ['x'], zones: [], contactSettings: {} });
    expect(job.plate).toBe(7 - record.settings.liftHeight);
    expect(job.frame).toEqual({ position: [1, 2, 3], rotation: [0, 0, 0] });
    expect(job.contacts.deleted).toEqual(['x']);
    expect(job.mode).toBe('preview');
  });
});

describe('status codes', () => {
  it('every mapped code exists in the locale and the editing helpers this app uses are all mapped', () => {
    for (const key of Object.values(STATUS_KEYS)) expect(t(key)).not.toBe(key);
    const report = { added: 2, removed: 1, reset: 1, customisedKept: 1, customisedReset: 1 };
    const messages = [
      landedStatus([{ name: 'A', placed: 5 }]),
      regeneratedStatus('A', 5, report),
      landedStatus([{ name: 'A', placed: 5, report }, { name: 'B', placed: 4, report }]),
      landedStatus([{ name: 'A', placed: 5 }, { name: 'B', placed: 4 }]),
      // With the overlap rule's sentence, alone and behind a hand-work report: the walk below
      // follows `then` to the end, so a sentence appended after another is covered only here.
      landedStatus([{ name: 'A', placed: 5, buried: 9 }]),
      landedStatus([{ name: 'A', placed: 5, report, buried: 9 }]),
      recheckStatus({ unitId: 'a', position: [0, 0, 0], radius: 1 }, []),
      recheckStatus({ unitId: 'a', position: [0, 0, 0], radius: 1 }, [{ position: [0, 0, 0] }]),
    ];
    for (const message of messages) {
      let m: typeof message | undefined = message;
      while (m) { expect(STATUS_KEYS[m.key], m.key).toBeTruthy(); m = m.then; }
      expect(statusText(message, t)).not.toMatch(/\{\w+\}/);
    }
  });
  it('fills the values in', () => {
    expect(statusText(regeneratedStatus('Crown', 5, { added: 2, removed: 1, reset: 0, customisedKept: 0, customisedReset: 0 }), t)).toContain('Crown');
  });
});

describe('contactOfTriangle', () => {
  it('finds the contact whose index range holds the triangle', () => {
    const components = [{ contactId: 'a', start: 0, count: 6 }, { start: 6, count: 3 }, { contactId: 'b', start: 9, count: 6 }];
    expect(contactOfTriangle(components, 1)).toBe('a');
    expect(contactOfTriangle(components, 2)).toBeUndefined();
    expect(contactOfTriangle(components, 4)).toBe('b');
  });
});

describe('scaledJobInputs (P4.2 ratio rule)', () => {
  const model = { local: { positions: new Float32Array([-1, -2, 0, 1, 2, 0, 0, 0, 3]), indices: new Uint32Array([0, 1, 2]) }, center: [10, 20, 30] as [number, number, number], minY: 18 };
  const point = { id: 'auto-1', regionId: 0, position: [1, -2, 0] as [number, number, number], normal: [0, -1, 0] as [number, number, number], source: 'auto' as never };
  const inputs = {
    points: [point], manual: [{ ...point, id: 'm-1', position: [0, -2, 1] as [number, number, number] }], deleted: ['auto-9'],
    zones: [{ kind: 'paint' as const, center: [1, -2, 0] as [number, number, number], radius: 2, normal: [0, -1, 0] as [number, number, number] }],
    contactSettings: { 'auto-1': { pointDiameter: 0.5 } },
  };
  it('scales the model and the contact positions about the support-frame origin, keeps ids, normals and mm settings', () => {
    const out = scaledJobInputs(model, inputs, 2);
    expect([...out.model.local.positions]).toEqual([-2, -4, 0, 2, 4, 0, 0, 0, 6]);
    expect(out.model.center).toEqual([10, 20, 30]);
    expect(out.model.minY).toBe(16);
    expect(out.inputs.points[0]).toEqual({ ...point, position: [2, -4, 0] });
    expect(out.inputs.manual[0]!.position).toEqual([0, -4, 2]);
    expect(out.inputs.zones[0]).toEqual({ ...inputs.zones[0], center: [2, -4, 0], radius: 4 });
    expect(out.inputs.deleted).toEqual(['auto-9']);
    expect(out.inputs.contactSettings).toEqual({ 'auto-1': { pointDiameter: 0.5 } });
    expect([...model.local.positions]).toEqual([-1, -2, 0, 1, 2, 0, 0, 0, 3]);
  });
  it('the plate stays liftHeight under the scaled model (lift is mm, never scaled)', () => {
    const record = { ...emptySupports(), settings: { ...emptySupports().settings, liftHeight: 5 } };
    const out = scaledJobInputs(model, inputs, 3);
    expect(buildJob(out.model, record, out.inputs).plate).toBe(20 + (18 - 20) * 3 - 5);
  });
});
