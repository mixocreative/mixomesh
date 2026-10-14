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
- 2026-10-15 — LI.3 a9bf783. Running: build-installer + drop cloudflared (sonnet), LI.4 renderer (sonnet; contract names fixed: pullLaunchRequests / onLaunchRequests, batch {id, items[{kind,ref,name}], library, errors[]}). LI.2 waits for main.cjs to be free.
- 2026-10-15 — LI.4 778a3c8; build-installer.cmd + cloudflared drop 2034998 (installer 109.9 MB → installers/MIXOMESH-Setup-0.1.0.exe + .sha256; full tree green unit 527). Running LI.2 (sonnet; main reviews line by line). Owner re-asked: add objects to an ALREADY RUNNING app = second-instance forwarding (LI.2) — confirmed in scope.
- 2026-10-15 — LI.2 43f7caa (main reviewed line by line: lock before ready, trusted handle, basenames only, reset on reload; known minor: >16 queued batches dropped with console.warn). Running LI.6 (sonnet: launch smoke incl. real second instance). Next LI.8/LI.9 docs (may merge with automation-API docs), LI.7 owner.
- 2026-10-15 — LI.6 caf0a2d (dev launch smoke 2→3 objects, second exits 0 ~150 ms; packaged --launch PASS 148 ms). build-installer.cmd bugs found by main: bare `find` resolved to Git's GNU find (walked C:\Windows) → pinned %SystemRoot%\System32\find.exe; double-click pause also hung callers using cmd /c → added --no-pause. LI.8/LI.9 docs folded into API.9/API.10 (one 'Automation' README section). Remaining LI: LI.7 owner installer-registry check.
- 2026-10-15 — Launch integration DONE (LI.1–LI.6, LI.8/9 docs via API.9/10); packaged --launch PASS. Owner-only: LI.7 installer registry check (silent install → reg query App Paths/Software\MIXOMESH/.mixo → uninstall).
