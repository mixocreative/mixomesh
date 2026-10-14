# Listbridge (Cults3D publish) — execution ledger

Read first on resume. Plan: `docs/plans/2026-10-14-marketplace-publish.md` · ADR: `docs/adr/0004-marketplace-publish.md`.
Protocol: same as `overhaul-execution.md` (cheap agents, main verifies, `# fail 0`, commit to master, update this file every task).

## Owner inputs needed

- [ ] Cults3D nickname + API key (https://cults3d.com/en/api/keys) — for PB.0 and PB.11. Give via env var `CULTS_USER` / `CULTS_API_KEY` in your own shell, never pasted into chat or files.
- [x] ~~Cloudflare R2 bucket~~ — DROPPED by owner 2026-10-14: default host = automatic temporary link from this PC (cloudflared quick tunnel, PB.5b); S3/R2 kept as advanced option. PB.0 also checks whether Cults has a native (Rails direct) upload → then no host at all.
- [ ] Publish tab mockup approval — PB.9.

## Tasks

| Task | Status |
|---|---|
| PB.0 live schema check | waiting on owner key |
| PB.1 ListingPackage | done |
| PB.2 listing shot capture | done 02e7e17 |
| PB.3 adapter contract + Cults payload | todo |
| PB.4 main publish service | done 015a0d8 |
| PB.12 ingestion confirm + hold | done 3116af9 |
| PB.14 quit safety + packaged smoke | done a1ed7c9 + build fix 6fc54a8 |
| PB.13 error codes → i18n | done 11f9c6a |
| PB.15 dress rehearsal | running (sonnet) |
| PB.5 S3 file host | done |
| PB.5b tunnel file host (auto links) | done 6d9be84 (live tunnel verified) |
| PB.6 renderer bridge + caps | done |
| PB.7 package to disk | done |
| PB.8 persistence 3.5 | done 0e84e0b |
| PB.9 Publish tab (mockup gate) | done 0a1b8f2 |
| PB.10 docs | done 49c08c8 (Failure model pending PB.12; ADR status after PB.11) |
| PB.11 live publish (owner) | todo |

## Gotchas

- **Never `git commit -a` while agents are working** — 2026-10-14 a ledger `-am` swept PB.2's half-done render files into master (without the new untracked ListingShot.js → master broken); undone with `reset --soft` before push. Stage ledger by path only.
- Browser smokes are unreliable while agent smokes/builds run (shared Vite cache, CPU) — clean master timed out too. Verify browser only when no agent is running.

## Session log

- 2026-10-14 — owner: desktop only, Cults3D only, extensible to WooCommerce/ProcessWire. ADR 0004 + plan written.
- 2026-10-14 — owner: name it for reuse → **Listbridge** (portable core `src/listbridge/`, Electron runner `electron/listbridge/`, MIXOMESH glue `src/core/publish/`).
- 2026-10-14 — running in parallel: PB.1 (sonnet, src/listbridge/), PB.2 (sonnet, FrameCapture listing shot + smoke), PB.5 (opus, electron/listbridge/filehosts/s3.cjs). Main verifies + commits each. Next: PB.3 (needs PB.0 schema → owner key), PB.4, PB.6–PB.8; PB.9 mockup.
- 2026-10-14 — PB.1 909008e (+main fix: manifest path traversal), PB.5 43e0087 (+eslint now lints electron/*.cjs). Running: PB.2, PB.4 (opus), PB.8.
- 2026-10-14 — PB.2 02e7e17, PB.8 0e84e0b, PB.4 015a0d8 (full tree green: unit 401, all smokes, build, electron). Credentials file = <userData>/listbridge-credentials.bin (ADR aligned). Blueprint text pending in .tmp/blueprint-pending/listings-3.5.md → PB.10. Running PB.6+PB.7. PB.9 mockup published.
- 2026-10-14 — PB.6+PB.7 committed (full tree green: unit 408, all smokes incl. export, build, electron). Remaining: PB.0/PB.3 (owner Cults key), PB.9 (mockup approval), PB.10 docs, PB.11 live.
- 2026-10-14 — owner approved Publish mockup; owner: drop R2 → PB.5b tunnel host (cloudflared present at C:\Program Files (x86)\cloudflared). Running PB.9 + PB.5b. Cults key still not set (PB.0/PB.3 blocked).
- 2026-10-14 — owner: "fable plan and use economical agents to implement" → Fable agent revising plan (docs/plans/2026-10-14-marketplace-publish.md + ADR 0004 edits, uncommitted until main verifies). PB.9 + PB.5b still running.
- 2026-10-14 — Fable plan committed d8bfa6f (decisions D1–D8 proposed, recommendations used as defaults until owner overrides). Running: PB.9 (sonnet), PB.5b (opus), PB.0a (sonnet), PB.3a (sonnet; main.cjs registration deferred to main after PB.5b). Next: PB.12 (opus, after 5b), PB.13 (haiku, after 9), PB.14 (sonnet), PB.10 (haiku), PB.15.
- 2026-10-14 — PB.0a e736310, PB.3a f27a901 (main moved ADAPTERS registry to core index), PB.5b 6d9be84 (+main registered Cults via core loader; electron security smoke now requires cults3d + default tunnel). Running: PB.9 (sonnet), PB.12 (opus; main resolved spec conflict: failed keeps tunnel only for a retry window then closes). Next: PB.14 after PB.12 (same jobs.cjs), PB.13 after PB.9, PB.10, PB.15.
- 2026-10-14 — PB.9 0a1b8f2 (main fixes: localized S3 style options, 4-tab labels fit (icons hidden, verified by screenshot), gate vs job-failure boxes, race-free publish smoke 3/3; `SHOTS=<dir> npm run test:publish` saves screenshots). Running PB.12 (opus). Starting PB.10 docs (haiku).
- 2026-10-14 — PB.10 49c08c8: haiku draft had ~8 invented facts (fake IPC names, findExisting, runtime re-hash, "transferred" bytes, View link) — main rewrote against code. Lesson: haiku docs need line-by-line proofreading vs grep of the code.
- 2026-10-14 — PB.12 3116af9 (full tree green: unit 466, browser/publish smokes, build, electron; live tunnel Range coverage verified; Windows res.end false-finish bug found+fixed). Blueprint failure model merged. Running PB.14 (sonnet, + Keep-waiting UI wiring). Then PB.13 (error codes → i18n), PB.15 rehearsal.
- 2026-10-14 — PB.14 a1ed7c9 (early remoteId, quit prompt, Keep waiting). `npm run dist` was broken since 179b4dc (electron-builder never declared) → 6fc54a8: electron-builder 26.15.3 devDep, package version 0.1.0, electronDist=node_modules/electron (skips the hanging Electron checksum download). Full installer built: release/MIXOMESH Setup 0.1.0.exe (129 MB, unsigned → SmartScreen expected). PACKAGED SMOKE PASS: boots from app.asar, security ok, publish:describe lists cults3d + tunnel, cloudflared bundled. Next: PB.13 (haiku), PB.15 (sonnet).
- 2026-10-14 — PB.13 11f9c6a (haiku; main polished ja/zh-Hant wording; unit 479, all smokes, electron). Running PB.15 (sonnet): live tunnel test + in-app rehearsal with fake Cults (dev-only switch, packaged must ignore). Remaining after: PB.0 + PB.3b + PB.11 (owner key).
