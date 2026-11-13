# src/kit/ — the component library

28 files: the controls every panel is built from. **A new control goes here; a new panel goes in
`../ui/`.** The split is the point — a control in `kit` is styled once, tested once, and has no
idea which panel is using it.

`index.ts` is the only entry point other code should import from.

## The vocabulary — which control means what

Choosing the wrong one is the most common mistake here, so the distinctions are written down:

| Control | Use it for | Not for |
|---|---|---|
| `Button.tsx` | an action. **`primary` is the one red action per view**; `danger` is outline, never filled; an icon button needs `aria-label` | anything that holds a state |
| `Toggle.tsx` | a feature, a mode, a visibility. Pressed = ink fill | a sub-option |
| `Check.tsx` | a sub-option under a feature | a feature or mode — that is `Toggle` |
| `Segmented.tsx` | one of a few mutually exclusive choices, all worth showing | more than about five options — that is `Select` |
| `Select.tsx` | one of many | a yes/no |

## Fields

| File | Job |
|---|---|
| `NumberField.tsx` + `numberParse.ts` | a number with a unit shown after it (mm, deg, ×). **`numberParse.ts` is pure and forgiving on purpose**: `2mm`, `2,5`, full-width digits and `1.5x` all parse, and it has its own test because a strict parser here means a user retyping a value |
| `RangeField.tsx` | a slider. **Live while it moves, and no undo entry** — the undo entry belongs to the commit, not the drag |
| `TextField.tsx` | text, with a mapper from what is typed to what is accepted |
| `ColorField.tsx` | `#rrggbb` |
| `FieldRow.tsx` | the label + control row; the render function receives the id the label is bound to, so the binding cannot be forgotten |

## Structure and feedback

| File | Job |
|---|---|
| `Section.tsx` | a collapsible group. Tri-state `collapsed`: `true`, `false`, or `undefined` = defer to `defaultCollapsed` |
| `Modal.tsx` | **at most one `primary` is honoured**; extra primaries render plain rather than giving the user two first choices |
| `Notice.tsx` | an inline notice, with actions on their own row below the text |
| `Toast.tsx` | transient feedback with one optional action (e.g. Undo), which runs and then dismisses |
| `ProgressRow.tsx` | `0..1` for determinate; omit the value for indeterminate |
| `KeyCaps.tsx` | a shortcut drawn as key caps, so `Ctrl+Shift+Z` never renders as prose |

## Tests

Nine `*.test.tsx` files plus `containers.test.tsx`. Each one tests the control's **contract** — the
accessible name, the pressed state, what a bad value does — not its markup. A test that asserts a
class name is a test a restyle breaks, and this folder's whole job is to be restyled safely.

`gallery/` renders every control on one page: the fastest way to see the library, and the thing to
check after a token change.

## Styling

Tokens come from `mixo-app-style` (`tokens.css` / `base.css`), copied in, never re-derived. A
hard-coded colour or spacing value in this folder is a defect: it is the one folder where a
hard-coded value spreads to every panel at once.
