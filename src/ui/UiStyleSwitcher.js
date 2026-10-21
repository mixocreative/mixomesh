import { t } from '../i18n/index.js';
import { UI_STYLES, getStyle, setStyle } from '../core/UiStyle.js';

// Header picker for the interface style, beside the language picker and
// styled like it (#locale-switcher, #ui-style-switcher share one rule).
export function mount(host) {
  if (!host) return;
  host.innerHTML = '';
  const sel = document.createElement('select');
  sel.id = 'ui-style-switcher';
  sel.setAttribute('aria-label', t('setting.uiStyle'));
  sel.dataset.i18nKey = 'setting.uiStyle';
  for (const style of UI_STYLES) {
    const opt = document.createElement('option');
    opt.value = style;
    opt.textContent = t(`uiStyle.${style}`);
    opt.dataset.uiStyle = style;
    sel.appendChild(opt);
  }
  sel.value = getStyle();
  sel.addEventListener('change', () => setStyle(sel.value));
  host.appendChild(sel);
}

/** Re-render labels and selection (LOCALE_CHANGED / UI_STYLE_CHANGED). */
export function refresh(host) {
  const sel = host?.querySelector('#ui-style-switcher');
  if (!sel) return;
  sel.setAttribute('aria-label', t('setting.uiStyle'));
  for (const opt of sel.querySelectorAll('option')) {
    opt.textContent = t(`uiStyle.${opt.dataset.uiStyle}`);
  }
  sel.value = getStyle();
}

export const UiStyleSwitcher = { mount, refresh };
