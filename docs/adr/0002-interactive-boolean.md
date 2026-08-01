# ADR 0002 — Interactive Boolean (pre-slice kitbash combine)

Status: **Debating (planning)** · Date: 2026-06-17 · Companion resume tracker:
`docs/handoff/boolean-ops.md`.

## Context

MIXOMESH is a **pre-slice kitbash** tool (not a mesh editor — we do NOT compete with
Meshmixer/Blender). Its gap to being a complete kitbash tool is the defining "combine"
verb: interactive **Boolean union / subtract / intersect** on selected parts, turning
arranged kit pieces into one printable solid (or cutting sockets). This is the single
highest-leverage feature. The Boolean engine (Babylon CSG2 / Manifold) already ships in
the export re-bake path — so this reuses proven, in-browser tech (runs on web AND
Electron; compute is identical, only memory headroom differs — ADR 0001).

## Hard constraints (AGENTS.md)

- Reversible ⇒ a **Command** on HistoryManager. State via `dispatch`; typed events.
- **One-mesh-one-shader** — a multi-material result splits into single-material siblings.
- **Babylon-first** — reuse CSG2/Manifold.
- **Color moat** — textures/UVs must survive for Mimaki color export.
- BLUEPRINT update in the same turn as the feature.

## Known prior (to verify in debate)

The export path **skips CSG2 for textured meshes** (memory: "3MF: textured mesh skips
CSG2 (preserves UVs), solid mesh re-bakes") — i.e. CSG2/Manifold as used today **loses
UVs**. So Boolean-on-textured is the central risk: the moat vs the engine limitation.

## Debate axes → decisions

> **[TO FILL after the 3-agent panel synthesises]**

1. **Engine/threading** — reuse export CSG2 as a shared `BooleanService`? Worker vs main?
   Size-gating threshold + where it lives. → *decision:*
2. **Texture/UV preservation** — can Manifold carry UVs / per-triangle provenance so each
   source part keeps its texture on its own faces? Or gate/warn textured Booleans? → *decision:*
3. **Data model** — destructive bake (result = new mesh needing its own persisted geometry,
   sources consumed) vs non-destructive recompute-on-load; how it round-trips in `.mixo`;
   the `BooleanCommand` shape (execute/undo, one-mesh-one-shader). → *decision:*
4. **UX/gating** — invocation (select 2+ → context menu; subtract base = active), non-manifold
   operand handling (validate/auto-fix first?), progress, warnings. → *decision:*

## Decision

> **[TO FILL]**

## Implementation plan (first slice)

> **[TO FILL — smallest coherent, testable, green increment per the decisions]**

## Consequences

> **[TO FILL]**
