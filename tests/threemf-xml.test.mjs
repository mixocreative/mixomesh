import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThreeMFXml } from '../src/core/import/ThreeMFXml.js';
import { IMPORT_LIMITS, assertZipSafe } from '../src/core/import/ImportLimits.js';

const model = body => `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1"><mesh>${body}</mesh></object></resources><build><item objectid="1"/></build></model>`;
const vertex = '<vertex x="0" y="1.25" z="-2e-3"/>';
const triangles = '<triangles><triangle v1="0" v2="0" v3="0" p1="2"/></triangles>';

test('geometry stays in typed arrays, not millions of XML DOM elements', async () => {
  const parsed = await parseThreeMFXml(model(`<vertices>${vertex.repeat(10000)}</vertices>${triangles}`));
  assert.ok(parsed.geometry.get('1').positions instanceof Float64Array);
  assert.equal(parsed.geometry.get('1').positions.length, 30000);
  assert.deepEqual([...parsed.geometry.get('1').positions.subarray(0, 3)], [0, 1.25, -0.002]);
  assert.deepEqual([...parsed.geometry.get('1').triangles], [0, 0, 0, -1, 2, -1, -1]);
  assert.ok(parsed.xml.length < 400);
  assert.doesNotMatch(parsed.xml, /<vertex|<triangle/);
});

test('XML comments, entities, single quotes and prefixed core elements parse correctly', async () => {
  const xml = `<c:model xmlns:c='http://schemas.microsoft.com/3dmanufacturing/core/2015/02'><c:metadata name='Title'>A &amp; B</c:metadata><c:resources><c:object id='7' name='a &quot; b'><!-- <mesh><vertex x="99"/></mesh> --><c:mesh><c:vertices><c:vertex x='1' y='2' z='3'/></c:vertices><c:triangles><c:triangle v1='0' v2='0' v3='0'/></c:triangles></c:mesh></c:object></c:resources></c:model>`;
  const parsed = await parseThreeMFXml(xml);
  assert.deepEqual([...parsed.geometry.get('7').positions], [1, 2, 3]);
  assert.match(parsed.xml, /A &amp; B/);
  assert.match(parsed.xml, /name="a &quot; b"/);
  assert.doesNotMatch(parsed.xml, /x="99"/);
});

test('large XML yields between chunks so the web and Electron UI can update', async () => {
  let yields = 0;
  await parseThreeMFXml(model(`<vertices>${vertex.repeat(10000)}</vertices>${triangles}`), {
    yieldControl: async () => { yields++; },
  });
  assert.ok(yields > 0);
});

test('malformed XML, DTD, missing coordinates and invalid indices fail closed', async () => {
  for (const xml of ['<model><resources></model>', '<!DOCTYPE model><model/>',
    model('<vertices><vertex y="0" z="0"/></vertices>'),
    model('<vertices><vertex x="NaN" y="0" z="0"/></vertices>'),
    model('<triangles><triangle v1="-1" v2="0" v3="0"/></triangles>')]) {
    await assert.rejects(parseThreeMFXml(xml));
  }
});

test('many texture entries pass by default; size/path checks and explicit entry budgets remain', () => {
  const files = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`3D/Textures/${i}.png`, { _data: { uncompressedSize: 1 } }]));
  assert.doesNotThrow(() => assertZipSafe({ files }));
  assert.throws(() => assertZipSafe({ files }, '3MF', { ...IMPORT_LIMITS, maxZipEntries: 256 }), /too many entries/);
  assert.throws(() => assertZipSafe({ files }, '3MF', { ...IMPORT_LIMITS, maxZipUncompressedBytes: 10 }), /uncompressed/);
  assert.throws(() => assertZipSafe({ files: { '../bad': {} } }), /unsafe/);
});
