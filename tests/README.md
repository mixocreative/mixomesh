# tests/ — the map

308 files in one flat folder, so this is the map. The folder is flat **on purpose**: a test's
subject is in its filename, and the two kinds of test here are told apart by the filename too, not
by a directory. Read this before adding a file, because which kind you are writing decides how it
is named and which npm script will ever run it.

## Two kinds, and the naming tells you which

| Pattern | Kind | Runner | What it may assume |
|---|---|---|---|
| `<subject>.test.mjs` / `.test.ts` | **unit / node test** (254 files) | `npm test` → vitest + `node --test` | no browser, no GPU, no real engine unless it loads the vendored wasm itself |
| `browser-<subject>-smoke.mjs` and friends (34 files) | **browser walk** | its own `npm run test:<name>`, all of them in `npm run test:all` | a real Chrome over CDP, a real Babylon scene, real workers |
| everything else (19 files) | **harness**, not a test | imported by the two above | — |

A browser walk that is not named in `package.json` is a file nothing runs. Check the script list
before you believe a walk is covering something.

## The harness — read these before writing a walk

| File | Job |
|---|---|
| `cdp-harness.mjs` | the Chrome DevTools Protocol driver every `browser-*` walk is built on |
| `support-browser-kit.mjs` | the shared setup for support-generation walks (scene, object, armed tool) |
| `load-harness.mjs` · `env.mjs` · `hooks.mjs` · `register-hooks.mjs` | module loading, environment shims and the hook registration a node test needs before it imports `src/core/*` |
| `idb-stub.mjs` · `opfs-stub.mjs` · `jszip-stub.mjs` · `xml-dom.mjs` · `local-fetch.mjs` | stubs for browser APIs a node test cannot have. **A stub with no real behaviour is how a probe reports OK without measuring** — a stubbed `Matrix.Scaling` once had no `.m`, so every bake recorded ×1 and the check passed vacuously. Read what a stub actually returns before trusting a green test built on it |
| `failures-reporter.mjs` | collects failures so a long run names every one, not just the first |
| `scan-probe.mjs` · `webcodecs-probe.mjs` | capability probes: what this machine's Chrome can actually do |
| `listbridge-live-tunnel.mjs` · `listbridge-rehearsal.mjs` | the marketplace-publish bridge, driven against a tunnel and against a rehearsal |
| `consumers.mjs` · `consumers.py` | the external-consumer check: a published file read back by something that is not us |
| `fixtures/` | the meshes and projects the tests load (29 files, a data store — no map needed) |

## Where the subjects cluster

Grouped by what a failure here tells you. Counts are test files, not assertions.

| Cluster | Files named | What it guards |
|---|---|---|
| **print / export** | `export*`, `stl*`, `threemf*`, `print*`, `publish*`, `uv-transform*`, `zip-text` | the bytes that leave the app. The biggest cluster, and the one where a regression is unrecoverable: the user already sent the file to a printer |
| **persistence** | `persistence*`, `storage-adapter`, `project*`, `unload`, `viewer-projects` | a project saved and reopened is the same project |
| **import** | `import*`, `geometry*`, `mesh*`, `triangle*`, `weld`, `validator*`, `validation` | a file read in becomes a mesh with the transform the file meant |
| **supports** | `supports*`, `support-*` | the ported support generation (`src/supports/`), including the committed engine baseline |
| **scene + history** | `history`, `undo-trim`, `hierarchy*`, `selection*`, `transform*`, `split-join`, `boolean*` | the scene graph and that every command undoes exactly once |
| **listbridge** | `listbridge*` | marketplace publishing (6 files — it talks to someone else's service, so it is tested hardest) |
| **shell + i18n** | `i18n*`, `workspace*`, `viewer`, `touch`, `properties*`, `render*` | the UI vocabulary and the responsive shell |

## Two things worth knowing before you trust a green run

**`npm run test:all` is sequential and browser-heavy.** A failure that passes when the suite is run
alone is usually contention, not a defect — but check it alone before concluding that. On
2026-11-13 a step that looked exactly like contention turned out to be clicking 27 px off target.

**Never pipe a run through `tail` or `head`.** The exit code becomes the pipe's, and the failing
check's name is the one line you needed. A 35-minute run was repeated for exactly this.

## Size debt in this folder

`browser-smoke.mjs` (2,839 lines) and `export.test.mjs` (1,982) are both over the cut limit. Their
next cut is written down in `../docs/size-debt.md`; neither is split yet, and the reason is there.
