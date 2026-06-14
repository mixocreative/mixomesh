import { SUPPORTED, getLocale, setLocale, t } from '../i18n/index.js';

// Labels shown for each language are ALWAYS rendered in their own script —
// universal i18n best practice (a JA user must read 日本語 in their own letters,
// not "Japanese"). Pulled from translation files so any locale-specific
// override surfaces through the same channel.
function labelFor(code) { return t(`locale.${code}`); }

export function mount(host) {
  if (!host) return;
  host.innerHTML = '';
  const sel = document.createElement('select');
  sel.id = 'locale-switcher';
  sel.setAttribute('aria-label', t('setting.locale'));
  sel.dataset.i18nKey = 'setting.locale';   // tests + reseed on LOCALE_CHANGED
  for (const code of SUPPORTED) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = labelFor(code);
    opt.dataset.locale = code;
    if (code === getLocale()) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => setLocale(sel.value));
  host.appendChild(sel);
}

/** Re-render labels (called from LOCALE_CHANGED listener in AppShell). */
export function refresh(host) {
  if (!host) return;
  const sel = host.querySelector('#locale-switcher');
  if (!sel) return;
  sel.setAttribute('aria-label', t('setting.locale'));
  for (const opt of sel.querySelectorAll('option')) {
    opt.textContent = t(`locale.${opt.dataset.locale}`);
  }
  sel.value = getLocale();
}

export const LocaleSwitcher = { mount, refresh };
