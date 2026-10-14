# ADR 0004 — Listbridge: marketplace publishing (Cults3D first, self-hosted shops later)

Status: **Accepted (planning)** · Date: 2026-10-14 · Plan: `docs/plans/2026-10-14-marketplace-publish.md`.

## Context

The owner wants to list finished prints for sale straight from MIXOMESH: pick the exported
files, take a clean viewport shot as the hero image, enter title / description / tags / price,
and create the product on the platform. Owner decisions (2026-10-14): **desktop (Electron)
only**, **Cults3D only** for now, but keep it clean so the same work can later go to a
self-hosted shop (WordPress/WooCommerce, ProcessWire e-commerce).

Platform facts that shape the design:
- Cults3D has a GraphQL API (`https://cults3d.com/graphql`, Basic auth = nickname + API key).
  `createCreation` takes **URLs**, not bytes: `fileUrls` / `imageUrls`, at most 10 each, public
  HTTPS links that show the file extension. Cults downloads them itself. Community-known limits:
  ~60 requests / 30 s, ~500 / day; honour `x-ratelimit-*`. Argument types must be confirmed by
  live introspection (the public example is not valid GraphQL).
- Self-hosted shops (WooCommerce REST + WP media, ProcessWire API) take **direct uploads**.
- A browser page cannot hold an API key safely and is likely CORS-blocked; files on the PC are
  not reachable by Cults' servers.

## Decision

Three layers, each replaceable on its own:

1. **Listing package (platform-neutral, pure).** One `ListingPackage` built once from the
   project: title, description (Markdown), tags, price `{amount, currency}`, license, AI flag,
   category hint, images `[{name, mime, bytes, role}]`, files `[{name, mime, bytes}]`.
   Files come from the existing export pipeline (`ExportContext → PrintPipeline`), byte-identical
   to Export; > 10 files are zipped with `fflate`. The hero image comes from
   `FrameCapture.capturePng` with a new "listing shot" preset (furniture already hidden).
   The package can also be **written to disk** as a folder (`listing.json` + `images/` + `files/`)
   — usable today for manual upload to any platform, and the input format for future adapters.

2. **Publish adapter (one per platform, main process).** Interface:
   `describe() → {id, label, transfer: 'url'|'direct', maxFiles, maxImages, currencies, fields}`,
   `validate(pkg) → issues[]`, `publish(pkg, ctx) → {remoteId, url, status}`,
   `update(remoteId, pkg, ctx)`, optional `listCategories(ctx)`, `testConnection(ctx)`.
   Payload builders are pure (unit-tested against fixtures); transport is injected.
   Cults3D = `transfer: 'url'`. WooCommerce / ProcessWire = `'direct'` (future, no host needed).

3. **File host (only for `transfer: 'url'`).** S3-compatible presigned PUT + short-lived
   presigned GET (Cloudflare R2 default). Uploaded under a random prefix, deleted after the
   platform confirms ingestion. Paid files are never left at a permanent public URL.

**Security (follows 6.1/6.2).** Network calls and secrets live only in the Electron main
process (`electron/listbridge/`). Credentials are encrypted with `safeStorage` (DPAPI) in
`<userData>/listbridge-credentials.bin`, never in the renderer, `.mixo`, localStorage or logs.
The renderer sends a descriptor over one validated IPC channel (`publish:*`); bytes are passed
as transferred `ArrayBuffer`s, never as paths. The web build gets `caps.publish = false` and
the UI is hidden (capability-gated, ADR 0001).

**Persistence.** `project.listings[]` (schema 3.5): `{platform, title, description, tags,
price, currency, license, madeWithAi, remoteId, url, publishedAt, fileNames}` — no secrets, no
bytes. Re-publishing an existing `remoteId` updates instead of duplicating.

**Failure model.** Publishing is a resumable job: export → package → host upload → create →
confirm → cleanup. Each step reports to the user; a failed create retries with the same hosted
URLs; host cleanup runs only after confirmation (or on explicit cancel). If the platform has no
draft state, the final button names the consequence ("Publish live on Cults3D for €4.00").

## Name and reuse: **Listbridge**

The architecture is named **Listbridge** so other projects can share it: a platform-neutral
*listing package* → one *adapter* per platform → an optional *file host* for URL-only platforms,
run by a *host-side runner* that owns secrets and network.

Reuse boundary (enforced by a unit test that scans imports):
- `src/listbridge/` — **portable core**: `core/package.js` (model, validation, bundle plan,
  disk layout `listing.json` + `images/` + `files/`), `core/adapter.js` (contract +
  `assertAdapter`), `adapters/*.js` (pure payload builders / result parsers). Plain ES modules,
  no Babylon, no MIXOMESH imports, no DOM, no Node built-ins → can move to its own package later.
- `electron/listbridge/` — **runner** for an Electron host: credentials (safeStorage), transport
  (timeouts, rate-limit backoff), resumable jobs, `filehosts/s3.cjs`. Only Node + Electron.
  A non-Electron project supplies its own runner with the same job contract (a small server or CLI).
- `src/core/publish/` + `src/ui/print/PublishTab.js` — **MIXOMESH glue only**: builds a package
  from the project (export pipeline + listing shot) and shows the UI.

`listing.json` carries `"listbridge": 1` (format version) so packages written by one project are
readable by another.

## Consequences

- Adding WooCommerce / ProcessWire later = one new adapter (`transfer: 'direct'`) + its
  credential form; the package, capture, UI and persistence are reused unchanged.
- The disk export of a listing package works for every platform, including ones with no API
  (Printables).
- Cults3D publishing needs a file-host account (R2 bucket + keys) in addition to the Cults key.
- Real end-to-end publishing is an owner check (one real listing); automated tests use a fake
  GraphQL server and a fake S3 endpoint.

## Rejected

- Browser-side publishing (key exposure, CORS) and GitHub Pages hosting (no server).
- GitHub Release / permanent public links as the file host (leaks paid files).
- One "Cults" module doing packaging + transport + hosting (blocks reuse for self-hosted shops).
