import assert from 'node:assert/strict';

const {
  extractModelRatio,
  extractMixoProvenance,
  isLibraryImport,
  findLibraryItemRoots,
} = await import('../src/core/import/ImportMetadata.js');

function extras(value) {
  return { metadata: { gltf: { extras: value } } };
}

function geomMesh(name, parent = null, extra = {}) {
  return {
    name,
    parent,
    geometry: {},
    metadata: {},
    getTotalVertices: () => 3,
    ...extra,
  };
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('extractModelRatio reads Blender glTF extras with existing ratio keys', () => {
  const container = {
    meshes: [geomMesh('part', null, extras({ Ratio: '1:72' }))],
    transformNodes: [],
  };
  assert.equal(extractModelRatio(container), 72);
});

await test('extractMixoProvenance reads the nearest Blender Mixo marker and normalizes its levels', () => {
  const root = extras({
    mixo_origin: 'mixo3d',
    mixo_marker_version: 1,
    mixo_viewport_subdiv_level: 1,
    mixo_render_subdiv_level: 2,
  });
  const mesh = geomMesh('part', root);

  assert.deepEqual(extractMixoProvenance(mesh), {
    origin: 'mixo3d',
    markerVersion: 1,
    viewportSubdivLevel: 1,
    renderSubdivLevel: 2,
  });
});

await test('extractMixoProvenance does not treat an unmarked GLB as Mixo-authored', () => {
  assert.equal(extractMixoProvenance(geomMesh('part')), null);
});

await test('extractMixoProvenance rejects an unsupported or malformed nearest marker', () => {
  const unsupported = geomMesh('part', null, extras({
    mixo_origin: 'mixo3d', mixo_marker_version: 2,
    mixo_viewport_subdiv_level: 1, mixo_render_subdiv_level: 2,
  }));
  const malformed = geomMesh('part', null, extras({
    mixo_origin: 'mixo3d', mixo_marker_version: 1,
    mixo_viewport_subdiv_level: 1.5, mixo_render_subdiv_level: 2,
  }));
  assert.equal(extractMixoProvenance(unsupported), null);
  assert.equal(extractMixoProvenance(malformed), null);
});

await test('extractMixoProvenance rejects a malformed child marker instead of trusting a marked ancestor', () => {
  const parent = extras({
    mixo_origin: 'mixo3d', mixo_marker_version: 1,
    mixo_viewport_subdiv_level: 1, mixo_render_subdiv_level: 2,
  });
  const child = geomMesh('part', parent, extras({
    mixo_origin: 'mixo3d', mixo_marker_version: 2,
    mixo_viewport_subdiv_level: 1, mixo_render_subdiv_level: 2,
  }));
  assert.equal(extractMixoProvenance(child), null);
});

await test('extractMixoProvenance requires all four marker fields to be own properties', () => {
  const inherited = {
    mixo_marker_version: 1,
    mixo_viewport_subdiv_level: 1,
    mixo_render_subdiv_level: 2,
  };
  const extrasWithInheritedLevels = Object.assign(Object.create(inherited), {
    mixo_origin: 'mixo3d',
  });
  const markedParent = extras({
    mixo_origin: 'mixo3d', mixo_marker_version: 1,
    mixo_viewport_subdiv_level: 1, mixo_render_subdiv_level: 2,
  });
  const partial = geomMesh('part', markedParent, extras(extrasWithInheritedLevels));
  const onlyInherited = geomMesh('part', null, extras(Object.create({
    mixo_origin: 'mixo3d', mixo_marker_version: 1,
    mixo_viewport_subdiv_level: 1, mixo_render_subdiv_level: 2,
  })));

  assert.equal(extractMixoProvenance(partial), null);
  assert.equal(extractMixoProvenance(onlyInherited), null);
});

await test('isLibraryImport reads the Blender library=1 custom property', () => {
  const container = {
    meshes: [],
    transformNodes: [extras({ library: 1 })],
  };
  assert.equal(isLibraryImport(container), true);
});

await test('isLibraryImport ignores non-enabled library values', () => {
  const container = {
    meshes: [],
    transformNodes: [
      extras({ library: 0 }),
      extras({ library: 'library' }),
    ],
  };
  assert.equal(isLibraryImport(container), false);
});

await test('findLibraryItemRoots splits by first real top-level Blender object', () => {
  const root = { name: '__root__', parent: null, ...extras({ library: 1 }) };
  const cola = { name: 'Cola', parent: root, metadata: {} };
  const juice = { name: 'Juice', parent: root, metadata: {} };
  const colaMesh = geomMesh('cola_mesh', cola);
  const juiceMesh = geomMesh('juice_mesh', juice);

  const roots = findLibraryItemRoots({
    transformNodes: [root, cola, juice],
    meshes: [colaMesh, juiceMesh],
  });

  assert.deepEqual(roots.map(r => r.name), ['Cola', 'Juice']);
  assert.deepEqual(roots.map(r => r.path), ['Cola', 'Juice']);
});

await test('findLibraryItemRoots scopes items to a marked Blender Empty', () => {
  const sceneRoot = { name: '__root__', parent: null, metadata: {} };
  const library = { name: 'BeverageLibrary', parent: sceneRoot, ...extras({ library: 1 }) };
  const cola = { name: 'Cola', parent: library, metadata: {} };
  const juice = { name: 'Juice', parent: library, metadata: {} };
  const helper = { name: 'ReferenceScaleCube', parent: sceneRoot, metadata: {} };
  const colaMesh = geomMesh('cola_mesh', cola);
  const juiceMesh = geomMesh('juice_mesh', juice);
  const helperMesh = geomMesh('helper_mesh', helper);

  const roots = findLibraryItemRoots({
    transformNodes: [sceneRoot, library, cola, juice, helper],
    meshes: [colaMesh, juiceMesh, helperMesh],
  });

  assert.deepEqual(roots.map(r => r.name), ['Cola', 'Juice']);
  assert.deepEqual(roots.map(r => r.path), ['Cola', 'Juice']);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
