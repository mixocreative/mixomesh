// The puck's controls on this page, and nothing about radios or arithmetic.
//
// One surface, in two places: a chip with its menu inside the viewport toolbar, and the Line up
// card over the middle of the viewport. Everything it draws comes from `PuckLink.snapshot()` and
// every click goes back to `PuckLink` — this module owns no state beyond whether its own menu is
// open, which is `README.md`'s rule for this folder and the reason it can be re-rendered from
// scratch on every change without losing anything.
//
// **The chip lives in the toolbar rather than in viewport chrome of its own, and that is not a
// cosmetic choice.** The first version put it at the viewport's top-right, where the Arrange
// drawer slides out over it — a control that disappears under another panel is a control that is
// missing exactly when it is wanted. The toolbar is also where the camera already is (follow mode,
// pivot, gizmo space), and the puck IS a camera control. `ViewportToolbar` renders `buttonHtml()`
// and calls `wire()`, the same arrangement `TransformSheet` uses for its own button.
//
// **The workflow is `mixo-ar`'s, deliberately, down to the glyphs.** Somebody who has turned a
// model on the product page should not have to learn a second set of motions to turn the camera
// here: one chip that shows the link with the menu shut, Connect, Line up, a card that asks for a
// pose and takes a double-tap on the puck to confirm it. What differs is only what moves — there
// the model, here the camera (`core/puck/orbit.ts` has the geometry, `PuckLink` the consequences).

import { EVENTS } from '../core/events.js';
import { dispatch, subscribe } from '../core/StateManager.js';
import { PuckLink } from '../core/puck/PuckLink.js';
import { icon } from '../core/Icons.js';
import { escapeAttr, escapeHtml } from './renderSafe.js';
import { t } from '../i18n/index.js';
import { safeAsync } from './Status.js';

let _card = null;
let _host = null;
let _open = false;

/**
 * Start the link and take charge of the Line up card. The chip itself is the toolbar's to draw.
 *
 * Called BEFORE `ViewportToolbar.init()`, so the toolbar's first render already knows whether
 * there is a puck to offer at all.
 */
export function init() {
  _card = document.getElementById('puck-align-card');
  _host = document.getElementById('puck-menu-host');
  if (!_card || !_host) return;

  PuckLink.init();
  subscribe(EVENTS.PUCK_CHANGED, _draw);
  subscribe(EVENTS.LOCALE_CHANGED, _draw);

  /*
   * A resize SHUTS the menu rather than moving it. The menu is positioned once, from where the
   * chip was when it opened, and a layout that moves under it would leave it pointing at nothing.
   * Closing is the honest answer to a question nobody is mid-way through answering.
   */
  window.addEventListener('resize', () => {
    if (!_open) return;
    _open = false;
    _draw();
  });

  // A click anywhere else shuts the menu. Capture phase, so the test is made against the element
  // that was actually hit rather than against whatever a re-render has put there since.
  document.addEventListener('pointerdown', (e) => {
    if (!_open || e.target?.closest?.('[data-ui="puck-chip"], [data-ui="puck-menu"]')) return;
    _open = false;
    _redraw();
  }, { capture: true });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Escape shuts the menu, and closes the card the same way its own Close button does: both are
    // "I am not doing this now", and neither drops the link.
    if (_open) {
      _open = false;
      _redraw();
    } else if (PuckLink.snapshot().aligning) {
      PuckLink.cancelAlign();
    }
  });

  _draw();
}

/** Everything this module owns outright: the menu and the card. The chip is the toolbar's. */
function _draw() {
  const puck = PuckLink.snapshot();

  _renderMenu(puck);
  _renderCard(puck);
}

/** Ask the toolbar to draw the chip again, which also redraws the menu and the card. */
function _redraw() {
  dispatch(EVENTS.PUCK_CHANGED, {});
}

/** The state line, which is also the one place the battery is drawn. */
function _stateLine(puck) {
  if (puck.link === 'connected' && puck.noSensor) {
    // §5: the sensor did not answer. The link is fine and the camera will not move; say which.
    return t('puck.noSensor');
  }

  if (puck.link !== 'connected') {
    const line = t(`puck.${puck.link}`);

    return puck.link === 'lost' ? `${line} ${t('puck.lostReason')}` : line;
  }

  /*
   * NO CELL FITTED IS NOT NOUGHT PER CENT, and that distinction is the whole reason the puck's
   * firmware carries the Battery Level Status characteristic. A bench board runs from USB with
   * empty battery pads, and a percentage — any percentage — would be a confident lie about
   * hardware that is absent.
   */
  if (puck.batteryStatus?.present === false) {
    return `${t('puck.connected')} · ${t('puck.noCell')}`;
  }

  if (puck.battery !== null) {
    return `${t('puck.connected')} · ${puck.battery}%`;
  }

  // PROTOCOL.md §4: no plausible reading yet is reported as unknown, never as 0%.
  return `${t('puck.connected')} · ${t('puck.batteryUnknown')}`;
}

/**
 * The chip and its menu, for the viewport toolbar to place.
 *
 * Empty until `isAvailable()` has said there is a radio to use (decision 0010): a browser without
 * Web Bluetooth gets no control at all rather than one that cannot work. That answer arrives
 * asynchronously, which is why `PUCK_CHANGED` fires when it does — the toolbar redraws on it.
 *
 * @returns {string} markup, or '' when there is no puck to offer
 */
export function buttonHtml() {
  const puck = PuckLink.snapshot();

  if (!puck.offered) return '';

  const connected = puck.link === 'connected';
  const label = t('puck.label');

  return `
    <span class="puck-chip" data-ui="puck-chip">
      <button class="vt-btn ${connected ? 'vt-on' : ''}" data-ui="puck-toggle"
              data-act="menu" aria-haspopup="menu" aria-expanded="${_open ? 'true' : 'false'}"
              title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">
        ${icon('Puck', { width: 14, height: 14 })}
        <i class="puck-dot" data-link="${escapeAttr(puck.link)}" aria-hidden="true"></i>
      </button>
    </span>
  `;
}

/**
 * The menu, drawn into its own host over the viewport and positioned under the chip.
 *
 * **It cannot be a child of the chip, and that is not a style choice.** `#viewport-toolbar` is
 * `overflow: auto` below a certain width so it can scroll on a narrow window, and an overflow
 * ancestor clips an absolutely positioned descendant that leaves its box — the menu rendered,
 * reported a correct rectangle, and was invisible and unclickable, which is the worst shape a bug
 * can take. `position: fixed` would not have saved it either: the toolbar carries a `transform`
 * for its centring, which makes it the containing block for fixed descendants too.
 *
 * So the host sits in the viewport beside the Line up card, and the position is copied from the
 * chip each time the menu opens. It is right-aligned to the chip and sits just above it.
 */
function _renderMenu(puck) {
  if (!_host) return;

  const chip = document.querySelector('[data-ui="puck-toggle"]');

  _host.hidden = !(_open && puck.offered && chip);

  if (_host.hidden) {
    _host.innerHTML = '';

    return;
  }

  const connected = puck.link === 'connected';

  /*
   * CHARGING IS DRAWN ONLY WHEN THE PUCK SAYS SO, never inferred.
   *
   * `charging` is three-valued: true, false, and absent for "the puck did not say" — which is
   * what firmware without the status characteristic reports. Drawing the bolt for absent would be
   * inventing a fact; leaving it out is the honest rendering of not knowing.
   */
  const charging = connected && puck.batteryStatus?.charging === true;
  const label = t('puck.label');

  _host.innerHTML = `
    <div class="puck-menu" data-ui="puck-menu" role="menu" aria-label="${escapeAttr(label)}">
      <p class="puck-state" data-ui="puck-state" role="status">
        ${escapeHtml(_stateLine(puck))}
        ${charging ? `<i class="puck-charge" aria-hidden="true">${icon('Zap', { width: 12, height: 12 })}</i>` : ''}
      </p>
      <button class="puck-item" role="menuitem" data-act="connect">
        ${icon('Bluetooth', { width: 14, height: 14 })}
        <span>${escapeHtml(t(connected ? 'puck.disconnect' : 'puck.connect'))}</span>
      </button>
      ${connected ? `
        <button class="puck-item" role="menuitem" data-act="align">
          ${icon('LocateFixed', { width: 14, height: 14 })}
          <span>${escapeHtml(t('puck.align'))}</span>
        </button>` : ''}
    </div>
  `;

  const chipBox = chip.getBoundingClientRect();
  const hostBox = _host.offsetParent?.getBoundingClientRect();

  if (hostBox) {
    _host.style.right = `${Math.round(hostBox.right - chipBox.right)}px`;
    _host.style.bottom = `${Math.round(hostBox.bottom - chipBox.top + 6)}px`;
  }

  for (const btn of _host.querySelectorAll('[data-act]')) {
    btn.addEventListener('click', () => _act(btn.dataset.act));
  }
}

/** Attach the chip's handler, and redraw the menu under wherever the toolbar has just put it. */
export function wire(root) {
  for (const btn of root.querySelectorAll('[data-ui="puck-chip"] [data-act]')) {
    btn.addEventListener('click', () => _act(btn.dataset.act));
  }

  _draw();
}

/**
 * The Line up card.
 *
 * The drawing is the cube as the person should end up SEEING it, front face square on — not the
 * puck with an arrow on it. The thing being matched is on the screen, not in the hand, and an
 * earlier version of this card in `mixo-ar` had that the wrong way round.
 *
 * It is not a modal. A dialog that has to be dismissed before the viewport can be touched would
 * block the one thing the person may need to do, which is look at what they are lining up to.
 */
function _renderCard(puck) {
  if (!_card) return;

  _card.hidden = !puck.aligning;

  if (!puck.aligning) {
    _card.innerHTML = '';

    return;
  }

  _card.innerHTML = `
    <svg class="puck-align-figure" viewBox="0 0 120 70" aria-hidden="true" focusable="false">
      <path d="M12 64h96" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.45"/>
      <ellipse cx="60" cy="65.5" rx="30" ry="2.4" fill="currentColor" opacity="0.12"/>
      <path d="M36 16 48 6h48L84 16Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" opacity="0.4"/>
      <path d="M84 16 96 6v48L84 64Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" opacity="0.4"/>
      <rect x="36" y="16" width="48" height="48" rx="1.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>
      <text x="60" y="41" text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="700"
            fill="currentColor">${escapeHtml(t('puck.cubeFront'))}</text>
    </svg>
    <p data-ui="puck-align-hint">${escapeHtml(t(puck.hint))}</p>
    <div class="puck-align-actions">
      <button class="btn btn-primary" data-act="finish" ${puck.canFinish ? '' : 'disabled'}>${escapeHtml(t('puck.alignNow'))}</button>
      <button class="btn" data-act="cancel">${escapeHtml(t('btn.close'))}</button>
    </div>
  `;

  for (const btn of _card.querySelectorAll('[data-act]')) {
    btn.addEventListener('click', () => _act(btn.dataset.act));
  }
}

function _act(name) {
  const puck = PuckLink.snapshot();

  if (name === 'menu') {
    _open = !_open;
    _redraw();

    return;
  }

  if (name === 'connect') {
    _open = false;

    if (puck.link === 'connected') {
      // Sleeping the puck first is a write that may fail, so it goes through the toast policy
      // like any other async UI entry point.
      safeAsync(() => PuckLink.disconnect());
    } else {
      /*
       * NOT awaited, and this handler is NOT async. An `await` before `connect()` would spend the
       * user gesture that the browser's device chooser needs, and the symptom is a Connect button
       * that silently does nothing. `PuckLink.connect` says the same thing from the other side.
       */
      PuckLink.connect();
    }

    _redraw();

    return;
  }

  if (name === 'align') {
    _open = false;
    PuckLink.beginAlign();

    return;
  }

  // 0010 keeps a button as Line up's fallback: a hand that never quite settles, or a desk on a
  // bus, must still be able to finish. It takes whatever has been seen rather than refusing.
  if (name === 'finish') PuckLink.finishAlign();
  if (name === 'cancel') PuckLink.cancelAlign();
}

export const PuckPanel = { init, buttonHtml, wire };
