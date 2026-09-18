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
  const mk = (name, parent) => ({ name, parent, geometry: {}, getTotalVertices() { return 3; } });
  const a = mk('PartA', root), b = mk('PartB', root);
  let serial = 0;

  const hierarchy = buildImportHierarchy(
    { meshes: [a, b], transformNodes: [root] },
    prefix => `${prefix}_${++serial}`,
    name => name,
  );

  assert.equal(Object.values(hierarchy.groups)[0].origin, 'import');
  assert.equal(hierarchy.groupIdForMesh(a), hierarchy.groupIdForMesh(b), 'both parts sit in the assembly group');
});

// Owner decision 2026-09-18: a wrapper node with a single structural child
// is NOT a group — a scan showed as file → node → mesh, three rows for one
// object. Groups survive only for real assemblies (2+ objects / sub-groups).
test('single-child wrapper nodes collapse; assemblies keep their group; chains collapse to the assembly', () => {
  const mk = (name, parent) => ({ name, parent, geometry: {}, getTotalVertices() { return 3; }, uniqueId: name });
  let serial = 0;
  const build = (meshes, nodes) => buildImportHierarchy({ meshes, transformNodes: nodes }, p => `${p}_${++serial}`, n => n);

  // (1) one mesh under one node → no group
  const n1 = { name: 'Scan', parent: null, metadata: {}, uniqueId: 'n1' };
  const h1 = build([mk('Scan', n1)], [n1]);
  assert.equal(Object.keys(h1.groups).length, 0, 'single mesh wrapper collapses');

  // (2) one multi-primitive mesh (one logical object) under one node → no group
  const n2 = { name: 'Bowl', parent: null, metadata: {}, uniqueId: 'n2' };
  const p0 = mk('Bowl_primitive0', n2), p1 = mk('Bowl_primitive1', n2);
  const h2 = build([p0, p1], [n2]);
  assert.equal(Object.keys(h2.groups).length, 0, 'primitives of one mesh are one logical object → wrapper collapses');
  assert.equal(h2.originNodeKey(p0), 'nn2', 'origin key names the authored node');
  assert.equal(h2.originNodeKey(p0), h2.originNodeKey(p1), 'siblings share the origin key');

  // (3) two objects under one node → group kept
  const n3 = { name: 'Set', parent: null, metadata: {}, uniqueId: 'n3' };
  const h3 = build([mk('Cup', n3), mk('Saucer', n3)], [n3]);
  assert.equal(Object.keys(h3.groups).length, 1, 'real assembly keeps its group');

  // (4) empty → empty → two objects: outer chain collapses, inner assembly stays
  const outer = { name: 'Outer', parent: null, metadata: {}, uniqueId: 'o' };
  const inner = { name: 'Inner', parent: outer, metadata: {}, uniqueId: 'i' };
  const h4 = build([mk('A', inner), mk('B', inner)], [outer, inner]);
  const g4 = Object.values(h4.groups);
  assert.equal(g4.length, 1, 'single-child chain collapses to the assembly');
  assert.equal(g4[0].name, 'Inner');
  assert.equal(g4[0].parentId, null, 'the surviving group has no collapsed parent');
});
