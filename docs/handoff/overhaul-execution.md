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

- Partial staging of shared files (Blueprint.md): scratchpad helper must pipe the patch as BYTES — Python text-mode stdin on Windows turns LF→CRLF and `git apply --cached` fails.
- Verify COMMITTED state while agents edit the tree: clean worktree `<scratchpad>/wt-head` (node_modules = junction to repo's); `git -C <wt> checkout -q --detach <sha>` then `npm test` there. Never gate a commit on `grep` succeeding — require `# fail 0`.
- WATCH (flaky, passed on rerun; export smoke now dumps Vite output on failure — suspect Vite dep re-optimisation reload): browser-smoke `glTF restore AABB != fresh import` (ratio ~1.6 — suspect import-bounce timing, memory audit_2026-06-16); browser-export-smoke `Inspected target navigated or closed`. If either repeats twice in a row, investigate.
- `browser-export-smoke` flaked once with a zlib stream error (passed on rerun) — rerun before investigating.
- Python heredoc anchors with `\n` sometimes fail to match `console.log('
' + out.join('
'))` in tests — insert by line number with `sed -i "<N>r file"` instead.
- Parallel agents: give each disjoint files; agents never touch Blueprint/locales unless the task owns them — they report lines, main applies.

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
| 0.1 Terminology pass | sonnet | done 6dbdb78 | bundled w/ 0.9 (shared locales); UV rot field now degrees |
| 0.2 Write hardening + persistent storage | sonnet | done 16e169a | bundled w/ 0.8+0.10 (shared files) |
| 0.3 Input hygiene | sonnet | done 6d66b10 | Ctrl+I = Import (plan row 11), not invert-select |
| 0.4 Electron reload/crash guard | sonnet | done a3da60f | `npm run test:electron` not yet run (needs build) — run at phase close |
| 0.5 Load-path integrity | sonnet | done 7efeb91 | |
| 0.6 Readiness strip every Print tab | sonnet | gated | Mockup gate |
| 0.7 Arrange rename + toolbar button | sonnet | gated | Mockup gate |
| 0.8 Texture capture failure surfaced | sonnet | done 16e169a | |
| 0.9 Undo/Redo buttons + reset-all confirm | haiku | done 6dbdb78 | smoke: Undo button reverts Duplicate |
| 0.10 Case-insensitive texture export names | sonnet | done 16e169a | |
| 0.11 Autosave reachable, keyed by id | opus | done b84bece | also fixed: loader deleted autosave via raw IDB (missed Electron kv) |
| 0.12 Shader → Material strings | haiku | done 5c5a24c | bundled w/ 1.6 (shared locales/smoke) |
| 0.13a DESIGN.md | opus | done 2b4edff | stitch designMd.valid=true |
| 0.13b Stitch gitignore + capture recipe + hygiene test | haiku | done 2b4edff | trial capture OK (scratchpad, git clean) |

### Phase 1 — Printer strategy, export flow, scale model (18)
| Task | Tier | Status | Notes |
|---|---|---|---|
| 1.1 printers.json v2 + loader (+AGENTS rule 6) | sonnet | done 2e47d4c | 20 rows; some bed specs flagged for owner double-check |
| 1.2 Printer tab | sonnet | gated | Mockup gate; deps 1.1 |
| 1.3 Export flow + settings scope (+ApplyPrinterProfileCommand) | opus | gated | Mockup gate; deps 1.1/1.15/1.16/1.17 |
| 1.4 Per-printer readiness hints | sonnet | done 4aabce3 | thickness tests written by main (agent claimed but had none) |
| 1.5 3MF split-by-material / metadata / thumbnail / alpha | opus | done 8bdfaca | owner eyeball checklist in commit/agent report: Bambu Studio + PrusaSlicer |
| 1.6 PLY + WRL writers | opus | done 5c5a24c | trimesh +1000 mm³ both |
| 1.7 OBJ through PrintSpace w/ per-printer axis | opus | done ba786e6 | Y-up identical to old OBJExport; owner eyeball in Mimaki tool |
| 1.8 Gate tightening | sonnet | done 0ce3ce4 | smokes pass acknowledgeWarnings (follow-up commit) |
| 1.9 Texture colour-space check | sonnet | done fc71135 | conversion export-readback only (capture raw) |
| 1.10 Dead export/scale code removal | sonnet | done 498f444 | dead keys also stripped from old .mixo on load |
| 1.11 Bambu/Orca 3MF flavour | opus | done 8446ac3 | owner eyeball checklist (Bambu Studio/Orca) before `verified` |
| 1.12 Blueprint §12 consistency pass | haiku | done c4351f1 | 7 contradictions fixed; main corrected 1 agent error (3MF flavour) |
| 1.13 Scale control: declare vs convert | opus | gated | Mockup gate |
| 1.14 Rescale about own origin | sonnet | done e7fed24 | |
| 1.15 Explicit export reference + mixed-scale note | opus | done 1d7864f | UI row lands in 1.3 |
| 1.16 Effective scale | sonnet | done f4c8d88 | logic; Properties line waits on 1.13 mockup |
| 1.17 Typed print sizes + filename tokens | opus | done 55bd4f6 | bundled w/ 2.7 (shared ProjectLoader/PrintPanel); editor UI → 1.3 |
| 1.18 Per-target cost lines | sonnet | done 5faaac5 | |

### Phase 2 — Hierarchy core (7)
| Task | Tier | Status | Notes |
|---|---|---|---|
| 2.1 Selection accepts group ids | opus | done d7843e5 | |
| 2.2 Pivot attaches group nodes rigidly | opus | done 29667e2 | median/active pivot now bbox centre; Properties/CursorTools/Swab still mesh-only (2.4/3.6) |
| 2.3 Group creation semantics + persistence | sonnet | done 2b9c0e4 | Ctrl+G selects new group; Blueprint text in c4351f1 |
| 2.4 Ungroup/Delete/Duplicate accept groups | sonnet | done 6fcd5ee | group duplicate nudged +10 mm like objects |
| 2.5 Lock enforcement | sonnet | done a242b9b | Delete ASKS (main fixed agent's refusal → Decision 9); group lock persisted |
| 2.6 Logical-object edge cases | sonnet | todo | after 2.3/2.7 (ParentCommands, MeshValidator) |
| 2.7 Retire runtime sourceGroupId (+AGENTS rule 7) | sonnet | done 55bd4f6 | legacy seed in ProjectLoader + test |

### Phase 3 — Hierarchy UI (7): 3.1 sonnet, 3.2 opus, 3.3-3.6 gated (Mockup), 3.7 haiku — todo

### Phase 4 — Asset model + name clashes (10)
| Task | Tier | Status | Notes |
|---|---|---|---|
| 4.1 Schema 3.4 + real migrate() | opus | done 39ae3e4 | ratioSource hook left for 1.13 (gated) |
| 4.2 Adapter resolveAsset/persistRef/restoreRef/findMoved | opus | done 1210b7f | load-time scan + 'changed' live bytes still on → 4.3/4.5 switch off and update persistence.test priority 1/2 cases |
| 4.3 Explicit Find moved file | sonnet | todo | after 4.2 |
| 4.4 Route remaining FSA/idb + boot gate | opus | todo | after 4.2 |
| 4.5 RelinkAssetCommand | sonnet | todo | after 4.2 |
| 4.6 Source status / Project-Folders tabs / Sources modal | sonnet | gated | Mockup |
| 4.7 Boot banner | sonnet | gated | Mockup |
| 4.8 Name-clash rules | opus | todo | logic ungated, display parts gated; after 4.1 |
| 4.9 Dead code + registry growth | sonnet | todo | after 4.2 |
| 4.10 Blueprint §11 pass + ADR addendum | haiku | todo | last |

### Phases 5–6
Copy task ids/titles from the plan into a table here when the phase starts (keeps this file short until then).
- Phase 2 — Hierarchy core (7) — todo
- Phase 3 — Hierarchy UI (7) — todo
- Phase 4 — Asset model + name clashes (10) — todo
- Phase 5 — Shell, viewport, onboarding (10) — todo
- Phase 6 — Hardening + maintenance (13) — todo

## Owner queue (things waiting on the owner)

- Owner rule: start every status report with 🟡/⛔, and ✅🎉 ALL DONE only when the whole mission is finished (memory feedback_done_emoji).
- [ ] Double-check printer bed specs flagged by 1.1: Stratasys J55/J850, Anycubic Photon Mono/Kobra 3, Bambu H2D, Prusa XL, Elegoo Centauri Carbon, Formlabs Form 4, HP MJF 580.

- [ ] Confirm Stitch project binding + first fixture-screen batch upload (Decision 30) — 0.13a/b DONE, asked owner 2026-10-14 (non-blocking).
- [ ] Optional: fix `~/.codex/config.toml` so Codex audits work again.

## Session log

- 2026-10-14 — Plan authored (Fable), audited twice (Sonnet), committed `421b8be`; all decisions accepted;
  this handoff created. Next: Phase 0, start with 0.13a/0.13b + ungated 0.1–0.5, 0.8–0.12.
- 2026-10-14 (cont.) — Phase 0 batch A landed: 0.13a/b 2b4edff, 0.3 6d66b10, 0.4 a3da60f, 0.2+0.8+0.10 16e169a (all checks + browser/export smokes green). Batch B (0.1, 0.5, 0.9) dispatched; then 0.11 (opus, main), 0.12.
- 2026-10-14 (cont.) — Phase 0 ungated DONE: 0.5 7efeb91, 0.1+0.9 6dbdb78, 0.11 b84bece. Remaining Phase 0: 0.12 (batch C), gated 0.6/0.7. Batch C dispatched: 0.12, 1.1, 1.6 (opus agent), 1.9, 1.14. 
- 2026-10-14 (cont.) — 1.1 2e47d4c, 1.9 fc71135, 1.14 e7fed24, 1.6+0.12 5c5a24c, 1.15 1d7864f. Phase 0 ungated complete. Batch D running: 1.4, 1.5 (opus), 1.7 (opus), 1.16. Then 1.10, 1.8, 1.11, 1.17, 1.18, 1.12.
- 2026-10-14 (cont.) — 1.16 f4c8d88, 1.4 4aabce3, 1.7 ba786e6 (amended: 1.5 tests had leaked in), 1.5 8bdfaca. Full tree green incl. browser/export/ELECTRON smokes. Pending follow-up for 1.3: ExportContext._capturePrefs must carry objAxis + splitByMaterial (+exportFormat, threeMFFlavour). Batch E: 1.10, 1.11. Then 1.8, 1.17, 1.18, 1.12.
- 2026-10-14 (cont.) — 1.10 498f444, 1.11 8446ac3, 2.1 d7843e5 (worktree green 170/170). Running: 1.17 (opus), 2.2 (opus), 2.7. Next: 1.8, 1.18, 1.12; 2.3-2.6 sequenced per table.
- 2026-10-14 (cont.) — 1.17+2.7 55bd4f6 (worktree 173/173 + both smokes). Running: 2.2 (opus), 1.8, 1.18. Then 1.12 (Phase 1 close), 2.3 → 2.4 → 2.5 → 2.6.
- 2026-10-14 (cont.) — 1.18 5faaac5, 2.2 29667e2, 1.8 0ce3ce4 + smoke ack fix. Phase 1 ungated complete except 1.12 (Blueprint pass, next). Then 2.3 → 2.4 → 2.5 → 2.6.
- 2026-10-14 (cont.) — 2.3 2b9c0e4, 1.12 c4351f1 → Phase 1 ungated DONE (remaining 1.2/1.3/1.13 gated). Running: 2.4, 4.1 (opus), 4.2 (opus).
- 2026-10-14 (cont.) — 2.4 6fcd5ee, 4.1 39ae3e4, 2.5 a242b9b, 4.2 1210b7f. Full tree: unit 174/174, browser + electron smokes green; export smoke flaky (3 clean reruns). Next: 2.6; 4.3 + 4.5 (+switch off load scan), 4.4, 4.8 logic, 4.9.
