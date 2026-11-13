# src/ui/ — the map

43 files: everything the operator sees that is not the 3D viewport itself. The rule the folder
works by: **a module here owns one surface and reads state, it never owns state.** State lives in
`../core/StateManager.js`; a UI module subscribes to it and renders. A UI module that becomes the
only place a value exists is a bug, because nothing else can then undo, save or test it.

`../kit/` is the component library (Button, Toggle, NumberField…). This folder is the application's
own panels, built from it. New controls go in `kit`; new panels go here.

## The shell — always present

| File | Surface it owns |
|---|---|
| `AppShell.js` | the static shell outside every panel: wiring the affordances that belong to no panel |
| `StatusBar.js` | the bottom bar, including autosave liveness — the last snapshot time, or a persistent warning when there is none |
| `MeshStats.js` | the live triangle/vertex readout in the status bar's centre |
| `Toast.js` · `Status.js` | the feedback policy. **`Status.js` is the one place error surfacing and loading lifecycle are decided** — a module that shows its own error bypasses it. A toast that never times out must still be closable |
| `Modal.js` | the modal registry: id → renderer. Each phase registers its own renderers |
| `BootBanner.js` | one slim non-blocking strip above the viewport for boot-time conditions |
| `ProgressOverlay.js` | the full-screen blocking overlay while an export runs |
| `JobActivity.js` | **the one place every background worker job shows up.** A job that runs without a row here is work the user cannot see |
| `LocaleSwitcher.js` | language choice; each language's label is always drawn in its own script |

## Panels and sheets

| File | Surface it owns |
|---|---|
| `PropertiesPanel.js` | the per-object inspector: transform, scale, source, material. The largest file here (1,482 lines) and named as debt in `../../docs/size-debt.md` |
| `ScenePanel.js` | scene-wide settings, deliberately moved out of Properties |
| `ShaderPanel.js` | material and shader editing, with per-section collapse preserved across sessions |
| `AssetPanel.js` | the imported-asset list and its cards |
| `Outliner.js` | the object tree. **Only lead objects get a row**; a logical object's internal parts are disclosed under it, session-only |
| `PrintPanel.js` · `print/` | the print tab bar and readiness strip; the tabs themselves are in `print/` |
| `CursorPanel.js` | the slide-open viewport sidebar (Blender's "N panel") |
| `PanelSheets.js` | below 1280 px the panels become slide-over sheets |
| `Workspace.js` | the three fixed task layouts |
| `ContextMenu.js` · `ProjectMenu.js` | the right-click menu and the project menu, including their submenus |
| `SourcesModal.js` | every asset with its source, in one place |
| `FindMoved.js` | the "Find moved file…" action, shared by the asset card and Properties |

## Viewport overlays and modes

| File | Surface it owns |
|---|---|
| `ViewportToggles.js` · `ViewportToolbar.js` | the display-control strip and the tool strip over the viewport |
| `ViewportDrop.js` | drag-and-drop import, routed through the "already in this project" check |
| `ViewportEmptyState.js` | what an empty scene says, and the one action it offers |
| `NavCube.js` | the orientation cube |
| `RenderFrame.js` | the framing overlay while Render view is active |
| `ScopeBreadcrumb.js` | the chip at the viewport's top-left saying which scope you are inside |
| `PartScopeMode.ts` · `isolation.ts` · `isolationEvents.test.ts` · `partScopeKeys.test.ts` | **inside-object scope.** While it is active, selection holds part ids, not displayable ids — which is why delete, duplicate and hide refuse here (`../core/InputManager.js`). Its event subscriptions must match its sibling `../supports/SupportMode.ts`; they drifted once |
| `modeShell.ts` | the shared shell every mode applies, so modes cannot each invent their own |
| `SliceConnectorSession.js` | the slice-connector placement session |
| `ViewerMode.js` | under 768 px the app becomes a read-only phone viewer |
| `Onboarding.js` | first-run guidance, once |

## The rest

| File | Job |
|---|---|
| `CopyPaste.js` | copy/paste with an aspect chooser |
| `NumberScrub.js` | wheel-scrub on any number input |
| `ImportError.js` · `RepairFeedback.js` | the two failure surfaces that are worth a screen rather than a toast: a failed import, and what a repair actually changed |
| `renderSafe.js` | `escapeHtml` / `escapeAttr` / `safeImageSrc`. **Any user-supplied string reaching innerHTML goes through here.** A filename is user-supplied |

## Conventions

- Every string the operator reads comes from `../i18n/` via `t()`. A literal in a template is a
  missed locale; `npm run i18n:check` is the guard (`../../docs/TRANSLATIONS.md`).
- Every element a designer or a walk needs to find carries a stable `data-ui` name. A walk that
  selects on a class is a walk a restyle breaks.
- Styling follows the `mixo-app-style` tokens; never re-derive a colour or a spacing value.
