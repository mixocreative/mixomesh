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
- **Asset surface (overhaul task 4.2, 2026-10-14):** `resolveAsset(source,{contentHash}) ->
  {status:'embedded'|'linked'|'changed'|'missing', blob|null}`; `persistRef(ref) -> stableKey`,
  `restoreRef(stableKey) -> ref|null` (re-validated), `deleteRef(key)`;
  `findMoved(source,{contentHash,onProgress,limit,refKey}) -> {source|null, blob|null, scanned}`
  (explicit only — load never scans). Desktop session tokens still never persist; persistence is
  by stable key → main-only `mixo-refs.json`, kept separate from the KV the renderer can read.
  Desktop `watchFiles` stays false until implemented.

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

## Addendum 2026-10-14 (Overhaul Phase 4 completion)

**Overhaul Phase 4** (2026-10-14) completed all asset-model refactoring:

### Final StorageAdapter Surface (async/Promise-based)

**Project I/O:**
- `pickOpenProject()` → `{ref, name, file: File|Blob} | null`
- `pickSaveProject(suggestedName)` → `{ref, name} | null`
- `writeFile(ref, data)` → atomic write (browser: createWritable + abort; desktop: temp file + rename in main)

**Asset Import & Export:**
- `pickImportAssets({multiple?})` → `Array<{ref, name}>`
- `saveExport(blob, suggestedName, hint?)` → boolean (false = cancelled; browser falls back to anchor download; desktop has no fallback)
- `refForDrop(item)` → opaque ref | null (call synchronously inside drop event; desktop preload via `webUtils.getPathForFile`)

**Asset Resolution & References (task 4.2, 4.3):**
- `resolveAsset(source, {contentHash?})` → `{status: 'embedded'|'linked'|'changed'|'missing', blob: Blob|null}` — reads ONE source, never scans (Decision 3)
- `persistRef(ref)` → stable key (`dir_`/`file_` + 32 hex)
- `restoreRef(key)` → re-validated session ref | null
- `deleteRef(key)` → void
- `findMoved(source, {contentHash, onProgress?, limit?, refKey?})` → `{source: AssetSource|null, blob: Blob|null, scanned: number}` — only hash walk, user-invoked only (task 4.3)
- `hasRef(key)` → boolean (no permission prompt; for lost-recent-project checking)

**Routing & Boot (task 4.4):**
- `ready()` → void | rejects with `storageUnavailable(...)` — browser without FSA → blocking error; IndexedDB timeout (5 s) → continue with `persistAssets=false`; desktop bridge missing or timeout (10 s) → blocking error
- `listDirectory(ref, parentPath?)` → `Array<{name, path, kind: 'file'|'directory', ref}>`
- `readFile(ref)` → File | Blob

**Cross-Session KV (task 4.4):**
- `kvSet(key, value)` → void
- `kvGet(key)` → any
- `kvDelete(key)` → void
- `kvKeys()` → string[]

### Desktop (Electron) Token Rules

**Token persistence (`<userData>/mixo-refs.json`, main-process only):**
- Desktop `persistRef` writes to a main-only registry: `{kind, absolutePath, name}` keyed by sha256(normalised path)
- Renderer never receives or submits absolute paths; all refs are opaque session tokens (`mount_*` / `ref_*`)
- `restoreRef` checks file exists, kind (file/directory), R_OK permission; mints fresh token or returns null
- Relative reads cannot escape the folder; symlinks are skipped

**Token capabilities:**
- Project open/save tokens: WRITABLE (flag persists, enables recents recovery)
- Import/mount/drop tokens: read-only
- Write operations enforce 1 GiB cap (desktop `fs:writeFileRef` refuses oversize)
- Session tokens never persist; persistence only via stable key → main-only registry

**Browser implementation:**
- Refs are opaque `FileSystemHandle` (web File System Access API)
- Directory key = sha256(name + first sorted entry name); file key = sha256(name + size + lastModified)
- Stored in IndexedDB `handles` store; `_n` suffix on collision
- Write permission is only requested for project save/open handles; import/mount handles are used read-only

### Asset Source (`storage/AssetSource.js`)

Every asset entry carries an optional `source: {kind: 'folder'|'file', refKey, path?, label?}` indicating live-file linkage:
- `kind='folder'`: mounted directory; `refKey` = persisted folder key; `path` = relative path within folder
- `kind='file'`: loose drag-drop file; `refKey` = persisted file key; `path` unused
- `null` = embedded-only, no live link (Snapshot)

`resolveAsset(source, {contentHash})` checks ONE source (no scan, Decision 3); returns status + blob:
- **`embedded`** — no source or source tier fails; fallback to fileData/textureImages in `.mixo`
- **`linked`** — source resolves and matches contentHash
- **`changed`** — source resolves but contentHash mismatch (live file modified since save); load uses the EMBEDDED copy, the user refreshes via `RelinkAssetCommand` (task 4.5)
- **`missing`** — source refKey invalid or permission denied; fallback to embedded

**Asset persistence & migration:**
- Schema v3.4 (task 4.1): asset entry adds `source` + `displayName` derived from legacy `directoryHandleKey`, `fileHandleKey`, `originalPath`
- Legacy fields still written for one minor version (backward compat); new `source` field authoritative for phase 4+
- Load never scans (task 4.3): one `resolveAsset` per link; missing/changed falls through to embedded bytes
- Explicit "Find moved file..." action (asset Properties) calls `findMoved` with progress overlay; user-invoked only

### Boot Sequence (task 4.4)

1. Call `await storage.ready()` before UI init
   - Browser without File System Access → blocking "Browser not supported"
   - IndexedDB unavailable (no response in 5 s) → log warning, continue with `persistAssets=false` (web-only, no recent projects)
   - Desktop bridge missing or `storage:ready` > 10 s → blocking "Desktop storage unavailable"

2. PersistenceManager.init() and UI init only after ready

3. Folder-remount prompt (desktop only) before autosave recovery offer

### Summary

The StorageAdapter seam is a domain-level interface (opaque refs, no FSA/idb primitives leaking to renderer). Asset resolution is tiered (live path → file handle → embedded → ghost) but load never scans. Persistence is by stable key, with desktop main-process registry (`mixo-refs.json`) keeping absolute paths invisible to the renderer. The boot gate ensures storage is available before UI init. All calls (project open/save, import, export, KV, asset resolution) route through the adapter; direct File System Access and IndexedDB live only in `StorageAdapter.js` and `idb.js`.

## Addendum 2026-10-14 (tasks 6.1/6.2 — security hardening)

Phase 3's security hardening landed ahead of the installer: sandboxed, isolated renderer;
navigation and popups locked to the app document; permissions denied except clipboard write;
IPC sender frames validated; one meta-tag CSP shared by web and desktop. Dialogs are
descriptor-only (sanitised in main, export extension whitelist); export writes mint no renderer
token; writable tokens come only from project dialogs or their persisted recents keys. Known
concessions: `'unsafe-eval'` for the Embind glue of the vendored WASM libraries (until rebuilt
with `DYNAMIC_EXECUTION=0`), and `fs:registerDropped` trusting a preload-supplied path
(read-only), because Electron offers no main-side drop verification.

## Addendum 2026-10-14 (Phase 8 — WebKit / OPFS tier, responsive + touch)

**Decision.** The "Chrome/Edge only" stance is relaxed for WebKit. All iOS and iPadOS browsers
are WebKit, so Safari support is the only way to reach iPad and iPhone. AGENTS rule 5 now reads:
Chrome/Edge = full app; Safari/WebKit = supported through a third storage tier; Firefox and other
engines stay blocked at boot (`capabilities.js detectEngine` + `engineGate`, task 8.1).

**Third tier: `OpfsStorageAdapter` (task 8.2).** Same adapter surface; picked by
`detectStorageTier` when there are no File System Access pickers but OPFS exists, and never for
blocked engines. What changes for the user:
- Projects live in the browser (OPFS `Projects/`), listed in an in-app chooser; Save needs no OS
  dialog. Opening an outside `.mixo` copies it in (`importProjectFile`).
- Imports come from `<input type=file multiple>`; refs are read-only `File`s, so bytes are always
  embedded.
- Exports go to the share sheet on touch Apple devices ("Save to Files"), else a download.
- No live links: `mountDirectory`, `relinkByPath` and `watchFiles` are false; `resolveAsset`
  always reports `embedded`; `findMoved` never finds. The capability flags hide those controls,
  as the UI capability-gating map above already requires.

**Form factors (tasks 8.3–8.6).** iPad gets the full app: touch camera and selection, larger gizmo
handles plus a numeric Transform sheet on coarse pointers, and slide-over or bottom panel sheets
below 1280 px. Below 768 px the app is a read-only viewer (`ViewerMode.js`): it opens files, lists
objects and shows name, size and scale, with editing blocked at the input layer. Layout tiers come
from one pure function (`ViewerModel.layoutModeForWidth`) mirrored by the CSS breakpoints.

**PWA (task 8.7).** Manifest + service worker on the hosted https build only (never the dev
server, never Electron), so an iPad can install the app and open it offline.

**Consequences.** `.mixo` stays the interop format across all three tiers; a project saved on an
iPad opens on desktop with every byte embedded. WebKit coverage rests on unit tests, emulated
touch and narrow-width smokes; real-device testing (iPad, iPhone) is an owner check. WebKit was
never run in CI.
