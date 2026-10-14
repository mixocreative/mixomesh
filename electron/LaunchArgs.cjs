'use strict';
// Launch-argument parsing + path validation (plan LI.1, decisions D2/D3).
// Pure: no Electron import; fs functions are injected. Windows path semantics.

const path = require('node:path').win32;
const { MAX_WRITE_BYTES } = require('./OpaqueFileRegistry.cjs');

const LAUNCH_EXTENSIONS = Object.freeze(['mixo', 'glb', 'gltf', '3mf', 'obj', 'stl']);
const MAX_LAUNCH_OPENS = 32;
const RESERVED_NAME_RE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(\..*)?$/i;
const DEVICE_PREFIX_RE = /^[\\/]{2}[?.][\\/]/;

const extOf = p => path.extname(String(p)).slice(1).toLowerCase();
const hasAllowedExt = p => LAUNCH_EXTENSIONS.includes(extOf(p));
const baseName = raw => path.basename(String(raw).replace(/\0/g, '')) || '(empty)';

/**
 * argv -> { opens[], library, ignored[], truncated }. Never throws.
 * `truncated` = number of --open/positional entries dropped past MAX_LAUNCH_OPENS.
 */
function parseLaunchArgv(argv, { isPackaged } = {}) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const args = list.slice(isPackaged ? 1 : 2);
  const opens = [];
  let library = null;
  const ignored = [];
  let truncated = 0;
  const addOpen = v => {
    if (opens.length >= MAX_LAUNCH_OPENS) truncated++;
    else opens.push(v);
  };
  let flagsDone = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!flagsDone && a === '--') { flagsDone = true; continue; }
    if (!flagsDone && a.startsWith('-')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (name === '--open' || name === '--library') {
        let value;
        if (eq !== -1) value = a.slice(eq + 1);
        else if (i + 1 < args.length) value = args[++i];
        if (!value) { ignored.push(a); continue; }
        if (name === '--open') addOpen(value); else library = value;
      } else {
        ignored.push(a);
      }
      continue;
    }
    if (hasAllowedExt(a)) addOpen(a); else ignored.push(a);
  }
  return { opens, library, ignored, truncated };
}

/**
 * Validate one launch path (async; realpath/stat may be sync or async).
 * Reasons never contain the directory part; `name` is the basename only.
 */
async function validateLaunchPath(raw, { kind = 'file', cwd, realpath, stat, maxBytes = MAX_WRITE_BYTES } = {}) {
  const name = baseName(raw);
  const fail = reason => ({ ok: false, name, reason });
  if (typeof raw !== 'string' || raw.trim() === '') return fail('empty path');
  if (raw.includes('\0')) return fail('invalid characters in path');
  if (DEVICE_PREFIX_RE.test(raw)) return fail('device path syntax not allowed');
  if (/^[\\/]{2}/.test(raw)) return fail('network (UNC) paths not allowed');
  const drive = /^[a-zA-Z]:/.exec(raw);
  if (drive && !/^[\\/]/.test(raw.slice(2))) return fail('drive-relative path not allowed');
  if (raw.slice(drive ? 2 : 0).includes(':')) return fail('invalid characters in path');
  if (raw.split(/[\\/]/).some(s => RESERVED_NAME_RE.test(s))) return fail('reserved device name');
  if (kind === 'file' && !hasAllowedExt(raw)) return fail('unsupported file type');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return fail('no working directory');

  const abs = path.resolve(cwd, raw);
  let real;
  try { real = await realpath(abs); } catch { return fail('not found or not accessible'); }
  if (typeof real !== 'string' || real === '') return fail('not found or not accessible');
  // Windows realpath may legitimately return \\?\C:\... ; anything else odd is refused.
  const plain = real.replace(/^\\\\\?\\(?=[a-zA-Z]:\\)/, '');
  if (DEVICE_PREFIX_RE.test(plain)) return fail('device path syntax not allowed');
  if (/^[\\/]{2}/.test(plain)) return fail('network (UNC) paths not allowed');
  if (plain.split(/[\\/]/).some(s => RESERVED_NAME_RE.test(s))) return fail('reserved device name');
  if (kind === 'file' && !hasAllowedExt(plain)) return fail('unsupported file type');

  let st;
  try { st = await stat(plain); } catch { return fail('not found or not accessible'); }
  if (kind === 'file') {
    if (!st || !st.isFile()) return fail('not a regular file');
    if (typeof st.size === 'number' && st.size > maxBytes) return fail('file too large');
  } else if (!st || !st.isDirectory()) {
    return fail('not a directory');
  }
  return { ok: true, absolutePath: plain, name, ext: extOf(plain) };
}

module.exports = { parseLaunchArgv, validateLaunchPath, LAUNCH_EXTENSIONS, MAX_LAUNCH_OPENS };
