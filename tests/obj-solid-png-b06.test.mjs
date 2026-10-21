import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
installEnv();
const { serializeOBJ } = await import('../src/core/print/ObjWriter.js');

test('OBJ export aborts, naming the part, when its solid-colour PNG cannot be made', async () => {
  const realCreate = document.createElement.bind(document);
  document.createElement = (tag) => (tag !== 'canvas' ? realCreate(tag) : {
    width: 0, height: 0,
    getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
    toBlob: (cb) => cb(null),
  });
  try {
    const mesh = {
      name: 'Hull', material: { id: 'Paint', diffuseColor: { r: 1, g: 0, b: 0 } },
      getVerticesData: (k) => (k === 'position' ? new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) : null),
      getIndices: () => [0, 1, 2],
    };
    const ctx = {
      meshes: [{ mesh, logicalName: 'Hull' }], cloneGroups: [], individually: false,
      projectName: 'P', referenceRatio: 1, targetRatio: 1,
      prefs: { objBakeSolidTextures: true }, state: { print: {} },
    };
    await assert.rejects(serializeOBJ(ctx), /Hull/);
  } finally {
    document.createElement = realCreate;
  }
});
