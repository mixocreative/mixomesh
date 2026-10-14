# Automation API — execution ledger

Read first on resume. Plan: `docs/plans/2026-10-15-automation-api.md` + `docs/adr/0005-automation-api.md` (Fable, being written). Builds on launch integration (`docs/handoff/launch-integration.md`).
Protocol: cheap agents, main verifies, `# fail 0`, commit by path (never `git commit -a` / `git stash`), update this file every task.

## Owner request (2026-10-15)

"List out and suggest all possible APIs for our app, assign token-economical agents to build and test, then build and push."

## Session log

- 2026-10-15 — Fable planning API inventory, transports (CLI / batch / named pipe / localhost / stdio / hot folder), v1 BUILD NOW vs owner decisions. LI.2 still running in parallel.
- 2026-10-15 — Plan + ADR 0005 committed 72da8bd. OWNER ACCEPTED all 9 recommendations ("Ok"): API on by default + Preferences toggle; confirm:true for destructive; repair.run in v1 behind confirm; NO publish.* in v1; NO localhost HTTP; --job + --result ⇒ --hidden --quit; refuse overwrite by default; limits 4 clients / 1 MiB / 32 imports / 10 min; web embed LATER. Next: G1 API.1 (ApiErrors+ApiSchema) ∥ API.3 (LaunchArgs output-path kinds). API.0 = this file.
- 2026-10-15 — G1 dispatched: API.1 (sonnet), API.3 (sonnet). Full installer build (with tests) running in background as a check.
- 2026-10-15 — API.3 committed (outputDir/outputFile kinds).
- 2026-10-15 — API.1 committed (27 methods, 13 codes). Next G2: API.2 dispatcher ∥ API.4 pipe server (security review).
- 2026-10-15 — G2 dispatched: API.2 dispatcher (sonnet), API.4 named-pipe server (sonnet; main reviews line by line).
- 2026-10-15 — API.4 committed (main reviewed hello/token/rewrite/write; fixed API.3 gap: mixo missing from OUTPUT_EXTENSIONS → saveAs impossible). Waiting API.2.
- 2026-10-15 — API.2 committed (main: bounds → print space at rest). CONTRACT GAP for API.5: project.saveAs — server must validate outputFile (+exists/overwrite) then register a WRITABLE token and forward {file:{ref,name}} (dispatcher saves through PersistenceManager.saveAs(preset) so the project stays bound), NOT expect bytes. Also: app.info appVersion must come from main (app.getVersion()). Known limits: export.run has no ids param; validate/repair ignore group ids; cost.quote ids via temp selection.
- 2026-10-15 — G3 dispatched: API.5 main wiring (sonnet, security; + saveAs writable-ref fix + appVersion from main + api_enabled KV + api:setEnabled/api:status) ∥ API.6 renderer bridge + Preferences toggle (sonnet). Fixed preload names: onApiRequest, respondApi, notifyApi, setApiEnabled, getApiStatus.
- 2026-10-15 — API.6 committed (bridge + Preferences toggle; i18n merged). Waiting API.5.
- 2026-10-15 — API.5 committed (main reviewed; added readiness gate: E_BUSY 'starting' until launch:pull handshake). Next: API.7 (--job/--result) then API.8 e2e smoke, API.9/10 docs.
- 2026-10-15 — MISTAKE: 48c324f (API.5) committed with 1 failing test (security pin assumed LF; autocrlf checkout = CRLF). Fixed in next commit (test normalises EOL). Rule reaffirmed: never commit unless the log shows # fail 0. Gotcha: Python text-mode writes on Windows emit CRLF — edit source files in binary mode.
- 2026-10-15 — API.7 dispatched (sonnet): --job/--result runner; lock-loser forwards via the pipe (exit 5 if API off/unreachable).
- 2026-10-15 — API.7 implemented (NOT yet committed; gate green: typecheck, lint, npm test # fail 0, build, test:electron). `electron/JobRunner.cjs` (pure factory) + main.cjs job branch + `ApiServer.readSessionFile` + `LaunchArgs` (`--job/--result/--hidden/--quit`, kind `jobFile`). Grammar: `MIXOMESH.exe --job job.json --result r.json [--hidden] [--quit]`; `--job` REQUIRES `--result` (a job always runs hidden and quits; `--hidden/--quit` are accepted, redundant). Exit codes: 0 ok · 2 a step failed / result unwritable · 3 bad job or args · 4 timeout (20 min total or app not ready in 120 s) · 5 API unavailable (disabled, no/stale session file, pipe refused, token rejected). Lock loser with `--job` does NOT quit: it reads the session file, speaks NDJSON to the running app's pipe (hello+token), writes the result and `app.exit(code)`s; the winner ignores its `second-instance` (no window raise). `--result` may overwrite an existing .json (caller's own file); temp+rename. Live-verified on the real built app (first-instance job, and lock-loser job against a running MIXO_SMOKE=api app). A hard-killed app leaves a stale session.json (exit 5 for a client).
- 2026-10-15 — API.7 b72f3a1 (unit 651, all smokes). Running in parallel: API.8 e2e smoke (sonnet) ∥ API.9/10 docs incl. LI.8/LI.9 (haiku; main proofreads every name vs code). Then: build-installer, packaged --launch/--api smokes, push.
- 2026-10-15 — API.9/10 docs committed (proofread: names vs code, README job.json validated by ApiSchema). Waiting API.8.
