# HANDOFF — Windows Electron desktop (ADR 0001 Phase 2/3)

Solo dev, all on `master`. The desktop shell is scaffolded in `electron/` + wired to the
capability model. **What's code-complete vs what still needs a real desktop run is called
out below** — packaging/running can't be verified in a headless session.

## Done (code-complete, build-verified headless)

- **Capability model** — `src/core/storage/capabilities.js`: `detectCapabilities` reads
  `window.electronAPI.capabilities` (desktop → all true) or feature-detects (web). Headless-tested.
- **`DesktopStorageAdapter`** — `src/core/storage/DesktopStorageAdapter.js`: KV via the preload
  IPC bridge; picker/fs methods declared. Import is headless-safe (touches `window.electronAPI`
  only at call time). `StorageAdapter.storage` swaps to it when `isDesktop()`. Headless-tested
  (browser stays active off-desktop; desktop shape ok).
- **Electron shell** — `electron/main.cjs` (hardened `BrowserWindow`: contextIsolation on,
  nodeIntegration off; loads `dist/index.html` or `MIXO_DEV_URL`; IPC handlers for KV → a JSON
  file in userData, `fs:readFile/writeFile`, `dialog:open/save`) + `electron/preload.cjs`
  (allowlisted `window.electronAPI` = capabilities + kv + fs). Additive — NOT in the Vite/TS
  graph, so the web build is untouched.

## NOT done — needs a real desktop environment (can't verify headless)

1. **Install + run.** `npm i -D electron` (not added to package.json to keep the lock + web
   install green), then:
   - Dev: `npm run dev` (Vite) in one shell, then `MIXO_DEV_URL=http://localhost:5173 npx electron electron/main.cjs`.
   - Built: `npm run build`, then `npx electron electron/main.cjs`.
   Verify: window opens, `storage.kind === 'desktop'`, KV persists to userData, filesystem controls appear.
2. **Route the LEAF fs sites through the adapter** (Phase 1c) — PersistenceManager open/save,
   AssetImport, DirMounts, Download currently call File System Access directly. Add the adapter's
   pickOpen/pickSave/readFile/writeFile methods (browser = FSA, desktop = IPC) and route them so
   the desktop build uses real paths. This is the bulk of the desktop payoff (real files, offline).
3. **electron-builder packaging** — `npm i -D electron-builder` + a build config (NSIS target for
   Windows), `npm run dist`. Optional code-signing (SmartScreen warning until then).
4. **Security hardening review** — CSP, IPC input validation, `will-navigate`/`new-window` guards.

## macOS — deferred (ADR 0001) until Web + Windows are production-level.
