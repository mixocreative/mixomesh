// Replaces {name} in `s` with String(params[name]). Missing → leaves "{name}" intact.
// `s` MUST be a plain string; placeholders are literal text, never evaluated.
export function interpolate(s, params) {
  if (!params) return s;
  return s.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}
