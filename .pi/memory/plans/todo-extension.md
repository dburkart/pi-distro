# todo-extension — Roadmap H1: in-session todo tool

Status: done
Goal: Ship the harness-eng roadmap's first item (H1): package pi's
`examples/extensions/todo.ts` as an in-session `todo` tool + `/todos`
command — a lightweight model-auto-invocable scratchpad that keeps
"what am I doing right now" state out of prose/context. Complements the
durable `plan` skill (which stays in memory); does not replace it.

Steps:
  1. Create `agent/extensions/todo.ts` (single file) adapted from
     `examples/extensions/todo.ts`: `todo` tool (list/add/toggle/clear)
     storing state in tool-result `details` (reconstructed on
     `session_start`/`session_tree` so it branches correctly with the
     session tree); `/todos` command rendering the TUI list component.
     Guard the TUI component to `ctx.mode === "tui"`.
  2. Add `promptSnippet` + `promptGuidelines` so the tool is
     model-auto-invocable: use it to track multi-step task progress; do
     NOT use it to replace the `plan` skill's durable memory-resident
     plans (todos are an ephemeral scratchpad; compaction may prune
     them).
  3. Typecheck against the installed dist via the synthetic-tsconfig
     recipe in lessons.md. Confirm clean.
  4. Smoke-load the extension under jiti (`pi -e ./agent/extensions/todo.ts -p`
     or `pi --mode json -p`) and call `todo list` to confirm it loads +
     reconstructs without error.
  5. Doc: write `docs/extensions/todo.md`; add an index line to
     `docs/README.md` under Extensions; mark H1 done in
     `docs/roadmap-harness-eng.md` (Implemented-to-date + H1 entry).
  6. Mark plan Status: done; mirror decisions into decisions.md; append
     lessons.md only if something diverged.

Assumptions:
  - Single-file packaging (`agent/extensions/todo.ts`) is appropriate:
    the example is one self-contained file (~200 lines, one tool + one
    command + one TUI component), and extensions.md explicitly blesses
    single-file for small extensions. Other distro extensions are
    directories only because they're multi-file.
  - State in tool-result details is the correct branching primitive
    (per the example + roadmap H1): it rides the session tree so todos
    are correct per-branch. It is ephemeral — compaction may prune tool
    results — which is acceptable for a scratchpad. Durable task
    tracking stays in the `plan` skill's memory pages.
  - `Theme` is importable from `@earendil-works/pi-coding-agent`
    (confirmed: `dist/index.d.ts` re-exports `Theme` from
    `modes/interactive/theme/theme.ts`); `Text`, `truncateToWidth`,
    `matchesKey` from `@earendil-works/pi-tui` (confirmed exported). The
    example should typecheck nearly verbatim. (Lessons.md's "Theme not
    exported from pi-tui" caveat applies only to importing Theme from
    pi-tui directly — the example imports it from pi-coding-agent.)
  - Plan-skill composition (layering todos atop the durable plan) is a
    deliberate follow-up, not part of H1 — it would change the plan
    skill's contract and risks conflating ephemeral + durable state.

Open questions:
  - none

Decisions (mirrored into decisions.md):
  - Single-file `agent/extensions/todo.ts` (small extension; docs bless
    single-file).
  - Model-auto-invocable via `promptSnippet` + `promptGuidelines`; also
    a `/todos` user command. Precedent: verify/memory extensions.
  - State in tool-result `details`, reconstructed on session_start /
    session_tree (correct branching; ephemeral scratchpad). Complements,
    does not replace, the `plan` skill's memory-resident plans.

Log:
  - 2026-07-08: Plan written. Resume check done (verify-extension plan
    is `done`; no in-progress todo plan). No escalation signals —
    small/reversible/clear-criteria packaging task; grilling not
    recommended. Verified the example's imports typecheck against the
    installed dist before committing to "package verbatim."
  - 2026-07-08: Implementation complete. `agent/extensions/todo.ts`
    (single file, ~340 lines) adapted from `examples/extensions/todo.ts`:
    `defineTool`+`pi.registerTool` with `promptSnippet`/`promptGuidelines`
    (matches verify/web convention), richer description with positive+
    exclusion signals, `/todos` TUI command guarded to tui mode. State in
    tool-result details; reconstructs on session_start/session_tree.
    Typecheck clean (tsc 5.5 strict, synthetic tsconfig per lessons.md).
    jiti smoke-load + functional test pass (add/toggle/list/clear +
    branch-reconstruction of state and nextId). Docs: docs/extensions/todo.md,
    indexed in docs/README.md, roadmap-harness-eng.md H1 marked done. No
    divergence from plan. The `Theme` import resolves from
    `@earendil-works/pi-coding-agent` (not pi-tui) — confirmed, typechecks.
    Note for the jiti smoke harness: bare `require.resolve` of
    @earendil-works/* fails (ESM-only exports maps, no `require`
    condition); must pass a jiti `alias` map pointing at the dist entry
    files, exactly as pi's own loader does (getAliases in loader.ts).
    Captured in lessons.md for the next extension packaging task.
