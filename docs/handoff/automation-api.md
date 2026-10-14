# Automation API — execution ledger

Read first on resume. Plan: `docs/plans/2026-10-15-automation-api.md` + `docs/adr/0005-automation-api.md` (Fable, being written). Builds on launch integration (`docs/handoff/launch-integration.md`).
Protocol: cheap agents, main verifies, `# fail 0`, commit by path (never `git commit -a` / `git stash`), update this file every task.

## Owner request (2026-10-15)

"List out and suggest all possible APIs for our app, assign token-economical agents to build and test, then build and push."

## Session log

- 2026-10-15 — Fable planning API inventory, transports (CLI / batch / named pipe / localhost / stdio / hot folder), v1 BUILD NOW vs owner decisions. LI.2 still running in parallel.
