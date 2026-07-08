# Roadmap — Harness Engineering

High-value gaps surfaced by SOTA harness engineering research (Ryan Lopopolo's
"Harness Engineering" essay + OpenAI Frontier/Symphony practice; the Agent
Safehouse reverse-engineering of Claude Code v2.1.39). Where the
[cognition roadmap](roadmap-cognition.md) asks *how the agent thinks*, this
track asks *how the agent does work concisely*: keeping noise out of the
context window, staying unblocked on long operations, and delegating the
boring loops. Ordered by evidence-to-effort. Each item lists basis, shape,
prerequisites, and rough effort.

> **The unifying lever:** nearly every item here reduces context-window noise
> — background polls instead of blocked stdout, a todo scratchpad instead of
> plan-in-prose, compact test summaries instead of raw 500-line output,
> distilled review findings. Concise implementations come from concise
> context, and concise context comes from these substrate tools.

> **Substrate note:** pi already ships working `examples/extensions/` for
> several of these (subagent, todo, git-checkpoint, git-merge-and-resolve,
> auto-commit-on-exit, bash-spawn-hook). The gap is largely *package and
> polish*, not build from scratch.

## Research basis

- **Lopopolo, "Harness Engineering" (2026-04)** + Latent Space podcast. The
  defining practitioner account: 1M LOC, 0 human-written/reviewed code, $2-3k
  token spend/day. Core levers: background shells, one-minute inner loop,
  observability over the agent, skills/docs/tests/quality-scores as durable
  non-functional-requirement encoding, full PR-lifecycle delegation,
  spec-driven "ghost libraries," and the Symphony orchestrator.
- **Agent Safehouse, Claude Code v2.1.39 analysis.** Feature archeology:
  `Task`/`TaskOutput`/`TaskStop` subagents (v1.0.60), `TodoWrite` (v0.2.93) +
  task system (v2.1.16), background agents (v2.0.60) + Ctrl+B bash (v1.0.71),
  hooks (PreToolUse/PostToolUse/Stop…), plugins, OTEL telemetry, worktree +
  gh PR support, `/rewind` (v2.0.0).
- **pi's own extension/event surface** (`tool_call`, `tool_result`,
  `message_end` usage, `after_provider_response`, `bash` `spawnHook`) and
  the `examples/` tree.

Implemented to date: H1 (in-session todo tool), H2 (background shells). The
cognition roadmap's shipped items — memory, plan, verify — compose with
everything below.

## Tier 1 — cheap, high conciseness leverage

### H1. In-session todo tool  ✅ done

**Shipped:** `agent/extensions/todos/index.ts` (`todo` tool + `/todos` command).
See [extensions/todos.md](extensions/todos.md). State in tool-result details
(branches correctly); ephemeral scratchpad that complements the `plan` skill.

**Basis:** Claude Code's `TodoWrite` (v0.2.93) and task system (v2.1.16) are
standard across SOTA harnesses. The distro's `plan` skill writes plans to
*memory*, which is durable but heavy for the lightweight "what am I doing
right now" scratchpad. Notably, pi's own system prompt references an
"in-session todo list" that does not exist.

**Shape:** Package `examples/extensions/todo.ts` almost verbatim. It already
stores state in *tool-result details* (not external files), so todo state
branches correctly with the session tree — the right primitive. Register a
`todo` tool (list/add/toggle/clear) + `/todos` command. Keep it
model-auto-invocable; the plan skill can layer on top of it instead of
holding plan state in prose.

**Prerequisites:** None.

**Effort:** Small (~1 hour). The example is essentially done; this is
packaging, a skill prompt tweak, and a doc.

### H2. Background shells / async bash  ✅ done

**Shipped:** `agent/extensions/bg/index.ts` (`bg` tool + `/bg` command).
See [extensions/bg.md](extensions/bg.md). Single `bg` tool with an `action`
enum (`start`/`read`/`list`/`stop`) — mirroring the `todos` enum pattern, not
four separate tools (context-footprint discipline). Detached `child_process`
spawn (own process group) with stdout/stderr piped to separate files under a
per-process `$TMPDIR/pi-bg-<id>/` dir; `bg read` returns a cheap status tail
and the file paths, so the model `grep`s/`read`s the full log with existing
tools. Fully ephemeral: in-memory handle table, SIGKILL all children +
remove tmpdir on every `session_shutdown`. `stop` = SIGTERM→3s→SIGKILL,
leaves files (stop-then-grep). Env vars `PI_BG_MAX_LIFETIME` (default 1800s),
`PI_BG_DISABLED`.

**Deferred enhancement — auto-backgrounding:** Claude Code auto-backgrounds
long `bash` calls (a `bash` exceeding a threshold returns a `bg` handle
instead of blocking). Out of scope for v1 (`bg` is model-invoked only):
it would require the `bg` extension to *own the `bash` tool's execute path*
(`spawnHook` only adjusts command/cwd/env before spawn; `tool_call` can't
take over execution; `BashOperations.exec` is blocking-until-exit and yields
no PID), which is more risk than the rest of H2 combined and would change
the `bash` tool's contract. Revisit if the "model accidentally blocks on a
slow command" problem surfaces in practice; the answer then may be the model
learning to use `bg` earlier, or H3's test-loop tool.

**Basis:** Codex "background shells" are the central operational lever in
the harness-eng essay — the team retooled their entire build to <1 minute
specifically because the model became *less patient* when it could spawn
work in the background and continue. Claude Code ships background agents
(v2.0.60), Ctrl+B background bash (v1.0.71), and auto-backgrounding of
long-running commands (v2.0.19). The pattern: spawn, keep working, poll.

**Shape:** A `bg` tool that runs a command detached (tmux pane or
`nohup`-style process, writing stdout to a file), returns a handle, plus
`bg_read` / `bg_list` / `bg_stop`. pi's `bash` tool accepts a `spawnHook`
(`examples/bash-spawn-hook.ts`) and the `tmux.md` doc documents
coexistence — the substrate exists. Claude Code's `TaskOutput` is the
model to mirror.

**Prerequisites:** None strictly. Composes with H3 (run tests in the
background, poll for results).

**Effort:** Medium. Detached-process + output-capture + handle table is
mechanically straightforward; the design work is the tool surface (what the
LLM sees, how completion is signaled) and portability (tmux optional vs
required).

### H3. Test/CI loop as a first-class tool

**Basis:** The harness-eng essay's central invariant: keep the inner loop
under one minute, and when it breaches, treat that as a signal to decompose
the build graph. The agent must run tests, parse results, and act on
failures — not drown in raw stdout. The distro's own hand-rolled
typecheck recipe (see `lessons.md`) is a prototype of this.

**Shape:** A `test` tool that runs the project's configured test/build
command, parses exit code + output, and returns a *compact* summary:
pass/fail counts, failing test names + one-line messages, not the full log.
Config via project-local file (command, parser hint). Pairs with H2: long
suites run in the background and report back distilled.

**Prerequisites:** None. Strongly composes with H2.

**Effort:** Small-to-medium (~1 day). Wrapping `bash` + a result parser per
framework family. Start with one parser (jest/vitest or cargo or go test);
add others on demand.

## Tier 2 — the delegation substrate

### H4. Git checkpoint + PR lifecycle

**Basis:** The essay frames full PR-lifecycle delegation (push, wait for CI,
fix flakes, merge queue, repeat) as "what it means to delegate fully."
Claude Code has worktree support, `gh` PR create/review, commit
co-authoring, and session↔PR linking (v2.1.27). The cheap form —
auto-checkpoint per turn — is a pure safety net.

**Shape:** Two layers.
- **Cheap:** Package `examples/git-checkpoint.ts` (auto-commit/stash per
  turn) as the always-on safety net. This is the practical form of the
  cognition roadmap's #2 (checkpoint/rewind) — git-level, not tree-level.
- **Full:** A `/pr` skill: create a worktree, push, `gh pr create`, watch CI
  (composes with H2/H3), surface failures, drive fixes, merge. Mirrors
  Claude Code's bundled `commit-commands` and `pr-review-toolkit` plugins.

**Prerequisites:** H2/H3 helpful for the CI-watching layer. Overlaps
[cognition #2 checkpoint/rewind](roadmap-cognition.md) — recommend doing
the cheap git form first and reserving tree-rewind for when git checkpoints
prove insufficient.

**Effort:** Cheap form ~half a day (package the example). Full `/pr` skill
medium (1-2 days); the worktree + gh mechanics are standard, the design
work is the CI-watch loop and failure surfacing.

### H5. Sub-agent orchestrator

**Basis:** The single most-cited architectural pattern across all sources.
Claude Code's `Task`/`TaskOutput`/`TaskStop` + custom subagents as `.md`
files; Symphony is the extreme form. The essay: sub-agents give context
multiplication (total work far exceeds one window) and separation of
concerns (exploration context stays isolated; lead agent synthesizes).

**Shape:** Package `examples/extensions/subagent/` (already implements
single/parallel/chain modes via the headless child `pi` spawn — the
correct isolation primitive per `lessons.md`, *not* `ctx.newSession`/
`ctx.fork`). Add an orchestrator contract: when to delegate, how to scope a
sub-agent's task, how to verify its output. Sub-agents should write durable
results to the memory extension. Agent definitions as `.md` files with
frontmatter (model, tools, system prompt), mirroring Claude Code's
`.claude/agents/`.

**Prerequisites:** Memory extension (shipped) for durable handoff. This is
the shared item with [cognition #3 orchestrator](roadmap-cognition.md) —
the two tracks converge here. The verify extension already proved the spawn
pattern; extract it to a shared lib when this lands.

**Effort:** Large. The mechanical spawn is done (the example + verify); the
real work is the orchestration contract and agent-definition format.

### H6. Diff-oriented code review

**Basis:** Claude Code ships a `code-review` plugin (5 parallel agents on a
diff) and `pr-review-toolkit` (6 agents); `security-guidance` runs 9
PreToolUse patterns. The essay frames review agents as a way to encode
non-functional requirements and "what good looks like." The distro's
`verify` extension is *claim*-oriented, not *diff*-oriented — it checks an
assertion, not "is this change good."

**Shape:** A `/review` skill that diffs `git diff` (staged or vs base
branch) and runs N verify-style sub-agents with distinct lenses (security,
performance, style, test-coverage, spec-conformance), returning compact
findings ranked by severity. Builds on H5 (parallel sub-agents) and the
verify extension's verdict format. Optionally a PostToolUse-style hook
(`tool_call`/`tool_result` events) that auto-runs a lightweight review on
edits — pi's `examples/confirm-destructive.ts`, `protected-paths.ts`,
`dirty-repo-guard.ts` are the substrate for the hook form.

**Prerequisites:** H5 (sub-agents) for the multi-lens form. The
single-lens hook form is buildable now. Overlaps
[cognition #4 verification](roadmap-cognition.md) — this is the
*diff-specialized, multi-antagonist* form the cognition roadmap defers
pending the orchestrator.

**Effort:** Medium (single lens) to Large (full antagonist ensemble on
diffs).

## Tier 3 — the flywheel and the meta

### H7. Skill-distillation loop

**Basis:** The essay's core loop: when the agent fails or the human
corrects it, ask "what capability, context, or structure is missing?" and
write it down durably — as a skill, a doc, a rule, a quality-score table.
This is the flywheel that makes the distro improve with use. The distro's
memory extension captures *lessons*, but there is no loop that converts a
failure into a durable project-local skill or rule.

**Shape:** A `/distill` skill, prompt-side (no runtime): on a failure or
human correction, propose a project-local skill (pi supports
`.pi/skills` / `.agents/skills` per `docs/skills.md`) or a rules file
capturing the non-functional requirement that was violated. Review with the
human (via the `review` tool), then write it. Lean on memory for the
cross-session "what did we learn" record.

**Prerequisites:** Memory extension (shipped). Optional but better with the
terminal extension's `review` tool for human-in-the-loop approval.

**Effort:** Small (~1 day). Mostly prompt engineering over existing
primitives. Highest long-term ceiling of anything on this track.

### H8. Observability / agent-run telemetry

**Basis:** The essay: "invest in observability so you're not sitting in
front of a terminal." Claude Code ships OTEL export (spans, active-time,
token spend); Symphony runs a full local traces/metrics/logs stack. The
purpose is the human's gardening loop — see where tokens/time go, where the
agent spins.

**Shape:** A `/stats` extension aggregating per-session token/cost and
tool-call data from the events pi already emits for free
(`message_end` usage, `after_provider_response`, `tool_execution_end`).
Surface "tokens spent per task," "tool-call heat map," "where did the agent
spin." Persist aggregates to memory so they survive compaction. No external
backend required for v1; OTEL export is a later option.

**Prerequisites:** None for v1 (events + memory suffice).

**Effort:** Medium (1-2 days). Aggregation + a compact TUI/command surface.

### H9. Spec-driven development skill

**Basis:** The essay's "ghost libraries" — distribute software as specs; a
coding agent reassembles the implementation locally. Claude plan-mode +
skills point the same way. Emerging norm for spec-first teams.

**Shape:** A `spec` skill: write/maintain a `SPEC.md`, then drive
implementation and verify-against-spec (composes with the verify extension).
Lower priority — more workflow/convention than machinery.

**Prerequisites:** Verify extension (shipped) for spec-conformance checks.

**Effort:** Small. Defer unless the user works spec-first.

## Explicitly deferred / not building

- **MCP client support.** Ryan is explicitly bearish: MCP "forcibly injects
  all those tokens in the context," messes with auto-compaction, and the
  agent forgets how to use the tools. pi has no MCP client and that is
  defensible. Build only if a specific MCP server becomes load-bearing for
  the user.
- **Plugin marketplace / distribution.** The distro is personal; pi already
  has `pi install`. Not a leverage gap.
- **IDE integration / LSP.** Out of scope for a terminal distro.
- **Enterprise managed settings / multi-tenant governance.** Single-user.

## Sequencing

Recommended order, by evidence-to-effort, with cognition-track overlaps
noted:

1. **H1 todo tool** ✅ done — packaged `examples/todo.ts` as
   `agent/extensions/todos/index.ts` (tool + `/todos` command; state in
   tool-result details). Cleaner planning.
2. **H2 background shells** ✅ done — `bg`/`bg_read`-style as a single
   `bg` tool with `action` enum (`start`/`read`/`list`/`stop`) in
   `agent/extensions/bg/index.ts`. Detached spawn + file-piped stdout/stderr
   + ephemeral handle table. Auto-backgrounding deferred (would require
   owning `bash` execute). Composes with H3.
3. **H3 test-loop tool** — wrap bash + parser. ~1 day. Biggest
   context-noise win.
4. **H4 git-checkpoint + `/pr`** — package git examples + worktree skill.
   ~1-2 days. Cheap form is the practical cognition-#2 checkpoint; full
   `/pr` delegates the boring loop.
5. **H5 sub-agent orchestrator** — package `examples/subagent` + contract.
   ~2-3 days. *Converges with cognition #3.* Unlocks H6.
6. **H6 diff-review skill** — verify-on-diff with N lenses. ~1 day after
   H5. *Converges with cognition #4* (the deferred antagonist ensemble).
7. **H7 distill skill** — prompt-side flywheel. ~1 day. Highest long-term
   ceiling.
8. **H8 `/stats` observability** — events → aggregate. ~1-2 days.
9. **H9 spec skill** — defer unless spec-first.

The cheap front of this track (H1-H3) is the fastest route to *more concise
implementations* — each one removes a category of context noise the agent
currently carries inline.
