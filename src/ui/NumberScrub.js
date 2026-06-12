// Wheel-scrub for number inputs (field request): hovering any
// <input type="number"> and scrolling adjusts the value by its step
// (default 0.1) instead of scrolling the parent panel — the DCC-standard
// behaviour (Blender/Fusion). Shift = 10× coarser, Alt = 10× finer.
// One delegated listener, panels never re-wire anything.

const DEFAULT_STEP = 0.1;

export function init() {
  document.addEventListener('wheel', _onWheel, { passive: false, capture: true });
}

function _onWheel(e) {
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'number') return;
  if (input.disabled || input.readOnly) return;

  // The input owns the wheel — the panel must not scroll underneath.
  e.preventDefault();
  e.stopPropagation();

  let step = parseFloat(input.step);
  if (!Number.isFinite(step) || step <= 0) step = DEFAULT_STEP;
  if (e.shiftKey) step *= 10;
  if (e.altKey)   step /= 10;

  const dir = e.deltaY < 0 ? 1 : -1;
  const cur = parseFloat(input.value);
  let next = (Number.isFinite(cur) ? cur : 0) + dir * step;

  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);

  // Snap to the step's decimal precision so 0.1 increments don't drift into
  // 0.30000000000000004 territory.
  const decimals = (String(step).split('.')[1] ?? '').length;
  input.value = next.toFixed(Math.min(decimals + 1, 6)).replace(/\.?0+$/, '');
  if (input.value === '' || input.value === '-') input.value = '0';

  // Route through the panels' existing commit handlers.
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export const NumberScrub = { init };
