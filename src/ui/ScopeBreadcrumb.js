// Scope breadcrumb (overhaul 3.3) — a chip at the viewport's top-left,
// "Scene › <group> › <subgroup>", visible only while the click-depth scope is
// not the root. Each ancestor crumb jumps out to that level; the last crumb is
// the current scope. Also owns the status-bar hint while inside a group.

import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { Selection } from '../core/Selection.js';
import { StatusBar } from './StatusBar.js';
import { escapeHtml, escapeAttr } from './renderSafe.js';
import { tr } from './lib/tr.js';

let _root = null;

export function init() {
  _root = document.getElementById('scope-breadcrumb');
  if (!_root) return;
  _root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scope]');
    if (!btn) return;
    const id = btn.dataset.scope;
    Selection.setScope(id === '' ? null : id);
  });
  for (const ev of [EVENTS.SCOPE_CHANGED, EVENTS.PROJECT_LOADED, EVENTS.PROJECT_NEW,
    EVENTS.LOCALE_CHANGED, EVENTS.HISTORY_PUSHED, EVENTS.HISTORY_UNDONE, EVENTS.HISTORY_REDONE]) {
    subscribe(ev, _render);
  }
  _render();
}

/** Ancestor chain of a scope, outermost first: [{ id, name }]. */
export function scopeChain(scopeId, groups) {
  const chain = [];
  const seen = new Set();
  let cur = scopeId;
  while (cur != null && groups?.[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift({ id: cur, name: groups[cur].name ?? cur });
    cur = groups[cur].parentId ?? null;
  }
  return chain;
}

function _render() {
  if (!_root) return;
  const scope = Selection.getScope();
  if (scope == null) {
    _root.hidden = true;
    _root.textContent = '';
    StatusBar.setHint('');   // back to the default hint
    return;
  }
  const chain = scopeChain(scope, getState().scene.groups);
  const rootLabel = tr('scope.root', 'Scene');
  const sep = '<span class="sb-crumb-sep" aria-hidden="true">›</span>';
  const crumbs = [`<button type="button" class="sb-crumb" data-scope="">${escapeHtml(rootLabel)}</button>`];
  chain.forEach((c, i) => {
    const last = i === chain.length - 1;
    crumbs.push(last
      ? `<span class="sb-crumb sb-crumb-current" aria-current="true">${escapeHtml(c.name)}</span>`
      : `<button type="button" class="sb-crumb" data-scope="${escapeAttr(c.id)}">${escapeHtml(c.name)}</button>`);
  });
  const hint = tr('scope.escHint', 'Esc to exit group');
  _root.hidden = false;
  _root.setAttribute('aria-label', tr('scope.aria', 'Group path'));
  _root.innerHTML = `<span class="sb-crumbs">${crumbs.join(sep)}</span><span class="sb-esc">${escapeHtml(hint)}</span>`;
  StatusBar.setHint(tr('scope.statusHint', 'Inside a group · Click to select · Esc to exit · Double-click a group to enter'));
}

export const ScopeBreadcrumb = { init, scopeChain };
