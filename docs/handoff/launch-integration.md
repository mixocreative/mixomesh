# Launch integration — execution ledger

Read first on resume. Plan: `docs/plans/2026-10-15-launch-integration.md` (Fable, being written).
Protocol: same as `publish-execution.md` (cheap agents, main verifies, `# fail 0`, commit by path — never `git commit -a`/`git stash`, update this file every task).

## Owner request (2026-10-15)

Installable on Windows so other apps can call it: `MIXOMESH.exe --open <file>… --library <folder>`; `.mixo` double-click; single instance forwards args; installer registers App Paths. Not requested: mixomesh:// protocol, report-back/--export.

## Session log

- 2026-10-15 — Fable planning (launch args, single instance, safe path→token handoff, library mount, App Paths + .mixo association in NSIS).
- 2026-10-15 — Plan committed 311ccdb (Fable). Owner decisions 1–5 = Fable defaults until overridden. G1 running: LI.1 (sonnet, LaunchArgs.cjs), LI.3 (sonnet, mount/import entry points), LI.5 (sonnet, installer.nsh + fileAssociations). LI.0 = this file. Pending owner answer: drop bundled cloudflared (Cults uploads natively) + rename installer MIXOMESH-Setup-<v>.exe + clean release/ before dist.
- 2026-10-15 — LI.1 4068551. OWNER DECISIONS: (a) DROP bundled cloudflared from the installer (Cults uploads natively; future URL-only platform → download once on first use, SHA-256 pinned); (b) build script runs unit tests first, stops on failure. TODO after LI.5: `build-installer.cmd` → node scripts/build-installer.mjs: wipe release/ + dist/, warn on uncommitted changes, npm test, build, electron-builder, copy only installers/MIXOMESH-Setup-<v>.exe (+ print SHA-256), wipe release/ + dist/ after; artifactName MIXOMESH-Setup-${version}.exe; installers/ gitignored. Installer = NSIS wizard, per-user default %LOCALAPPDATA%\Programs\MIXOMESH, folder choosable, no admin.
- 2026-10-15 — LI.5 8dc002a. Running: LI.3 (sonnet), build-installer.cmd + drop bundled cloudflared w/ verified first-use download (sonnet). Next: LI.2 ∥ LI.4, then LI.6/LI.8/LI.9, LI.7 (owner).
