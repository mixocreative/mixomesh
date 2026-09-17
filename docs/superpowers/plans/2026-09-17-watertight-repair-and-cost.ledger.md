# SDD ledger — plan: docs/superpowers/plans/2026-09-17-watertight-repair-and-cost.md
Task 1: dispatched (base 14d5e1d, implementer sonnet)
Task 1: review round 0 — Approved w/ 1 Important (plan-mandated changed-gate field names) → fix round 1
Task 1: fix round 1/5 dispatched (commits 2b92c6e..36cbddd)
Task 1: fix round 1/5 (1 addressed, 0 open; commits 2b92c6e..36cbddd)
Task 1: minor (deferred): three duplicate vendor-URL helpers (MeshRepair/PrintPipeline/BooleanService); _nearestIndex O(n) fallback
Task 1: complete (commits 14d5e1d..36cbddd, review clean)
Task 2: dispatched (base 36cbddd, implementer sonnet)
Task 2: review round 0 — Needs fixes (2 Important: nonManifold.autoFixAvailable unconditional; load replay no per-object try/catch). Minors deferred: holes message wording when not fixable; un-awaited applyGeometryFix in PlacementCommands.js:247 + browser-smoke:1364
Task 2: fix round 1/5 dispatched (commits 0b6bcf9..8272d99)
Task 2: fix round 1/5 (2 addressed, 0 open; commits 0b6bcf9..8272d99)
Task 2: minor (deferred): loader replay loop beyond geometryFixes unguarded; /no engine/ regex couples to MeshRepair wording
Task 2: complete (commits 36cbddd..8272d99, review clean)
Task 3: dispatched (base 8272d99, implementer sonnet)
Task 3: review round 0 — Approved w/ 2 Important: (1) duplicated batch loop ContextMenu/PrintPanel → fix round 1; (2) brief 'history entry' not implemented — parked, ruling: dispatch resolution said undo not required beyond existing Auto-Fix; no GeometryFixCommand precedent; revisit if undo of repairs is requested. Minors deferred: toast.repaired reused for batch label; Outliner badge not focusable; AlertTriangle reused for repair (no Wrench icon)
Task 3: fix round 1/5 dispatched (commits 4830c64..c65b382)
Task 3: fix round 1/5 (1 addressed, 0 open; commits 4830c64..c65b382)
Task 3: complete (commits 8272d99..c65b382, 1 parked: history entry)
Task 4: dispatched (base c65b382, implementer sonnet)
Task 4: review round 0 — Approved w/ 2 Important (CCW flag rule untested via pipeline; double exportedWithWarnings toast + no exportGate UI test) → fix round 1. Minors deferred: _tryRepair swallow w/o console.error; ctx.repairSkipped unconsumed; validationWarningsBody copy stale
Task 4: fix round 1/5 dispatched (commits 457e2d0..376a9b8)
Task 4: fix round 1/5 (4 addressed, 0 open; commits 457e2d0..376a9b8)
Task 4: complete (commits c65b382..376a9b8, review clean)
Task 5: dispatched (base 376a9b8, implementer sonnet)
Task 5: complete (commits 376a9b8..298a3ce, review clean). minor (deferred): auto-repair gated on error-free results (inherited); setting read at repair time
Task 6: dispatched (base 298a3ce, implementer sonnet)
Task 6: review round 0 — Needs fixes (Critical: cap checked AFTER unitVolumesMM3; Important: double unitVolumesMM3 per render; 'change' not 'input' events). Minors deferred: Vector3 alloc per vertex; redundant computeWorldMatrix
Task 6: fix round 1/5 dispatched (commits ea82744..29a5de1)
Task 6: fix round 1/5 (3 addressed, 0 open; commits ea82744..29a5de1)
Task 6: complete (commits 298a3ce..29a5de1, review clean)
Task 7: dispatched (base 29a5de1, implementer sonnet)
Task 7: review round 0 — Needs fixes (3 Important: per-selection tris dropped + Blueprint stale; instantiateAsset no budget check; O(scene) traversal per per-mesh event). Minors deferred: styles in layout.css; dual export surfaces; hud-danger font-weight
Task 7: fix round 1/5 dispatched (commits fa2bb82..ebaa05d)
Task 7: fix round 1/5 (3 addressed, 0 open; commits fa2bb82..ebaa05d)
Task 7: complete (commits 29a5de1..ebaa05d, review clean)
Task 8: dispatched (base ebaa05d, implementer sonnet)
Task 8: review round 0 — Needs fixes (Important: live tris=8 for 4-tri solid unexplained & written into Blueprint; smoke HUD regex too loose). Minors: README paragraph length; Blueprint pointer to concerns
Task 8: fix round 1/5 dispatched (commits 71c2f18..0fb3b53) — root cause: export clone shares metadata.meshId (Mesh.clone), HUD double-counted mid-export
Task 8: fix round 1/5 (2 addressed, 0 open; commits 71c2f18..0fb3b53)
Task 8: complete (commits ebaa05d..0fb3b53, review clean)
FINAL REVIEW: dispatched over 14d5e1d..0fb3b53
CIA SWEEP (HEAD 0fb3b53): F1 CRIT severity:'error' never emitted → HUD ✓watertight blind, Outliner/Panel error states unreachable, _validateExportMeshes hard gate unreachable; F2 HIGH arraysToMesh no index-range/finite check on engine output; F3 HIGH _tryCsg silent catch; F4 HIGH no repair timeout/cancel; F5 HIGH PrintCost _hasOpenResult treats no-cache as watertight (readiness says pending); F6 MED holes message promises Auto-Fix when unavailable; F7 MED exportGate no test; F8 MED test:repair not in default gate; F9 MED PrusaSlicer check not recorded in repo (verify Blueprint); F10 MED CSG after repair not re-diagnosed; F11-F14 LOW (normalsFlipped unused, assert.ok(true), materialId silent fallback, weld console-only)
FINAL REVIEW: Fix wave needed — C1 + I1..I12 + M1..M12 + T1..T8; merged with CIA F1..F14 into fix-wave-findings.md; ONE fix dispatch (opus) from base 0fb3b53
FIX WAVE: done eb49e18..91dfa11 (7 commits); re-review dispatched
FIX WAVE: my gate run on 91dfa11 green (153/153, all smokes). NEW: repair smoke once reported volume 1002.57 (vs 1000.00 on 2 reruns) → engine may move existing vertices (edge-flip/remesh/fairing) nondeterministically; 1% tolerance hides it. To fold into the residual round: pin engine options so repair never moves existing vertices, assert 0.01% on this fixture, test that untouched vertices are byte-identical after repair.
FIX WAVE: re-review clean (2 DISPUTED-ACCEPTED: T6 clause, CIA F6 unreachable branch). PARKED — ruling: engine nondeterminism (one run 1002.57 mm³, reruns 1000.00) is real, not load-bearing; follow-up #1: pin engine options so repair never moves existing vertices + assert 0.01% on the tetra + byte-identical untouched vertices. PLAN COMPLETE at 91dfa11.
