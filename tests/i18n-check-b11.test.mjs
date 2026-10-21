import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHardcodedSinkText } from '../scripts/i18n-check.mjs';

test('flags English passed to progress, toast and overlay sinks outside src/ui', () => {
  const src = [
    "progress(0.02, 'Collecting meshes…');",
    'progress(0.3, `Preparing ${i}/${n}…`);',
    "_overlayUpdate(0.98, `${filename} ready`);",
    "Toast.show('Export failed', 'error');",
    'ProgressOverlay.update(f,',
    "  'Writing file');",
  ].join('\n');
  const found = findHardcodedSinkText(src, 'src/core/x.js').map(f => f.split(': ')[1]);
  assert.deepEqual(found, ['Collecting meshes…', 'Preparing /…', 'ready', 'Export failed', 'Writing file']);
});

test('accepts t() keys, translated wrappers, toast types and protocol objects', () => {
  const src = [
    "progress(0.5, t('progress.writing', { format }));",
    "Toast.show(tr('toast.nothing', 'Nothing selected'), 'info', 2000);",
    "Toast.show(t('toast.exportedOk', { filename }), 'success', 3000);",
    "options.onProgress?.({ phase: 'Reading topology', completed: 1 });",
    "progress({ stage: 'hash' });",
    "Toast.show(parsed.reason === 'scale' ? t('a.b') : t('c.d'), 'info');",
    "// progress(0, 'Commented out text');",
  ].join('\n');
  assert.deepEqual(findHardcodedSinkText(src, 'src/core/x.js'), []);
});

test('reports the line of a literal on a wrapped call', () => {
  const src = "const a = 1;\nToast.show(\n  'Something went wrong',\n  'error');\n";
  assert.deepEqual(findHardcodedSinkText(src, 'f.js'), ['f.js:2: Something went wrong']);
});
