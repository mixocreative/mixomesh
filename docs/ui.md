# UI guide

For developers who add or change UI in mixomesh. Read it before you touch `src/react/`,
`src/kit/` or `src/panels/`. The rules are D13–D17 in
`docs/plans/2026-10-29-react-wasm-supports.md`; progress is in `docs/handoff/react-wasm-supports.md`.

Most panels are still plain DOM in `src/ui/*.js` and move to React over time (P7). New UI is
React and uses the kit.

---

## 1. The three layers

```
React panels       src/panels/*, src/react/*, src/kit/     draw, read state, call commands
      | useCommand (writes)           | useStore (reads, by event name)
Logic + state      src/core/commands/*, HistoryManager.js,  change the document, one undo entry each
                   StateManager.js, src/core/events.js
      |
Babylon scene      src/core/SceneManager.js, src/core/scene/  meshes, cameras, gizmo, materials
```

What each layer may do, in plain words:

- **React panels** draw the UI and turn clicks into commands. A panel never imports Babylon
  and never keeps a mesh, texture or Babylon object in state or props (D13).
- **Logic and state** own the document. Every change to the project goes through a command,
  so it can be undone. `createDispatcher` (`src/core/api/ApiDispatcher.js`) is the automation
  API for scripts, not the UI path. Per-user view settings are the one exception: the stats
  HUD toggle writes with `setState(..., { silent: true })` and `SettingsStore`, and is not
  undoable.
- **Babylon scene** draws. Only the scene and its helpers touch engine objects.

Per-frame values never go through React (D14). Gizmo deltas, pointer position, brush rings
and the camera are drawn by Babylon. React learns a value only when it is committed.

Panels subscribe only to the events they show (D16). There is no generic "state changed"
event; the named events are in `src/core/events.js`.

---

## 2. Add a panel

Reference: the numeric Transform sheet, `src/panels/TransformSheet/TransformSheet.tsx`. Its
host is created in `init()`:

```tsx
export function init(host: HTMLElement | null) {
  if (_unmount || !host) return;
  const root = document.createElement('div');
  root.id = 'transform-sheet-root';
  root.className = 'mx-kit';
  root.style.display = 'contents';
  host.appendChild(root);
  _unmount = mountPanel('transform-sheet-root', <SheetView />);
}
```

1. **Entry.** Put the panel in `src/panels/<Name>/<Name>.tsx` and export `init()` and
   `unmount()`. Keep pure logic and its tests beside it (`sheetPlan.ts`, `buildSheetCommand.ts`).
2. **Root.** Use a static element from `index.html` (`rp-properties-body`, `status-bar`,
   `modal-root`, `toast-container`, ...) or create one in `init()`. Give it class `mx-kit`:
   kit CSS is scoped under `.mx-kit`, so without the class no kit style applies.
   `display: contents` keeps the wrapper from adding a layout box.
3. **Mount.** `mountPanel(rootId, element)` (from `src/react/index.ts`) renders into that
   element. It is idempotent per root, wraps the panel in an error boundary and the shared
   locale provider, and returns an unmount function.
4. **Boot.** Call `init()` where the others are called: `StatsHud.init()` in
   `src/app/main.ts`, `TransformSheet.init(...)` in `src/ui/ViewportToolbar.js`.

### Reading state: `useStore(events, selector, isEqual?)`

It re-renders only when one of the named events fires and the selected value changes. The
only use in the repo is the test in `src/react/react.test.tsx`:

```tsx
function S() { s.n++; return <p>{useStore(['test:s'], () => v)}</p>; }
```

Subscribe to the events whose handler changes the value. The StatsHud re-reads its flag on
`EVENTS.PROJECT_LOADED`, `EVENTS.PROJECT_NEW` and `EVENTS.SETTINGS_RESET`
(`src/panels/StatsHud/StatsHud.tsx`). Use `EVENTS` names, not string literals. If the selector
returns a new object or array, pass an `isEqual` function or the panel re-renders on every event.

### Writing state: `useCommand()`

It returns `run(command)` (one undo entry) and `batch(label, fn)` (several commands, one undo
entry). The Transform sheet builds one command on Apply:

```ts
// src/panels/TransformSheet/buildSheetCommand.ts
return { status: 'applied', command: new TransformCommand(prev, next) };
// src/panels/TransformSheet/TransformSheet.tsx
run(r.command);   // one TransformCommand = one undo step
```

New commands go in `src/core/commands/*.js` and run through `HistoryManager.push`.

### Strings: `useT()`

```tsx
const tt = useT();   // re-renders the component when the locale changes
<Button variant="icon" aria-label={tt('stats.hide')} title={tt('stats.hide')}>×</Button>
```

Legacy code uses `t()` from `src/i18n/index.js` or `tr(key, fallback)` from `src/ui/lib/tr.js`.
New React code uses `useT`.

---

## 3. Add a control to the kit (D17)

If the control is not in `src/kit/`, add it there first, then use it.

1. **Component.** Create `src/kit/<Name>.tsx`, export the component and its props type, and
   add the export to `src/kit/index.ts`. A component that wraps a DOM element uses
   `forwardRef`, as `Toggle` does (`src/kit/Toggle.tsx`). Use `Toggle` for a feature, mode or
   visibility switch and `Check` for a sub-option.
2. **Test.** Add `src/kit/<Name>.test.tsx` (vitest, jsdom, `@testing-library/react`). See
   `src/kit/Toggle.test.tsx`: role, `aria-*` state, callback, disabled.
3. **CSS.** Component rules go in `src/kit/styles/kit.css`, under `.mx-kit`, using tokens only.
   Never edit `src/kit/styles/tokens.css` or `base.css`: they are unchanged copies of the
   mixo-app-style skill (`S:\ai\skills\mixo-app-style`). To update them, copy again from the
   skill, then run `node src/kit/styles/scope.mjs`, which regenerates `kit.scoped.css`. Do not
   edit that file by hand. `src/kit/styles/scope.test.ts` fails if the generated file is stale
   or any selector is not under `.mx-kit`.
4. **Gallery.** Add a `<Comp>` block with its states and props table to
   `src/kit/gallery/main.tsx`. `kit.html` loads that file; check it at `/kit.html` (section 6).

---

## 4. Live edits versus commits

`NumberField` (`src/kit/NumberField.tsx`) is the reference. It has two callbacks:

- `onInput(value)` fires while the user is still acting (scrubbing a label). It runs on every
  pointer move, so keep it cheap. Push the value to the scene here if it must show live. No
  undo entry.
- `onCommit(value)` fires once, when the gesture ends (scrub release, Enter, blur, arrow step).
  It is the only place a command runs.

From the gallery (`src/kit/gallery/main.tsx`):

```tsx
<NumberField label="Width" unit="mm" min={0} max={300} step={0.5} value={w}
  onInput={setLive}
  onCommit={(v) => { setW(v); setLive(v); setCommits((c) => c + 1); }} />
```

- One drag is one undo step, created in `onCommit`, never in `onInput`.
- `NumberField` calls `onCommit` only when a typed or scrubbed value changed.
- Expensive rebuilds (support generation) are debounced, run in a worker, keep only the latest
  job per object and carry a `revision` (D15). This is planned for P3, not yet built.

---

## 5. Strings (D8)

- Every new string needs a key in **all three** files: `src/i18n/locales/en.json`, `ja.json`
  and `zh-Hant.json`, with the same parameters (`{n}`, `{total}`).
- Use `tt('key')` in React or `t('key', { n })` in plain code.
- Write the ja and zh-Hant text with the Gemini skill (`~/.claude/skills/gemini/SKILL.md`):
  `python ~/.config/gemini/gemini_chat.py "prompt"`. zh-Hant uses Taiwan wording. The key is in
  `~/.config/gemini/api_key`; never print or commit it.
- `npm run i18n:check` (`scripts/i18n-check.mjs`) fails on a missing English key and on
  hard-coded visible text. Missing ja or zh-Hant keys only warn, so check those files yourself.

---

## 6. Checking your work

| Check | Command |
|---|---|
| Tests | `npm test`: `node --test` on `tests/*.test.mjs`, then vitest on `src/**/*.test.ts` and `*.test.tsx` |
| Lint | `npm run lint` |
| Types | `npm run typecheck` |
| Strings | `npm run i18n:check` |
| Kit gallery | `npx vite`, then open `http://127.0.0.1:5173/kit.html` |
| The app | `npx vite`, then open `http://127.0.0.1:5173/`; browser smoke: `npm run test:browser` |

**Evidence (D5).** "It works" needs a screenshot or a probe, not only green tests.
`node scripts/ui-screenshot.mjs [outDir]` boots the app in headless Chrome, loads the textured
fixture, selects it and saves PNGs. `OPEN_SHEET=1` also opens the Transform sheet;
`SIZES="1366x1024,390x844"` captures several widths; `PROBE=1` prints probe values. Measure
at rest, after the import has settled.

**Performance gate.** Fixtures come from `scripts/heavy-mesh/generate.mjs`
(`node scripts/heavy-mesh/generate.mjs --sizes 1 --3mf 0 --ascii 0 --glb 2`). Then:

```
node scripts/heavy-mesh/measure.mjs --files pillow-1M.stl,pillow-5M.stl,pillow-textured-2M.glb --runs 5
```

`--runs 5` repeats each fixture and prints the median. Read:

- `cpuFrameMs` orbit and gizmo lines. The fields are `orbitCpuMean`/`gizmoCpuMean` (and p95).
  The **mean** is the gate.
- `reactCommitMs` and `reactCommits` during the gizmo drag. Panels unrelated to the gizmo must
  not commit during a drag.

**Gate rule (P0.6 done-when):** on each fixture, the median `cpuFrameMs` mean must be at most
`baseline + max(0.1 ms, 10%)`. The baseline is the P0.3b row in
`docs/handoff/react-wasm-supports.md`. Record the before and after numbers, not just "passes".
