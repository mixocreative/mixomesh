# Stitch Design Tool: Capturing MIXOMESH UI

**Purpose:** Capture production-built MIXOMESH UI into [Google Stitch](https://stitch.google.com) for mockup review during "Mockup gate" tasks in [docs/plans/2026-10-14-mixomesh-overhaul.md](../plans/2026-10-14-mixomesh-overhaul.md). Design tokens and utilities live in [DESIGN.md](../../DESIGN.md) at the repo root.

## Prerequisites

- **Stitch CLI**: `npm install -g @google/stitch` (or `stitch` if in PATH)
- **Chrome or Edge** installed: `stitch capture browser` drives headless Chrome through its own `chrome-devtools` daemon (no extension needed)
- **DESIGN.md validated**: `stitch status --flow=design --json` returns `data.designMd.valid === true`

## Build Production + Preview Server

Never capture from the **Vite dev server** — it inlines HMR JS instead of CSS, leaving panels unstyled.

```bash
npm run build
npx vite preview --host 127.0.0.1 --port 5180 --strictPort
```

The port `5180` is used because `4173` is reserved (EACCES) on the owner's Windows machine. The preview server runs locally without network exposure.

**Verify** before capturing:
```bash
curl http://127.0.0.1:5180/ >/dev/null && echo "Server is ready"
```

## Capture UI Panels

Capture only **panel chrome** — the WebGL viewport renders as a blank canvas and is not captured.

### Basic Capture

```bash
stitch capture browser \
  --url http://127.0.0.1:5180/ \
  -o <scratchpad>/<view>.html \
  --json
```

Replace `<scratchpad>` with your session scratchpad path (e.g. `C:\Users\DCT\AppData\Local\Temp\claude\…\scratchpad`) and `<view>` with a descriptive name (e.g., `layout-workspace`, `shade-workspace`).

### Workspace / Tab Switches

UI state (sidebar collapsed, Properties vs. Library, workspace active) is **in-memory only**. Drive state transitions in **Chrome DevTools** before capturing:

```bash
stitch capture browser \
  --url http://127.0.0.1:5180/ \
  -o <scratchpad>/<view>.html \
  --page 1 \
  --json
```

The `--page 1` flag captures after DevTools interactions.

## Capture Rules

- **Fixture scenes only:** Empty scenes or minimal test geometry
- **Never capture** owner models, `.mixo` project files, or real assets
- **Project binding** (`stitch config set project <name>`) requires explicit owner approval
- **Batch uploads** require explicit owner approval
- **Prepare scripts** (if any preprocessing is needed) live in the scratchpad, **never** in the repo
- **Stitch output** is a reference picture for mockup review, **never** pasted into `src/` or committed

## Verify Design System

Before capturing, validate that DESIGN.md is present and well-formed:

```bash
stitch status --flow=design --json
```

Output should include:
```json
{
  "data": {
    "designMd": {
      "valid": true
    }
  }
}
```

## Output

Captured `.html` files are stored in your session scratchpad and are **design references only**. Use them to:
- Review panel layouts against mockup gate criteria
- Check spacing, typography, and component alignment
- Iterate on UI before committing changes to the codebase

Do NOT edit or commit Stitch output files into the repository.
