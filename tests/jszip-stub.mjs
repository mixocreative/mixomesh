// Minimal JSZip stand-in for headless export tests. Records what was added
// so assertions can inspect the archive without a real zip.
// Every JSZip created during a test is recorded so assertions can inspect
// the archive contents (file names + string payloads).
export const instances = [];

export default class JSZip {
  constructor() { this.files = {}; instances.push(this); }
  file(name, content) { this.files[name] = content; return this; }
  folder(name) {
    const self = this;
    return { file(fname, blob) { self.files[`${name}/${fname}`] = blob; } };
  }
  async generateAsync() { return { __fakeZip: true, names: Object.keys(this.files) }; }
}
