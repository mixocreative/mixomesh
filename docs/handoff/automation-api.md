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
