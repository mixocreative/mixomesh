# Launch integration — execution ledger

Read first on resume. Plan: `docs/plans/2026-10-15-launch-integration.md` (Fable, being written).
Protocol: same as `publish-execution.md` (cheap agents, main verifies, `# fail 0`, commit by path — never `git commit -a`/`git stash`, update this file every task).

## Owner request (2026-10-15)

Installable on Windows so other apps can call it: `MIXOMESH.exe --open <file>… --library <folder>`; `.mixo` double-click; single instance forwards args; installer registers App Paths. Not requested: mixomesh:// protocol, report-back/--export.

## Session log

- 2026-10-15 — Fable planning (launch args, single instance, safe path→token handoff, library mount, App Paths + .mixo association in NSIS).
- 2026-10-15 — Plan committed 311ccdb (Fable). Owner decisions 1–5 = Fable defaults until overridden. G1 running: LI.1 (sonnet, LaunchArgs.cjs), LI.3 (sonnet, mount/import entry points), LI.5 (sonnet, installer.nsh + fileAssociations). LI.0 = this file. Pending owner answer: drop bundled cloudflared (Cults uploads natively) + rename installer MIXOMESH-Setup-<v>.exe + clean release/ before dist.
