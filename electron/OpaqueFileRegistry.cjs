const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');

/**
 * Main-process-only registry. Renderer code receives random references and
 * display paths; operating-system paths remain inside this closure.
 */
function createOpaqueFileRegistry(deps = {}) {
  const makeId = deps.randomUUID ?? randomUUID;
  const readdir = deps.readdir ?? fs.readdir;
  const readFile = deps.readFile ?? fs.readFile;
  const refs = new Map();

  function register(kind, absolutePath, name, prefix = 'ref') {
    const ref = `${prefix}_${makeId()}`;
    refs.set(ref, { kind, absolutePath, name });
    return ref;
  }

  function requireRef(ref, kind) {
    const entry = refs.get(ref);
    if (!entry || entry.kind !== kind) throw new Error(`Unknown ${kind} reference`);
    return entry;
  }

  return {
    registerMount(absolutePath, name = path.basename(absolutePath)) {
      return { ref: register('directory', absolutePath, name, 'mount'), name };
    },

    async listDirectory(ref, parentPath = '') {
      const directory = requireRef(ref, 'directory');
      const children = await readdir(directory.absolutePath, { withFileTypes: true });
      return children
        .filter(child => child.isDirectory() || child.isFile())
        .map(child => {
          const kind = child.isDirectory() ? 'directory' : 'file';
          return {
            name: child.name,
            path: parentPath ? `${parentPath}/${child.name}` : child.name,
            kind,
            ref: register(kind, path.join(directory.absolutePath, child.name), child.name),
          };
        })
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    },

    async readFile(ref) {
      const file = requireRef(ref, 'file');
      const bytes = await readFile(file.absolutePath);
      const copy = Uint8Array.from(bytes);
      return { name: file.name, bytes: copy.buffer };
    },
  };
}

module.exports = { createOpaqueFileRegistry };
