import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeGroupOrigin,
  planHierarchyRemoval,
} from '../src/core/hierarchy/HierarchyIntegrity.js';
import { buildImportHierarchy } from '../src/core/import/ImportHierarchy.js';

test('removing an object cleans its id from every group', () => {
  const groups = {
    a: { id: 'a', parentId: null, childIds: ['keep', 'remove'], origin: 'user' },
    b: { id: 'b', parentId: null, childIds: ['remove'], origin: 'user' },
  };

  const plan = planHierarchyRemoval(groups, new Set(['remove']));

  assert.deepEqual(plan.groups.a.childIds, ['keep']);
  assert.deepEqual(plan.groups.b.childIds, []);
  assert.deepEqual(plan.pruneIds, []);
});

test('empty imported ancestors are pruned from leaf to root', () => {
  const groups = {
    root: { id: 'root', parentId: null, childIds: [], origin: 'import' },
    leaf: { id: 'leaf', parentId: 'root', childIds: ['mesh'], origin: 'import' },
  };

  const plan = planHierarchyRemoval(groups, new Set(['mesh']));

  assert.deepEqual(plan.pruneIds, ['leaf', 'root']);
});

test('empty user groups are preserved', () => {
  const groups = {
    user: { id: 'user', parentId: null, childIds: ['mesh'], origin: 'user' },
  };

  const plan = planHierarchyRemoval(groups, new Set(['mesh']));

  assert.deepEqual(plan.groups.user.childIds, []);
  assert.deepEqual(plan.pruneIds, []);
});

test('an imported group containing a preserved user subgroup is preserved', () => {
  const groups = {
    imported: { id: 'imported', parentId: null, childIds: [], origin: 'import' },
    user: { id: 'user', parentId: 'imported', childIds: ['mesh'], origin: 'user' },
  };

  const plan = planHierarchyRemoval(groups, new Set(['mesh']));

  assert.deepEqual(plan.pruneIds, []);
});

test('missing group origin migrates conservatively to user', () => {
  assert.equal(normalizeGroupOrigin({ id: 'old' }).origin, 'user');
  assert.equal(normalizeGroupOrigin({ id: 'new', origin: 'import' }).origin, 'import');
});

test('captured import transform nodes are marked as imported groups', () => {
  const root = { name: 'Assembly', parent: null, metadata: {} };
  const mesh = {
    name: 'Part', parent: root, geometry: {},
    getTotalVertices() { return 3; },
  };
  let serial = 0;

  const hierarchy = buildImportHierarchy(
    { meshes: [mesh], transformNodes: [root] },
    prefix => `${prefix}_${++serial}`,
    name => name,
  );

  assert.equal(Object.values(hierarchy.groups)[0].origin, 'import');
});
