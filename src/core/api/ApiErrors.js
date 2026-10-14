// ApiErrors — fixed error model of the automation API (ADR 0005, API.1).
// Pure ES module, no imports: main-side CJS loads it via dynamic import().
// Wire shape: JSON-RPC 2.0 error `{code, message, data:{code:'E_...', ...}}`.
// Codes are a STABLE CONTRACT (pinned by a snapshot test) — add, never renumber.

export const API_VERSION = 1;

/** Symbolic code -> JSON-RPC numeric code. */
export const ERROR_CODES = Object.freeze({
  E_INVALID_PARAMS: -32602,
  E_METHOD_NOT_FOUND: -32601,
  E_INTERNAL: -32603,
  E_NOT_FOUND: -32000,
  E_PATH_REJECTED: -32001,
  E_BUSY: -32002,
  E_CONFIRM_REQUIRED: -32003,
  E_DIRTY: -32004,
  E_CANCELLED: -32005,
  E_UNSUPPORTED: -32006,
  E_EXPORT_GATE: -32007,
  E_LIMIT: -32008,
  E_TIMEOUT: -32009,
});

const has = code => Object.prototype.hasOwnProperty.call(ERROR_CODES, code);

/** JSON-RPC numeric code for a symbolic code (unknown -> E_INTERNAL's). */
export function rpcCodeFor(code) {
  return has(code) ? ERROR_CODES[code] : ERROR_CODES.E_INTERNAL;
}

/** Reverse lookup: numeric code -> symbolic code, or null. */
export function symbolicCodeFor(rpcCode) {
  for (const [k, v] of Object.entries(ERROR_CODES)) if (v === rpcCode) return k;
  return null;
}

/**
 * Build a JSON-RPC error object. An unknown symbolic code degrades to E_INTERNAL
 * (the original is kept in data.requestedCode) so a typo can never leak a bogus code.
 * `data` (plain object) is merged into `data`; `data.code` is always the symbolic code.
 * @param {string} code
 * @param {string} [message]
 * @param {object} [data]
 * @returns {{code:number, message:string, data:object}}
 */
export function apiError(code, message, data) {
  const known = has(code);
  const sym = known ? code : 'E_INTERNAL';
  const extra = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const out = { ...extra, code: sym };
  if (!known) out.requestedCode = String(code);
  return {
    code: ERROR_CODES[sym],
    message: String(message == null || message === '' ? sym : message),
    data: out,
  };
}

/** True for objects produced by apiError(). */
export function isApiError(e) {
  return !!e && typeof e === 'object' && typeof e.code === 'number'
    && !!e.data && typeof e.data === 'object' && symbolicCodeFor(e.code) === e.data.code;
}
