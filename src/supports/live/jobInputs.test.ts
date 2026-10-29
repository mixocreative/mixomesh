import '../testEnv';
import { describe, expect, it } from 'vitest';
import { landedStatus, regeneratedStatus } from '@mixo-geocore/editing/regenerate';
import { recheckStatus } from '@mixo-geocore/editing/check';
import { t } from '../../i18n/index.js';
import { emptySupports, placementSignature } from '../model';
import { buildJob, contactOfTriangle, needsPlacement, placementChanged } from './jobInputs';
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
