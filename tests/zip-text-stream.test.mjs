import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { zipEntryTextChunks } from '../src/core/import/zipText.js';
import { createThreeMFXmlParser } from '../src/core/import/ThreeMFXml.js';
import { threeMFModelChunks } from '../scripts/heavy-mesh/generate.mjs';

const JSZip = createRequire(import.meta.url)('jszip');

test('zip entry streams as many decoded chunks; multi-byte characters survive chunk edges', async () => {
  const text = 'é漢字🙂'.repeat(200_000);
  const zip = await JSZip.loadAsync(await new JSZip().file('a.txt', Buffer.from(text, 'utf8')).generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const chunks = [];
  const fractions = [];
  for await (const c of zipEntryTextChunks(zip.file('a.txt'), { onProgress: f => fractions.push(f) })) chunks.push(c);
  assert.ok(chunks.length > 4, `${chunks.length} chunks`);
  assert.equal(chunks.join(''), text);
  assert.equal(fractions.at(-1), 1);
});

test('a streamed 3MF model part parses without ever being one string', async () => {
  const n = 120;
  const zip = await JSZip.loadAsync(await new JSZip().file('3D/3dmodel.model', [...threeMFModelChunks(n)].join('')).generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const parser = createThreeMFXmlParser();
  let largest = 0;
  for await (const c of zipEntryTextChunks(zip.file('3D/3dmodel.model'))) { largest = Math.max(largest, c.length); parser.write(c); }
  const parsed = parser.close();
  assert.ok(largest < 1024 * 1024, `largest chunk ${largest}`);
  assert.equal(parsed.geometry.get('1').triangles.length, 4 * n * n * 7);
  assert.ok(parsed.geometry.get('1').triangles instanceof Int32Array);
});

test('stand-ins without internalStream fall back to async(text)', async () => {
  const out = [];
  for await (const c of zipEntryTextChunks({ async: async () => 'whole' })) out.push(c);
  assert.deepEqual(out, ['whole']);
});
