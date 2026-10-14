# ADR 0005 — Automation API: drive MIXOMESH from other apps

Status: **Accepted** · Implemented (2026-10-15) · Date: 2026-10-15 · Plan: `docs/plans/2026-10-15-automation-api.md` · Builds on ADR 0001 (opaque refs), ADR 0004 (Listbridge), launch integration (`docs/plans/2026-10-15-launch-integration.md`).

**Implemented in:** `src/core/api/ApiErrors.js` · `src/core/api/ApiSchema.js` · `src/core/api/ApiDispatcher.js` · `electron/ApiServer.cjs` · `electron/JobRunner.cjs` · `electron/LaunchArgs.cjs` · `electron/main.cjs` · `src/core/LaunchRequests.js` · `README.md` (Automation section) · `Blueprint.md` (ADR 0005 section).

## Context

The owner wants other tools (own scripts, shop backends, possibly a Blender add-on) to launch MIXOMESH, add objects, set the library and get results back: exported files, a validation / readiness report, a cost quote, a thumbnail. Launch integration already covers the fire-and-forget half (`--open`, `--library`, single-instance forwarding, App Paths). Nothing returns results today, and the export / render / validation seams are renderer code that needs the real engine (GPU, WebCodecs, WASM) — a Node-only pipeline would duplicate the export seam, which AGENTS forbids.

## Decision

1. **One command set, two transports.** A runtime-agnostic dispatcher (`src/core/api/ApiDispatcher.js`) exposes JSON-RPC 2.0 methods over existing seams (`PersistenceManager`, `ViewportDrop.importPicked`, `AssetPanel.mountFromRef`, `MeshValidator`, `PrintReadiness`, `PrintCost`, `PrintPipeline.collectExportFiles`, `RenderOutput`). Transports in v1: a **Windows named pipe** (`\\.\pipe\mixomesh-<hash>`, NDJSON) for live sessions and a **job file** (`MIXOMESH.exe --job job.json --result out.json [--hidden] [--quit]`) for one-shot converts. A job started while an instance is running is forwarded over the pipe; the result file is still written by the second process.
2. **Same-user only, token-gated.** The pipe is created by the user's own process; every connection must open with `hello {token}` where the token is a 32-byte random value written to `<userData>/api/session.json` (user-profile ACL) for the life of the process. No localhost HTTP/WebSocket server (browser-reachable, DNS-rebinding/CSRF class) — rejected for v1.
3. **Paths stay in main (ADR 0001 extended).** Path-taking params (`scene.import.files`, `library.mount.dir`, `project.open/saveAs.file`, `export.run.outDir`, `render.*.outFile`) are validated in `electron/` with `validateLaunchPath` (realpath, device/ADS/NUL rejects, kind, size, allowlist; new kinds `outputDir`, `outputFile`) and turned into opaque tokens; the renderer only ever receives `{ref, name}` and returns bytes. Main writes outputs atomically into the caller-named existing directory, refuses to overwrite unless `overwrite:true`, and returns absolute paths to the caller only. A static test asserts no absolute path appears in any frame sent to the renderer.
4. **Fail closed, no hidden dialogs.** Destructive or consent-worthy methods (`project.new/open` on a dirty project, `scene.remove`, `repair.run`) return `E_CONFIRM_REQUIRED` / `E_DIRTY` unless the request carries `confirm:true`. `publish.*` is not exposed in v1 (owner decision pending). Web / OPFS runtimes answer `E_UNSUPPORTED` for path-taking methods; the dispatcher still exists so a `postMessage` transport can be added later.
5. **Stable contract.** `apiVersion` (integer, bumped only on breaking change) in `hello`, `app.info` and every job result; `app.capabilities` lists methods for discovery. Errors are JSON-RPC errors with `data.code` from a fixed set (`E_INVALID_PARAMS`, `E_METHOD_NOT_FOUND`, `E_NOT_FOUND`, `E_PATH_REJECTED`, `E_BUSY`, `E_CONFIRM_REQUIRED`, `E_DIRTY`, `E_CANCELLED`, `E_UNSUPPORTED`, `E_EXPORT_GATE`, `E_LIMIT`, `E_TIMEOUT`, `E_INTERNAL`). Job exit codes: 0 ok, 2 step error, 3 invalid job, 4 timeout.
6. **Limits.** One request in flight (serial, same busy gate as launch batches), 4 clients, 1 MiB per frame, 32 imports per request, 1 GiB per file, 10 min per request, 64 steps / 20 min per job, events ≤ 50/s.
7. **Verification.** Pure modules are unit-tested with fakes; the contract is pinned end-to-end by `MIXO_SMOKE=api` driving the real built app over the pipe (import → validate → export → thumbnail → save → forwarded job) in `npm run test:electron`, plus the packaged smoke.

## Consequences

- Other apps get results (files, reports, images) without any screen scraping; the Export button and the API produce byte-identical files because they share `collectExportFiles`.
- The preload bridge grows three OPTIONAL methods (`onApiRequest`, `respondApi`, `notifyApi`); `REQUIRED_BRIDGE` is unchanged so an older preload still boots. `electron/main.cjs` gains the server start, two sender-checked handlers and the job branch; the security test keeps counting `ipcMain.handle` once.
- Windows only for the pipe (macOS deferred, as in ADR 0001). A Blender/Python caller uses the pipe directly or, in v2, the `--rpc` stdio relay — the only Blender-related work, matching the overhaul's "ToolAdapter typedef, no sidecar" rule.
- A hidden instance that needs user consent fails fast instead of hanging; callers must pass `confirm:true` deliberately.

## Rejected

- Localhost HTTP/WebSocket (browser-reachable surface for a hobbyist desktop app).
- A Node-only headless export pipeline (duplicates the export seam; loses render capture).
- Hot-folder polling (no results, ambiguous ordering, anyone with folder access can trigger work).
- Passing paths to the renderer, or letting the renderer choose output locations.
- Exposing publishing in v1 (outward-facing, paid files, secrets).
