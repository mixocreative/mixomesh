// Pure classification shared by the web and Electron import-error dialog.
// Keep the original loader message/stack in Technical details; these keys
// explain the failure and the next useful action without exposing a stack.
// Our own failures carry `code`; the message patterns cover third-party text
// (Babylon, JSZip, the browser).

import { OVER_BUDGET } from './ImportLimits.js';

const CATEGORY_BY_CODE = { [OVER_BUDGET]: 'polygons', timeout: 'timeout' };
// Hints whose web wording points at the desktop app's higher limits.
const WEB_HINT = new Set(['polygons', 'memory', 'timeout']);

function _result(category, desktop) {
  const hint = !desktop && WEB_HINT.has(category) ? `${category}Web` : category;
  return { category, reasonKey: `import.reason.${category}`, hintKey: `import.fix.${hint}` };
}

/**
 * @param {{ message?: string, code?: string } | string} failure  the error (or its message)
 * @param {string} [filename]
 * @param {{ desktop?: boolean }} [runtime]  desktop: the hint never sends the user to the desktop app
 */
export function classifyImportFailure(failure, filename = '', { desktop = false } = {}) {
  const text = String((typeof failure === 'object' ? failure?.message : failure) ?? '');
  const byCode = typeof failure === 'object' ? CATEGORY_BY_CODE[failure?.code] : null;
  if (byCode) return _result(byCode, desktop);
  const threeMF = /\.3mf$/i.test(filename) || /3mf/i.test(text);
  let category = 'unknown';
  if (/quota|storage.*full|disk.*full/i.test(text)) category = 'storage';
  else if (/out of memory|allocation|array buffer|arraybuffer|invalid (?:array|typed array) length|insufficient memory/i.test(text)) category = 'memory';
  else if (/timed out/i.test(text)) category = 'timeout';
  else if (/too large|limit is .*MB|uncompressed|too many entries/i.test(text)) category = 'size';
  else if (/unsafe.*path|path.*traversal/i.test(text)) category = 'unsafePath';
  else if (/unsupported file type/i.test(text)) category = 'format';
  else if (/unsupported unit/i.test(text)) category = 'unit';
  else if (/missing object|component (?:path|cycle)|no 3D model part/i.test(text)) category = 'package';
  else if (/vertex|coordinate|invalid v[123]|invalid p(?:id|[123])|duplicate mesh object/i.test(text)) category = 'geometry';
  else if (/texture|mtl|sibling|material/i.test(text)) category = threeMF ? 'embeddedTexture' : 'sidecars';
  else if (/no importable|no geometry|no meshes|empty model/i.test(text)) category = 'empty';
  else if (/handle|permission|not allowed|file.*(?:moved|not found)|NotFoundError/i.test(text)) category = 'permission';
  else if (/xml|zip|central directory|end of data|corrupt|unexpected|unclosed|unbound namespace/i.test(text)) category = 'damaged';
  return _result(category, desktop);
}
