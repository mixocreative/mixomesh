// Maps a BCP-47 tag (e.g. 'zh-TW', 'ja-JP', 'en-GB') to one of SUPPORTED, or
// null if no rule matches. Order of rules matters: zh-Hant > zh.
//
// Reference: https://www.rfc-editor.org/rfc/bcp/bcp47.txt §2.2
const ZH_HANT_REGION = /^(TW|HK|MO)$/i;
const ZH_HANT_SCRIPT = /^Hant$/i;

export function mapTag(tag, supported) {
  if (!tag || typeof tag !== 'string') return null;
  const [langRaw, ...rest] = tag.split('-');
  const lang = langRaw.toLowerCase();
  if (lang === 'en' && supported.includes('en')) return 'en';
  if (lang === 'ja' && supported.includes('ja')) return 'ja';
  if (lang === 'zh') {
    for (const part of rest) {
      if (ZH_HANT_SCRIPT.test(part) || ZH_HANT_REGION.test(part)) {
        return supported.includes('zh-Hant') ? 'zh-Hant' : null;
      }
    }
    // bare 'zh' or zh-Hans/zh-CN — no rule yet (no zh-Hans locale shipped).
    return null;
  }
  return null;
}

// Walks navigator.languages in order; first match wins.
export function detectFromNavigator(langs, supported) {
  for (const tag of langs ?? []) {
    const hit = mapTag(tag, supported);
    if (hit) return hit;
  }
  return null;
}
