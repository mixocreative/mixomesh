// Licence scan M1/M2/M3: the shipped notices cover every production package and the non-npm material.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildNotices, productionPackages } from '../scripts/build-notices.mjs';

const text = buildNotices();

test('notices list Babylon (Apache-2.0 + NOTICE), jszip (MIT elected) and every production package with its text', () => {
  assert.match(text, /@babylonjs\/core 9\.\d+\.\d+\nLicence: Apache-2\.0/);
  assert.match(text, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(text, /Copyright 2023 The Babylon\.js team/, "Babylon's NOTICE file is carried");
  assert.match(text, /jszip 3\.\d+\.\d+[\s\S]*Licence elected: MIT/);
  for (const p of productionPackages()) {
    assert.ok(text.includes(`${p.name} ${p.version}`), `${p.name} missing`);
    assert.ok(!p.name.startsWith('@types/'), 'type-only packages are not shipped');
  }
  assert.doesNotMatch(text, /licence identifier: (MIT|ISC)\.\)/, 'MIT/ISC packages without a licence file get the full text');
});

test('non-npm material: Lucide/Feather, font, vendored engines, HDRI maps (CC BY 4.0 with source URLs)', () => {
  assert.match(text, /Lucide Contributors/);
  assert.match(text, /Cole Bemis/);
  assert.match(text, /SIL OPEN FONT LICENSE/i);
  assert.match(text, /MeshFixLib/);
  assert.match(text, /Clipper2/);
  assert.match(text, /CC BY 4\.0/);
  for (const f of ['environments/studio.env', 'core/environments/environmentSpecular.env', 'environments/sanGiuseppeBridge.env']) {
    assert.ok(text.includes(`https://assets.babylonjs.com/${f}`), f);
  }
});

test('the notices are built with the app and shipped in the web dist and the desktop package', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.postbuild, 'node scripts/build-notices.mjs');
  const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  assert.match(builder, /- dist\/\*\*\/\*/);
  assert.match(builder, /extraResources:\s*\n\s*- from: dist\/THIRD_PARTY_NOTICES\.txt/);
  const icons = readFileSync(new URL('../src/core/Icons.js', import.meta.url), 'utf8');
  assert.match(icons, /^\/\*! Icon path data from Lucide[\s\S]*ISC License[\s\S]*Feather[\s\S]*MIT License/);
  const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.match(vite, /comments: \{ legal: true \}/, 'the minified bundle keeps /*! */ credits');
});
