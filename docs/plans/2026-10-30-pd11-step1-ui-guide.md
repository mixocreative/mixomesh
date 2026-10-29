> **OWNER ANSWERS 2026-10-30 (binding; override anything below):**
> 1. Keep the label **Back** (no rename to Prev).
> 2. **Exit is a text button labelled Exit (not an arrow)**, at the top right of the nav bar, shown **always** (every step).
> 3. **Remove the Hide models button everywhere** (not only Step 1).
> 4. In Free transform mode, **Auto orient RESTORES the stored automatic pose and exits Free transform mode** (no re-run of the orientation worker / tilt scan).
> 5. **Step 1 shows the gizmo ONLY in Free transform mode** (never in normal Step 1).
# PD.11 build guide: mixoDental Step 1 (orientation) UI

Spec (owner, 2026-10-30): `docs/plans/2026-10-29-react-wasm-supports.md`, item PD.11, plus D26 (modular: every new rule or
widget in its own named module, one responsibility, doc comment, own test; App.tsx is 1346 lines and must only gain
a few wiring lines). Designer-friendly: icons are SVG files in `src/ui/assets/icons/` drawn through `src/ui/Icon.tsx`
(`<Icon name="exit-arrow" />`); styles live in `src/styles.css` (one file, tokens in `:root`), no `style={...}` and no hex
colours in TSX. The only allowed inline value is a data-driven geometry number passed as a CSS custom property or an SVG
attribute (for example a dial arc `d`).

All paths are in `S:\ai\mixodental`. Spec text under test:

> viewport shows only model + debug layers (no supports, no raft, adding supports disabled); bottom-right view buttons
> hidden in Step 1; Exit = arrow icon top right of the nav bar; language = one dropdown; no Hide-models button in the nav
> bar; edit bar on the right, as narrow as possible. Rows top to bottom: Auto orient (primary, new orientation icon),
> tilt range (stable band), a dial (tilt live; full scanned range, stable band highlighted, starts at the chosen angle),
> Free transform, then Prev | Next as one full-width row at the bottom. Big tilt number with ° top left under the Step 1
> badge. Free transform: confirm prompt ("you will orient it yourself") then rotation-only gizmo; edit bar shows only
> Auto orient + Prev|Next; big number hidden; Auto orient returns to the normal layout and re-runs auto orientation.

## Global rules (every step)

1. Commit only when `npm test` exits 0 (a lone `Timeout calling onTaskUpdate` worker error: rerun once), `npx tsc --noEmit`
   is clean and `npm run build` succeeds. One commit per step, message `feat(ui): PD.11 S<n> <title>`; stage only that
   step's files.
2. Never edit `vendor/`, `scripts/walk.mjs`, or untracked owner files (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`,
   `tools/EGM.md`, `graphify-out/`). `git status` before commit: `scripts/walk.mjs` is already modified by the owner, do
   not stage it.
3. Owner's dev server runs on port 5180: leave it alone. Screenshots: write a temporary Playwright script in `.tmp/`
   (delete it after use, never commit it), start `npx vite --port 5181 --strictPort` in the background, copy the launch
   pattern from `scripts/walk.mjs` (`chromium` from `playwright-core`, `executablePath` of the newest `chromium-*` in the
   Playwright cache; the file input is `input[aria-label="Choose aligner file"]`; fixture: any `dentalwork/fixtures/case-aligner/*.stl`;
   start screen: pick the Reference aligner card first). Take one screenshot at 1440x900 and one at 900x700. Stop ONLY the vite
   PID you started (note its PID; never kill by image name).
4. Every new user-visible string goes through `t('English key')`. English text is the key. Add `ja` and `zh-Hant` entries in
   `src/locales/ja.ts` and `src/locales/zh-Hant.ts` (same key). Translate with
   `python C:\Users\DCT\.config\gemini\gemini_chat.py "Translate this UI label to <Japanese|Taiwan Traditional Chinese>, UI wording, short: <key>"`
   (never print the API key). `src/i18n.test.ts` fails if a literal in a component has no translation, so run it.
5. New component = new file, named export, doc comment (inputs, units), its own `*.test.tsx` using
   `renderToStaticMarkup` like `src/components/DentalBar.test.tsx`.
6. Do not touch: `DebugSection.tsx` (keep as is), `useDebugLayers.ts`, the Step 2 and Step 3 branches of `DentalBar.tsx`,
   `dentalFlow` pose logic except where a step says so.

## Facts found in the code (read before starting)

- Nav bar = `<header>` at the bottom of the `App` function in `src/App.tsx` (search `<header>`): brand, then
  `.header-actions` holding the language `Segmented` (`chooseLanguage`, `LANGS` from `src/i18n.ts`), then (when
  `startScreen === null`) undo/redo and the `view.models` / `view.wireframe` buttons.
- Step 1 = session `mode === 'dental' && dentalStage === 'aligner'`, gesture kind `dental-aligner`, phase `prompt | loading | ready`.
  Its chrome is `DentalBar` (`src/components/DentalBar.tsx`, `dental-aligner` branch) which renders the red badge
  (`.edit-badge`, text `Step 1 · Aligner`) and, when `phase === 'ready'`, `DentalAlignerBar` + `PrintAngleField` in
  `src/components/DentalSteps.tsx`.
- Tilt data: `useDentalFlow` (`src/components/useDentalFlow.ts`) returns `tilt: DentalTiltState` (`status: scanning | failed | ready`).
  When ready: `scan.rows[i].tiltDeg`, `.rotation`, `.failed`; `scan.band = [firstRow, lastRow]` (row indices, or undefined);
  `scan.order[0]` = the pick; `index` = chosen row. `chooseTilt(index)` turns the model (`turnTo` dispatches `transform/set`
  on `unit.transform.rotation`): this is THE live-tilt path, reuse it. `tiltLabel(deg)` (vendor `dentalTilt.ts`) formats one decimal.
  `useDetected` (command `dental.useDetected`, label `Auto orientation`) restores the pick.
- Today the slider is `RangeField` with `band` (an inline `left/width` style) inside `PrintAngleField`.
- Supports reach the viewport only through `supportMeshes` (a `Map`) passed to `ObjectViewport`; `UnitObject` draws raft and
  pillars as part of that mesh. Hiding them = pass an empty map.
- Gizmo: `ObjectViewport.tsx` renders `UnitTransformControls` only when `props.gesture.kind === 'none'`. In Step 1 the gesture is
  `dental-aligner`, so the existing `setGizmoMode('rotate')` in `startAligner` shows NO gizmo today (verify in S0). S6 fixes this
  with an explicit prop. The `onTransform` handler in App dispatches `transform/set`.
- DANGER in `useDentalFlow.next`: if `tilt.hand` is false, Next re-turns the model to a scanned row. A freely rotated model
  must set `hand: true` first or Next throws the user's rotation away (S6 handles it).
- The `Exit` and `Back` buttons are registry commands `dental.exit`, `dental.back` (`src/dental/editingMode.ts`, run through
  `runCommand`); `Next` is `dental.next`. Reuse them with `CommandButton` / `resolve(id, ui)`. Do not add new registry ids.

---

## S0 Baseline (no commit)

Goal: know what Step 1 looks like now. Start vite on 5181, load an aligner fixture, screenshot Step 1 at 1440x900, write
down: is a gizmo visible? where do the badge, DebugSection and view buttons sit? Delete the temp script, stop the PID.
Done when: you can state in one line whether the gizmo shows in Step 1 now. Nothing to commit.

## S1 Navbar: Exit arrow, language dropdown, no Hide models

Files: `src/components/LanguageSelect.tsx` (new) + `.test.tsx`, `src/ui/assets/icons/exit-arrow.svg` (new),
`src/ui/assets/icons/README.md` (add one table row), `src/App.tsx` (`<header>` only), `src/styles.css`, locales.

1. `LanguageSelect({ lang, onChange })`: a native `<select className="lang-select" aria-label={t('Language')}>` with one
   `<option value={entry.lang} lang={entry.lang}>{entry.name}</option>` per `LANGS`. Keep `LANGS` as is.
2. `exit-arrow.svg`: 24x24, `fill="none" stroke="currentColor" stroke-width="1.7"`, a left-pointing arrow leaving a bracket
   (door-exit): `<path d="M14 4h5v16h-5"/><path d="M4 12h11"/><path d="m8 8-4 4 4 4"/>`. No width/height attributes. README row:
   `exit-arrow.svg | Nav bar, top right: leave the dental flow`.
3. In `<header>`: replace the `Segmented ... lang` with `<LanguageSelect lang={lang} onChange={chooseLanguage} />`; delete the
   line `<CommandButton command={command('view.models')} .../>` (keep `view.wireframe`; keep the `view.models` command in the
   registry and its `case 'view.models'` in `runCommand` untouched). After the toolbar groups add, only when
   `session.mode === 'dental' && session.dentalStage === 'aligner'`:
   `<button type="button" className="nav-exit" aria-label={t('Exit')} {...hint('Leave the dental flow. The aligner stays on the plate without supports')} onClick={() => runCommand('dental.exit')}><Icon name="exit-arrow" /></button>`
   (import `Icon` from `./ui/Icon`, `hint` from `./components/hint`; the hint key already exists in the locales).
4. CSS: `.lang-select` (height like buttons, `border: 1px solid var(--line)`, `background: var(--surface)`, `border-radius: var(--radius)`),
   `.nav-exit` (square 36px button, `margin-left: 8px`), `.nav-exit svg { width: 20px; height: 20px; }`. Delete the now unused
   `.segmented.lang button` rule (line near `.segmented.lang`).
5. In `DentalBar.tsx` Step 1 `ready` branch the Exit button stays for now (S3 removes it); in the `prompt/loading` branch delete
   `<CommandButton command={resolve('dental.exit', ui)} .../>` (the nav arrow replaces it). Update `DentalBar.test.tsx`
   expectations that look for `Exit` in that branch (Step 0 and Step 2 still contain it).
i18n keys: `Language` exists; add none unless a new literal appears. Done when: new `LanguageSelect.test.tsx`
asserts `<select`, 3 options, `selected` on the active language; a `header` screenshot at Step 1 shows the dropdown, no
"Hide models", and the arrow top right; `npm test` green. Do not touch: Step 0 / Step 2 / Step 3 Exit buttons, `StartScreen`.

## S2 Step-1 viewport rules (model + debug layers only)

Files: `src/dental/step1View.ts` (new) + `step1View.test.ts`, `src/App.tsx` (3 small edits).

1. `step1View.ts`: `export function isOrientationStep(s: { mode: string; dentalStage?: string }): boolean` (true for
   `mode === 'dental' && dentalStage === 'aligner'`) and `export const NO_SUPPORT_MESHES: ReadonlyMap<string, never> = new Map()`.
   Doc comment: Step 1 draws the model and the Debug layers only (PD.11).
2. App.tsx: `const orienting = isOrientationStep(session);` near `debug`. Pass
   `supportMeshes={orienting ? NO_SUPPORT_MESHES : supportMeshes}` to `ObjectViewport` (type: `ReadonlyMap<string, GeneratedSupportMesh>`; an empty
   `Map<string, never>` is assignable). Wrap the whole `<div className="viewport-view">` in `{orienting ? null : (...)}`.
   Do NOT change `built`/`supportMeshes` computation (Step 3 needs them).
3. Adding supports is disabled by construction (gesture is `dental-aligner`, the Click/Add tools exist only in
   Edit Mode / Step 2 / Step 3, and no support bodies are drawn). Add a test line proving it: in `step1View.test.ts` assert
   `gesture({ ...initialSession, mode: 'dental', dentalStage: 'aligner' }).kind` is `'dental-aligner'` (import from
   `@mixo-geocore/editing/gesture` after registering the dental mode, copy the setup of `src/dental/editing/dentalStep2.test.ts`).
Done when: tests `step1View` pass (`isOrientationStep` true for aligner stage, false for `area`, `review`, `type`, `off`); screenshot of Step 1 with a
previously generated aligner shows no pillars/raft and no Tips only / Fit view / Bottom view buttons, Debug section still present and its
layers still draw; Step 3 screenshot still has supports and buttons. Do not touch: `UnitObject.tsx`, `ObjectViewport.tsx`.

## S3 Orientation bar: layout, narrow width, Prev | Next row

Files: `src/components/OrientationBar.tsx` (new) + `.test.tsx`, `src/components/DentalBar.tsx` (Step 1 `ready` branch),
`src/components/DentalSteps.tsx` (remove `DentalAlignerBar` after moving), `src/styles.css`.

1. Move `DentalAlignerBar`'s body into `OrientationBar` (same props: notices, proposal, profile, lang, ui, send, run, tilt, onTilt).
   Layout inside `<div className="edit-bar edit-bar--orient">` as a column of rows, in this order, each a `div.orient-row`:
   (a) Auto orient button (S4 styles it; for now `CommandButton command={resolve('dental.useDetected', ui)}`);
   (b) the tilt range text row and (c) the dial slot: render the existing `<PrintAngleField .../>` unchanged for now (S5 replaces it);
   (d) Free transform slot: empty `<div className="orient-row orient-free" />` (S6 fills);
   (e) notices: keep the existing `notices.map(...)` block and the mismatch Switch/Keep buttons; drop the confidence span and the
   old "Auto orientation only rotates..." note (delete that key's use only; leave locale entries);
   (f) last row `div.orient-row.orient-nav`: `dental.back` and `dental.next` `CommandButton`s, each `flex: 1`, so the row spans the full bar width.
   Remove `dental.exit` from this bar (nav arrow from S1 owns it).
2. `DentalBar.tsx`: in the `ready` branch render `<OrientationBar .../>` instead of `DentalAlignerBar`; delete `DentalAlignerBar` and its now
   unused imports from `DentalSteps.tsx` (keep `noticeText`, `PrintAngleField`, `tiltFlags`, `tiltProblems`, `DentalAlignerPrompt`, `DentalTypeStep`).
3. CSS: `.edit-bar--orient { width: 232px; align-items: stretch; padding: 8px; }` `.orient-row { display: flex; gap: 6px; flex-wrap: wrap; }`
   `.orient-row > * { flex: 1 1 auto; }` `.orient-nav { margin-top: auto; }` `.orient-nav button { flex: 1 1 0; }`. Keep it on the right edge (the default
   `.edit-bar` is already `right: 14px`). In the `@media (max-width: 1100px)` block the generic `.edit-bar` goes full width; add
   `.edit-bar--orient { width: auto; }` there so phones keep working.
i18n: none new. Done when: `OrientationBar.test.tsx` asserts that the HTML contains, in order, `Auto orientation`, `Back`, `Next` and does
not contain `Exit`; existing `DentalBar.test.tsx` Step 1 test is updated (no `Exit`); screenshot shows a narrow bar at the right with Back|Next as the last full-width row.
Do not touch: Step 2/3 bars, the badge.

## S4 Auto orient primary button + orientation icon

Files: `src/ui/assets/icons/orient.svg` (new), `icons/README.md`, `src/components/OrientationBar.tsx`, `src/styles.css`, `src/dental/editingMode.ts` (one role).

1. `orient.svg` (24x24, currentColor strokes, same attributes as `tool-pointer.svg`): a box with a circular arrow, e.g.
   `<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="M12 12 4 7.5M12 12l8-4.5M12 12v9"/>` plus an arc arrow
   `<path d="M17.5 3.5a6 6 0 0 1 3 3"/><path d="m20.7 3.2-.2 3.4-3.3-.4"/>` (any clear "rotate to orientation" glyph is fine; keep stroke-only).
   README row: `orient.svg | Orientation bar, Auto orient button`.
2. In `OrientationBar` row (a): `<CommandButton command={{ ...resolve('dental.useDetected', ui), role: 'primary' }} run={run} className="orient-auto"><Icon name="orient" /></CommandButton>`
   (look at `CommandButton.tsx` to see how children/label render; if children replace the label, put the label text after the icon yourself).
   Do NOT change the registry label (`Auto orientation` stays: the owner calls it Auto orient; no translation churn).
3. CSS: `.orient-auto { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 40px; }`
   `.orient-auto svg { width: 18px; height: 18px; }` (the `.primary` class already gives red background).
Done when: test asserts the button HTML has class `primary` and an `<svg`; screenshot shows a red full-width Auto orientation button with the icon. Do not touch: `dental.useDetected` handler.

## S5 Tilt range row + dial + big number

Files: `src/ui/parts/tiltDialGeometry.ts` + `.test.ts` (new), `src/ui/parts/TiltDial.tsx` + `.test.tsx` (new), `src/components/TiltReadout.tsx` + test (new),
`src/components/DentalSteps.tsx` (`PrintAngleField`), `src/components/OrientationBar.tsx`, `src/components/DentalBar.tsx`, `src/styles.css`, locales.

1. `tiltDialGeometry.ts` (pure, no React): `valueToAngle(value, min, max)` maps to a 240-degree arc (from -120 to +120 deg about the top);
   `angleToValue(...)` inverse; `polar(cx, cy, r, angleDeg)` -> `{x,y}`; `arcPath(cx, cy, r, fromAngle, toAngle)` -> SVG `d` string;
   `valueFromPointer(rect, clientX, clientY, min, max, step)` clamps and snaps. Tests: round trip `angleToValue(valueToAngle(v)) === v` at min, mid, max;
   `arcPath` starts at `polar(from)`; pointer straight up gives the mid value.
2. `TiltDial({ min, max, step, value, band, label, disabled, onChange })` (`band?: readonly [number, number]`): an `<svg className="tilt-dial" viewBox="0 0 120 120"
   role="slider" tabIndex={0} aria-label={label} aria-valuemin aria-valuemax aria-valuenow>` with three arcs by CSS class (`tilt-dial-track`, `tilt-dial-band`,
   `tilt-dial-knob` circle at `polar(valueToAngle(value))`) and a centre `<text className="tilt-dial-value">` is NOT needed (the big number is separate).
   Pointer: `onPointerDown` captures the pointer, `onPointerMove` while pressed calls `onChange(valueFromPointer(...))` (live), keys ArrowLeft/Down/ArrowRight/Up change by `step`.
   All colours in CSS: track `stroke: var(--line-strong)`, band `stroke: var(--kraft)` thicker, knob `fill: var(--red)`. Test: markup has `role="slider"`, the band path exists only
   when `band` is given, `aria-valuenow` equals `value`.
3. `PrintAngleField` (in `DentalSteps.tsx`): replace the `RangeField` block with the dial. Data: `min = rows[0].tiltDeg`, `max = rows.at(-1).tiltDeg` (the FULL scanned range, not
   `startDeg +/- range`), `step = tiltStepDeg`, `value = row.tiltDeg` (starts at the pick because `index` starts at `order[0]`), `band` as today. `onChange(value)` keeps the
   existing nearest-row lookup then `onChoose(nearest)` (the existing live path: `chooseTilt` -> `turnTo`). Replace the long hint paragraph by the tilt range row:
   `band ? t('Stable {a}–{b}°', { a, b }) : t('No stable angle')` in `<p className="orient-range">`. Keep `tilt-flags` and the `problems` list below the dial. Remove the unused `RangeField` import if nothing else uses it there.
4. `TiltReadout({ deg })`: `<div className="tilt-readout" role="status" aria-label={t('Print angle')}><span className="tilt-readout-num">{tiltLabel(deg)}</span><span className="tilt-readout-deg">°</span></div>`.
   In `DentalBar.tsx` Step 1 `ready` branch, right after the `.edit-badge`: `{tilt?.status === 'ready' && !freeTransform ? <TiltReadout deg={tilt.scan.rows[tilt.index]!.tiltDeg} /> : null}` (add an optional prop
   `freeTransform?: boolean`, default false; S6 passes it).
5. CSS: `.tilt-readout { position: absolute; top: 62px; left: 16px; z-index: 3; pointer-events: none; color: var(--ink); font-variant-numeric: tabular-nums; }`
   `.tilt-readout-num { font-size: 56px; font-weight: 500; line-height: 1; }` `.tilt-readout-deg { font-size: 28px; }` `.tilt-dial { width: 100%; max-width: 200px; touch-action: none; }`
   plus the arc classes. Check it does not collide with the Debug section; if it does, move Debug below with `top` only on `.debug-section` under `.viewport--dental`.
i18n keys to add (en/ja/zh-Hant): `Stable {a}–{b}°`, `No stable angle`. Done when: dial and geometry tests pass; screenshot at 1440x900 shows the big number under the Step 1 badge and the dial knob at the pick
with the kraft band; dragging the knob in the Playwright script (pointer move) changes the number and the model turns (assert the number text changed). Do not touch: `useDentalFlow.chooseTilt`, scan code.

## S6 Free transform

Files: `src/components/useFreeTransform.ts` (new) + test, `src/components/OrientationBar.tsx`, `src/components/ObjectViewport.tsx` (+ `viewport/types.ts`), `src/components/useDentalFlow.ts` (two small additions),
`src/components/DentalBar.tsx`, `src/App.tsx` (wiring), `src/styles.css`, locales.

1. `useFreeTransform(stageKey: string)` returns `{ free, asking, ask, confirm, cancel, leave }`; state is reset (free false, asking false) whenever `stageKey` changes (pass
   `${session.dentalStage}:${session.dentalUnitId}`) and on unmount. `ask()` sets asking; `confirm()` sets free and clears asking; `leave()` clears both. Test with a tiny
   harness or by exporting the reducer as a pure function `freeReducer(state, action)` and unit-testing it.
2. `useDentalFlow.ts`: add (a) `markHand()` = if tilt is ready, `keepTilt({ ...current, hand: true })` so Next keeps the user's rotation; (b) `reorient()` = clear `scanned.current`
   then `startAligner(activeUnit)` (fresh auto orientation and fresh scan), and return both from the hook. Do not change other functions.
3. `ObjectViewport.tsx` + `types.ts`: new optional prop `rotationGizmo?: boolean`. Render `UnitTransformControls` with `mode="rotate"` for the active unit when
   `props.rotationGizmo` is true (in addition to the existing `gesture.kind === 'none'` rule; extract the condition into a small exported function
   `showsGizmo(gesture, gizmoMode, rotationGizmo)` and test it). Rotation-only: mode is always `rotate`.
4. `OrientationBar` new props: `freeTransform`, `asking`, `onAskFree`, `onConfirmFree`, `onCancelFree`, `onAutoOrient`. Row (d) renders a `Free transform` secondary button (`orient-free`) that calls `onAskFree`.
   While `asking`, replace rows (a)-(d) with an inline confirm block `div.orient-confirm role="alertdialog"`: text `You will orient it yourself. Continue?` and two buttons `Cancel` / `Continue`
   (`onCancelFree` / `onConfirmFree`); Prev|Next stays. While `freeTransform` is true render ONLY: Auto orient (row a) and the Prev|Next row; hide range text, dial, Free transform button, flags and notices.
   Auto orient in free mode calls `onAutoOrient` (App: `freeTransform.leave(); dentalFlow.reorient();`), which returns the normal layout. In normal mode Auto orient still runs `dental.useDetected`.
5. `DentalBar.tsx`: pass `freeTransform` to `TiltReadout` (hidden when true; S5 prop). App wiring (minimal lines): `const free = useFreeTransform(...)`; `ObjectViewport rotationGizmo={orienting && free.free}`;
   `onConfirmFree={() => { dentalFlow.markHand(); free.confirm(); }}`; thread props through `DentalBar` to `OrientationBar`. Also hide the gizmo and leave free mode when Step 1 is left (the hook reset handles state).
6. CSS: `.orient-confirm { display: grid; gap: 8px; white-space: normal; }` `.orient-confirm p { margin: 0; }` `.orient-confirm .orient-row button { flex: 1 1 0; }`.
i18n keys (en/ja/zh-Hant): `Free transform`, `You will orient it yourself. Continue?`, `Cancel` (exists? grep first), `Continue` (grep first).
Done when: tests (`freeReducer`, `showsGizmo`, `OrientationBar` markup in the three states: normal has dial and `Free transform`; asking has `Continue`; free has neither dial nor number, still has `Auto orientation`
and `Next`); screenshot script: click Free transform, Continue, assert a gizmo is drawn (canvas differs from the S5 screenshot) and the big number is gone; click Auto orientation, assert the dial is back and the number returns;
press Next in free mode after a gizmo rotation and confirm the model pose did not jump (compare `unit.transform.rotation` is unchanged by the confirm step; assert via the Debug layer or a pose label in a unit test of `markHand`).
Do not touch: scan/orient code paths other than the two additions.

## Final check (S7, no new code)

Run the whole suite, `npx tsc --noEmit`, `npm run build`, then screenshots of Step 0, Step 1 (normal and free), Step 2, Step 3 to prove Steps 0, 2 and 3 are unchanged. Then update
`docs/handoff/` ledger in mixomesh (owner's rule) if the repo asks; do not mark PD.11 done without owner eyeball.

## Open questions for the owner

1. Prev label: the registry button is called `Back` (it returns to the type screen from Step 1). Keep `Back`, or rename to `Prev` in all steps?
2. Should the nav-bar Exit arrow appear in every dental step (0 to 3) or only Step 1? The guide does only Step 1 and leaves Exit buttons in other steps.
3. Does "Hide models" disappear from the nav bar in every mode, or only during dental Step 1? The guide removes it from the nav bar everywhere (the command stays in the registry).
4. Auto orient while in Free transform "re-runs auto orientation": the guide re-runs the orientation worker and the tilt scan from scratch (`reorient`). Acceptable, or only restore the stored pose?
5. Today Step 1 shows no rotation gizmo unless S0 proves otherwise; confirm that the normal (non-free) Step 1 should show none, with the gizmo only in Free transform.
