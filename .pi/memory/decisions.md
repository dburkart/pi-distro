# Decisions

Durable project decisions and the reasoning behind them. Append; don't
rewrite history. Cross-link to docs/ where the full rationale lives.

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

Next roadmap item: #2 Checkpoint/rewind.
