# Autonomous run 2 (2026-10-22): PAUSED, resume here

Owner asked "do items 1-5 on your own", then asked to pause safely. Master is NOT pushed past 017c7fe
(pushing deploys GitHub Pages: owner gate). Run `git log --oneline 017c7fe..HEAD` for what landed.

## Done (committed on master)

- Item 1 live check with the owner's real scans (Chromium build copy + Playwright WebKit). Findings L2-01..L2-14
  below. Evidence lives in the git-excluded `.audit/live2/` on the run machine.
- L2-01 CRITICAL fixed (f00b1a6, test c0f6976): Draco decoder 1.5.7 ships in `public/vendor/draco/` (SHA-256
  pinned, `scripts/fetch-draco.mjs --check`); all 12 real scans import offline; `tests/browser-draco-offline.mjs`
  (`--preview`, `--electron`).
- Item 2 `npm run test:consumers` (80c24fe): 4 models x 7 formats through the real export path, read by
  PrusaSlicer `--info` + trimesh/pymeshlab against a truth table. KNOWN defects table in `tests/consumers.mjs`
  (a fixed defect makes the run fail until its entry is removed).
- Item 3 failing tests name themselves (73313aa): `.tmp/last-test-failures.txt`; five load-sensitive tests fixed.
- Item 4 code-quality leftovers (13cb207, 800b44e, e59a01a): one progress shape, one job registry (no `hidden`
  flag), one parse core per format (custom `import/StlLoader.js` replaces Babylon's unwelded STL loader so worker
  and main thread agree), ThreeMFLoader 798 -> 284 lines, AssetImport 754 -> 377.
- Item 5: 3MF loader honours tilestyle (50dce95); OBJ clamped-texture readiness hint (bb5ab54); Boolean
  subtract/intersect browser smokes `npm run test:boolean` + two boolean bugs fixed (84cf964).

## In flight when paused (see agent handoff notes)

- Agent E: L2-02 CRITICAL washed-out textures after save -> reopen -> export (double gamma; ColorSpace.js:65 +
  ExportTextures.js:52 fallback; why export falls back after reopen is untraced) and L2-03 HIGH textured exports
  non-manifold (writer splits vertices at UV seams; 3MF/OBJ allow per-corner UV indices). Status:
  `.audit/pending/E-handoff.md`, unfinished code in `.audit/pending/E-wip.patch`.
- Agent F: L2-04..L2-14 (rotated size uses loose box; WebKit 0-byte save reported success; export dialog counts
  parts as objects; Outliner name hidden; Esc no-op undo; WebKit messages; toast never dismissed; Base Color mode
  darker; WebKit NavCube). Status: `.audit/pending/F-handoff.md`, code in `.audit/pending/F-wip.patch`.

## Not started (final round)

1. Finish E and F from their handoff notes (apply the wip patch, finish, test).
2. Consumers KNOWN defects: export repair turns an open sheet into a 0 mm3 double-sided shell; colorgroup 3MF and
   OBJ split vertices per colour (closed box reads as 3 open parts; may be fixed by E's weld work, then delete
   that KNOWN row); colorgroup 3MF object unnamed; VRML drops non-ASCII names.
3. Merge `.audit/pending/L2-01-locales.json` + `L2-01-import-failure.md` (plain-words decoder error in
   `ImportFailure.js`, hygiene test entries, optional `fetch:draco`/`test:draco` scripts, Blueprint paragraph).
4. Ship meshopt and KTX2 decoders locally like Draco (Babylon defaults them to its CDN; blocked by CSP).
5. Unexplained: `triangle-budget` test died silently once in 24 runs at 8-way load (the failures file will
   catch a repeat).
6. Full gates on a quiet machine: npm test, lint, typecheck, i18n:check, build, test:all (incl. consumers,
   boolean, uv-transform), test:electron, test:publish, browser-draco-offline --preview. Then ask the owner to
   push (deploy).

## Rules learned this session

- No git worktrees / stash / checkout -- while agents share the tree (node_modules junction deletion).
- Serve a production build copy for browser walks while other agents edit src (HMR reloads otherwise).
- Real scans in `tests/fixtures/real-scans` are customer data: git-ignored, never commit; decoded copies in
  `.audit/live2/undraco/`.

## Pause point (verified)

HEAD ac0d3f3, tree clean, `npm test` 1083/1083 (0 skipped), lint clean. Not run at the pause: typecheck,
i18n:check, build, test:all, test:electron (run them first on resume).
- L2-02 CRITICAL fixed: ac2fa4e (tests af06af5). Reopened texture colour 202,134,113 = fresh export.
- F's L2-04..L2-14 committed (see `.audit/pending/F-handoff.md`); L2-09 not started; NavCube mirror is a
  Playwright-WebKit limit, needs real Safari.
- L2-03 resume: restore `.audit/pending/E-export-welded-seams-l2.test.mjs` to `tests/`, apply
  `.audit/pending/E-wip.patch`, then trace why export prep re-points the cube's triangles to the X faces' UVs
  (4 of 12 faces match; suspect repair or optimizeIndices; check if it predates the patch) per `E-handoff.md`.
  After it lands, delete the colorgroup manifold rows from the KNOWN table in `tests/consumers.mjs`.
- Pending merges for other owners: `L2-04-bedfit-cost.patch` (bed-fit/cost use the loose box), L2-01 locales +
  ImportFailure note, `L2-10-csp.md` (no change needed).
