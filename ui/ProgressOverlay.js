// Full-screen blocking progress overlay. While an export runs the UI is
// darkened and pointer-locked so the user can't mutate the scene mid-pipeline.

let _root = null;
let _bar = null;
let _pct = null;
let _msg = null;
let _title = null;

function _ensure() {
  if (_root) return;
  _root = document.createElement('div');
  _root.className = 'progress-overlay hidden';
  _root.innerHTML = `
    <div class="po-panel" role="status" aria-live="polite">
      <div class="po-title">Working…</div>
      <div class="po-track"><div class="po-bar"></div></div>
      <div class="po-row"><span class="po-pct">0%</span><span class="po-msg"></span></div>
    </div>`;
  // Swallow every interaction while visible (capture phase).
  for (const ev of ['pointerdown', 'pointerup', 'click', 'wheel', 'keydown', 'contextmenu']) {
    _root.addEventListener(ev, (e) => { e.stopPropagation(); e.preventDefault(); }, true);
  }
  document.body.appendChild(_root);
  _bar   = _root.querySelector('.po-bar');
  _pct   = _root.querySelector('.po-pct');
  _msg   = _root.querySelector('.po-msg');
  _title = _root.querySelector('.po-title');
}

/** Show the overlay. @param {string} title */
export function show(title = 'Working…') {
  _ensure();
  _title.textContent = title;
  update(0, 'Starting…');
  _root.classList.remove('hidden');
}

/**
 * @param {number} frac 0..1
 * @param {string} [message]
 */
export function update(frac, message) {
  if (!_root) return;
  const p = Math.max(0, Math.min(100, Math.round(frac * 100)));
  _bar.style.width = `${p}%`;
  _pct.textContent = `${p}%`;
  if (message != null) _msg.textContent = message;
}

export function hide() {
  if (_root) _root.classList.add('hidden');
}

export const ProgressOverlay = { show, update, hide };
