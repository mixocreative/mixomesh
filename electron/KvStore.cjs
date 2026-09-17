// Cross-session KV store backing DesktopStorageAdapter.kv* (autosave / recent /
// settings). One JSON object in a single file under userData. Pure Node — no
// Electron import — so it is unit-testable (tests/kv-store.test.mjs).
//
// Guarantees (audit M7):
//   * atomic replace: every write goes to a temp file in the same directory, then
//     fs.rename over the target — a crash mid-write never leaves a partial file;
//   * serialised mutations: every op runs through one promise chain, so
//     read-modify-write never interleaves and concurrent sets cannot lose updates;
//   * corrupt-file quarantine: unparsable JSON is renamed to
//     `<name>.corrupt-<timestamp>` and logged via console.error (recoverable),
//     then the store starts empty instead of silently returning {}.

const fs = require('node:fs/promises');
const path = require('node:path');

function createKvStore(filePath, deps = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('createKvStore: filePath is required');
  const io = {
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    unlink: fs.unlink,
    now: Date.now,
    log: (...args) => console.error(...args),
    pid: process.pid,
    ...deps,
  };
  let chain = Promise.resolve();
  let tmpSeq = 0;

  const enqueue = task => {
    const run = chain.then(task, task);   // keep the chain alive after a rejection
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

  async function quarantine(reason) {
    const stamp = new Date(io.now()).toISOString().replace(/[:.]/g, '-');
    const corruptPath = `${filePath}.corrupt-${stamp}`;
    try {
      await io.rename(filePath, corruptPath);
      io.log(`[KvStore] ${filePath} is unreadable (${reason}); moved to ${corruptPath} and starting empty`);
    } catch (err) {
      io.log(`[KvStore] ${filePath} is unreadable (${reason}); quarantine rename failed: ${err?.message ?? err}`);
    }
    return corruptPath;
  }

  async function read() {
    let text;
    try {
      text = await io.readFile(filePath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return {};
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      await quarantine(`JSON parse error: ${err?.message ?? err}`);
      return {};
    }
    if (!isPlainObject(parsed)) {
      await quarantine(`top-level JSON is ${Array.isArray(parsed) ? 'an array' : typeof parsed}, expected object`);
      return {};
    }
    return parsed;
  }

  async function write(obj) {
    const tmpPath = path.join(path.dirname(filePath), `${path.basename(filePath)}.${io.pid}.${++tmpSeq}.tmp`);
    try {
      await io.writeFile(tmpPath, JSON.stringify(obj));
      await io.rename(tmpPath, filePath);
    } catch (err) {
      try { await io.unlink(tmpPath); } catch { /* temp may not exist; target is untouched either way */ }
      throw err;
    }
  }

  return {
    set: (key, value) => enqueue(async () => { const o = await read(); o[key] = value; await write(o); }),
    get: key => enqueue(async () => { const o = await read(); return key in o ? o[key] : null; }),
    delete: key => enqueue(async () => { const o = await read(); delete o[key]; await write(o); }),
    keys: () => enqueue(async () => Object.keys(await read())),
    /** Resolves once every op queued so far has settled (test/shutdown helper). */
    flush: () => chain,
  };
}

module.exports = { createKvStore };
