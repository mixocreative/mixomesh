# MIXOMESH

Browser-based 3D model assembly tool for full-color 3D printing. MIXOMESH is
 UV inkjet color 3D print-first: textured 3MF Materials Extension and OBJ+MTL+PNG exports preserve
continuous-tone color for UV-inkjet printers, while filament targets use solid
per-part 3MF color groups.

## Run

Install dependencies, then start Vite:

```bash
node scripts/install-deps.mjs
npm run dev
```

Open http://127.0.0.1:5173/index.html in Chrome or Edge.

## Verify

```bash
npm run typecheck
npm run build
npm run test
npm run test:browser
npm run test:export
```

The browser smokes start a temporary Vite server and drive Chrome or Edge
through the DevTools Protocol (`test:browser` covers UI + rendering output
including a real headless turntable mp4; `test:export` is the functional
export round-trip). `npm run test:video` is an OPTIONAL headed check — it
opens a small visible browser window for a full-size turntable recording
(`VIDEO_CHECK_EDGE=1` forces Edge). Add targeted manual Chrome or slicer
checks when changing browser-only file picker flows or external export
compatibility.

## Dependency Notes

Dependencies are project-local and installed with npm. The helper script forces
`.tmp/` and `.npm-cache/` inside this repo so global temp/cache permissions do
not decide the install.

## Status

See `BLUEPRINT.md` for the canonical rebuild spec. Active agent instructions
live in `AGENTS.md`; `CLAUDE.md` is a compatibility pointer for older tools.
