# Gap Analysis: SOTA Coding Harnesses vs. This Distro

Research basis: Ryan Lopopolo's "Harness Engineering" essay + Latent Space podcast
(OpenAI Frontier / Symphony); Agent Safehouse's Claude Code v2.1.39 reverse-engineering;
pi's own extension/event surface and shipped examples. Done 2026-07-07.

## What the distro already has (strong baseline)

- Persistent cross-session memory (factual + experiential, conflict detection, lint)
- Plan-before-execute skill (living-contract, compaction-resume anchor)
- Independent adversarial verifier (isolated headless spawn, re-derives from source)
- Terminal extension (`/edit`, `review` tool, secondary-buffer primitive)
- Web extension (search + fetch, pluggable backend)
- Grilling / handoff / grill-me skills
- Rich substrate unused: pi ships *examples* for subagent, todo, git-checkpoint,
  git-merge-and-resolve, plan-mode, bash-spawn-hook, auto-commit-on-exit — none packaged.

## Gaps, ordered by leverage × (1 − effort), with pi-substrate notes

### G1. Parallel sub-agent orchestration (THE big one)
SOTA norm: Claude Code `Task`/`TaskOutput`/`TaskStop` tools + custom subagents as
.md files; Symphony is the extreme form. Every major harness has this.
Distro: absent. Roadmap #3. pi ALREADY ships `examples/extensions/subagent/`
(single/parallel/chain modes, headless spawn) — the exact pattern verify uses.
Gap = package + polish the example, add an orchestrator contract.
This is the single highest-leverage gap: unlocks antagonist-ensemble verify (#4),
context multiplication, and is the substrate for almost everything below.

### G2. Background / async task execution ("background shells")
SOTA: Codex background shells (spawn cmd, keep working); Claude Code background
agents (v2.0.60) + Ctrl+B background bash (v1.0.71) + auto-background long cmds
(v2.0.19). This is THE lever in the harness-eng essay — it's why they retooled
builds to <1min.
Distro: bash tool is synchronous w/ timeout only. No way to spawn a long build/test,
keep working, poll later. pi has `examples/bash-spawn-hook.ts` (spawnHook) and the
tmux doc, but no packaged background-shell tool.
Gap = a `bg` tool + `bg_poll`/`bg_list` (tmux or detached-process backed), like
Claude Code's TaskOutput. Cheap, huge conciseness win (agent isn't blocked on tests).

### G3. In-session todo / task tracking tool
SOTA: Claude Code `TodoWrite` (v0.2.93) + task system (v2.1.16, `/tasks`).
Distro: plan skill writes to *memory*, but no lightweight model-callable todo tool.
The system prompt even references an "in-session todo list" that doesn't exist.
pi ships `examples/extensions/todo.ts` (state in tool-result details → branches
correctly!). Gap = package todo.ts. Near-zero effort; the example is done.
Why it matters for conciseness: keeps plan state out of the context window and
gives the model a scratchpad that survives compaction properly.

### G4. Git/PR lifecycle & worktree automation
SOTA: Claude Code has git worktree support, gh PR create/review, commit
co-authoring, session↔PR linking (v2.1.27). Symphony fully delegates the PR
lifecycle (push, wait for CI, fix flakes, merge queue) — Ryan calls this "what it
means to delegate fully."
Distro: zero git tooling. pi ships `examples/git-checkpoint.ts`,
`git-merge-and-resolve.ts`, `auto-commit-on-exit.ts` — none packaged. Roadmap #2
(checkpoint/rewind) overlaps.
Gap = package git-checkpoint (auto-stash/commit per turn = cheap safety net) +
a `/pr` skill (worktree → push → gh pr create → watch CI). Medium effort, big
"delegate the boring loop" win.

### G5. Test/CI loop as a first-class tool (build-loop discipline)
SOTA: harness-eng essay's central operational invariant — keep the inner loop
<1min, auto-decompose when it breaches. Agent parses test output, fixes flakes.
Distro: tests run via raw bash; no structured test-runner tool, no result parsing,
no "run-and-report-failures-compact" primitive. The distro's own typecheck recipe
(in lessons.md) is a hand-rolled version of this.
Gap = a `test` tool that runs the project's test command, parses exit code + output,
and returns a *compact* pass/fail + failing-test summary (not raw 500-line stdout).
Conciseness win is large: keeps test noise out of context. Cheap to build (wrap
bash + a parser). Pairs with G2 (run in background).

### G6. Hooks/guardrails: diff-oriented code review on changes
SOTA: Claude code-review plugin = 5 parallel agents on a diff; pr-review-toolkit
= 6 agents; PreToolUse/PostToolUse hooks. security-guidance plugin = 9 patterns.
Distro: `verify` is *claim*-oriented, not *diff*-oriented. No "review my uncommitted
diff against repo guardrails" tool. No PreToolUse-style permission/annotation hooks
exposed as a packaged thing (though pi's `tool_call` event can block — substrate
exists; `examples/confirm-destructive.ts`, `protected-paths.ts`, `dirty-repo-guard.ts`).
Gap = a `/review` skill that diffs `git diff`, runs N verify-style sub-agents with
distinct lenses (security, perf, style, tests), returns compact findings. Builds on
G1 + verify. Also: package a guardrail extension from the existing examples.

### G7. Skill distillation / learning loop (capture mistakes into durable context)
SOTA: harness-eng essay's core insight — when the agent fails, ask "what
capability/context/structure is missing?" and write it down as a skill/doc/quality
score. Tech-tracker.md, quality-score table, reliability docs updated from pages.
Distro: memory captures lessons, but there's no *loop* — no mechanism that, on
agent failure or human correction, proposes a durable skill/rule/doc update.
Gap = a `/distill` skill: "the agent just failed / I just corrected it → propose a
project-local skill or rules file capturing the non-functional requirement."
Cheap (prompt-side, uses memory). High ceiling — this is the flywheel that makes
the distro improve with use. Project-local skills are supported by pi
(`.agents/skills` / `.pi/skills` per skills.md).

### G8. Observability / telemetry of agent runs
SOTA: Claude Code ships OTEL export (spans, active-time, token spend); Symphony
has a full traces/metrics/logs local stack. harness-eng: "invest in observability
so you're not sitting in front of a terminal."
Distro: sessions are jsonl, but no analytics — no "tokens spent per task," "where
did the agent spin," "tool-call heat map." The `after_provider_response` +
`message_end` (usage) + `tool_execution_end` events give the raw signal for free.
Gap = a `/stats` extension aggregating per-session token/cost/tool-call data from
the events, plus a "where am I spending tokens?" summary. Medium effort. Helps the
*human* garden the harness (the essay's actual loop).

### G9. Spec-driven development tooling (ghost libraries / SPEC.md)
SOTA: harness-eng essay — distribute software as specs; agent reassembles.
Claude plan-mode + skills. Emerging norm.
Distro: plan skill is task-oriented, not spec-oriented. No `SPEC.md` convention or
spec→implementation workflow.
Gap = a `spec` skill: write/maintain a SPEC.md, then drive impl + verify-against-spec.
Lower priority — more workflow/convention than machinery. Defer unless the user
works spec-first.

## Explicitly NOT gaps (don't chase)

- **MCP client support.** Ryan is bearish ("forcibly injects all those tokens,
  messes with auto-compaction, agent forgets how to use the tool"). pi has none and
  that's defensible. Only build if a specific MCP server is load-bearing for the user.
- **Plugin marketplace / distribution.** Distro is personal; pi has `pi install`
  already. Not a leverage gap.
- **IDE integration / LSP.** Out of scope for a terminal distro; pi is a TUI.
- **Enterprise managed settings / multi-tenant.** Single-user; not relevant.

## Suggested build order (evidence-to-effort, revised)

1. **G3 todo tool** — package `examples/todo.ts`. ~1hr. Unblocks cleaner planning.
2. **G2 background shells** — `bg`/`bg_poll` tools. ~1 day. Unblocks G5, G4, G6.
3. **G5 test-loop tool** — wrap bash + parser. ~1 day. Huge conciseness win.
4. **G4 git-checkpoint + /pr** — package git examples + worktree skill. ~1-2 days.
5. **G1 sub-agent orchestrator** — package `examples/subagent` + contract.
   ~2-3 days. Unlocks G6 antagonist ensemble.
6. **G6 diff-review skill** — verify-on-diff with N lenses. ~1 day after G1.
7. **G7 distill skill** — prompt-side flywheel. ~1 day. Highest long-term ceiling.
8. **G8 /stats observability** — events→aggregate. ~1-2 days. Medium.
9. **G9 spec skill** — defer unless spec-first workflow wanted.

Roadmap #2 (checkpoint/rewind) folds into G4 (git-checkpoint is the cheap form;
tree-rewind is the expensive form — do the cheap form first).
