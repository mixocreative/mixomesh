import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
installEnv();
const { collectObjSiblings, noteMissingMtl } = await import('../src/core/assets/ObjSiblings.js');

test('OBJ imports retain more than 64 texture/material resource files', async () => {
  const files = Array.from({ length: 100 }, (_, i) => Object.assign(new Blob(['image']), { name: `t${i}.png` }));
  const map = await collectObjSiblings({ siblingFiles: files });
  assert.equal(map.size, 100);
  for (const url of map.values()) URL.revokeObjectURL(url);
});

test('missing/unreadable OBJ resources report actionable failures', async () => {
  const obj = new Blob(['mtllib tile.mtl\nv 0 0 0\n']);
  await assert.rejects(noteMissingMtl(obj, 'tile.obj', new Map()), /required MTL file tile.mtl.*not provided/);
  await assert.doesNotReject(noteMissingMtl(obj, 'tile.obj', new Map([['renamed.mtl', 'blob:test']])));
  await assert.rejects(collectObjSiblings({ siblingFiles: [{ name: 'bad.png', getFile: async () => { throw new Error('permission denied'); } }] }), /bad.png.*permission denied/);
});
