# HANDOFF — Placement precision verbs (Phase B)

Resume tracker. Solo dev, all on `master`. ADR `docs/adr/0003-placement-precision.md` is canonical.
Verify green (typecheck · npm test · build · smoke) + commit per slice.

## Sequence (adjudicated: safest first)

Align → Mirror → Mate → Array.

## Progress

- [x] Debate panel (2 agents: mate+align, mirror+array) → ADR 0003.
- [x] **Align slice 1:** `src/core/placement/AlignMath.js` `computeAlignDeltas(items, mode)` pure
      (min/center/max axis deltas) + `tests/align-math.test.mjs` (6 asserts). BLUEPRINT §Placement.
- [x] **Align slice 2 done:** `src/core/commands/PlacementCommands.js` `AlignCommand(meshIds, axis,
      mode)` — reads each logical object's world AABB (union of parts), applies the axis delta via
      `applyTransforms` (TransformSwab pattern), undo restores; re-exported from HistoryManager.
      Browser smoke exercises align-x-min on 3 boxes + undo. Green.
- [x] **Align slice 3 done — ALIGN VERB COMPLETE:** ContextMenu entries "Align Center X/Y/Z"
      (multi-select gated) → `_align('align-<axis>-<mode>')` → `AlignCommand`; i18n en/ja/zh-Hant.
      typecheck · 106 headless · build · browser smoke green. (min/max modes exposed via a future
      Placement panel — the command already supports them.)
- [ ] **Mirror:** vertex-bake reflection + `flipFaces` (determinant<0, copy ImportNormalizer:100) +
      `makeGeometryUnique`; expand `logicalObjectCommandIds`; export-winding smoke.
- [ ] **Mate:** face pick (`scene.pick`.faceId, `getFacetNormal`/`getFacetPosition`) → `FromToRef`
      rotation + coincident centres; snap at pick-time.
- [ ] **Array:** linear/radial N clones, atomic single-`push`, pre-register before mutate.

## Watch-outs (from the debate interrogation)

- Winding: mirror/reflection MUST `flipFaces` on negative determinant, else inverted geometry.
- `makeGeometryUnique()` before ANY vertex bake (block source aliasing).
- Always expand `logicalObjectCommandIds` so all parts of a logical object move together.
- Detach the pivot (`withDetachedPivot`) before capturing absolute transforms.
