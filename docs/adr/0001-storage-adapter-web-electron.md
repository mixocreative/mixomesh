# ADR 0001 — StorageAdapter: one codebase for Web + Windows (Electron)

Status: **Accepted (planning)** · Date: 2026-06-17 · Supersedes: none

> Companion runtime tracker: `HANDOFF.md` (resume state). Design lives here.

## Context

MIXOMESH is a Vite + Babylon.js browser 3D-print-prep app. Its hardest maintenance
area is the **asset "database"**: because the browser has no real filesystem, asset
persistence rides on the File System Access API's permission-gated `FileSystemHandle`
model + IndexedDB handle storage + a multi-tier resolver (live path → hash-scan relink
→ embedded bytes → ghost). This causes ghost assets, relink complexity, and
permission churn (audit findings M7 etc.).

We want the app to also run as an offline Windows desktop app where a **real
filesystem** removes most of that complexity — while keeping a web build that treats
assets as ephemeral (imported by picker, embedded in `.mixo`).

## Decision

1. **One codebase.** Core (render, edit, ratio, validation, export, `.mixo` schema)
   stays runtime-agnostic.
2. **A capability-tiered `StorageAdapter`** is the single seam for all filesystem /
   persistence / asset-resolution concerns. Runtime is detected at boot
   (`window.electronAPI` present → desktop, else web). Application logic and UI branch
   on capability **flags**, never on ad-hoc "is Electron" checks.
3. **Electron, not Tauri**, for the desktop shell — its Chromium renderer is the same
   engine the Chrome/CDP test suite already targets (Babylon/WebGL2, WebCodecs,
   `readPixels` full-res-lock, Workers). Full engine parity, no second render-test matrix.
4. **Targets now: Web + Windows. macOS deferred** until Web+Windows are production-level;
   it is additive behind the adapter, not a rewrite.
5. **`.mixo` is the interop/sync contract.** ALWAYS embed raw asset bytes; the desktop
   adapter ADDITIONALLY records a path as an optional live-recovery tier. A project
   opened on the other runtime falls to the embedded bytes → byte-identical geometry.
   The portable file is the sync unit (a synced folder gives cross-device sync for free).

## StorageAdapter surface (capability flags + methods)

**Design decision — DOMAIN-level interface, opaque refs (NOT FSA primitives).**
The storage audit inventoried ~30 call sites and suggested a thin passthrough of the
raw File System Access API (`showOpenFilePicker`, `createWritable`, `entries`, …). We
reject that: it hard-codes the browser *handle* model into the interface, so the Node
(Electron) impl would have to fake `FileSystemHandle`/`createWritable`/`entries`
semantics. Instead the interface speaks the app's domain (open/save project, import/
read/resolve asset, mount, watch). Every location token is an **opaque `ref`** — the
browser adapter owns a `FileSystemHandle`; the desktop adapter owns a random token whose
absolute path exists only in the Electron main process. **Callers never inspect a ref,
renderer state never contains an OS path, and refs never cross runtimes or sessions.** What crosses
runtimes (and lives in `.mixo`) is a serialisable **descriptor** `{ path?, contentHash,
handleKey? }`; `resolveAsset(descriptor)` turns it back into bytes via whatever tiers
the runtime supports (real path → hash-scan → embedded bytes).

```text
caps: { persistAssets, mountDirectory, relinkByPath, watchFiles, writeFiles }

Project:  pickOpenProject() -> {ref,name,bytes}|null
          pickSaveProject(suggestedName) -> {ref,name}|null
          readProject(ref) -> bytes        writeProject(ref, bytes)
Assets:   pickImportAssets(accept) -> [{ref,name,bytes}]
          readAsset(ref) -> bytes
          resolveAsset(descriptor) -> {bytes, live}|null   // tiered; descriptor from .mixo
          mountDirectory() -> {ref,name}|null               // caps.mountDirectory
          listDirectory(ref,displayParent?) -> [{name,path,ref,kind}]
          readFile(ref) -> File|Blob                        // files only
          watchAsset(ref, cb) -> unsubscribe                // caps.watchFiles (desktop)
Refs+KV:  persistRef(key,ref) / restoreRef(key) / deleteRef(key)   // handle/path store
          kvSet/kvGet/kvDelete/kvKeys                        // autosave, recent, settings
Export:   saveExport(suggestedName, bytes)                   // picker+write, else blob-download
```

- **BrowserStorageAdapter** — wraps today's File System Access + `idb` code (`ref` = handle).
  `caps` feature-detected: `writeFiles/mountDirectory/relinkByPath = 'showOpenFilePicker' in window`;
  `persistAssets = indexedDB present`; `watchFiles = false`.
- **DesktopStorageAdapter** — Electron IPC → a main-process registry (`ref` = random
  `mount_*` / `ref_*` token). The renderer cannot submit or receive absolute paths for
  mounted assets; unknown/stale tokens fail closed. All caps `true`. Injected when
  `window.electronAPI` is present.

### Refactor order (from the LEAF/LEAKED audit)

1. **LEAF — wrap cleanly behind the adapter:** `idb.js`, `PersistenceManager` doc I/O,
   `persist/AssetResolver`, `persist/RecentProjects`, `persist/Autosave`,
   `assets/DirMounts`, `assets/TextureAssets`, `print/Download`.
2. **LEAKED — pull FS logic out into the adapter first, then route:**
   `assets/AssetImport` (`_fileHandleKeyFor`→persistHandle mid-flow),
   `assets/ObjSiblings` (directory walk + getFile), `ui/AssetPanel` (`_scanDirectory`/
   `_cacheHandles` session handle tree), `ui/ViewportDrop` (reads OS DataTransferItem handles).
3. **Core seams — confirmed runtime-agnostic, do NOT touch:** `ImportNormalizer`,
   `ScaleMath`, `print/ExportContext`, `print/PrintPipeline` (+ PrintPrep/ObjWriter/
   ThreeMFWriter). `PersistenceManager` *owns* the I/O funnel — the adapter injects there.

## UI capability-gating map

From the UI audit. Each control gates behind a capability; on web (flag false) the
control is **hidden**, not shown-and-broken. Today several appear and throw on web.

| Control | Site | Gate flag |
|---|---|---|
| New / Save project | `ProjectMenu.js:24,26` | `writeFiles` |
| Open project | `ProjectMenu.js:25` (showOpenFilePicker) | `writeFiles` |
| Save As | `ProjectMenu.js:27` (showSaveFilePicker) | `writeFiles` |
| Recent projects | `ProjectMenu.js:29,141` (IDB read) | `persistAssets` |
| Relink asset | `ProjectMenu.js:215` (showOpenFilePicker) | `relinkByPath` |
| Mount Directory | `AssetPanel.js:62‑64` → `DirMounts.js:15` (showDirectoryPicker) | `mountDirectory` |
| Last-mount persist (IDB) | `AssetPanel.js:170,181,211‑213` | `mountDirectory`/`persistAssets` |
| Drag-drop OS files | `ViewportDrop.js:81,100‑102` (getAsFileSystemHandle) | `mountDirectory` (handle) / falls back to blob drop |
| Export downloads (PNG/turntable) | `ScenePanel.js:775,811` → `Download.js:7` | `writeFiles` |
| Export OBJ/3MF/STL | `PrintPanel.js:449,452,455` → `Download.js` | `writeFiles` |
| Panel layout persist | `Workspace.js:243` (localStorage) | none — local-only, no adapter |

**Direct-storage reads to route through the adapter later:** `AssetPanel.js:5,170,181`
(imports + calls `kvSet/kvGet/getHandle` directly); `ProjectMenu.js:141`
(`getRecentProjects()` reads IDB internally). **Web fallback already partial:**
`Download.js:~15` blob-URL download when `showSaveFilePicker` is absent — so exports
degrade gracefully; the *pickers* (open/save/dir/relink) are the ones that throw today.
`watchFiles` is unused in UI today (desktop-only, Phase 2).

## Consequences

Positive:
- Asset-DB tier soup becomes an adapter concern → simpler, testable, less ghost-prone.
- Desktop gets real paths + offline + live relink/watch.
- Core + render + export + `.mixo` unchanged → the 101 headless + browser smoke + export
  smoke validate BOTH runtimes (same engine). One adapter-conformance suite (run against
  both impls) + one `.mixo` cross-runtime round-trip test guard the seam.
- One repo, one version, CI builds both from one commit → no drift.

Negative / costs:
- Electron adds a build target + security hardening (contextIsolation, no nodeIntegration,
  IPC allowlist) + optional auto-update.
- Windows code-signing (optional first; SmartScreen warning until then).
- Always-embed makes web `.mixo` larger for heavy scenes (known/acceptable).

## Phased plan

- **Phase 0** — audit + this ADR.
- **Phase 1** — extract `StorageAdapter` + `BrowserStorageAdapter` (web-only, behavior
  unchanged); all tests stay green. No Electron.
- **Phase 2** — Windows Electron shell + `DesktopStorageAdapter` (Node fs via IPC).
- **Phase 3** — electron-builder (NSIS) installer, security hardening, optional auto-update.
- **macOS** — parked.
