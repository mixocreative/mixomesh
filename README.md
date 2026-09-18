# MIXOMESH

Browser-based 3D model assembly tool for full-color 3D printing. MIXOMESH is
 UV inkjet color 3D print-first: textured 3MF Materials Extension and OBJ+MTL+PNG exports preserve
continuous-tone color for UV-inkjet printers, while filament targets use solid
per-part 3MF color groups.

## First-time setup

You need **Node.js 22 or newer** once. Get it from https://nodejs.org (the "LTS"
button). Then, inside this folder, install the project's dependencies:

```bash
npm install
```

That's it — you only do this once (and again whenever dependencies change).

## Run the web version locally

Start the local web server:

```bash
npm run dev
```

Then open **http://127.0.0.1:5173/** in Chrome or Edge. Edits reload live. Press
`Ctrl+C` in the terminal to stop it.

To preview the real production build instead (what visitors get online):

```bash
npm run build
npm run preview
```

Open the **http://127.0.0.1:4173/** address it prints.

## Run the desktop (offline) version

The desktop app is the same tool in its own window, works fully offline, and can
read/write local files. Build once, then launch it:

```bash
npm run build
npm run electron
```

To make a double-clickable Windows installer (`.exe`) for other people:

```bash
npm install --save-dev electron-builder
npm run dist
```

The installer lands in the `release/` folder.

## Build a clean dist every time

```bash
npm run build
```

`npm run build` always **wipes the `dist/` folder first**, so every build is
clean — no leftover old files. `dist/` is what gets published online and what the
desktop app loads.

## Put it online (GitHub Pages — free hosting)

This repo is already wired to publish itself. One-time steps:

1. Push the project to a GitHub repository (from this folder):

   ```bash
   git push
   ```

2. On GitHub, open the repo → **Settings** → **Pages**. Under
   **"Build and deployment" → Source**, choose **"GitHub Actions"**. Save.

That's all. From now on, **every `git push` rebuilds and republishes the site
automatically** (via `.github/workflows/deploy.yml`). After a minute or two your
app is live at:

```
https://<your-github-username>.github.io/<your-repo-name>/
```

You never edit any paths — the build uses relative links, so it works whatever
your repo is named.

## Verify

```bash
npm run lint
npm run typecheck
npm run i18n:check
npm run build
npm run test
npm run test:browser
npm run test:export
npm run test:repair
npm run test:group
```

`npm run probe:scans [dir]` (not part of `test:all`) runs every model in
`tests/fixtures/real-scans/` (git-ignored — drop your own scans there) through
import → validate → repair → re-validate → 3MF export and prints one row per
file with the manifold/volume verdict; see the header of
`tests/scan-probe.mjs` for the `PROBE_*` switches.

`npm run test:all` chains the five test commands in that order
(`test && test:browser && test:export && test:repair && test:group`). The browser smokes
stay OUT of `npm test`: they launch a real Chrome/Edge and a Vite server, so
the headless node:test suite must remain runnable without either.

The browser smokes start a temporary Vite server and drive Chrome or Edge
through the DevTools Protocol (`test:browser` covers UI + rendering output
including a real headless turntable mp4; `test:export` is the functional
export round-trip; `test:repair` imports an open (non-watertight) mesh,
repairs it, exports it, and checks the result is actually watertight).
`npm run fixtures` regenerates the two committed `.glb` fixtures those smokes
import (`tests/fixtures/open-tetra.glb`, `tests/fixtures/textured-quad.glb`)
from their generator scripts; `tests/hygiene.test.mjs` fails if a committed
fixture has drifted from its generator.

`npm run test:video` is an OPTIONAL headed check — it opens a small visible
browser window for a full-size turntable recording (`VIDEO_CHECK_EDGE=1`
forces Edge). Add targeted manual Chrome or slicer checks when changing
browser-only file picker flows or external export compatibility.

## Dependency Notes

Dependencies are project-local and installed with npm. The helper script forces
`.tmp/` and `.npm-cache/` inside this repo so global temp/cache permissions do
not decide the install.

One-click watertight repair and a live material-cost quote run on vendored,
offline engines in `public/vendor/`: [MeshFixLib](https://github.com/hololocheck/MeshFixLib)
(MIT) fills holes and fixes non-manifold geometry, [Manifold](https://github.com/elalish/manifold)
(Apache-2.0) backs the offline Boolean/CSG path — no runtime CDN, no network
call either engine depends on.

## Status

See `BLUEPRINT.md` for the canonical rebuild spec. Active agent instructions
live in `AGENTS.md`; `CLAUDE.md` is a compatibility pointer for older tools.
