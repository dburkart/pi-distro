# Plan Skill

`agent/skills/productivity/plan/SKILL.md` enforces a **plan-before-execute**
phase for long tasks. It is the roadmap's Tier-1 #1 item, grounded in the
finding (across Claude Code, Codex, and Anthropic's "deep agents" framing)
that a dedicated planning pass beats inline ad-hoc reasoning on long-horizon
work.

It is a **skill**, not an extension — pure prompt-side orchestration with no
runtime machinery. It composes with two things that already exist:

- The **memory extension** — plans are durable markdown pages at
  `plans/<slug>.md` in the project memory scope, so they survive compaction
  and the session tree. Decisions mirror into `decisions.md`.
- The **grilling skill** — a relentless interview this skill escalates to
  when stakes are high.

## What it adds

- **Model-auto-invokable** *and* a `/plan` command. Auto-invocation is the
  primary path so planning fires at task kickoff without depending on the
  user remembering. The description carries positive signals (multi-file,
  refactor, architectural, ≥3 steps, expensive-to-be-wrong) **and** explicit
  exclusions (single-file edits, read-only exploration, running a known
  command, factual questions) — over-firing is the bigger practical risk.
- **Resume trigger** — the description also tells the model to `memory search`
  for `Status: in-progress` plans when resuming a task, so a fresh instance
  after compaction picks up an in-flight plan.

## Phases

**Phase 1 — Plan:**

1. **Resume check.** `memory search` for `Status: in-progress`. If a plan
   matches, resume it instead of forking a sibling.
2. **Escalation gate.** If any signal fires (irreversible/large blast radius,
   architectural, unclear success criteria, ≥2 viable approaches, user-stated
   uncertainty): **recommend `/grilling` and pause** — write nothing yet. The
   user runs grilling (it's deliberately command-only) or says "skip."
3. **Light inline brainstorm.** If genuine open decisions exist, ask the 1–3
   highest-leverage questions one at a time with recommended answers. If not,
   draft-then-confirm with assumptions stated explicitly.
4. **Write the plan** to `plans/<slug>.md` (project scope), checking
   `memory list`/`search` for an existing similar page and reusing/updating
   it rather than creating a sibling. Mirror decisions into `decisions.md`.

**Phase 2 — Execute (living contract):** Read the plan at execution start,
execute against the steps, and **when reality diverges, pause and update the
plan page** (and `decisions.md` if a decision changed, plus an append-only
`Log:` line) before continuing. The plan stays truthful — a plan that stops
matching reality gets ignored, which is the failure mode this skill exists to
prevent.

## Plan page template

Flat markdown, no YAML frontmatter — consistent with the memory schema's
"flat markdown, no machinery" design choice:

```markdown
# <slug> — <one-line goal>

Status: in-progress
Goal: <one line>
Steps:
  1. <concrete, verifiable step>
Assumptions:
  - <things you're guessing at>
Open questions:
  - <unresolved, or "none">
Decisions:
  - <each mirrored into decisions.md>
Log:
  - <append-only, one line per living-contract update>
```

`Status:` ∈ {`in-progress`, `done`, `abandoned`}. The `Log:` section records
how the plan diverged and adapted — the raw material for `lessons.md`.

## Design decisions (and why)

- **Skill, not extension.** The roadmap was explicit, and the whole mechanism
  is prompt-side: it orchestrates the memory tool and the grilling skill
  rather than adding runtime. No new commands beyond the `/plan` alias the
  skill system registers for free.
- **Both auto- and command-invokable.** The single biggest risk with a plan
  skill is that it never fires at the moment it matters (task kickoff).
  Auto-invocation addresses that; the `/plan` alias is a near-free forcing
  function. Grilling/handoff are command-only because they're interactive
  side-passes; planning is a *primary* phase.
- **Exclusions in the description.** Over-firing (every `git status` becomes
  planning ceremony) trains the user to disable the skill. Concrete exclusions
  are the cheapest gate and live in the always-in-context description.
- **Escalation recommends + pauses, doesn't auto-invoke grilling.** Grilling
  is `disable-model-invocation: true` on purpose — a user-triggered
  interrogation. Auto-invoking it from another skill would sidestep that
  intent. But a toothless recommendation is pointless, so the skill *pauses*
  the plan until the user decides — making the recommendation consequential
  without overstepping.
- **Living contract, not strict or advisory.** A frozen plan that can't absorb
  new information gets ignored (the failure mode of strict); an advisory plan
  gets ignored too. Updating the memory page on divergence is exactly what the
  memory extension is for, and keeps the plan truthful as a resume anchor.
- **Project scope by default.** Plans are about *this* codebase. Project
  memory is committed/reviewable/diffable — exactly what a plan should be.
  Falls back to global only when no project root exists (the memory tool's
  existing `resolveScope` defaulting).
- **Slug reuse over forking.** Two near-identical slugs drifting across
  sessions is the drift the memory lint pass exists to catch. The skill leans
  on existing conflict detection rather than reinventing it.

## File layout

```
agent/skills/productivity/plan/
└── SKILL.md    frontmatter (name, description) + the two-phase workflow
```

No scripts, no references — the whole skill is the SKILL.md body. The
template and signals are tuned by editing the body.
