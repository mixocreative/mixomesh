// cia D-03: the default Mimaki format (OBJ) always ships as a .zip, which Cults3D does not count as a
// printable model (U3/U6 unconfirmed: a zip is sent as an extra download). The Publish tab must say so
// before the seller fills the form, and the platform check must name the zip, not ask for an OBJ.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installEnv } from './env.mjs';

installEnv();
const core = await import('../src/listbridge/index.js');
const M = await import('../src/ui/print/PublishModel.js');
const require = createRequire(import.meta.url);
const { registerListbridgeIpc } = require('../electron/listbridge/index.cjs');

async function cultsDescribe() {
  const handlers = new Map();
  registerListbridgeIpc((c, fn) => handlers.set(c, fn), {
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lb-d03-')),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    adapters: [core.cults3dAdapter], fetchImpl: async () => { throw new Error('no network in tests'); }, loadCore: async () => core,
  });
  return (await handlers.get('publish:describe')({ sender: { id: 1 } })).platforms.find(p => p.id === 'cults3d');
}

test('the Publish tab knows which chosen formats reach Cults3D as a model it counts', async () => {
  const d = await cultsDescribe();
  assert.ok(Array.isArray(d.printableExtensions) && d.printableExtensions.includes('stl'));
  assert.equal(M.shipsPrintable(['obj'], { individually: false }, d.printableExtensions), false, 'OBJ always arrives as a .zip');
  assert.equal(M.shipsPrintable(['obj', '3mf'], { individually: false }, d.printableExtensions), true);
  assert.equal(M.shipsPrintable(['stl'], { individually: false }, d.printableExtensions), true);
  assert.equal(M.shipsPrintable(['stl'], { individually: true }, d.printableExtensions), false, 'one file per object is zipped');
  assert.equal(M.shipsPrintable(['obj'], { individually: false }, undefined), true, 'a platform without the list is not second-guessed');
});

test('the Cults3D check names the zip instead of asking for an OBJ the seller already chose', () => {
  const pkg = core.createListing({
    title: 't', description: 'd', categoryHint: '1', license: 'cc', tags: [],
    images: [{ name: 'hero.png', mime: 'image/png', bytes: new Uint8Array(4), role: 'hero' }],
    files: [{ name: 'Model_1-1.zip', mime: 'application/zip', bytes: new Uint8Array(4) }],
  });
  const issue = core.cults3dAdapter.validate(pkg).find(i => i.code === 'no-printable-file');
  assert.ok(issue);
  assert.match(issue.message, /Model_1-1\.zip/);
  assert.doesNotMatch(issue.message, /\(STL, OBJ, 3MF, STEP\)/);
});
