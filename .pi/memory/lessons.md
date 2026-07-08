# Lessons

Experiential memory: dead-ends, what worked, and the reasoning that won't be
re-derived from the code alone. Append; don't rewrite history.

## 2026-07-07 — The distro repo's project memory lives at .pi/.pi/memory/

The distro repo lives at `~/.pi`, which is *also* the global memory root
(`~/.pi/memory/`). So the distro has no obvious committed home for its own
project memory — the `<cwd>/.pi/memory/` convention nests awkwardly to
`~/.pi/.pi/memory/`.

**The mistake:** quietly demoting a project-level decision (the plan-skill
design choices) to **global** scope to avoid that nesting. That violated the
memory doc's project-scope intent (committed, reviewable, portable) and the
AGENTS.md portability principle. Global scope is for cross-project,
never-committed knowledge — distro decisions are the opposite.

**The fix:** initialize and use `~/.pi/.pi/memory/` as the distro's project
memory. The nesting is cosmetically ugly but semantically clean and uniform
with every other project. `resolveScope` finds it automatically once it
exists.

**Second trap:** a bare `memory/` line in `.gitignore` matches at *any*
level, so it would wrongly exclude `.pi/memory/` too. Anchor it as
`/memory/` so only the top-level global root (`~/.pi/memory/`) is ignored.
Verify with `git check-ignore -v` on both paths after editing.

**Generalization for the plan skill:** when the skill runs *inside the
distro repo*, project scope resolves to `~/.pi/.pi/memory/` — correct. The
skill's "project scope by default" rule holds everywhere once the project
root is initialized.
