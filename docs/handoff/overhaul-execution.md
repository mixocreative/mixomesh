# HANDOFF — MIXOMESH overhaul execution

**Read this first after any interruption** (context compaction, token cutoff, crash, new session).
Then read the plan section for the next task. Update this file at every safe boundary
(after each task commit). Solo dev: **all work on `master`, no feature branches.**

- **Plan (authoritative):** `docs/plans/2026-10-14-mixomesh-overhaul.md` — 79 tasks in Phases 0–6
  (12 haiku · 48 sonnet · 19 opus) + 8 deferred (Phase 7, do NOT start). Each task has
  Files · Behaviour · Accept · Deps · Tier.
- **Owner goal (2026-10-14, verbatim intent):** "all accept, set goal to complete all things, non stop" —
  execute every scheduled task, phase by phase, without waiting for prompts between tasks.
- **Decisions:** ALL 1–33 ACCEPTED by owner 2026-10-14 (plan §6). Do not re-litigate.
  Owner wording for #32: "on select it will choose the suggested profile default, allow user change,
  and can be reverted by choosing default profile again."

## Execution protocol (every task)

1. Read the task block in the plan + every cited `path:line` (code is the truth; plan citations were
   verified at `421b8be` but code moves as tasks land — re-read before editing).
2. Dispatch by tier with `Agent` (model `haiku` / `sonnet`; opus-tier = main session does it, or an
   opus/fable subagent for big cross-cutting work). Prompt = full task block + relevant AGENTS.md rules +
   "run the Accept checks, report diff summary + test output". Never let a subagent commit.
3. **Main session verifies** before commit: `npm run typecheck`, `npm run lint`, `npm test`, plus the
   task's Accept smoke (`npm run test:browser` / `test:export` / `test:repair` / `test:group` /
   `test:electron` as relevant). Read the diff. A failed check → fix or re-dispatch; never commit red.
4. Blueprint.md + AGENTS.md edits ship **in the same commit** as the contract change (plan §8 header).
5. Commit to master, one task (or tightly-coupled pair) per commit, message `feat|fix|refactor|docs: <task id> <title>`,
   with the session attribution lines. Then tick the ledger below and commit the ledger with it.
6. Long suites that may outlive the session: `python ~/.claude/skills/token-economy-delegation/detached.py start <name> -- <cmd>`;
   record the run name in the ledger "Notes" before waiting.

## Gates that need the owner (do not block on them — batch them)

- **Mockup gate** (18 UI tasks, marked in plan): needs owner-approved Stitch mockup before implementation.
  Strategy: do ungated tasks first; when a phase's ungated work is done, prepare mockups for all its
  gated tasks in one batch and ask the owner once. Continue with the next phase's ungated tasks while waiting.
- **Stitch (Decision 30):** binding a Stitch project and each batch upload need explicit owner OK.
  Fixture/empty scenes only; never owner models/.mixo. Output = reference picture, never pasted into `src/`.
- **Live eyeball** items (plan marks them): collect into one list for the owner; don't claim UI works
  without `ui-screenshot.mjs`/smoke evidence (memory: ui_overhaul_2026-06-12).

## Known gotchas (verified this session)

- Stitch capture: **production build only** (`npm run build` → `npx vite preview --host 127.0.0.1 --port 5180 --strictPort`).
  Dev server capture inlines Vite HMR JS instead of CSS. Port **4173 is EACCES-reserved** by Windows here.
  WebGL viewport is not captured (blank). Workspace switches need chrome-devtools + `--page`.
  `stitch status` may report a dev server that isn't running — curl first.
- Codex CLI currently misconfigured: `~/.codex/config.toml` points `openai_base_url` at local Ollama
  (`127.0.0.1:11434`) → audits fail (`unknown input item type "additional_tools"`). Owner not yet asked to fix;
  use a Sonnet subagent for second-opinion audits instead.
- `refs.py` can't parse table-joined citations; spot-check by `sed -n` instead.
- Orientation/axis: verify empirically (trimesh / PrusaSlicer CLI / cull screenshot), never by LH/RH reasoning.
- MediaRecorder is removed (video = WebCodecs only); don't reintroduce.
- `.claude/` is gitignored; Stitch skill lives user-wide at `~/.claude/skills/stitch`.

## Ledger

Status: `todo` · `doing` · `done <commit>` · `blocked <why>` · `gated` (awaiting mockup approval)

### Phase 0 — Safety net + quick wins (14)
| Task | Tier | Status | Notes |
|---|---|---|---|
| 0.1 Terminology pass | sonnet | todo | |
| 0.2 Write hardening + persistent storage | sonnet | todo | |
| 0.3 Input hygiene | sonnet | todo | |
| 0.4 Electron reload/crash guard | sonnet | todo | |
| 0.5 Load-path integrity | sonnet | todo | |
| 0.6 Readiness strip every Print tab | sonnet | gated | Mockup gate |
| 0.7 Arrange rename + toolbar button | sonnet | gated | Mockup gate |
| 0.8 Texture capture failure surfaced | sonnet | todo | |
| 0.9 Undo/Redo buttons + reset-all confirm | haiku | todo | |
| 0.10 Case-insensitive texture export names | sonnet | todo | |
| 0.11 Autosave reachable, keyed by id | opus | todo | |
| 0.12 Shader → Material strings | haiku | todo | |
| 0.13a DESIGN.md | opus | todo | prerequisite of every Mockup gate |
| 0.13b Stitch gitignore + capture recipe + hygiene test | haiku | todo | prerequisite of every Mockup gate |

### Phases 1–6
Copy task ids/titles from the plan into a table here when the phase starts (keeps this file short until then).
- Phase 1 — Printer strategy, export flow, scale model (18) — todo
- Phase 2 — Hierarchy core (7) — todo
- Phase 3 — Hierarchy UI (7) — todo
- Phase 4 — Asset model + name clashes (10) — todo
- Phase 5 — Shell, viewport, onboarding (10) — todo
- Phase 6 — Hardening + maintenance (13) — todo

## Owner queue (things waiting on the owner)

- [ ] Confirm Stitch project binding + first fixture-screen batch upload (Decision 30) — ask when 0.13a/b are done.
- [ ] Optional: fix `~/.codex/config.toml` so Codex audits work again.

## Session log

- 2026-10-14 — Plan authored (Fable), audited twice (Sonnet), committed `421b8be`; all decisions accepted;
  this handoff created. Next: Phase 0, start with 0.13a/0.13b + ungated 0.1–0.5, 0.8–0.12.
