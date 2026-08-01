# MIXOMESH — Behaviour specification

Gherkin-style **living documentation**. Plain prose, no Cucumber/framework, no
new deps. Each scenario names the automated test that backs it, so this file
reads as the human spec and the test suite is its executable proof.

- **Backing test layers:** `headless` = `npm test` (mock Babylon; logic +
  geometry math). `smoke` = `npm run test:browser` (real Chrome + real Babylon
  via CDP; GPU-dependent behaviour). `export` = `npm run test:export`.
- Update this file in the same change that alters a behaviour; a scenario with
  no backing test is a coverage gap worth flagging.

---

## Feature: Import scale (unit + authored ratio)

    Scenario: A fresh import lands at its authored size
      Given a model whose glТF extras declare a ratio
      When it is imported
      Then each object is seeded ratio = modelRatio
      And the import seed cancels to a unit-only scale factor
      # headless: "import seed cancels: ratio == modelRatio ⇒ unit-only factor"
      # headless: "extractModelRatio reads Blender glTF extras with existing ratio keys"

    Scenario: A duplicate gets its own geometry
      Given an imported object
      When it is duplicated
      Then the copy has unique geometry, not a shared buffer
      And a per-object vertex bake on the copy never mutates the source
      # headless: "duplicate command creates an independent logical split object"

## Feature: Per-object scale ratio

    Scenario: Each object remembers its own ratio
      Given two objects imported at different ratios
      When one object's ratio is changed
      Then only that object rescales, never a shared group ancestor
      And its own ratio field is updated before OBJECT_UPDATED listeners run
      # headless: "objectRatio: own ratio wins, else modelRatio, else 1"
      # headless: "ratio command updates state before OBJECT_UPDATED listeners run"

    Scenario: A ratio change is baked into the object's own vertices
      Given an object at ratio 1
      When its ratio is set to 2
      Then it scales by prev/next (×0.5), baked into its geometry
      And the change survives a .mixo save → load round-trip at the same size
      # smoke: per-object ratio survives .mixo save → load (audit #1)

## Feature: Export (as-shown + target ratios)

    Scenario: Empty target list prints the displayed size
      Given no export ratios are set
      When the scene is exported
      Then it prints "as shown" at the active object's ratio (factor ×1000)
      # export: "as-shown: empty exportRatios prints at the active object ratio"

    Scenario: A target-ratio list emits one file per target
      Given export ratios [72, 144]
      When the scene is exported
      Then one scaled file is produced per target, with an _r{scene}to{target} suffix
      # export: "batch: exportRatios list emits one file per target ratio"

    Scenario: Export reads full-resolution source, never the viewport copy
      Given a textured mesh with a viewport texture cap
      When it is exported
      Then the writer uses the captured full-res source bytes, not a GPU readback
      # headless: "export prefers the captured source over GPU readback"

    Scenario: Colour formats do not depend on the printer
      Given any target printer
      When a textured mesh is exported to 3MF
      Then it uses the Materials Extension layout (printer never chooses the format)
      # headless: "Bambu target + textured mesh → Materials Extension layout"

## Feature: .mixo persistence & restore fidelity

    Scenario: A project opens "as saved"
      Given a saved project with per-object ratios and node transforms
      When it is reopened
      Then every object restores at its displayed size and ratio
      And a glTF right-to-left-handed flip is reproduced
      # smoke: per-object ratio survives .mixo save → load; glTF flip round-trip

    Scenario: Duplicates stay distinct across reload
      Given two objects duplicated from one asset, each at a different ratio
      When the project is round-tripped
      Then each restores as its own mesh at its own size (no collapse)
      # smoke: "Duplicate survives .mixo reload as a DISTINCT mesh (audit H1)"

    Scenario: Auto-fix edits survive reload
      Given a mesh repaired with Auto-Fix (weld / normal-flip)
      When the project is round-tripped
      Then the applied fixes replay on load at the displayed scale
      # smoke: "Auto-fix geometry edits survive .mixo reload (audit M1)"

    Scenario: Autosave never ghosts a loose drop
      Given a drag-dropped asset with no file/dir handle
      When autosave runs (which normally skips embedding)
      Then its bytes are embedded anyway, because they are its only recovery tier
      # headless: "A9/M7: autosave ... embeds handle-less loose drops"

    Scenario: Save does not stall on large scenes
      Given a heavy scene being saved
      When the document is built
      Then base64 encoding runs off-thread in a Worker, byte-identical to the sync codec
      And the source buffer is never detached
      # smoke: base64 worker === sync codec across the 0x8000 boundary, no detach

## Feature: Print validation (multi-shader aware)

    Scenario: A multi-shader object validates as one welded solid
      Given a closed model split into per-material primitives
      When it is validated
      Then the parts are welded into one union and report no false non-manifold
      # smoke: "closed 2-material cube → 1 logical object, union watertight"

    Scenario: Separate objects are never wrongly merged
      Given two distinct objects
      When they are validated
      Then they stay two objects, not one union
      # smoke: "two separate objects → stay 2, not merged"

    Scenario: A real hole is still reported
      Given a cube missing a face
      When it is validated
      Then a small real boundary count is reported as a non-blocking warning
      # headless: "cube missing a face → reports a SMALL real boundary count"

## Feature: Shaders on import

    Scenario: Identical materials collapse to one shader
      Given two materials with identical appearance but different names in one import
      When the container is registered
      Then exactly one shader is created and both meshes share it
      And a material identical to an already-registered shader dedupes to it
      # smoke: "Shader content-dedupe on import (audit #15 guard)"

## Feature: Viewport — selection, cursor, cross-section

    Scenario: The active object outline is distinct from selected
      Given a multi-primitive object is the active selection
      Then all its parts render the active (brighter orange) outline, none the dim tint
      # smoke: two-channel outline mask (active R / selected G)

    Scenario: The cross-section fill follows the model
      Given a cross-section is active
      When the model is moved
      Then the amber interior fill tracks the cut (does not detach)
      # smoke: "cross-section fill clone did not follow the source when it moved (M10)"

    Scenario: The import bounce yields to a user scale
      Given a mesh is mid bounce-in pop
      When the user sets its scale
      Then the pop stops touching scaling and the user's value survives settle
      # smoke: "bounce clobbered a scale set DURING the pop (wrinkle fix)"

## Feature: Settings vs project content

    Scenario: Per-user panel settings persist; content never leaks as a setting
      Given panel settings edited by the user
      When the app reloads
      Then the settings restore from localStorage
      But per-project content (exportRatios, objects) is never persisted as a setting
      # smoke: settings persist; content excluded; resetAll preserves exportRatios

    Scenario: A .mixo never carries per-user layout
      Given a saved project
      Then the document omits workspace layout / panel widths (per-user preference)
      # headless: ".mixo documents never carry workspace layout (13b per-user rule)"

## Feature: Localisation

    Scenario: Every UI surface is translatable
      Given a supported locale (en / ja / zh-Hant)
      Then all three locales carry the same key set with no missing/extra keys
      # headless: i18n key-parity tests + scripts/i18n-check.mjs
