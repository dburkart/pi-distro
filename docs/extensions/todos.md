# Todo Extension

`agent/extensions/todos/` adds a lightweight **in-session todo list** — a
`todo` tool (model-auto-invocable) and `/todos` command. It is a scratchpad
for "what am I doing right now" on a multi-step task: add the steps up front,
toggle each done as you finish, and progress stays out of prose and the
context window.

This is roadmap item **H1 (In-session todo tool)** on the
[harness-engineering roadmap](../roadmap-harness-eng.md). Based on pi's
`examples/extensions/todo.ts`, packaged with auto-invocation signals.

## Why a todo tool

Across SOTA harnesses an in-session todo list is standard (Claude Code's
`TodoWrite` + task system). Without one, the agent either holds task state in
prose (consuming context) or in memory (heavy for ephemeral state). A
model-callable `todo` tool keeps the scratchpad out of the context window and
gives the model a structured place to track its own progress — the
harness-eng track's unifying lever (less context noise → more concise work).

## State model: tool-result details, not files

Todo state is stored in each tool result's `details` field, **not** in an
external file. This is the load-bearing design choice: because state rides
the session tree as ordinary tool results, it **branches correctly** — when
you fork or navigate the tree, the todo list is automatically correct for
that point in history. An external file would be shared across branches and
desynchronize.

On `session_start` and `session_tree`, the extension reconstructs in-memory
state by replaying the current branch's `todo` tool results in order.

> **Ephemeral, not durable.** Compaction may prune tool results, so the todo
> list is *not* guaranteed to survive compaction. It is a scratchpad, not a
> plan store. For state that must survive compaction or resume across
> sessions, use the [`plan` skill](../skills/plan.md), which writes durable
> plans to memory. The two compose: `plan` holds the durable contract; `todo`
> holds the in-the-moment checklist.

## The `todo` tool

Actions: `list`, `add` (`text`), `toggle` (`id`), `clear`. The tool is
model-auto-invocable via `promptSnippet` + `promptGuidelines`, with positive
*and* exclusion signals to bound firing: use it to track a multi-step task;
do not use it for single-step edits, and do not use it as a substitute for the
`plan` skill's durable plans.

## The `/todos` command

`/todos` opens a full-screen TUI list of the todos on the current branch
(completed count + each item with a ✓/○ marker). TUI-only; in non-interactive
modes it notifies that it requires interactive mode.

## Configuration

None. The extension is pure in-process state with no external dependencies,
no env vars, and no network/filesystem access — it is always on when loaded.
Disable it with pi's standard `--exclude-tools todo` / `--no-extensions`
flags if needed.
