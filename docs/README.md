# Documentation Index

Entry point for all docs in this distro. When adding a doc, add a line here
under the right category with a one-sentence summary so it can be discovered
without recursively listing the tree.

## Extensions

- [extensions/terminal.md](extensions/terminal.md) — `/edit` command and
  `review` tool; shared "secondary buffer" primitive for suspending pi's TUI
  and running a foreground program (e.g. `$EDITOR`). Includes the sandbox
  rationale for `~/.local`/`~/.cache` writes.
- [extensions/web.md](extensions/web.md) — `web_search` and `web_fetch` tools
  with a pluggable search backend registry (Marginalia implemented); env-var
  configuration and HTML-to-text fetching.
- [extensions/memory.md](extensions/memory.md) — persistent cross-session agent
  memory as markdown (`memory` tool + `/memory` command); flat file-based store
  covering factual + experiential memory, with write-time conflict detection
  and a lint pass. Grounded in the memory-systems survey, pruned to what's
  practical on hosted models.
- [extensions/verify.md](extensions/verify.md) — independent adversarial
  verifier (`verify` tool + `/verify` command); spawns an isolated headless pi
  run that re-derives a claim from source and returns a structured verdict
  (confirmed/refuted/uncertain). Read-only investigation, distinct error state.
  Roadmap #4, standalone single-verifier form.
- [extensions/todo.md](extensions/todo.md) — in-session todo scratchpad
  (`todo` tool + `/todos` command); state stored in tool-result details so it
  branches correctly with the session tree. Ephemeral — complements, does not
  replace, the `plan` skill's durable memory plans. Roadmap H1.

## Skills

- [skills/plan.md](skills/plan.md) — `plan` skill: plan-before-execute
  phase for long tasks. Brainstorm lightly → write a durable plan to memory
  → execute against it as a living contract. Escalates to `/grilling` on
  high-stakes signals; resumes in-progress plans after compaction.

## Research

- (memory) `research/gap-analysis-sota-harnesses` — gap analysis vs.
  SOTA harnesses (Claude Code, Codex/Symphony) grounded in the harness-eng
  essay. Identifies 9 gaps; the basis for `roadmap-harness-eng.md`.

## Roadmaps

Two tracks with different research lineages, cross-linked where they
overlap (sub-agent orchestration, checkpoint/rewind, diff-oriented review):

- [roadmap-cognition.md](roadmap-cognition.md) — *how the agent thinks*
  across long horizons: memory, planning, verification, rewind, sub-agents,
  memory evolution. From the long-horizon-agent + memory-systems research.
- [roadmap-harness-eng.md](roadmap-harness-eng.md) — *how the agent does
  work concisely*: background shells, test loops, git/PR lifecycle,
  diff-review, skill-distillation flywheel, observability. From SOTA
  harness-engineering research (Lopopolo essay, Claude Code analysis).
  Nearly every item reduces context-window noise — the lever for concise
  implementations.
