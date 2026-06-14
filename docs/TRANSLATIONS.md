# Mixomesh Translations Guide

This is the day-to-day guide for editing UI strings. It is written for
translators and for the developer who adds a new visible string. No build
step is required for routine changes — translations are plain JSON files
imported directly by Vite at boot.

## Where the files live

```
src/i18n/
  index.js                     // runtime: t(), setLocale(), detectLocale()
  locales/en.json              // English (the source of truth)
  locales/ja.json              // 日本語
  locales/zh-Hant.json         // 繁體中文
```

Three JSON files. One key per UI string. That's it.

## How `t()` is used in code

```js
import { t } from '@/i18n';

button.textContent = t('btn.reset');                 // plain
toast(t('toast.exported', { filename: 'cup.3mf' })); // with variables
```

Every translated DOM node should also carry `data-i18n-key="..."` so tests
can assert against keys instead of literal text.

## File format

Flat dotted keys, one string per key:

```json
{
  "btn.reset":          "Reset",
  "toast.exported":     "Exported {filename}",
  "import.error.title": "Couldn't import {filename}"
}
```

### Variable interpolation

Anything inside `{name}` is a placeholder filled by the caller. **Keep the
placeholder spelling exact** — including case. The runtime does not normalize.

```jsonc
// EN
"toast.exported": "Exported {filename}"

// JA — placeholder unchanged, surrounding text translated
"toast.exported": "{filename} を書き出しました"
```

### Plural strings

For counts, use the `{name, plural, ...}` mini-syntax. Powered by
`Intl.PluralRules` per locale — you do NOT need to think about
English-vs-Japanese plural rules; the runtime picks the right arm.

```jsonc
// EN — English has =0, one, other
"_plural.objects":
  "{n, plural, =0{No objects} one{1 object} other{# objects}}"

// JA — Japanese has no plural distinction; just =0 and other
"_plural.objects":
  "{n, plural, =0{オブジェクトなし} other{オブジェクト # 件}}"

// zh-Hant — same as JA: =0 and other
"_plural.objects":
  "{n, plural, =0{無物件} other{# 個物件}}"
```

`#` inside an arm is replaced with the actual number.
Keys starting with `_` are **internal** — never shown to users raw.

## Translator-safety rules

These rules exist because past projects shipped real translation bugs.
Follow them and the strings will translate cleanly to every language.

1. **Never split a sentence across keys.** Do NOT write
   `t('verb') + ' ' + t('subject')` — word order differs across languages,
   and the result becomes ungrammatical. One sentence = one key.
2. **Pass dynamic values as `params`.** Not
   `t('greet') + name`. The placeholder system handles word order per locale.
3. **Keep punctuation inside the translation.** A trailing `:` or `…` in
   the EN string belongs in the JSON, not glued on in code — Japanese and
   Chinese use full-width punctuation (`：` `…`) and want to choose freely.
4. **Use `textContent`, never `innerHTML`,** when putting `t()` output in
   the DOM. Translations are plain text, not HTML, and treating them as
   HTML is an XSS hazard if a translation ever contains `<` or `&`.
5. **Brand names stay un-translated.** `Mixomesh` is `Mixomesh` in every
   locale.

## How to add a new string (3 steps, all in JSON)

1. **Pick a key.** Use a dotted namespace that matches where it appears,
   e.g. `panel.shader.title`, `btn.export`, `toast.saved`. Existing
   namespaces: `app.*`, `workspace.*`, `panel.*`, `section.*`, `btn.*`,
   `setting.*`, `toast.*`, `import.*`, `empty.*`, `hanko.*`, `locale.*`,
   `_plural.*`.
2. **Add it to `en.json` first.** English is the source of truth — the
   fallback chain reads `en.json` whenever a translation is missing, so
   nothing breaks if `ja.json` or `zh-Hant.json` hasn't been updated yet.
3. **Add it to `ja.json` and `zh-Hant.json`.** If you don't speak the
   language, leave the value as an empty string `""` — the validator will
   warn but won't fail, and the UI will fall back to English.

That's it. Reload the dev server, the new string is live. No "compile" step.

## How to change an existing string

Open the appropriate `locales/*.json`, edit the value, save. Vite hot-reload
pushes the change immediately in dev. In production, the JSON ships inside
the JS bundle (Vite imports JSON at build time), so it's part of the next
deploy.

If you change the EN key text but want JA / zh-Hant to update too, edit
those files in the same commit — the validator does NOT flag matching-EN
translations as stale, because it has no way to know.

## How to test locally

```bash
# 1. Start dev server
npm run dev

# 2. Switch language in the UI: Settings → Language → 日本語
#    OR force via URL (overrides detection + persistence for one boot):
#    http://localhost:5173/?locale=ja
#    http://localhost:5173/?locale=zh-Hant
#    http://localhost:5173/?locale=en

# 3. Validate that every code-side t('key') has a matching entry in en.json:
npm run i18n:check
```

The validator passes if every `t('xyz')` call in `src/` has `"xyz"` in
`en.json`. Missing keys in `ja.json` / `zh-Hant.json` print a warning but
don't fail — translators can fill incrementally.

## How to add a new locale (e.g. Simplified Chinese)

1. Create `src/i18n/locales/zh-Hans.json`. Easiest start: copy
   `zh-Hant.json` and convert characters (most tech vocabulary differs
   somewhat — 算繪 → 渲染, 匯入 → 导入, 列印 → 打印 etc.).
2. In `src/i18n/index.js`, add `'zh-Hans'` to the `SUPPORTED` array.
3. Add a detection mapping for the BCP-47 prefix in `detectLocale()`:
   `zh-CN` / `zh-SG` / `zh-Hans*` → `zh-Hans`.
4. Add a switcher entry: append `'zh-Hans'` to the `<select>` options in
   `LocaleSwitcher.js` — the label comes from `locale.zh-Hans` in the
   translation files, so add that key in EVERY existing locale file:
   `"locale.zh-Hans": "简体中文"` in all of them.
5. Add the new key `locale.zh-Hans` to `en.json` and `zh-Hans.json` as well.

Done. Switch the runtime to the new locale via Settings or `?locale=zh-Hans`.

## What "compile" means here (spoiler: nothing)

JSON files are loaded by Vite at build time via
`import locale from './locales/en.json' with { type: 'json' }`. The JSON
becomes part of the JS bundle. No separate translation compile step exists.

The only build-time work is:
- Vite bundles the JSON into the production JS.
- `npm run i18n:check` (CI) verifies key coverage. This is validation, not
  compilation — it never rewrites files.

So the workflow is **edit JSON → save → reload**. Production builds pick up
the latest JSON on the next `npm run build`.

## File path quick reference

| What | Where |
|---|---|
| EN source of truth | `src/i18n/locales/en.json` |
| JA translations | `src/i18n/locales/ja.json` |
| zh-Hant translations | `src/i18n/locales/zh-Hant.json` |
| Runtime API | `src/i18n/index.js` |
| Switcher UI | `src/ui/LocaleSwitcher.js` |
| Detection precedence | `detectLocale()` in `src/i18n/index.js` |
| Persistence key | `localStorage["mx-locale-v1"]` |
| HTML `lang` attribute | set by `applyHtmlLang()` on every `setLocale()` |
| Validator | `npm run i18n:check` |

## When in doubt

Open `en.json`, find the closest existing key, mirror its style.
