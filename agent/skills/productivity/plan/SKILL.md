---
name: plan
description: "Plan before executing long tasks: brainstorm lightly, write a durable plan to memory, then execute against it as a living contract. Use when a task involves multi-file changes, refactors, architectural decisions, >=3 steps, or anything expensive to get wrong. Also use when resuming a task that may have an existing in-progress plan — search memory for 'Status: in-progress' plans first. Do NOT use for single-file edits, read-only exploration, running a known command, or answering a factual question."
---

# Plan

A dedicated planning pass before long tasks. You brainstorm lightly, write the
plan to persistent memory (so it survives compaction and the session tree),
then execute against it as a *living* contract — updating it when reality
diverges rather than abandoning it.

This skill composes with two others:

- The **memory** tool (`memory read/write/update/list/search`) — plans live at
  `plans/<slug>.md` in the project memory scope. Decisions get mirrored into
  `decisions.md`.
- The **grilling** skill (`/grilling`) — a relentless interview for
  stress-testing a plan. This skill escalates to it when stakes are high.

## Phase 1 — Plan

### 0. Resume check

Before planning a *new* task, run `memory search` for `Status: in-progress`.
If an existing plan matches this task, **resume it** (jump to Phase 2 against
that page) rather than starting fresh. Do not silently fork a sibling plan.

### 1. Escalation gate

Judge whether any of these signals apply:

- Irreversible or large-blast-radius action (data migration, force-push, bulk
  refactor across many files).
- Architectural change (new module boundaries, dependency shifts, public API
  change).
- Unclear success criteria — you can't tell when "done" is reached.
- Two or more viable competing approaches.
- The user expressed uncertainty ("I'm not sure how to…", "what do you
  think?").

If **any** fire: **recommend `/grilling` and pause**. Do not write the plan
yet. Tell the user you'd recommend running `/grilling` to stress-test the
design before planning, then wait. If they run it, incorporate what it
surfaces into the plan. If they say "skip," proceed to step 2. Do not
auto-invoke grilling — it is deliberately a user-triggered skill.

### 2. Brainstorm (light, inline)

Decide whether there are genuine open decisions: ≥2 viable approaches,
ambiguous success criteria, or missing constraints you'd otherwise guess at.

- **Yes** → ask the 1–3 highest-leverage questions, **one at a time**, with
  your recommended answer for each. Wait on each. Resolve dependencies between
  them one by one before moving on.
- **No** → skip straight to drafting. State your assumptions explicitly in the
  `Assumptions:` section so the user can correct them rather than discover
  them mid-execution.

### 3. Write the plan

Pick a kebab-case slug from the task. Before writing, `memory search`/`list`
for a similar existing plan page — if one clearly matches this task, **update
it** instead of creating a sibling. Only create a new page under `plans/` if
none matches.

Write the page using the template below (project scope; fall back to global
only if no project root exists). Then mirror each concrete decision into
`decisions.md` (append or update — don't duplicate; cross-link from the plan's
`Decisions:` section to the `decisions.md` entry).

#### Plan page template

```markdown
# <slug> — <one-line goal>

Status: in-progress
Goal: <one line>
Steps:
  1. <concrete, verifiable step>
  2. ...
Assumptions:
  - <things you're guessing at, stated explicitly>
Open questions:
  - <unresolved, or "none">
Decisions:
  - <each mirrored into decisions.md>
Log:
  - <append-only, one line per living-contract update>
```

`Status:` is one of `in-progress`, `done`, `abandoned`. The `Log:` section is
append-only — it records how the plan *diverged and adapted*, which is the raw
material for `lessons.md` later.

## Phase 2 — Execute

1. **Read the plan** from memory at the start (don't rely on it staying in
   context).
2. Execute against the `Steps:` list.
3. **Living contract** — when reality diverges (a step reveals a wrong
   assumption, a new constraint appears, an approach doesn't work), **pause
   and update the plan page before continuing**:
   - `memory update` the relevant step / assumption.
   - If a *decision* changed, also update `decisions.md`.
   - Append a one-line entry to the plan's `Log:` section noting what changed
     and why.
4. Do not silently deviate. A plan that stops matching reality gets ignored —
   that's the failure mode this skill exists to prevent. Keep it truthful.
5. When the `Goal:` is met, set `Status: done` and append a final `Log:` line.

## Resume (after compaction or a new session)

A fresh instance picks up an in-flight plan because the page carries
`Status: in-progress`. On any task that might be a resume:

1. `memory search` for `Status: in-progress`.
2. If a plan matches, read it fully, read its `Log:` to see where it diverged,
   and continue from the current state of the `Steps:` — do not restart from
   step 1.
3. If the resume reveals the plan is now wrong, update it (living contract)
   before executing further.

## What this skill is not

- Not a ceremony tax on simple work — the description's exclusions stand. If
  you loaded this for a single-file edit or a factual question, stop and just
  do the thing.
- Not a replacement for grilling — grilling is the deep stress-test; this
  skill's inline brainstorm is light and only escalates when signals fire.
- Not advisory — a plan written here is meant to govern execution and stay
  truthful. If you're not going to update it as reality diverges, don't write
  one.
