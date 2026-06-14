// Parses one ICU-style "{n, plural, =0{...} one{...} other{# ...}}" string and
// returns the arm matching `n` under `locale`. `#` inside an arm is replaced
// with the number. Anything else returns `undefined` (caller falls back to key).
//
// Format reference: https://unicode-org.github.io/icu/userguide/format_parse/messages/
// We support only =N exact match, the keywords (zero/one/two/few/many/other),
// and the `#` token. No nested selects, no offset, no select-by-string.
export function parsePlural(template, n, locale) {
  const m = template.match(/^\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,\s*plural\s*,\s*(.+)\}\s*$/s);
  if (!m) return undefined;
  const body = m[2];
  const arms = _splitArms(body);
  const exact = arms.get(`=${n}`);
  if (exact != null) return exact.replace(/#/g, String(n));
  const cat = new Intl.PluralRules(locale).select(n);   // 'one' | 'other' | ...
  const armText = arms.get(cat) ?? arms.get('other');
  return armText == null ? undefined : armText.replace(/#/g, String(n));
}

// Splits "=0{...} one{...} other{...}" into Map<keyword, body>. Respects nested braces.
function _splitArms(body) {
  const out = new Map();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    const kStart = i;
    while (i < body.length && body[i] !== '{') i++;
    const key = body.slice(kStart, i).trim();
    if (body[i] !== '{') break;
    let depth = 1, j = i + 1;
    while (j < body.length && depth > 0) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') depth--;
      if (depth > 0) j++;
    }
    out.set(key, body.slice(i + 1, j));
    i = j + 1;
  }
  return out;
}
