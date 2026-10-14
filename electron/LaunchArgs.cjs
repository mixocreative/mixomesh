'use strict';
// Launch-argument parsing + path validation (plan LI.1, decisions D2/D3).
// Pure: no Electron import; fs functions are injected. Windows path semantics.

const path = require('node:path').win32;
const { MAX_WRITE_BYTES } = require('./OpaqueFileRegistry.cjs');

const LAUNCH_EXTENSIONS = Object.freeze(['mixo', 'glb', 'gltf', '3mf', 'obj', 'stl']);
const MAX_LAUNCH_OPENS = 32;
const MAX_API_IMPORTS = MAX_LAUNCH_OPENS;
const OUTPUT_EXTENSIONS = Object.freeze(['3mf', 'obj', 'stl', 'ply', 'wrl', 'zip', 'png', 'mtl', 'json', 'mixo']);
const W_OK = 2; // fs.constants.W_OK, inlined to keep this module fs-free
const RESERVED_NAME_RE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(\..*)?$/i;
const DEVICE_PREFIX_RE = /^[\\/]{2}[?.][\\/]/;

const extOf = p => path.extname(String(p)).slice(1).toLowerCase();
const hasAllowedExt = p => LAUNCH_EXTENSIONS.includes(extOf(p));
const baseName = raw => path.basename(String(raw).replace(/\0/g, '')) || '(empty)';

/**
 * argv -> { opens[], library, ignored[], truncated, job, result, hidden, quit }. Never throws.
 * `truncated` = number of --open/positional entries dropped past MAX_LAUNCH_OPENS.
 * API.7: `--job <file>` / `--result <file>` (last one wins, raw strings, validated by the caller),
 * `--hidden` / `--quit` (booleans; a job with a result implies both).
 */
function parseLaunchArgv(argv, { isPackaged } = {}) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const args = list.slice(isPackaged ? 1 : 2);
  const opens = [];
  let library = null;
  const ignored = [];
  let truncated = 0;
  let job = null;
  let result = null;
  let hidden = false;
  let quit = false;
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
      if (name === '--hidden' || name === '--quit') {
        if (eq !== -1) { ignored.push(a); continue; }
        if (name === '--hidden') hidden = true; else quit = true;
      } else if (name === '--open' || name === '--library' || name === '--job' || name === '--result') {
        let value;
        if (eq !== -1) value = a.slice(eq + 1);
        else if (i + 1 < args.length) value = args[++i];
        if (!value) { ignored.push(a); continue; }
        if (name === '--open') addOpen(value);
        else if (name === '--library') library = value;
        else if (name === '--job') job = value;
        else result = value;
      } else {
        ignored.push(a);
      }
      continue;
    }
    if (hasAllowedExt(a)) addOpen(a); else ignored.push(a);
  }
  return { opens, library, ignored, truncated, job, result, hidden, quit };
}

async function writable(access, p) {
  if (typeof access !== 'function') return false; // fail closed
  try { await access(p, W_OK); return true; } catch { return false; }
}

const plainOf = real => String(real).replace(/^\\\\\?\\(?=[a-zA-Z]:\\)/, '');
const unsafeReal = plain => {
  if (DEVICE_PREFIX_RE.test(plain)) return 'device path syntax not allowed';
  if (/^[\\/]{2}/.test(plain)) return 'network (UNC) paths not allowed';
  if (plain.split(/[\\/]/).some(s => RESERVED_NAME_RE.test(s))) return 'reserved device name';
  return null;
};

/** outputFile: parent must be an existing writable dir; the file itself may not exist yet. */
async function validateOutputFile(abs, name, { realpath, stat, access }) {
  const fail = reason => ({ ok: false, name, reason });
  let parentReal;
  try { parentReal = await realpath(path.dirname(abs)); } catch { return fail('not found or not accessible'); }
  if (typeof parentReal !== 'string' || parentReal === '') return fail('not found or not accessible');
  const parent = plainOf(parentReal);
  const bad = unsafeReal(parent);
  if (bad) return fail(bad);
  let pst;
  try { pst = await stat(parent); } catch { return fail('not found or not accessible'); }
  if (!pst || !pst.isDirectory()) return fail('not a directory');
  let target = path.join(parent, path.basename(abs));
  let treal = null;
  try { treal = await realpath(target); } catch { treal = null; }
  let exists = false;
  if (typeof treal === 'string' && treal !== '') {
    target = plainOf(treal);
    const badT = unsafeReal(target);
    if (badT) return fail(badT);
    if (!OUTPUT_EXTENSIONS.includes(extOf(target))) return fail('unsupported file type');
    let tst;
    try { tst = await stat(target); } catch { return fail('not found or not accessible'); }
    if (!tst || !tst.isFile()) return fail('not a regular file');
    exists = true;
    if (!(await writable(access, target))) return fail('not writable');
  } else if (!(await writable(access, parent))) {
    return fail('not writable');
  }
  return { ok: true, absolutePath: target, name, ext: extOf(target), exists };
}

/**
 * Validate one launch path (async; realpath/stat/access may be sync or async).
 * kinds: 'file' | 'jobFile' (existing .json, --job only) | 'directory' | 'outputDir' (existing dir, W_OK) |
 * 'outputFile' (parent exists + W_OK, ext in OUTPUT_EXTENSIONS, result carries `exists`).
 * Reasons never contain the directory part; `name` is the basename only.
 */
async function validateLaunchPath(raw, { kind = 'file', cwd, realpath, stat, access, maxBytes = MAX_WRITE_BYTES } = {}) {
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
  if (kind === 'jobFile' && extOf(raw) !== 'json') return fail('unsupported file type');
  if (kind === 'outputFile' && !OUTPUT_EXTENSIONS.includes(extOf(raw))) return fail('unsupported file type');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return fail('no working directory');

  const abs = path.resolve(cwd, raw);
  if (kind === 'outputFile') return validateOutputFile(abs, name, { realpath, stat, access });
  let real;
  try { real = await realpath(abs); } catch { return fail('not found or not accessible'); }
  if (typeof real !== 'string' || real === '') return fail('not found or not accessible');
  // Windows realpath may legitimately return \\?\C:\... ; anything else odd is refused.
  const plain = real.replace(/^\\\\\?\\(?=[a-zA-Z]:\\)/, '');
  if (DEVICE_PREFIX_RE.test(plain)) return fail('device path syntax not allowed');
  if (/^[\\/]{2}/.test(plain)) return fail('network (UNC) paths not allowed');
  if (plain.split(/[\\/]/).some(s => RESERVED_NAME_RE.test(s))) return fail('reserved device name');
  if (kind === 'file' && !hasAllowedExt(plain)) return fail('unsupported file type');
  if (kind === 'jobFile' && extOf(plain) !== 'json') return fail('unsupported file type');

  let st;
  try { st = await stat(plain); } catch { return fail('not found or not accessible'); }
  if (kind === 'file' || kind === 'jobFile') {
    if (!st || !st.isFile()) return fail('not a regular file');
    if (typeof st.size === 'number' && st.size > maxBytes) return fail('file too large');
  } else if (!st || !st.isDirectory()) {
    return fail('not a directory');
  }
  if (kind === 'outputDir' && !(await writable(access, plain))) return fail('not writable');
  return { ok: true, absolutePath: plain, name, ext: extOf(plain) };
}

module.exports = { parseLaunchArgv, validateLaunchPath, LAUNCH_EXTENSIONS, MAX_LAUNCH_OPENS, MAX_API_IMPORTS, OUTPUT_EXTENSIONS };
