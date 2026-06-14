import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpolate } from '../src/i18n/interpolate.js';

test('interpolate replaces {var} with params value', () => {
  assert.equal(interpolate('Hello {name}', { name: 'Adrian' }), 'Hello Adrian');
});

test('interpolate leaves unknown placeholders intact', () => {
  assert.equal(interpolate('Hello {who}', { name: 'Adrian' }), 'Hello {who}');
});

test('interpolate coerces non-string values to String', () => {
  assert.equal(interpolate('Count: {n}', { n: 3 }), 'Count: 3');
});

test('interpolate is a no-op when params is undefined', () => {
  assert.equal(interpolate('plain', undefined), 'plain');
});

test('interpolate is XSS-safe: HTML inside the value is literal text', () => {
  // The interpolation itself returns a plain string; consumers MUST set
  // textContent (never innerHTML). This test pins that the substitution
  // does NOT decode/encode anything.
  assert.equal(interpolate('Hi {x}', { x: '<script>a</script>' }), 'Hi <script>a</script>');
});
