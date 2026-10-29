import { useCallback, useRef, useSyncExternalStore } from 'react';
import { subscribe, getState } from '../core/StateManager.js';

/**
 * Subscribe a component to the named StateManager events and read a slice of
 * state. The snapshot is cached by isEqual, so selectors returning derived
 * objects/arrays do not loop or re-render while the value is equivalent.
 */
export function useStore<T>(
  events: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selector: (state: any) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector);
  const equalRef = useRef(isEqual);
  selectorRef.current = selector;
  equalRef.current = isEqual;
  const cache = useRef<{ value: T } | null>(null);

  const key = events.join('|');
  const sub = useCallback((notify: () => void) => {
    const offs: Array<() => void> = key ? key.split('|').map((e) => subscribe(e, notify) as () => void) : [];
    return () => offs.forEach((off) => off());
  }, [key]);

  const getSnapshot = () => {
    const next = selectorRef.current(getState());
    if (cache.current && equalRef.current(cache.current.value, next)) return cache.current.value;
    cache.current = { value: next };
    return next;
  };
  return useSyncExternalStore(sub, getSnapshot, getSnapshot);
}
