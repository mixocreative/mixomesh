import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { classifyImportFailure } from '../src/core/import/ImportFailure.js';
import { assertTriangleCapacity } from '../src/core/import/ImportLimits.js';
import { parseThreeMFXml } from '../src/core/import/ThreeMFXml.js';

test('capacity and corrupt-file failures select a relevant reason and recovery action', () => {
  const cases = [
    ['file is too large to import', 'size'], ['archive expands to more than 2048 MB uncompressed', 'size'],
    ['invalid typed array length', 'memory'], ['polygon handling limit for this runtime', 'polygons'],
    ['QuotaExceededError', 'storage'], ['3MF: component cycle', 'package'],
    ['3MF: triangle references a vertex outside 0..3', 'geometry'],
    ['3MF: unsafe file path', 'unsafePath'], ['unsupported file type: .fbx', 'format'],
    ['3MF: unsupported unit furlong', 'unit'], ['3MF: no importable mesh objects', 'empty'],
    ['Unclosed root tag', 'damaged'], ['permission denied', 'permission'],
    ['"a.stl" has 30,000,000 triangles; this web build handles up to 6,000,000.', 'polygons'],
    ['Loading model timed out after 300000 ms', 'timeout'],
  ];
  for (const [message, expected] of cases) assert.equal(classifyImportFailure(message).category, expected, message);
  assert.equal(classifyImportFailure('texture missing', 'tile.3mf').category, 'embeddedTexture');
  assert.equal(classifyImportFailure('texture missing', 'tile.obj').category, 'sidecars');
  assert.equal(classifyImportFailure('other failure').category, 'unknown');
});

test('every recovery message is translated in English, Traditional Chinese and Japanese', async () => {
  for (const locale of ['en', 'zh-Hant', 'ja']) {
    const data = JSON.parse(await fs.readFile(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url)));
    for (const category of ['unknown', 'storage', 'memory', 'size', 'polygons', 'unsafePath', 'format', 'unit', 'package', 'geometry', 'embeddedTexture', 'sidecars', 'empty', 'permission', 'damaged', 'timeout']) {
      assert.ok(data[`import.reason.${category}`], `${locale}: ${category} reason`);
      assert.ok(data[`import.fix.${category}`], `${locale}: ${category} fix`);
    }
  }
});

test('triangle capacity checks report count and limit before mesh creation', async () => {
  assert.doesNotThrow(() => assertTriangleCapacity(400, 100));
  assert.throws(() => assertTriangleCapacity(401, 100), /401 triangles.*400/);
  const xml = '<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/></vertices><triangles>' + '<triangle v1="0" v2="0" v3="0"/>'.repeat(5) + '</triangles></mesh></object></resources></model>';
  await assert.rejects(parseThreeMFXml(xml, { triangleBudget: 1 }), /5 triangles.*4/);
});
