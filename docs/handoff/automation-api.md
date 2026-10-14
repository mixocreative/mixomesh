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
