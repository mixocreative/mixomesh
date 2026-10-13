// In-memory Origin Private File System + DOM stubs for the OPFS StorageAdapter
// tier (task 8.2). Handles sit on top of a tiny path-keyed fs model (the same
// shape storage-adapter.test.mjs's makeFs exposes: get / children / write /
// remove / mkdir) so a harness can move/delete files "on disk" underneath.
//   createOpfsRoot(fs, rootPath, {denied})  → FileSystemDirectoryHandle-like root
//   installOpfsEnv({fs, rootPath, ...})      → navigator.storage + document stubs

const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const base = p => norm(p).split('/').pop();

/** Minimal path → node fs model (dirs + files with bytes + mtime). */
export function makeMemFs() {
  const nodes = new Map();
  let clock = 1000;
  const mkdirp = p => {
    const parts = norm(p).split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      if (!nodes.has(sub)) nodes.set(sub, { kind: 'dir' });
    }
  };
  const fs = {
    nodes,
    write(p, bytes) {
      mkdirp(norm(p).split('/').slice(0, -1).join('/'));
      nodes.set(norm(p), { kind: 'file', bytes: Uint8Array.from(bytes), mtime: ++clock });
    },
    mkdir: mkdirp,
    remove(p) {
      const n = norm(p);
      for (const key of [...nodes.keys()]) if (key === n || key.startsWith(`${n}/`)) nodes.delete(key);
    },
    get: p => nodes.get(norm(p)),
    children(p) {
      const n = norm(p);
      return [...nodes.keys()]
        .filter(k => k.startsWith(`${n}/`) && !k.slice(n.length + 1).includes('/'))
        .map(k => ({ path: k, name: base(k), node: nodes.get(k) }));
    },
  };
  return fs;
}

const domErr = (name, msg = name) => Object.assign(new Error(msg), { name });

/**
 * OPFS-like handles over `fs`. `denied` (Set of paths) makes every access at or
 * under a path throw NotAllowedError. `withCreateWritable:false` models older
 * WebKit (no main-thread createWritable).
 */
export function createOpfsRoot(fs, rootPath = 'opfs', { denied = new Set(), withCreateWritable = true } = {}) {
  const rootN = norm(rootPath);
  fs.mkdir(rootN);
  const guard = p => {
    for (const d of denied) if (norm(p) === norm(d) || norm(p).startsWith(`${norm(d)}/`)) throw domErr('NotAllowedError');
  };
  const common = p => ({
    __path: norm(p),
    name: norm(p) === rootN ? '' : base(p),
    async isSameEntry(other) { return other?.__path === norm(p) && other.kind === this.kind; },
  });
  const fileHandle = p => {
    const h = {
      ...common(p), kind: 'file',
      async getFile() {
        guard(p);
        const n = fs.get(p);
        if (n?.kind !== 'file') throw domErr('NotFoundError');
        return new File([n.bytes], base(p), { lastModified: n.mtime });
      },
    };
    if (withCreateWritable) {
      h.createWritable = async () => {
        guard(p);
        const chunks = [];
        return {
          async write(d) {
            chunks.push(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(await new Blob([d]).arrayBuffer()));
          },
          async close() { fs.write(p, [...chunks.flatMap(c => [...c])]); },
          async abort() { chunks.length = 0; },
        };
      };
    }
    return h;
  };
  const dirHandle = p => ({
    ...common(p), kind: 'directory',
    async *entries() {
      guard(p);
      if (fs.get(p)?.kind !== 'dir') throw domErr('NotFoundError');
      for (const c of fs.children(p)) yield [c.name, c.node.kind === 'dir' ? dirHandle(c.path) : fileHandle(c.path)];
    },
    async getDirectoryHandle(name, opts = {}) {
      const child = `${norm(p)}/${name}`;
      guard(child);
      const n = fs.get(child);
      if (n?.kind === 'file') throw domErr('TypeMismatchError');
      if (!n) {
        if (!opts.create) throw domErr('NotFoundError');
        fs.mkdir(child);
      }
      return dirHandle(child);
    },
    async getFileHandle(name, opts = {}) {
      const child = `${norm(p)}/${name}`;
      guard(child);
      const n = fs.get(child);
      if (n?.kind === 'dir') throw domErr('TypeMismatchError');
      if (!n) {
        if (!opts.create) throw domErr('NotFoundError');
        fs.write(child, []);
      }
      return fileHandle(child);
    },
    async removeEntry(name) {
      const child = `${norm(p)}/${name}`;
      guard(child);
      if (!fs.get(child)) throw domErr('NotFoundError');
      fs.remove(child);
    },
    async resolve(other) {
      const op = other?.__path;
      if (!op) return null;
      if (op === norm(p)) return [];
      return op.startsWith(`${norm(p)}/`) ? op.slice(norm(p).length + 1).split('/') : null;
    },
  });
  return { root: dirHandle(rootN), dirHandle, fileHandle };
}

/**
 * Install `navigator` (storage.getDirectory + optional share) and `document`
 * (hidden file input + anchor) stubs. `answerFiles(opts)` answers each file
 * input: an array of Files, or null = the user cancelled (fires `cancel`).
 * Returns the recorded downloads/shares/inputs and a `restore()`.
 */
export function installOpfsEnv({ root, answerFiles = () => null, share = null, userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform = 'MacIntel', maxTouchPoints = 0 } = {}) {
  const rec = { downloads: [], shares: [], inputs: [], persistCalls: 0 };
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const nav = {
    userAgent, platform, maxTouchPoints,
    storage: {
      async getDirectory() { if (!root) throw domErr('SecurityError'); return root; },
      async persist() { rec.persistCalls++; return true; },
    },
  };
  if (share) {
    nav.canShare = data => share.canShare(data);
    nav.share = async data => { rec.shares.push(data); return share.share(data); };
  }
  const listeners = el => {
    const map = new Map();
    el.addEventListener = (type, cb) => { (map.get(type) ?? map.set(type, []).get(type)).push(cb); };
    el.dispatch = type => { for (const cb of map.get(type) ?? []) cb({ type }); };
  };
  const body = {
    children: new Set(),
    appendChild(el) { this.children.add(el); el.isConnected = true; },
  };
  const doc = {
    body,
    createElement(tag) {
      const el = { tagName: tag.toUpperCase(), style: {}, isConnected: false };
      el.remove = () => { body.children.delete(el); el.isConnected = false; };
      listeners(el);
      if (tag === 'input') {
        el.click = () => {
          rec.inputs.push({ type: el.type, accept: el.accept ?? '', multiple: el.multiple, connected: el.isConnected });
          queueMicrotask(() => {
            const files = answerFiles({ accept: el.accept ?? '', multiple: el.multiple });
            if (!files) { el.dispatch('cancel'); return; }
            el.files = files;
            el.dispatch('change');
          });
        };
      } else if (tag === 'a') {
        el.click = () => { rec.downloads.push({ name: el.download, href: el.href }); };
      }
      return el;
    },
  };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  return {
    rec,
    setAnswer(fn) { answerFiles = fn; },
    restore() {
      if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav); else delete globalThis.navigator;
      if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc); else delete globalThis.document;
    },
  };
}
