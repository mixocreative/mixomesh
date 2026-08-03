# Editor Asset, Hierarchy, and Print UX Design

**Status:** Approved direction; implementation pending

**Date:** 2026-08-03

**Plan:** `docs/superpowers/plans/2026-08-03-editor-asset-hierarchy-ux.md`

## Outcome

MIXOMESH remains a focused print-preparation editor, not a general DCC. The
next work makes its existing scope predictable: assets are easy to find,
hierarchy rows have clear semantics, shared shaders and images are safe to
manage, placement exposes print-oriented verbs, and export explains what will
happen before it starts.

Printer profiles remain build-volume presets only. OBJ, 3MF, and STL remain
explicit export choices independent of the selected printer.

## Conclusions after a second challenge pass

- The empty-parent symptom is a state-integrity bug. `DeleteCommand` removes
  SceneObjects without cleaning `GroupNode.childIds`; hiding rows alone would
  preserve corrupt membership.
- A filename, Babylon name, or dimensions are labels, not content identity.
- Continuously merging equal shaders would erase the user's intent to edit
  deliberately duplicated shaders independently.
- Recursively flattening every folder during normal browsing loses location
  context and scales poorly.
- A full digital-asset-management platform is unnecessary. A small index over
  opaque storage entries and a content-addressed image store are sufficient.
- Bed overflow is actionable but nonfatal: users may export for later scaling
  or a different machine. It never selects or disables a format.

## Locked behavior

### Scene hierarchy

The Outliner distinguishes three concepts:

- **Import** — display-only collection/provenance metadata; no Babylon node.
- **Group** — real `TransformNode` hierarchy; no visible surface.
- **Object** — selectable geometry.

Viewport picking selects an Object only. It reveals and highlights the
ancestor path but does not select or rename an Import or Group. Clicking an
Import or Group row selects its live descendants.

Deletion removes object ids from group membership in the same undoable
command. Empty imported groups are recursively pruned. Empty user-created
groups remain and show an `Empty` badge. Undo restores exact nodes, parents,
membership, collection routing, and enabled state. Add
`GroupNode.origin: 'import' | 'user'`; old files default to `'user'`, the
conservative migration that never silently discards user organization.

### Asset browsing

Complete the `StorageAdapter` directory methods so browser and Electron UI use
opaque refs rather than `FileSystemDirectoryHandle` or paths. Build one
immutable index on mount/refresh; rendering and searching query it without
filesystem scans.

The two panes become:

- **Sources:** Session smart views (`All`, `Used`, `Unused`, `Issues`) and
  mounted library folders.
- **Assets:** breadcrumb, search, scope, kind filter, result count, cards/list.

Normal browsing shows direct children. Search has explicit scopes: `This
folder`, `This folder + subfolders` (the default when search starts), and `All
libraries`. Each result appears once and includes its relative path. Refresh
preserves the selected path where possible. Favorites and user collections are
deferred until the core browse/search loop proves a need.

### Shader and image identity

`ShaderSignature` normalizes every MIXOMESH-supported appearance field. It
refuses automatic merging if untracked material features would be lost.
Material names never participate in identity.

Imported shaders auto-share only when the normalized appearance is exact.
Existing user-authored shaders merge only through an explicit undoable
**Consolidate Duplicates** action. **Make Unique** clones a shader/view so
future edits stop propagating.

Image identity is SHA-256 of canonical encoded image bytes captured before the
viewport cap. Texture-view identity separately records color space, invert-Y,
wrap, sampling, and other supported sampling semantics. Equal images share
stored bytes; only equal views share a mutable Babylon texture. Same filename
with different bytes never merges. Perceptual/pixel-equivalent matching may be
suggested later but is never automatic.

### Print and interaction flow

`PrintReadiness` is a pure projection over state, validation, live bounds, and
the selected build volume. It emits stable codes/data; UI owns translation.

The Print workspace persistently shows:

- Build Volume Preset and XYZ dimensions.
- Ready / Warnings / Blocked status with click-through issues.
- Format, object count, target ratios, selected/individual options, and package
  shape before export.
- Explicit OBJ, 3MF, and STL actions at all times.

Add only high-value print placement verbs: **Drop to Bed**, **Center on Bed**,
and **Place Face on Bed**. Keep existing align/mate tools but replace cryptic
glyph-only presentation with labels or reliable translated tooltips and
accessible names. A zero-object viewport shows separate **Import Model** and
**Open Project** actions plus the drop hint.

## Unmanaged-state policy

| Situation | Behavior |
| --- | --- |
| No objects | Import Model + Open Project + drop hint; export blocked. |
| No print parts | Error with action to mark selected/all as print parts. |
| Bed overflow | Per-axis warning and Center on Bed action; export may continue after acknowledgement. |
| Unconfirmed unit | Warning linked to the object's Source Unit field. |
| Missing source with snapshot | Warning; continue from embedded snapshot. |
| Missing required texture | Textured output blocked with relink action; solid-only output requires explicit acknowledgement. |
| Multiple ratios | Preview every output name/package before export. |
| Empty imported group | Prune recursively in the deletion command. |
| Empty user group | Preserve with Empty badge. |
| Equal imported shader | Share only on exact supported signature. |
| Equal image, different sampler | Share bytes; retain separate views. |

## Rejected approaches

- Flat recursive asset results during ordinary browsing.
- Renderer-only hiding of all empty groups.
- Shader or texture merging by name/dimensions.
- Continuous auto-merging after user edits.
- Printer-driven export-format selection.
- DAM features such as ratings, tags, cloud sync, or saved searches in this
  delivery.

## Verification and token economy

Pure contracts receive narrow headless tests first. DOM behavior is added to
browser smoke only after pure tests pass. Real export smoke runs only after
texture/persistence/readiness work; Electron smoke runs only after adapter and
close-guard work. Each independent slice ends green and committed, so an
implementer reads only the slice's files and Blueprint sections rather than
reloading the whole system.

## Reference patterns

- [Unity Project window](https://docs.unity3d.com/Manual/ProjectView.html):
  two columns, scoped search, favorites, and reveal-in-folder.
- [Unreal Content Browser](https://dev.epicgames.com/documentation/en-us/unreal-engine/content-browser-interface-in-unreal-engine):
  sources, breadcrumb, filters, search, asset view, and counts.
- [Blender Asset Browser](https://docs.blender.org/manual/en/latest/editors/asset_browser.html):
  current-file versus external-library separation.
- [Adobe Bridge search](https://helpx.adobe.com/uk/bridge/desktop/organize-and-find-files/organize-files-and-folders/search-for-files-and-folders.html):
  explicit subfolder search and flat results with provenance.
