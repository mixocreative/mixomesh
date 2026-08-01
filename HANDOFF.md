# HANDOFF — Storage Adapter + Web/Windows-Electron split

**Purpose of this file:** durable resume point. If a session is cut off mid-operation,
THIS is the first file to read. It tracks the goal, decisions, plan, and exactly
what is done vs next. Update it at every safe boundary (before each commit).

Branch: `feat/storage-adapter` (off `master` @ per-object-ratio-audit-2026-06-17).

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
- [ ] Audit findings synthesized → fill the 2 ADR sections.
- [ ] Architecture docs updated (Blueprint.md, AGENTS.md, memory).
- [ ] Phase 1 StorageAdapter interface + BrowserStorageAdapter implemented.
- [ ] Tests green (101 headless + browser smoke + export).
- [ ] Committed.

## RESUME POINTER (read this to continue)

**Current step:** Phase 0 — 2 background audit agents running (A: storage/persistence code
coupling + core-agnosticism + proposed adapter surface; B: UI filesystem controls + capability
gating map). ADR skeleton awaits their findings.
**Next action on resume:** if the audit findings are not in hand, re-run the two audits
(prompts are reproducible from the ADR's two `[TO FILL]` section headings + the "Key files"
list below). Then: fill ADR §"StorageAdapter surface" + §"UI capability-gating map" → update
Blueprint.md/AGENTS.md/memory → implement Phase 1 (`src/core/storage/StorageAdapter` interface
+ `BrowserStorageAdapter` wrapping current File System Access + idb, behavior unchanged) →
green tests → commit. Do NOT add Electron in Phase 1.

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
