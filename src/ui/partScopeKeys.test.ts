import { describe, expect, it } from 'vitest';
import en from '../i18n/locales/en.json';
import ja from '../i18n/locales/ja.json';
import zhHant from '../i18n/locales/zh-Hant.json';

/*
 * The separator mode's strings go through `tr(key, fallback)`, which shows the ENGLISH fallback when
 * a key is missing. That is deliberate — a missing key must not print a key — but it means a
 * forgotten translation looks like a finished UI, and `i18n:check` scans for `t()` literals, not for
 * these. So the keys are listed here and asserted in every locale.
 *
 * Strings only, on purpose: importing `PartScopeMode` to check its dimmed-panel list would drag the
 * whole app graph (Babylon, `location`) into a node test, and the dimming is already proven end to
 * end by `browser-support-mode-smoke`, which reads the COMPUTED opacity of each panel -- a better
 * guard than a regex over selector syntax.
 */
const KEYS = [
  'scope.escHintObject', 'scope.statusHintObject',
  'partScope.title', 'partScope.pickSome', 'partScope.pickedAll', 'partScope.ready',
  'partScope.separate', 'partScope.done',
  'history.separateSelection',
] as const;

const DICTS = { en, ja, 'zh-Hant': zhHant } as Record<string, Record<string, string>>;

describe('the separator mode strings', () => {
  it('exist in every locale, so none can fall back to English unnoticed', () => {
    for (const [name, dictionary] of Object.entries(DICTS)) {
      for (const key of KEYS) expect(dictionary[key], `${name} is missing ${key}`).toBeTruthy();
    }
  });

  it('keep every placeholder the English has', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [name, dictionary] of Object.entries(DICTS)) {
      for (const key of KEYS) {
        expect(placeholders(dictionary[key]!), `${name} ${key}`).toEqual(placeholders(en[key as keyof typeof en] as string));
      }
    }
  });

  it('is actually translated, not the English copied into a locale', () => {
    // A copied English string is the other way this ships broken: the key is present, the check
    // above passes, and the operator reads English in a Japanese UI.
    for (const [name, dictionary] of Object.entries(DICTS)) {
      if (name === 'en') continue;
      for (const key of KEYS) {
        expect(dictionary[key], `${name} ${key} is still English`).not.toBe(en[key as keyof typeof en]);
      }
    }
  });
});
