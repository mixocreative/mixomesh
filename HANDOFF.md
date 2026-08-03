# HANDOFF — Storage Adapter + Web/Windows-Electron split

**Purpose of this file:** durable resume point. If a session is cut off mid-operation,
THIS is the first file to read. It tracks the goal, decisions, plan, and exactly
what is done vs next. Update it at every safe boundary (before each commit).

Workflow: solo dev — **all work on `master`, no feature branches** (merged 2026-06-17).
Commit at each green boundary. This tracker persists across sessions.

---

## Goal (verbatim intent)

Audit code structure + UI design with subagents → decide the cleanest maintainable
approach to make MIXOMESH run as BOTH a web app and a Windows Electron desktop app
from one codebase → implement it. Update all architecture docs. Commit. Keep this
handoff current so a token cutoff is resumable by this or another AI.

## Locked scope decisions (do not re-litigate)

- **Targets now: Web + Windows (Electron). Mac DEFERRED** until Win+Web are production-level.
  Mac is additive later (behind the adapter), not a rewrite.
- **Electron, not Tauri** — Chromium renderer = the Chrome/CDP engine the test suite
  already targets → full engine parity, no re-test matrix (Babylon/WebGL2, WebCodecs,
  readPixels Mimaki lock, Workers, File System Access).
- **One codebase, capability-tiered `StorageAdapter`.** Runtime detected at boot
  (`window.electronAPI` → desktop, else web). App logic/UI branch on capability FLAGS,
  never on "is Electron" checks scattered around.
- **Web = ephemeral assets.** Import glb by picker → snapshot bytes → embed in `.mixo`.
  No asset DB, no folder mounts, no relink. `caps.persistAssets=false`.
- **Desktop = real fs, offline.** Absolute paths, live relink, folder mounts, file-watch.
- **`.mixo` is the interop/sync contract (already hybrid).** ALWAYS embed bytes; desktop
  ALSO stores path as an optional live tier. Cross-runtime open falls to embedded bytes →
  byte-identical geometry. The portable file is the sync unit (synced folder = poor-man's sync).

## Target architecture (the seam)

```
StorageAdapter (interface)
  caps: { persistAssets, relinkByPath, watchFiles, mountDirectory, writeFiles }
  pickOpen() / pickSave() / read(ref) / write(ref, bytes)
  resolveAsset(ref) / watch(ref, cb) / recentProjects()
impls:
  BrowserStorageAdapter  (File System Access + idb; current behavior)
  DesktopStorageAdapter  (Electron IPC → Node fs; Phase 2)
```
Core (render, edit, ratio, validation, export, .mixo schema) stays runtime-agnostic.
FS-only features (mount / relink / watch / recent-by-path) gate behind `caps`.

## Phased plan

- **Phase 0 — Audit + ADR (IN PROGRESS).** Subagents map storage coupling + UI capability
  gating + confirm core is FS-agnostic. Synthesize → ADR.
- **Phase 1 — StorageAdapter extraction (web-only, behavior unchanged).** Move current
  File System Access / idb / persist / assets calls behind the interface. All 101 headless
  + browser smoke + export stay green. NO Electron yet. Also cleans the asset-DB tier soup.
- **Phase 2 — Windows Electron shell + DesktopStorageAdapter (Node fs via IPC).**
- **Phase 3 — electron-builder (NSIS) installer, optional auto-update, security hardening
  (contextIsolation, no nodeIntegration, IPC allowlist).**
- **Mac — parked.**

## Progress log (update every boundary)

- [x] Branch `feat/storage-adapter` created.
- [x] HANDOFF.md scaffold written + committed (4ccca59).
- [x] Audit subagents dispatched (2 haiku agents: storage-coupling + UI-gating).
- [x] ADR skeleton written: `docs/adr/0001-storage-adapter-web-electron.md`
      (2 sections marked `[TO FILL after audit]`: StorageAdapter surface + UI gating map).
- [x] Audit findings synthesized → both ADR sections filled (263047a UI + interface after).
- [x] ADR complete: domain-level adapter w/ OPAQUE REFS (not FSA primitives), LEAF/LEAKED
      refactor order, core-agnostic confirmed. `docs/adr/0001-...md`.
- [x] Architecture docs updated: AGENTS.md + Blueprint.md pointers (74ae80d), memory
      `storage_adapter_direction.md` + MEMORY.md index.
- [x] Phase 1a: capability model `src/core/storage/capabilities.js` + `tests/capabilities.test.mjs`
      (5 asserts) (fda14cc); first UI gate = AssetPanel Mount button behind `caps.mountDirectory` (6a03deb).
- [x] De-flaked the dup round-trip smoke (settle source bounce before duplicating) (0b1a7d2)
      — 3× green. IMPORTANT: keeps the green-gate reliable for handoff.
- [x] Phase 1b (directory slice): `src/core/storage/StorageAdapter.js` domain interface +
      `BrowserStorageAdapter` delegating to today's code (opaque ref = FileSystemHandle);
      boot `storage` singleton; desktop directory refs are main-process registry tokens.
- [ ] Phase 1b: route LEAF modules through the adapter (idb.js, persist/*, DirMounts,
      TextureAssets, Download, PersistenceManager doc I/O).
- [ ] Phase 1b: gate remaining UI controls behind caps — ProjectMenu open/save/saveAs
      (`writeFiles`), recent (`persistAssets`), relink (`relinkByPath`); ViewportDrop OS-file handle.
- [ ] Phase 1c: refactor LEAKED modules (AssetImport `_fileHandleKeyFor`, ObjSiblings dir-walk,
      AssetPanel `_scanDirectory`/`_cacheHandles`, ViewportDrop DataTransferItem) to go via adapter.
- [x] Phase 2 (directory slice): Windows Electron shell + `DesktopStorageAdapter`; mounted
      assets use allowlisted opaque-ref IPC and never expose OS paths to the renderer.
- [ ] Phase 3: electron-builder (NSIS) installer, security hardening, optional auto-update.
- Verify green (typecheck · 102 headless · build · browser smoke ×N · export) at EACH commit.

## AUDIT RESULTS (captured — do NOT re-run the agents)

- **Core seams runtime-agnostic (do not touch):** ImportNormalizer, ScaleMath,
  print/ExportContext, print/PrintPipeline (+PrintPrep/ObjWriter/ThreeMFWriter).
  PersistenceManager OWNS the I/O funnel → adapter injects there.
- **LEAF (wrap cleanly):** idb.js, PersistenceManager doc I/O, persist/AssetResolver,
  persist/RecentProjects, persist/Autosave, assets/DirMounts, assets/TextureAssets, print/Download.
- **LEAKED (pull FS out first):** assets/AssetImport (`_fileHandleKeyFor`→persistHandle),
  assets/ObjSiblings (dir walk), ui/AssetPanel (`_scanDirectory`/`_cacheHandles`), ui/ViewportDrop
  (OS DataTransferItem handles).
- **UI controls throwing-on-web today (gate behind caps):** ProjectMenu open/save/saveAs/recent/
  relink; AssetPanel Mount Directory; ViewportDrop OS-file drop; exports degrade to blob-download
  already. Full `file:line` map in the ADR §UI capability-gating.
- **caps set:** persistAssets, mountDirectory, relinkByPath, watchFiles, writeFiles.

## RESUME POINTER (read this to continue)

**Current step:** Phase 0 (audit + ADR) DONE. Phase 1a (capability model + first UI gate)
DONE + committed + green. Next = Phase 1b.
**Next action on resume:** Build `src/core/storage/StorageAdapter.js` per ADR §"StorageAdapter
surface" — the domain interface (JSDoc typedef) + `BrowserStorageAdapter` that DELEGATES to
today's functions (PersistenceManager pickers, idb.js, DirMounts, AssetResolver, Download),
with `ref` = opaque FileSystemHandle and `.mixo` descriptors `{path?,contentHash,handleKey?}`.
Export a boot `storage` singleton (browser impl for now). Then incrementally route the LEAF
call sites through it (list in Progress log + AUDIT RESULTS), one module per commit, keeping
the suite green. Then gate the remaining UI controls (ProjectMenu open/save/saveAs/recent/relink)
behind their caps like AssetPanel's mount button already does. THEN Phase 1c (LEAKED refactor).
Do NOT add Electron until Phase 1 is fully green. Behavior on Chrome must stay identical
throughout (all caps true → nothing hides, nothing changes).

**Watch-outs:**
- The browser smoke has import-bounce timing sensitivity; if a size round-trip flakes,
  the fix is `settleImportBounce()` before measuring/cloning (see 0b1a7d2), not a longer wait.
- `caps` is imported from `src/core/storage/capabilities.js`; override in tests via `setCapabilities`.
- Solo dev: work directly on `master`, commit at each green boundary (no feature branches).

## Verify commands

`npm run typecheck` · `npm test` (101 pass) · `npm run build` · `npm run test:browser` · `npm run test:export`

## Key files (storage coupling — from initial grep)

`src/core/idb.js`, `src/core/persist/*` (Autosave, ProjectLoader, RecentProjects, AssetResolver),
`src/core/assets/*` (AssetImport, DirMounts), pickers in `src/app/main.ts`, `src/ui/AssetPanel.js`,
`src/ui/ViewportDrop.js`, `src/ui/ShaderPanel.js`, `src/core/print/Download.js`, `src/core/PersistenceManager.js`.

## Open questions / risks

- Windows code-signing: optional at first (SmartScreen warning) — decide before release.
- `.mixo` size on web (always-embed) — acceptable; heavy scenes = big files (known).
- Keep `master` untouched until Phase 1 is green + reviewed.
