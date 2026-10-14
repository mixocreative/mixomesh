# Listbridge — marketplace publishing, Cults3D (desktop) · plan (rev 2, 2026-10-14)

Design: `docs/adr/0004-marketplace-publish.md` · Ledger: `docs/handoff/publish-execution.md` (read first on resume).

## Binding owner decisions

- Desktop (Electron) only; Cults3D only for now. Architecture reusable by other projects and future
  self-hosted shops (WooCommerce, ProcessWire) → **Listbridge**: portable core `src/listbridge/` (zero
  MIXOMESH / Babylon / DOM / Node imports, pinned by `tests/listbridge-core.test.mjs`), Electron runner
  `electron/listbridge/`, MIXOMESH glue `src/core/publish/` + `src/ui/print/Publish*.js`.
- **Zero user setup beyond the platform's own API key.** Default file transfer for URL-only platforms =
  automatic temporary link from the user's PC through a Cloudflare **quick** tunnel (no account), with
  `cloudflared` **bundled** in the installer (pinned version + SHA-256). S3/R2 stays as an *advanced*
  option only. No Cloudflare/R2/S3 registration, nothing to install.
- Publish tab = 4th tab of the Print panel, desktop only ("Save listing package…" also on web). Mockup
  approved.
- Cults3D API facts are community-documented only (endpoint `https://cults3d.com/graphql`, Basic auth
  `nickname:api_key`, `createCreation(fileUrls, imageUrls ≤ 10 each)`, ~60 req/30 s, ~500/day, maybe
  `visibility`). **Confirmed only by live introspection (PB.0)** with the owner's key in env vars
  `CULTS_USER` / `CULTS_API_KEY` (never in chat, files, tests or logs). PB.0 also looks for a native
  upload path (Rails/ActiveStorage direct upload) → if present, Cults needs **no tunnel at all**.

Rules: AGENTS.md (no slicer, export seam unchanged, one-mesh-one-shader, CSP, Blueprint edit in the same
commit as any contract change). Network + secrets in Electron main only. New UI = mockup gate.

## Verification protocol (main session, before every commit — same as the ledger)

1. Re-read the task block + every cited path (code is the truth).
2. Dispatch by tier with `Agent` (haiku / sonnet; opus only where this plan says so). Prompt = the task
   block + AGENTS rules + "run the Accept checks, report diff + test output". Subagents never commit.
3. Main verifies: `npm run typecheck && npm run lint && npm test` → `# fail 0`; plus the task's listed
   smoke (`npm run test:electron` for anything under `electron/`; `npm run test:browser` /
   `test:export` for renderer work — only when no agent is running, shared Vite cache). Read the diff.
4. Stage **by path** (never `git commit -a` while agents work). One task per commit,
   `feat|fix|docs: PB.x <title>` + attribution lines. Tick the ledger in the same push.
5. Blueprint.md edits ship in the same commit as the contract change they describe.

## Done (commit refs)

| Task | What landed | Commit |
|---|---|---|
| PB.1 | `src/listbridge/core/package.js` (model, `validateListing`, `planBundle`, `toManifest`/`fromManifest` w/ path-traversal guard), `core/adapter.js` (`assertAdapter`), `index.js`, import-boundary test | 909008e |
| PB.2 | `src/core/render/ListingShot.js` + `FrameCapture.captureListingShot` (square, outline/gizmo suppressed, settled bounce), `tests/listing-shot.test.mjs` | 02e7e17 |
| PB.4 | `electron/listbridge/{credentials,transport,jobs,index}.cjs` (safeStorage store, rate-limit backoff, resumable 6-step job, `publish:*` IPC via trusted `handle()`), `main.cjs` wiring (`LISTBRIDGE_ADAPTERS = []`), preload `electronAPI.listbridge`, electron smoke probe | 015a0d8 |
| PB.5 | `electron/listbridge/filehosts/s3.cjs` SigV4 host (advanced option), fake-S3 tests, eslint for `electron/*.cjs` | 43e0087 |
| PB.6 | `caps.publish`, `src/core/publish/PublishClient.js` (package from `PrintManager.collectExportFiles` + listing shot, IPC, outcome → `project.listings`) | 37f18ad |
| PB.7 | `src/core/publish/ListingPackageExport.js` — `<title>.listbridge.zip` (`listing.json` + `images/` + `files/`) via `storage.saveExport`, works on every tier | 37f18ad |
| PB.8 | `project.listings[]` schema 3.5 + migration, `src/core/publish/Listings.js` (normalise/upsert, secret-named keys dropped) | 0e84e0b |

Blueprint text for 3.5 still sits in `.tmp/blueprint-pending/listings-3.5.md` (→ PB.10).

## Running now (not re-planned) — what main must verify when they land

**PB.9 Publish tab UI (sonnet).** Files: `src/ui/print/PublishTab.js` (new), `src/ui/print/PublishModel.js`
(untracked, pure helpers), `src/ui/PrintPanel.js` (`TABS` += 'publish' only when `caps.publish`),
`src/core/publish/PublishClient.js` (`retryPublish` added), i18n `en/ja/zh-Hant.json`.
Verify: `npm run i18n:check` clean (every `publish.*` key in all three locales); tab absent on web
(`caps.publish=false`) and in `npm run test:browser`; `npm run test:electron` green; a second
"Publish" click while a job runs is impossible (one job at a time); the primary button names platform +
price (`primaryAction`); the key field is a password input and never re-shown; progress uses
`applyProgress` and shows `issues[]` from an `invalid` outcome; "View on Cults3D" uses `result.url`;
retry after failure calls `retryPublish` (persists outcome); `ui-screenshot.mjs` evidence before
claiming the tab renders. Unit tests `tests/publish-tab.test.mjs` exist for every PublishModel export.

**PB.5b tunnel file host + bundled cloudflared (opus).** Files: `electron/listbridge/filehosts/tunnel.cjs`
(untracked), `scripts/fetch-cloudflared.mjs`, `electron-builder.yml` `extraResources`, `vendor/cloudflared/`
(git-ignored), `package.json` `dist`/`fetch:cloudflared`, likely `index.cjs` (`FILEHOST_TYPES.tunnel`,
default host for `transfer:'url'`) and `jobs.cjs` ("hold" until confirmed). Verify:
- `tests/listbridge-tunnel.test.mjs` runs a FAKE cloudflared under plain node (no network); real
  binary never spawned in `npm test`.
- `fetch-cloudflared.mjs` pins version + SHA-256 and FAILS the build on mismatch; `vendor/` git-ignored;
  Apache-2.0 LICENSE shipped; runtime also re-hashes the bundled exe before spawning (or the plan's PB.14
  adds it).
- Server binds `127.0.0.1` only; only `/<token>/<name>` served; HEAD + GET; 404/405/410 as documented;
  `close()` kills the child tree (`taskkill /T /F` on win32) and the process-exit hook is installed.
- `index.cjs`: `fileHostId` omitted + `transfer:'url'` → tunnel by default; tunnel needs NO credential
  record (`fileHostFor` must not look up `filehost:tunnel`); `publish:describe` lists it with
  `credentials: []`; S3 still selectable.
- `jobs.cjs`: if a "hold" was added, cleanup for a `requiresUptime` host runs only after confirm or
  cancel; `npm run test:electron` + `tests/listbridge-runner.test.mjs` green; no behaviour change for S3.
- Missing binary → the `NOT_INSTALLED` / `BUNDLE_MISSING` message reaches the UI as a failed `host` step
  (no hang); startup timeout 30 s honoured.
- Blueprint: none yet → covered by PB.10 (must mention tunnel + bundled binary + hash pin).

## Remaining tasks

Parallel groups: **G1** = {PB.0a, PB.3a, PB.12, PB.13, PB.14} touch disjoint files and can run at once
(PB.3a vs PB.12 both edit `jobs.cjs`? No — PB.3a is pure `src/listbridge/`; PB.12 edits `jobs.cjs` +
`tunnel.cjs`; PB.14 edits `main.cjs`/`PublishClient.js`; PB.13 edits i18n + `PublishModel.js`
(coordinate with PB.9 landing first)). **G2** after PB.0 result = {PB.3b, PB.10}. Then PB.15 → PB.11.

### PB.0a Introspection script (no key needed to write) — tier: sonnet · G1 · not blocked

Goal: the script the owner runs once, so PB.0 is a 2-minute owner action, not an agent session.
Files: `scripts/cults-introspect.mjs` (new), `tests/cults-introspect.test.mjs` (new, fake responses),
`docs/reference/` (new dir; output lands there), `.gitignore` unchanged (the JSON has no secrets).
Behaviour: reads `CULTS_USER` / `CULTS_API_KEY` from env only (exits 2 with a one-line hint if unset;
never echoes them); POSTs the standard introspection query to `https://cults3d.com/graphql` with Basic
auth; writes `docs/reference/cults3d-schema.json` (full `__schema`) and
`docs/reference/cults3d-findings.md` (generated, human-readable) answering, in this order:
1. `createCreation` / `updateCreation` argument names + types (incl. nested inputs); whether a
   `visibility` / `draft` / `published` arg or enum exists; description format (Markdown/HTML field name).
2. Price: type (`Money`? float? integer cents?), currency arg/enum, any min price; `license` enum values;
   `category`/`subcategory` ids and whether a `categories` query exists; tags: arg type + any limit.
3. Anything AI-related (`ai`, `generated`, `createdWithAi`…) across all input types.
4. **Native upload path**: every mutation / field whose name matches `/upload|directUpload|blob|signed|
   presign|attachment|createSignedUrl/i`, with its full signature. If found, PB.3b builds on it and the
   tunnel becomes a fallback, not the default.
5. Read-back queries: `me`, `myCreations`/`creations(user:)`, single `creation(id)` with its `files` /
   `images` status fields (needed for duplicate detection and ingestion confirm).
6. Rate-limit headers actually returned (`x-ratelimit-*`, `retry-after`).
Accept: `node scripts/cults-introspect.mjs` without env → exit 2, no network; unit test feeds a fixture
introspection JSON through the same reporter and asserts the findings sections; `npm run lint`/`test`
`# fail 0`. The script makes ≤ 3 requests (introspection + optional `me` + `categories`) to respect the
60/30 s limit.

### PB.0 Run introspection — tier: OWNER (+ main reads the output) · blocked on key

Owner: set `CULTS_USER` / `CULTS_API_KEY` in their own shell, run `node scripts/cults-introspect.mjs`,
commit `docs/reference/cults3d-*.{json,md}` (main checks they contain no key before commit:
`grep -i` for the nickname/key is NOT the check — the script never writes them; main reads the diff).
Unblocks PB.3b, PB.10 (license/category text), PB.11.

### PB.3a Cults3D adapter on community schema — tier: sonnet · G1 · not blocked

Goal: ship a working adapter now, structured so PB.3b only edits the payload builder + a fixture.
Files: `src/listbridge/adapters/cults3d.js` (new, pure), `src/listbridge/index.js` (export),
`tests/listbridge-cults3d.test.mjs` (new), `tests/fixtures/cults3d/*.json` (request/response fixtures),
`electron/main.cjs` (`LISTBRIDGE_ADAPTERS = [cults3dAdapter]` — loaded through the same dynamic
`import()` path `index.cjs` already uses, so main stays CJS; or pass an adapter *loader* to
`registerListbridgeIpc`).
Behaviour: `describe()` → `{id:'cults3d', label:'Cults3D', transfer:'url', maxFiles:10, maxImages:10,
currencies:['EUR','USD','GBP'] (placeholder until PB.0), fields:[...], credentials:['nickname','apiKey']}`;
`validate(pkg)` (file extensions Cults accepts; ≥1 printable file; image mime png/jpeg); `authHeaders`
→ `Authorization: Basic base64(nickname:apiKey)`; `buildCreate(pkg, ctx)` → GraphQL `createCreation`
with `fileUrls`/`imageUrls` from `ctx.*[].url` (throws if any url missing), title, description, tags,
price, license, category, `visibility` only when the adapter is told the enum exists (feature flag read
from `describe()`-level constant, flipped in PB.3b); `buildUpdate(remoteId, …)`; `parseResult` maps
GraphQL `errors[]` + `creation.errors` → typed issues, returns `{remoteId, url, status}`;
`testConnection()` → `{ me { nickname } }`-style query (placeholder name, PB.3b fixes).
**No** `buildConfirm` yet (PB.12 decides the confirm model). Every assumption marked with a
`// COMMUNITY-DOCUMENTED — confirm in PB.0` comment and listed at the top of the file.
Accept: `tests/listbridge-cults3d.test.mjs` covers describe/validate/build/parse incl. error mapping;
boundary test still passes (no new imports); `npm run test:electron` shows `platforms[0].id ===
'cults3d'`; `publish:testConnection` against the fake GraphQL server in `listbridge-runner.test.mjs`
returns ok/not-ok correctly.

### PB.3b Reconcile adapter with the live schema — tier: sonnet · G2 · blocked on PB.0

Files: `src/listbridge/adapters/cults3d.js`, its fixtures/tests, `docs/reference/cults3d-findings.md`
(tick each assumption). Behaviour: payload matches `docs/reference/cults3d-schema.json` exactly
(argument names, price representation, license + category enums, `visibility` if real, AI flag if real —
otherwise `madeWithAi` is appended to the description as a one-line disclosure, see decision D4);
if PB.0 found a native upload mutation → add `transfer:'direct'` branch (`buildUpload` requests per
file, runner already handles 'direct' = no host) and make it the default; `buildConfirm`/`parseConfirm`
from the `creation(id){files{…}}` read-back when it exists; `findExisting(pkg)` optional member (title +
recent createdAt) for duplicate protection on retry. Accept: fixture tests regenerated from the schema
(a test loads `cults3d-schema.json` and asserts every argument the builder emits exists in the schema
with the right type → schema drift fails the suite); `# fail 0`.

### PB.12 Ingestion confirm + hold for uptime hosts — tier: **opus** (protocol/concurrency: a wrong
confirm either leaks paid files or publishes a listing whose files never arrived) · G1 · not blocked,
but must land AFTER PB.5b (edits the same files)

Gap: Cults downloads `fileUrls` asynchronously after `createCreation` returns. With the tunnel host the
link dies when the job ends, so the job must stay open until ingestion is actually finished; today
`confirm` is 10 polls × 5 s (50 s) and only via an adapter query, and `tunnel.cjs` does not know
whether anything was fetched.
Files: `electron/listbridge/filehosts/tunnel.cjs` (per-object `served` = at least one GET that sent the
full body; `Range` support = 206 + `Accept-Ranges: bytes`, since Rails/aria-style fetchers use it;
`stats()` → `{served, total}`), `electron/listbridge/filehosts/s3.cjs` (no `stats()` → confirm falls
back to the adapter query / time-box), `electron/listbridge/jobs.cjs` (confirm step: confirmed when
`host.stats().served === total` AND (adapter confirm, if present, says ingested); otherwise keep
polling up to `confirm.holdMs` default 15 min, emitting `running` progress "Cults is downloading (3/5)";
cancel still works mid-hold; after the hold expires the job FAILS at `confirm` with hosted copies kept
so `retry` resumes the wait — for a tunnel host that means the server is still up as long as the app
runs), `electron/listbridge/index.cjs` (`confirm` options from a constant; optional `publish:extendHold`
IPC if the UI gets a "keep waiting" button — decision D2), `tests/listbridge-tunnel.test.mjs`,
`tests/listbridge-runner.test.mjs` (fake host with `stats()`; scenarios: all served → confirmed without
adapter query; partial → hold → served later → confirmed; hold expiry → failed/resumable; cancel
during hold → cleanup).
Accept: the four scenarios above pass; S3 path unchanged (existing tests untouched and green);
`npm run test:electron` green; no step can leave `cloudflared` running after `done`/`cancelled`/`failed`
(test asserts `close()` called on every terminal path); Blueprint §(Listbridge) "Failure model"
paragraph updated in the same commit.

### PB.13 Error codes → i18n and user-facing messages — tier: haiku (mechanical) after PB.9 lands · G1

Gap: `jobs.cjs`/`tunnel.cjs`/`index.cjs` throw English prose; the tab shows it raw in ja/zh-Hant.
Files: `electron/listbridge/{jobs,index}.cjs`, `electron/listbridge/filehosts/tunnel.cjs` (add a stable
`code` on thrown errors: `no-credentials`, `no-file-host`, `cloudflared-missing`, `tunnel-start-timeout`,
`platform-http`, `platform-rejected`, `not-confirmed`, `cleanup-left`, `cancelled`), `index.cjs` outcome
`{error, code}`, `src/ui/print/PublishModel.js` (`errorKey(code)` map like `issueKey`), locales
`en/ja/zh-Hant.json` (`publish.err.*`), `tests/publish-tab.test.mjs`, `tests/listbridge-runner.test.mjs`
(asserts codes). Accept: `npm run i18n:check` clean; every code has a key in all three locales; message
text unchanged for codes without a key (fallback). No secrets/URLs in any message (existing rule).

### PB.14 Quit / reload safety + packaged-app smoke — tier: sonnet · G1 · not blocked

Gap: jobs live in memory; quitting mid-job strands a Cults creation whose files were never downloaded
(tunnel) or leaves presigned S3 copies until expiry; the listing record is written only when the outcome
returns, so a crash after `create` loses the `remoteId` (next publish duplicates).
Files: `src/core/publish/PublishClient.js` (on progress `{step:'create'|'update', status:'done',
remoteId}` persist the record immediately with status `failed`/pending → upgraded to `published` on
outcome; requires `jobs.cjs` to include `remoteId` in that progress event — 3-line change, cite in
task), `electron/main.cjs` (the existing `app:close` flow: if `runner` has a running job, the close
prompt says "A publish to Cults3D is still transferring files — quitting will break it"; discard = cancel
job then quit; `before-quit` → `close()` every tunnel host), `electron/listbridge/index.cjs` (`hasRunningJobs()`),
`src/ui/print/PublishTab.js` (`beforeunload` guard while a job runs — dev-server reloads kill the renderer
but not the job), `tests/listbridge-runner.test.mjs`, `tests/publish-client.test.mjs`.
Packaged smoke (same task, documented in README dev section): `npm run dist` → run
`release/win-unpacked/MIXOMESH.exe` with `MIXO_SMOKE=1` (reuse the existing electron-smoke probe) and
assert `publish:describe` lists `cults3d` + `tunnel`, and that `defaultLoadCore`'s `import()` of
`src/listbridge/index.js` resolves inside `app.asar` (ESM-from-asar is the one packaging risk). Owner
runs this once on a clean Windows user profile (SmartScreen appears for the unsigned installer — known,
unchanged; cloudflared.exe itself is Cloudflare-signed).
Accept: tests above `# fail 0`; `npm run test:electron`; packaged probe result pasted into the ledger.

### PB.10 Docs — tier: haiku · G2 (text depends on PB.0 for license/category/price wording; can start
with placeholders) · touches only docs

Files: `Blueprint.md` (new §"Listbridge publishing": three layers, portable boundary, job steps + confirm
model, tunnel default + bundled cloudflared hash pin + S3 advanced, `project.listings[]` 3.5 from
`.tmp/blueprint-pending/listings-3.5.md`, Publish tab contract, capability gate), `README.md`
("Publishing to Cults3D": get an API key at cults3d.com/en/api/keys, Connect account, what the temporary
link is — "your files are served from this PC through a short-lived Cloudflare link only while the
publish runs; nothing is stored anywhere else", firewall note (outbound 443; UDP 7844 optional, falls
back to HTTP/2), advanced: own S3/R2 bucket), `docs/adr/0004-marketplace-publish.md` status →
Accepted (shipped) after PB.11, `AGENTS.md` one line pointing at the Blueprint section, delete
`.tmp/blueprint-pending/listings-3.5.md`. Accept: `npm run lint` (markdown not linted — main proofreads);
no R2 "required" wording anywhere (`grep -n "R2" README.md Blueprint.md` shows only the advanced note).

### PB.15 Pre-live dress rehearsal (no Cults key) — tier: sonnet · after PB.5b, PB.9, PB.12, PB.14

Goal: prove the whole chain against the real Cloudflare edge but a fake Cults, so PB.11 only tests Cults.
Files: `tests/listbridge-live-tunnel.mjs` (opt-in, `LIVE_TUNNEL=1`, not in `npm test`): starts the
real bundled/dev cloudflared, puts a 50 MB file + a PNG, fetches both through the public URL from a
second process (full GET + HEAD + a Range), asserts bytes identical, timing logged, `close()` leaves no
`cloudflared.exe` (`tasklist` check). Then an in-app run in the dev Electron with a stub adapter
(`LISTBRIDGE_FAKE_PLATFORM=1` registers a fake 'cults3d' pointing at a local fake GraphQL server that
downloads the `fileUrls` like Cults would). Accept: both runs green and recorded in the ledger with the
measured tunnel start time and throughput (feeds decision D2's hold default).

### PB.11 Live publish — tier: OWNER (main watches) · blocked on PB.0, PB.3b, PB.15

One real listing, priced, owner watching: Connect account → test connection → hero shot → fill fields →
primary button names "Publish live on Cults3D for €X" (or draft if D1 says so) → progress through
`confirm` → "View on Cults3D" opens the page with files downloadable. Record in the ledger: actual
ingestion time, whether Cults accepted `trycloudflare.com` links, any schema surprise, rate-limit
headers seen. If Cults rejects the tunnel domain → fallback decision D3 applies.

## Risks & decisions needed from the owner

- **D1 Draft vs live.** If PB.0 shows a `visibility`/draft state: publish as **draft/private by default**
  and let the owner flip it on cults3d.com (recommended — one review on the site before money is
  involved). If none exists: keep the consequence-naming live button.
- **D2 How long to hold the tunnel.** Cults downloads asynchronously; ingestion time is unknown until
  PB.11. Recommendation: confirm by *served-bytes* first (deterministic, needs no API), hold up to
  **15 min**, then fail-resumable with a "Keep waiting" button (the server stays up while the app runs).
- **D3 Quick-tunnel reliability + ToS.** TryCloudflare is "for testing, no SLA", can be rate-limited or
  withdrawn, and `trycloudflare.com` hostnames are sometimes blocklisted (phishing reputation) — Cults'
  fetcher *may* refuse them. Recommendation: accept for a solo hobbyist tool, keep the S3/R2 advanced
  path and "Save listing package → upload by hand" as fallbacks, show one honest line in the UI
  ("temporary link, works only while MIXOMESH is open"). If PB.0 finds a native upload mutation, the
  tunnel becomes the fallback and this risk disappears for Cults.
- **D4 "Made with AI" flag.** Keep it in the package (platform-neutral). On Cults, send it only if PB.0
  finds a real field; otherwise append one disclosure line to the description. Recommendation: yes,
  disclose in the description — honesty costs nothing and matches marketplace trends.
- **D5 Default license.** Recommendation: paid listings → Cults' "private use" (no redistribution);
  free listings → CC BY-NC-SA, both from the PB.0 enum; always shown, never silent.
- **D6 Duplicate protection.** A create that times out may still have succeeded. Recommendation: the
  adapter's `findExisting` (PB.3b, needs a read-back query) runs before any create on retry; plus the
  early `remoteId` persistence (PB.14). If PB.0 shows no read-back query, retry after a create timeout
  asks the owner to check the site first (button opens cults3d.com/my-creations).
- **D7 Installer size + unsigned binary.** cloudflared adds ~50–70 MB to the installer; cloudflared.exe is
  Cloudflare-signed (no extra SmartScreen hit); the MIXOMESH installer is still unsigned (existing risk,
  out of scope). Recommendation: accept; revisit code-signing separately.
- **D8 One account, one listing per project.** `Listings.findListing` returns the first record per
  platform+account — one product per project. Recommendation: accept for v1 (a `.mixo` is one product).
- **Noted, no decision:** AV/firewall — a 127.0.0.1 listener triggers no Windows Firewall prompt;
  cloudflared's outbound QUIC (UDP 7844) falls back to HTTP/2 over TCP 443 by itself; corporate proxies
  that block both make the host step fail with a clear message (PB.13 code `tunnel-start-timeout`).
  Images — 1600² PNG from the listing shot satisfies any known Cults minimum; no change. IPC moves whole
  ArrayBuffers (≤ 2 GiB per listing) — memory doubles briefly; acceptable at hobbyist sizes, MessagePort
  streaming is future work. Currency — Cults' real currency rules come from PB.0; until then the
  adapter's placeholder list is a guess and the UI must not promise EUR/USD/GBP.

## Order

PB.9 ∥ PB.5b (running) → G1: PB.0a ∥ PB.3a ∥ PB.14 ∥ (PB.12 after PB.5b lands) ∥ (PB.13 after PB.9 lands)
→ owner: PB.0 → G2: PB.3b ∥ PB.10 → PB.15 → PB.11 → ADR status Accepted (shipped).

## Future (not scheduled)

- WooCommerce adapter (`transfer:'direct'`): WP REST media upload + product create with downloadable
  files; application-password auth.
- ProcessWire adapter (`transfer:'direct'`): site-specific endpoint module.
- MyMiniFactory / Printables adapters (direct upload).
- Streaming bytes over a MessagePort instead of structured-cloning whole files.

## Do NOT

Put any key in the renderer, `.mixo`, localStorage, logs, tests or docs; leave paid files at permanent
public URLs; add a second export writer; publish without an explicit final click naming platform and
price; build platform specifics into ListingPackage; spawn the real cloudflared in `npm test`; require
any account beyond the platform's own API key.
