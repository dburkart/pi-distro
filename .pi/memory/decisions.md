# Decisions

Durable project decisions and the reasoning behind them. Append; don't
rewrite history. Cross-link to docs/ where the full rationale lives.

## 2026-07-08 — H1 in-session todo tool shipped (harness-eng track)

Packaged pi's `examples/extensions/todo.ts` as
`agent/extensions/todos/index.ts` (roadmap H1). [docs/extensions/todos.md](../../docs/extensions/todos.md)
documents it.

Key design choices:

- **Single-file extension.** The example is one self-contained file (one
tool + one command + one TUI component); extensions.md blesses single-file
for small extensions. Other distro extensions are directories only because
they're multi-file.
- **State in tool-result `details`, not files.** This is the load-bearing
choice: state rides the session tree as ordinary tool results, so todos
branch correctly with the tree (fork/navigate → list is correct for that
point in history). Reconstructed on `session_start`/`session_tree` by
replaying the branch's `todo` results in order.
- **Ephemeral, not durable — complements the `plan` skill.** Compaction may
prune tool results, so todos are a scratchpad, not a plan store. The
`plan` skill keeps durable plans in memory; `todo` keeps the in-the-moment
checklist. They compose. Deliberately did *not* rewrite the plan skill to
use todos — that would conflate ephemeral + durable state and change the
plan skill's contract; it's a separate follow-up if wanted.
- **Directory extension, not single file.** Initially shipped as
  `agent/extensions/todo.ts`; renamed to `agent/extensions/todos/index.ts`
  to match the convention of the other extensions (memory/verify/web/terminal
  are all `name/index.ts` dirs). The extension is still single-file internally
  — `index.ts` — because it's self-contained; the directory form is for
  consistency, not to enable splitting.
- **Model-auto-invocable via `promptSnippet` + `promptGuidelines`**
(matches verify/web/memory). Description carries positive + exclusion
signals: use for multi-step task tracking; not for single-step edits; not a
substitute for `plan`.
- **`defineTool` + `pi.registerTool`** (the newer convention; verify/web).

Next harness-eng item: H2 background shells.

## 2026-07-08 — H2 background shells designed (via /grilling)

Roadmap H2, `bg` tool + `/bg` command. Design resolved through a `/grilling`
pass; see [plans/bg-extension](../.pi/memory/plans/bg-extension.md) for the
full plan. Key decisions:

- **Detached process backend, no tmux.** stdout/stderr piped to files under a
  per-process `$TMPDIR/pi-bg-<random>/` dir; in-memory handle table. The
  distro is deliberately tmux-free; tmux-as-optional-backend deferred.
  Portability (an AGENTS.md principle) drove this.
- **Fully ephemeral, session-runtime-scoped.** Kill all live children on
  *every* `session_shutdown` (quit/reload/new/resume/fork); handle table
  in-memory, not persisted. No PID reattachment (fragile: PID reuse, dead
  processes, tmpdir cleanup). Matches the `todos` ephemeral precedent; the
  `plan` skill is the durable layer, not bg.
- **Poll model, not push.** `bg read` returns status + tails; optional `wait`
  (cap 120s) blocks for completion/new output then returns. Push via
  `pi.sendMessage` deferred — its session-message coupling and interruption
  semantics are a v2 concern. Matches Codex/Claude `TaskOutput` precedent.
- **Separate stdout/stderr files, paths exposed.** `bg read` returns tails
  (cheap status peek); the *full* log lives in inspectable files whose paths
  are in every result, so the model `grep`s/`read`s/`tail`s via existing tools.
  Files cleaned *only* on `session_shutdown` (not on `stop`) — supports the
  stop-then-grep test-loop pattern.
- **Single `bg` tool, `action` enum (start/read/list/stop)** — not separate
  `bg`/`bg_read`/`bg_list`/`bg_stop` tools. Mirrors the `todos` enum pattern;
  the context-footprint argument is load-bearing on this track (4 tools where
  1 suffices is exactly the noise this track removes). Claude's separate-tool
  precedent is a weak signal here — this distro is deliberately leaner.
- **`start`:** `command` req, `cwd` opt (default `ctx.cwd`), `timeout` opt
  seconds (no default), `PI_BG_MAX_LIFETIME` env ceiling (default 1800s)
  clamps explicit timeouts and kills over-lifetime shells. Env-var pattern
  matches verify (`PI_VERIFY_TIMEOUT`).
- **`read`:** `handle` req, `wait` opt (0, max 120), `lines` opt (50, max 500),
  `stream` opt (stdout|stderr|both, default both). Tail-from-end, no offset
  tracking (files are the full record; offset is ephemeral anyway).
- **`stop`:** SIGTERM → 3s grace → SIGKILL; leaves output files. `list`
  returns all session handles with status (running/stopped/exited code).
- **Auto-backgrounding OUT of scope for v1** (bg is model-invoked only).
  Briefly pulled in then walked back as scope bloat — it would require the
  `bg` extension to own the `bash` tool's execute path (spawnHook can't see a
  running process mid-flight; tool_call can't take over execution), which is
  more risk than the rest of H2 combined. Tracked as a deferred enhancement
  on the roadmap.
- **Incrementing-integer handles** per session (`#1`, `#2`, …), never reused.
- **`/bg` human command in v1**, mirroring `/todos` (read-only status panel).
- **Auto-invocation signals:** positive = "long-running *and* you want to keep
  working"; exclusion = quick/blocking → `bash`, plus ephemerality warning
  (killed on reload/switch/quit). promptSnippet + 2 promptGuidelines bullets.

Composes with H3 (test-loop: run tests in bg, poll) and H5 (spawn pattern can
be extracted to a shared lib when the sub-agent orchestrator lands).

Next harness-eng item: H3 test-loop tool.

## 2026-07-07 — Plan-before-execute skill shipped

Implemented the roadmap's Tier-1 #1 item as the `plan` skill
([docs/skills/plan.md](../../docs/skills/plan.md),
[SKILL.md](../../agent/skills/productivity/plan/SKILL.md)).

Key design choices (resolved via a `/grilling` session):

- **Skill, not extension.** Pure prompt-side orchestration of the memory tool
  + grilling skill; no runtime machinery.
- **Both model-auto-invokable and `/plan` command.** Auto-invocation is
  primary so planning fires at task kickoff. Description carries positive
  signals *and* explicit exclusions — over-firing is the bigger risk.
- **Two phases: plan → execute.** Brainstorming folded in lightly; grilling
  is a separate opt-in tool the skill *escalates* to.
- **Escalation = recommend `/grilling` then pause.** Honors grilling's
  `disable-model-invocation` contract while making the recommendation
  consequential (plan doesn't proceed past the gate).
- **Plans live at `plans/<slug>.md` in project memory scope**, decisions
  mirrored into `decisions.md`. Slug reuse over forking (leans on memory
  conflict detection).
- **Living-contract execution.** Plan updated in memory when reality
  diverges; stays truthful as a compaction-resume anchor.
- **Plan pages carry `Status:`** so a fresh session can `memory search` for
  `Status: in-progress` and resume.

Next roadmap item: H2 background shells (the harness-eng track; H1 todo
just shipped).

## 2026-07-07 — Roadmap split into two tracks (cognition + harness-eng)

Researched SOTA coding harnesses (Lopopolo "Harness Engineering" essay +
OpenAI Frontier/Symphony; Agent Safehouse's Claude Code v2.1.39 analysis)
against this distro. Findings persisted to project memory at
`research/gap-analysis-sota-harnesses`. The research surfaced a distinct set
of gaps (background shells, test-loop tool, in-session todo, git/PR
lifecycle, diff-oriented review, skill-distillation flywheel, observability)
that the existing `roadmap.md` — grounded in long-horizon-agent +
memory-systems research — didn't cover, plus reframings of three overlapping
items (sub-agents, checkpoint/rewind, verification).

**Decision: rename + new doc, not a merged rewrite.** The two tracks have
different research lineages and orientations (how the agent *thinks* vs. how
it *does work concisely*); merging would dilute both. Renamed
`docs/roadmap.md` → `docs/roadmap-cognition.md` (title "Roadmap — Agent
Cognition"), added `docs/roadmap-harness-eng.md` in the same doc style.
Cross-linked at the top of each; the three overlapping items are linked
where they appear (H5↔cognition #3, H4↔#2, H6↔#4). `docs/README.md` "Roadmap"
section became "Roadmaps" indexing both. The unifying lever for the
harness-eng track is *context-window noise reduction* — the path to more
concise implementations.

Key substrate finding: pi already ships working `examples/extensions/` for
several harness-eng gaps (subagent, todo, git-checkpoint, git-merge-and-resolve,
auto-commit-on-exit, bash-spawn-hook). Several items are "package and polish,"
not build-from-scratch.

## 2026-07-07 — verify extension designed (via /grilling)

Roadmap #4, standalone single-verifier form. **Shipped.**
Design resolved through a `/grilling` pass; see
[plans/verify-extension](../.pi/memory/plans/verify-extension.md)
for the full plan. [docs/extensions/verify.md](../../docs/extensions/verify.md)
documents the shipped extension. Key decisions:

- **Specialized verify extension, not the general sub-agent substrate.**
  Roadmap sequencing holds: standalone single verifier first, orchestrator
  (#3) and antagonist ensemble later. The spawn pattern can be extracted to a
  shared lib when #3 lands — no premature abstraction.
- **Isolation primitive = headless child `pi` spawn**
  (`pi --mode json -p --no-session --tools ... --append-system-prompt ...`),
  NOT `ctx.newSession`/`ctx.fork`. The latter are session-replacement
  primitives that tear down the user's active session — wrong for an inline
  verify. This corrects a misleading note in roadmap.md. Grounded in
  `examples/extensions/subagent`.
- **Verifier must re-derive from source.** Independently re-reads files /
  re-runs commands; `confirmed` forbidden without fresh grounding; no-evidence
  claims capped at `uncertain`. This is the whole point — unchecked-reasoning
  verifiers inherit the primary agent's sycophancy.
- **Read-only tool set** (read/bash/grep/ls/find; no write/edit/memory) +
  **read-only-filesystem sandbox profile** + observation-only adversarial
  prompt. **Network fully open** (revised from provider-only during grilling)
  — a verifier may legitimately need to hit a live/deployed endpoint. The
  mutation-collapse failure mode (a verifier that quietly "fixes" what it's
  checking) is blocked by read-only FS + tool allowlist; remote-state mutation
  via network is governed by prompt.
- **Structured verdict** (confirmed|refuted|uncertain) + findings +
  counterfactuals; compact text to primary context, full transcript in
  `details`; mild nudge on refuted/uncertain; distinct `error` state (not in
  the verdict enum) for timeout/cost-cap/parse/exit failures — rendered as
  "unverified, do not treat as confirmation."
- **Both model-auto-invocable tool AND `/verify` command.** Auto-invocation
  is primary (passive sycophancy catch); description carries positive +
  exclusion signals to bound over-firing (precedent: plan/memory skills).
- **Cost/abort:** PI_VERIFY_TIMEOUT (120s), PI_VERIFY_COST_CAP_TOKENS (20000),
  SIGTERM→SIGKILL propagation from the parent tool's AbortSignal,
  PI_VERIFY_DISABLED to disable. Env-var config for portability (matches
  memory/web extensions).
- **OS sandbox is opt-in, off by default.** Living-contract divergence
  from the grilling decision (which implied on-by-default): the read-only
  `--tools` allowlist is the primary, always-on enforcement; the
  read-only-FS `sandbox-exec` profile (PI_VERIFY_SANDBOX=auto) is
  defense-in-depth hardening, off by default for portability (the distro
  targets macOS but the sandbox shouldn't risk breaking the default run).
  Network is fully open at both levels.
