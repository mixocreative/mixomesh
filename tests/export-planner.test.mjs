import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};

const {
  exportBaseName,
  perMeshBaseName,
  safeFilenameStem,
  scaleFilenameSuffix,
} = await import('../src/core/print/ExportPlanner.js');

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('scaleFilenameSuffix preserves existing _r{scene}to{print} contract', () => {
  assert.equal(scaleFilenameSuffix({ sceneRatio: 1 }, { printRatio: 144 }), '_r1to144');
  assert.equal(scaleFilenameSuffix({ sceneRatio: 12 }, { printRatio: 35 }), '_r12to35');
});

await test('exportBaseName sanitizes project name and appends scale suffix', () => {
  assert.equal(exportBaseName('Bad:Name', { sceneRatio: 1 }, { printRatio: 72 }), 'Bad_Name_r1to72');
});

await test('perMeshBaseName sanitizes project and mesh names', () => {
  assert.equal(perMeshBaseName('Project', 'part/a', { sceneRatio: 1 }, { printRatio: 1 }), 'Project_part_a_r1to1');
});

await test('safeFilenameStem falls back for empty or illegal names', () => {
  assert.equal(safeFilenameStem(''), 'Untitled');
  assert.equal(safeFilenameStem('a<b>c'), 'a_b_c');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
