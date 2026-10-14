# Listbridge (Cults3D publish) — execution ledger

Read first on resume. Plan: `docs/plans/2026-10-14-marketplace-publish.md` · ADR: `docs/adr/0004-marketplace-publish.md`.
Protocol: same as `overhaul-execution.md` (cheap agents, main verifies, `# fail 0`, commit to master, update this file every task).

## Owner inputs needed

- [ ] Cults3D nickname + API key (https://cults3d.com/en/api/keys) — for PB.0 and PB.11. Give via env var `CULTS_USER` / `CULTS_API_KEY` in your own shell, never pasted into chat or files.
- [ ] Cloudflare R2 bucket + access key/secret — for PB.11 (entered in the app's Connect form, stored encrypted).
- [ ] Publish tab mockup approval — PB.9.

## Tasks

| Task | Status |
|---|---|
| PB.0 live schema check | waiting on owner key |
| PB.1 ListingPackage | done |
| PB.2 listing shot capture | running (agent) |
| PB.3 adapter contract + Cults payload | todo |
| PB.4 main publish service | running (agent) |
| PB.5 S3 file host | done |
| PB.6 renderer bridge + caps | todo |
| PB.7 package to disk | todo |
| PB.8 persistence 3.5 | built, unit-green isolated (369/0); HOLD commit until browser smoke on quiet machine |
| PB.9 Publish tab (mockup gate) | todo |
| PB.10 docs | todo |
| PB.11 live publish (owner) | todo |

## Gotchas

- **Never `git commit -a` while agents are working** — 2026-10-14 a ledger `-am` swept PB.2's half-done render files into master (without the new untracked ListingShot.js → master broken); undone with `reset --soft` before push. Stage ledger by path only.
- Browser smokes are unreliable while agent smokes/builds run (shared Vite cache, CPU) — clean master timed out too. Verify browser only when no agent is running.

## Session log

- 2026-10-14 — owner: desktop only, Cults3D only, extensible to WooCommerce/ProcessWire. ADR 0004 + plan written.
- 2026-10-14 — owner: name it for reuse → **Listbridge** (portable core `src/listbridge/`, Electron runner `electron/listbridge/`, MIXOMESH glue `src/core/publish/`).
- 2026-10-14 — running in parallel: PB.1 (sonnet, src/listbridge/), PB.2 (sonnet, FrameCapture listing shot + smoke), PB.5 (opus, electron/listbridge/filehosts/s3.cjs). Main verifies + commits each. Next: PB.3 (needs PB.0 schema → owner key), PB.4, PB.6–PB.8; PB.9 mockup.
- 2026-10-14 — PB.1 909008e (+main fix: manifest path traversal), PB.5 43e0087 (+eslint now lints electron/*.cjs). Running: PB.2, PB.4 (opus), PB.8.
