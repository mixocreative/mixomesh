// Real XML namespaces and entity decoding for 3MF importer regressions.
import { DOMParser } from '@xmldom/xmldom';
const sample = new DOMParser().parseFromString('<a><b/></a>', 'application/xml');
for (const list of [sample.childNodes, sample.getElementsByTagName('b')]) {
  const prototype = Object.getPrototypeOf(list);
  prototype[Symbol.iterator] ??= function* () {
    for (let i = 0; i < this.length; i++) yield this[i];
  };
}
export { DOMParser };
