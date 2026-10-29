import { useSyncExternalStore } from 'react';
import { subscribe } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';
import { t, getLocale } from '../i18n/index.js';

/** Returns t, re-rendering the caller whenever the locale changes. */
export function useT(): typeof t {
  useSyncExternalStore(
    (notify) => subscribe(EVENTS.LOCALE_CHANGED, notify) as () => void,
    getLocale,
    getLocale,
  );
  return t;
}
