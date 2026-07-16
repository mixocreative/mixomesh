// Shared collapsible-section controller. Unifies the two implementations that
// diverged across panels (2026-07-17 maintainability restructure): ScenePanel's
// per-user localStorage object vs the Properties/Shader session Sets.

/**
 * Create a collapse controller for a panel's sections.
 * storageKey null → session-only state (resets on reload); a string key →
 * per-user localStorage persistence (NEVER in .mixo — same per-user rule as
 * workspaces).
 * @param {{ storageKey?: string | null, defaults?: Record<string, boolean> }} [opts]
 */
export function createCollapseController({ storageKey = null, defaults = {} } = {}) {
  const load = () => {
    if (!storageKey) return { ...defaults };
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      return { ...defaults, ...(raw && typeof raw === 'object' ? raw : {}) };
    } catch {
      return { ...defaults };
    }
  };
  const state = load();
  const save = () => {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* private mode */ }
  };

  return {
    /** @param {string} key */
    isCollapsed(key) { return !!state[key]; },

    /** Flip a section; returns the new collapsed state. @param {string} key */
    toggle(key) {
      state[key] = !state[key];
      save();
      return state[key];
    },

    /**
     * Apply the stored collapsed state to freshly rendered sections and wire
     * their `:scope > header` click to toggle. Clicks on header-internal
     * buttons (↺ reset, + new, ↧ copy) never toggle.
     * @param {ParentNode} rootEl
     * @param {{ sectionSelector: string, collapsedClass: string, datasetKey?: string }} opts
     */
    wire(rootEl, { sectionSelector, collapsedClass, datasetKey = 'section' }) {
      rootEl.querySelectorAll(sectionSelector).forEach(sec => {
        const key = sec.dataset[datasetKey];
        if (this.isCollapsed(key)) sec.classList.add(collapsedClass);
        sec.querySelector(':scope > header')?.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          sec.classList.toggle(collapsedClass, this.toggle(key));
        });
      });
    },
  };
}
