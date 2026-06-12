// Render-output math — pure helpers behind Scene ▸ Rendering (PNG stills,
// turntable video, frame overlay). core/render/RenderMath.js has no Babylon
// or DOM dependency, so the geometry/easing/naming contracts pin headless.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();   // RenderMath → ExportPlanner → StateManager needs the DOM shims

const {
  clampDimension, turntableProgress, turntableAlpha,
  pickVideoFormat, fitFrameRect, renderPngName, turntableVideoName,
} = await import('../src/core/render/RenderMath.js');

test('clampDimension sanitises and bounds', () => {
  assert.equal(clampDimension(1920, 64), 1920);
  assert.equal(clampDimension('not a number', 64), 64);
  assert.equal(clampDimension(4, 64), 16);          // floor 16
  assert.equal(clampDimension(99999, 64), 8192);    // ceil 8192
  assert.equal(clampDimension(1919.6, 64), 1920);   // rounds
});

test('turntableProgress linear vs eased', () => {
  // Endpoints identical either way.
  for (const ease of [false, true]) {
    assert.equal(turntableProgress(0, ease), 0);
    assert.equal(turntableProgress(1, ease), 1);
  }
  // Midpoint identical (sinusoidal ease is symmetric).
  assert.ok(Math.abs(turntableProgress(0.5, true) - 0.5) < 1e-12);
  // Eased lags linear early (slow start) and leads late (slow stop).
  assert.ok(turntableProgress(0.2, true) < 0.2);
  assert.ok(turntableProgress(0.8, true) > 0.8);
  // Clamped outside [0,1].
  assert.equal(turntableProgress(-1, false), 0);
  assert.equal(turntableProgress(2, false), 1);
});

test('turntableAlpha sweeps a full signed 360°', () => {
  const a0 = 1.234;
  assert.equal(turntableAlpha(a0, 0, { direction: 'left', ease: false }), a0);
  assert.ok(Math.abs(turntableAlpha(a0, 1, { direction: 'left', ease: false }) - (a0 + 2 * Math.PI)) < 1e-12);
  assert.ok(Math.abs(turntableAlpha(a0, 1, { direction: 'right', ease: false }) - (a0 - 2 * Math.PI)) < 1e-12);
  // Quarter turn, linear, left.
  assert.ok(Math.abs(turntableAlpha(0, 0.25, { direction: 'left', ease: false }) - Math.PI / 2) < 1e-12);
});

test('pickVideoFormat prefers mp4, falls back to webm, survives throwers', () => {
  assert.deepEqual(pickVideoFormat(() => true),
    { mime: 'video/mp4;codecs=avc3.42E01E', ext: 'mp4' });
  assert.deepEqual(pickVideoFormat(m => m.startsWith('video/webm')),
    { mime: 'video/webm;codecs=vp8', ext: 'webm' });
  assert.deepEqual(pickVideoFormat(() => false), { mime: '', ext: 'webm' });
  assert.deepEqual(pickVideoFormat(() => { throw new Error('nope'); }),
    { mime: '', ext: 'webm' });
});

test('fitFrameRect aspect-fits and centres', () => {
  // Wide output in a square viewport → width-bound.
  const r1 = fitFrameRect(1000, 1000, 1920, 1080, 0.05);
  assert.ok(Math.abs(r1.width - 900) < 1e-9);
  assert.ok(Math.abs(r1.height - 900 / (1920 / 1080)) < 1e-9);
  assert.ok(Math.abs(r1.left - 50) < 1e-9);
  assert.ok(Math.abs(r1.top - (1000 - r1.height) / 2) < 1e-9);
  // Tall output in a wide viewport → height-bound (margin on both sides:
  // avail = 800 × (1 − 2×0.05) = 720).
  const r2 = fitFrameRect(2000, 800, 1080, 1920, 0.05);
  assert.ok(Math.abs(r2.height - 720) < 1e-9);
  assert.ok(Math.abs(r2.width - 720 * (1080 / 1920)) < 1e-9);
  // Frame centre == viewport centre.
  assert.ok(Math.abs((r2.left + r2.width / 2) - 1000) < 1e-9);
});

test('filenames share the export stem contract', () => {
  assert.equal(renderPngName('My Project', { width: 1920, height: 1080 }),
    'My Project_render_1920x1080.png');
  assert.equal(renderPngName('My Project', { width: 1920, height: 1080, transparent: true }),
    'My Project_render_1920x1080_alpha.png');
  // Illegal filename chars sanitised exactly like 3MF/OBJ exports.
  assert.equal(renderPngName('a<b>:c', { width: 100, height: 100 }),
    'a_b__c_render_100x100.png');
  assert.equal(renderPngName('', { width: 32, height: 32 }),
    'Untitled_render_32x32.png');
  assert.equal(turntableVideoName('Proj', 8, 'mp4'), 'Proj_turntable_8s.mp4');
  assert.equal(turntableVideoName('Proj', 12.5, 'webm'), 'Proj_turntable_12.5s.webm');
  assert.equal(turntableVideoName('Proj', NaN, undefined), 'Proj_turntable_8s.webm');
});
