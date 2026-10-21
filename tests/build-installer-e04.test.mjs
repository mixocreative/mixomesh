import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../scripts/build-installer.mjs', import.meta.url), 'utf8');
const at = needle => {
  const i = src.indexOf(needle);
  assert.notEqual(i, -1, `build-installer.mjs lacks ${needle}`);
  return i;
};

test('installer build runs the electron smoke after build and the packaged smoke before release/ is wiped', () => {
  const build = at("run('npm', ['run', 'build'])");
  const electronSmoke = at("run('npm', ['run', 'test:electron'])");
  const builder = at("run('npx', ['electron-builder', '--win'])");
  const packaged = at("run('npm', ['run', 'smoke:packaged'])");
  const collect = at("begin('collect installer')");
  const finalWipe = src.lastIndexOf('wipe()');
  assert.ok(build < electronSmoke && electronSmoke < builder, 'test:electron needs dist/ and must gate packaging');
  assert.ok(builder < packaged && packaged < collect, 'smoke:packaged needs release/win-unpacked and must gate collection');
  assert.ok(packaged < finalWipe, 'the final wipe of release/ must come after the packaged smoke');
});
