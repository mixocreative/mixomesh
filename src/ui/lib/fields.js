// Shared field-wiring helpers for the right-side panels (Scene / Properties /
// Shader / Print / Cursor). Every panel renders its body as an HTML string and
// then wires listeners — these fold the recurring wire shapes that were
// hand-rolled per panel (2026-07-17 maintainability restructure). Panels keep
// hand-rolled wiring for anything that doesn't fit these shapes ('input'-event
// sliders/pickers, multi-listener drop targets, command-dedup fields).

/**
 * Number/text input keyboard convention: Enter commits (blur → the input's
 * 'change' handler fires), Escape reverts via the panel's own callback
 * (usually a full re-render, sometimes a value restore).
 * @param {HTMLInputElement} input
 * @param {(input: HTMLInputElement) => void} [onEscape] omit for Enter-only
 */
export function escEnter(input, onEscape) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { onEscape?.(input); }
  });
}

/**
 * Wire numeric inputs: 'change' → parse → apply(input, value); a non-finite
 * parse calls onInvalid instead (typically re-render to restore the old
 * value). Keyboard handling is opt-in via onEscape — pass it only where the
 * original wiring had Enter/Escape handling.
 * @param {ParentNode} root
 * @param {string} selector
 * @param {(input: HTMLInputElement, value: number) => void} apply
 * @param {{ onInvalid?: (input: HTMLInputElement) => void,
 *           onEscape?: (input: HTMLInputElement) => void,
 *           parse?: (raw: string) => number }} [opts]
 */
export function wireNumbers(root, selector, apply, { onInvalid, onEscape, parse = parseFloat } = {}) {
  root.querySelectorAll(selector).forEach(input => {
    input.addEventListener('change', () => {
      const value = parse(input.value);
      if (!Number.isFinite(value)) { onInvalid?.(input); return; }
      apply(input, value);
    });
    if (onEscape) escEnter(input, onEscape);
  });
}

/**
 * Wire <select> elements: 'change' → apply(sel, sel.value).
 * @param {ParentNode} root
 * @param {string} selector
 * @param {(sel: HTMLSelectElement, value: string) => void} apply
 */
export function wireSelects(root, selector, apply) {
  root.querySelectorAll(selector).forEach(sel => {
    sel.addEventListener('change', () => apply(sel, sel.value));
  });
}

/**
 * Wire boolean controls — aria-pressed toggle BUTTON or checkbox (the
 * checkbox→toggle audit 2026-06-13 keeps both kinds: features are buttons,
 * sub-options are checkboxes). Fires apply(el, next) with the value to APPLY:
 * a button toggles its aria-pressed, a checkbox reports post-change `checked`.
 * The caller decides how to show the new state — reflectToggle in place, or a
 * full re-render when the toggle gates dependent rows.
 * @param {ParentNode} root
 * @param {string} selector
 * @param {(el: HTMLElement, next: boolean) => void} apply
 */
export function wireToggles(root, selector, apply) {
  root.querySelectorAll(selector).forEach(el => {
    const isBtn = el.tagName === 'BUTTON';
    el.addEventListener(isBtn ? 'click' : 'change', () => {
      apply(el, isBtn ? el.getAttribute('aria-pressed') !== 'true' : el.checked);
    });
  });
}

/**
 * Repaint a toggle BUTTON's pressed state in place (checkboxes repaint
 * themselves natively — no-op for them).
 * @param {HTMLElement} el
 * @param {boolean} on
 */
export function reflectToggle(el, on) {
  if (el.tagName !== 'BUTTON') return;
  el.classList.toggle('pp-toggle-on', on);
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
}
