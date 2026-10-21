// Listbridge create journal (cia B-04, F-01): what the main process knows about every create it
// sent, kept in <userData>/listbridge-journal.json so it survives a renderer reload, a renderer crash
// and an app restart. One entry per job, keyed by job id:
//   { jobId, projectKey, platform, accountId, state: 'creating'|'created'|'unknown', title, locale,
//     knownIds, listing, remoteId?, url?, status?, slug?, at }
// 'creating' is written BEFORE the create request leaves, 'created' the moment the platform answers
// with an id, 'unknown' when the answer was lost. The renderer removes an entry ('ack') once the
// listing record is in the project. No secrets and no file bytes are ever written here.
//
// Pure Node; io is injectable for tests. Writes are serialized and atomic (temp file + rename).

const fs = require('node:fs/promises');

/**
 * @param {{ filePath: string, io?: { readFile?: Function, writeFile?: Function, rename?: Function, unlink?: Function } }} opts
 */
function createJournal({ filePath, io: ioOverrides = {} } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('createJournal: filePath is required');
  const io = { readFile: fs.readFile, writeFile: fs.writeFile, rename: fs.rename, unlink: fs.unlink, ...ioOverrides };
  let chain = Promise.resolve();
  let tmpSeq = 0;
  const enqueue = task => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  async function load() {
    let text;
    try {
      text = await io.readFile(filePath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return {};
      throw err;
    }
    try {
      const parsed = JSON.parse(String(text));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  async function save(entries) {
    const tmp = `${filePath}.${process.pid}.${++tmpSeq}.tmp`;
    try {
      await io.writeFile(tmp, JSON.stringify(entries));
      await io.rename(tmp, filePath);
    } catch (err) {
      try { await io.unlink(tmp); } catch { /* temp already gone */ }
      throw err;
    }
  }

  return Object.freeze({
    /** Merge `fields` into the job's entry (created when missing). */
    put: (jobId, fields) => enqueue(async () => {
      const all = await load();
      all[jobId] = { ...(all[jobId] || {}), ...fields, jobId, at: new Date().toISOString() };
      await save(all);
      return { ...all[jobId] };
    }),
    remove: jobId => enqueue(async () => {
      const all = await load();
      if (!Object.hasOwn(all, jobId)) return false;
      delete all[jobId];
      await save(all);
      return true;
    }),
    get: jobId => enqueue(async () => {
      const all = await load();
      return Object.hasOwn(all, jobId) ? { ...all[jobId] } : null;
    }),
    list: () => enqueue(async () => Object.values(await load()).map(e => ({ ...e }))),
  });
}

module.exports = { createJournal };
