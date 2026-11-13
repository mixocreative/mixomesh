# docs/ — the map

Fifty-odd files, so this is the map rather than a list to read through. The rule the folder works
by: **a document says when it was written and what it decided.** Dated files are a record of a
moment and are not edited to match later reality — they are superseded by a newer dated file, or
corrected in place with the correction marked, so a reader can tell what was believed when.

| where | what is in it | read it when |
|---|---|---|
| `ui.md` | the UI vocabulary and the rules the panels follow | touching anything the operator sees |
| `TRANSLATIONS.md` | how locales are added and checked (`i18n:check`) | adding or changing a string |
| `support-generation-port.md` | how support generation came across from mixoDental, and what stayed shared | working on supports |
| `size-debt.md` | every file over ~600 lines with its next cut named, and which cuts are owed | before adding to a long file -- add at the seam |
| `roadmap-kitbash.md` | the longer arc for kitbashing | deciding what is next |
| `layperson-web-desktop-build-guide.md` | building and running without the context the rest assumes | first time through |
| `adr/` | architecture decisions, one per file — the load-bearing ones | before changing what something IS |
| `plans/` | dated plans, each with its units and their done-tests | picking up planned work |
| `design/` | dated design documents | questioning a feature's shape |
| `handoff/` | dated handoffs | resuming |
| `reviews/` | dated review and audit reports | looking for what a review already found |
| `reference/` | external references the code is checked against | changing geometry or placement |
| `superpowers/` | plans and specs from the superpowers workflow | archaeology on an older plan |
| `screens/` | captured screens the documents reference | — |

Dated documents are `YYYY-MM-DD-<subject>.md` (or `<subject>-YYYY-MM-DD.md` for the two audits at
the top level), kebab-case, in the folder matching their kind. A **contradiction with an ADR is
escalated, not quietly fixed** — the ADR is the decision, and code that disagrees with it is either
a bug or a decision nobody wrote down.

## The code's own maps

`docs/` is not the only map. Every folder past ~20 files carries its own README, and those are
closer to the code than anything here: `src/core/`, `src/core/assets/`, `src/core/print/`,
`src/ui/`, `src/kit/`, `src/supports/` and `tests/`. Start there for "where is X"; come here for
"why is X this way". `python ~/.claude/skills/cia/tools/maintainability.py S:/ai/mixomesh` checks
that a folder past the limit has one.

## Two things worth knowing before you trust a green run

**The engine baseline is a committed capture, and re-taking it is a decision.**
`tests/fixtures/engine-baseline.json` records this app's own output for the engine as vendored.
`src/supports/engineBaseline.test.ts` compares against it and says `UPDATE_BASELINE=1` re-takes it —
do that only after reading the diff row by row. Its `sunk-pair` row reads `tips 33 / verdict
blocked` **by decision, not by accident**: the generic placement path deliberately applies no
overlap rule, so a support lands on a buried face and the build says so loudly. The note on that row
explains why re-landing the rule would be a mistake.

**`npm run test:all` is sequential and browser-heavy.** A failure that passes when the suite is run
alone is contention, not a defect — but check it alone before concluding that, because on
2026-11-13 a step that looked exactly like contention turned out to be clicking 27 px off target.
