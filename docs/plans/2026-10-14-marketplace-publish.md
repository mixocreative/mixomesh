# Listbridge — marketplace publishing, Cults3D (desktop) · plan

Date: 2026-10-14 · Design: `docs/adr/0004-marketplace-publish.md` · Ledger: `docs/handoff/publish-execution.md`

Owner decisions: desktop (Electron) only; Cults3D only for now; architecture must let the same
listing later go to self-hosted shops (WooCommerce, ProcessWire). File host for Cults = S3-compatible
presigned URLs (Cloudflare R2 default) — owner supplies the bucket + keys before the live test.

Rules: AGENTS.md applies (no slicer, export seam unchanged, one-mesh-one-shader, CSP). Network +
secrets in Electron main only. New UI = mockup gate (Open Design / hand-made mockup → owner OK).
Every task: unit tests, `npm run typecheck && npm run lint && npm test` (`# fail 0`), relevant
smokes, `npm run test:electron` for main-process work. Commit to master per task; update ledger.

## Tasks

Listbridge reuse rule (ADR 0004): `src/listbridge/` imports nothing from MIXOMESH, Babylon, DOM or Node — pinned by a test in PB.1.


**PB.0 Live schema check (owner key).** Script `scripts/cults-introspect.mjs` (reads key from env,
never writes it) dumps `createCreation` / `updateCreation` args + types, `categories`, `licenses`,
`visibility` enum to `docs/reference/cults3d-schema.json` (no secrets). Confirms draft support and
whether price is set on create. Blocks PB.3 payload finalisation, not PB.1/PB.2. Tier: main + owner.

**PB.1 ListingPackage (pure).** `src/listbridge/core/package.js`: model, `validateListing(pkg,
caps)` (title 1–120, description, ≤ N tags, price ≥ 0 with currency, ≥ 1 image, ≥ 1 file, file
count vs adapter max → zip plan), `planBundle(files, maxFiles)` (zip when over). Tests. Tier: sonnet.

**PB.2 Listing shot capture.** `FrameCapture` preset `listingShot({size: 1600, background:
'studio'|'transparent'})`: furniture hidden (exists), selection outline + hover suppressed,
resting transforms (`withRestTransform`), current camera framing. Browser smoke asserts the PNG
has no outline colour pixels and expected size. Tier: sonnet.

**PB.3 Adapter contract + Cults3D payload builder (pure).** `src/listbridge/core/adapter.js`
(typedef + `assertAdapter`), `src/listbridge/adapters/cults3d.js`: `describe()`, `validate()`,
`buildCreateMutation(pkg, hostedUrls)`, `buildUpdateMutation(remoteId, pkg)`, `parseResult()`
(GraphQL `errors` + `creation.errors` → typed issues). Fixture tests against PB.0 schema.
Tier: sonnet.

**PB.4 Main-process publish service.** `electron/listbridge/` (host-side runner: credentials, transport, jobs, file hosts): `credentials.cjs` (safeStorage
encrypt/decrypt, per-platform record, `has/set/clear`, never returns the secret to the renderer),
`transport.cjs` (fetch with timeout, rate-limit backoff 1→5→10→30 s on 429/5xx, honours
`x-ratelimit-*`), `jobs.cjs` (resumable job: package → host → create → confirm → cleanup, progress
events). IPC (`publish:describe|testConnection|setCredentials|clearCredentials|publish|update|cancel`)
through the existing trusted-sender `handle()`. Tests with a fake GraphQL server. Tier: opus.

**PB.5 File host (S3-compatible).** `electron/listbridge/filehosts/s3.cjs`: SigV4 presigned PUT/GET
(no AWS SDK — small signer, tested against AWS test vectors), random prefix, GET expiry
(default 1 h), `delete()` after confirm. Credentials via PB.4 store. Fake S3 test server. Tier: opus.

**PB.6 Renderer bridge + caps.** `caps.publish` (desktop true, web false), preload methods,
`src/core/publish/PublishClient.js (MIXOMESH glue)` (builds the package from current project + chosen export
targets via PrintPipeline, transfers ArrayBuffers, listens to job progress). Tier: sonnet.

**PB.7 Listing package to disk.** "Save listing package…" writes `listing.json` + `images/` +
`files/` via the storage adapter (works on web too — no network). Tier: sonnet.

**PB.8 Persistence (schema 3.5).** `project.listings[]` (ADR fields, no secrets/bytes), migrate
ladder 3.4 → 3.5, serializer round-trip tests; publish of an existing `remoteId` → update.
Tier: sonnet.

**PB.9 Publish tab UI (Mockup gate).** 4th tab in the Print panel (no new workspace): platform,
connection status + "Connect account…" (credential form → IPC, key field never re-shown), hero
shot + Retake + extra angles, title, description, tags chips, category + license (from PB.0
lists), price + currency, AI flag, file checklist from export targets (sizes, zip note), readiness
strip, one primary button naming the consequence, progress checklist, "View on Cults3D" link
after success. i18n en / ja / zh-Hant. Hidden when `caps.publish` is false. Tier: sonnet.

**PB.10 Docs.** Blueprint section, ADR 0004 status → Accepted (shipped), README publishing
how-to (getting a Cults API key, creating an R2 bucket + keys). Tier: haiku.

**PB.11 Live publish (owner).** One real listing, priced, with the owner watching; record the
result + any schema surprises in the ledger. Tier: owner.

## Order

PB.0 ∥ PB.1 ∥ PB.2 → PB.3 → PB.4 ∥ PB.5 → PB.6 → PB.7 ∥ PB.8 → PB.9 (after mockup OK) → PB.10 → PB.11.

## Future (not scheduled)

- WooCommerce adapter (`transfer: 'direct'`): WP REST media upload + product create with
  downloadable files; application-password auth.
- ProcessWire adapter (`transfer: 'direct'`): site-specific endpoint module.
- MyMiniFactory adapter (direct upload).

## Do NOT

Put any key in the renderer, `.mixo`, localStorage, logs or tests; leave paid files at permanent
public URLs; add a second export writer; publish without an explicit final click naming platform
and price; build platform specifics into ListingPackage.
