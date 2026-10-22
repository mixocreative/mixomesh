// node --test reporter that names every failing test: file, line, test name
// and error, one block each, written as it happens, then a "done" count line.
// `npm test` sends it to .tmp/last-test-failures.txt so a failure in a long
// run cannot scroll away. The file is rewritten on every run; a run that hung
// or was killed has no "done" line but still names what failed before it.

import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

function fileOf(path) {
  if (!path) return '?';
  const file = path.startsWith('file:') ? fileURLToPath(path) : path;
  return relative(process.cwd(), file).replace(/\\/g, '/');
}

function describe(error) {
  const root = error?.code === 'ERR_TEST_FAILURE' && error.cause ? error.cause : error;
  if (!(root instanceof Error)) {
    // A whole-file failure: how the process ended tells a FAIL exit (1) from
    // a crash (0xC0000005 = 3221225477, 134 abort) or a kill (signal).
    const exit = error?.signal ? ` (killed by ${error.signal})`
      : error?.exitCode != null ? ` (process exit code ${error.exitCode})` : '';
    return `${inspect(root, { depth: 4 })}${exit}`;
  }
  // `fetch failed` and friends keep the reason (ECONNREFUSED, ...) in `cause`.
  const cause = root.cause ? `\ncause: ${inspect(root.cause, { depth: 2 })}` : '';
  return `${root.stack ?? `${root.name}: ${root.message}`}${cause}`;
}

// A failure of a whole file carries only "test failed": the file crashed
// outside any test, or it is one of the self-running files that print their
// own PASS/FAIL lines and exit 1. What the file printed says which test.
function outputTail(lines) {
  const text = lines.join('').trimEnd();
  if (!text) return '';
  const tail = text.split(/\r?\n/).slice(-60).join('\n');
  return `\n  output (last 60 lines):\n${tail.replace(/^/gm, '    ')}`;
}

export default async function* failuresReporter(source) {
  const output = new Map();
  let passed = 0, failed = 0;
  yield `${new Date().toISOString()} node --test started\n\n`;
  for await (const { type, data } of source) {
    if ((type === 'test:stdout' || type === 'test:stderr') && data.file) {
      const file = fileOf(data.file);
      if (!output.has(file)) output.set(file, []);
      output.get(file).push(data.message);
    }
    if (type === 'test:pass' && data.details?.type !== 'suite') passed++;
    if (type !== 'test:fail') continue;
    // A suite fails because a child failed; the child carries the error.
    if (data.details?.error?.failureType === 'subtestsFailed') continue;
    failed++;
    const file = fileOf(data.file);
    const error = describe(data.details?.error).replace(/^/gm, '  ');
    const tail = fileOf(data.name) === file ? outputTail(output.get(file) ?? []) : '';
    yield `FAIL ${file}:${data.line ?? '?'} > ${data.name}\n${error}${tail}\n\n`;
  }
  yield `${new Date().toISOString()} node --test done: ${failed} failing, ${passed} passing\n`;
}
