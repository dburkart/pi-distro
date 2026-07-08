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

## 2026-07-07 — pi's isolated-sub-agent primitive is the headless child spawn, NOT ctx.newSession/ctx.fork

When building the `verify` extension (roadmap #4), the roadmap text claimed
sub-agents would use `ctx.newSession({ withSession })` / `ctx.fork(entryId,
{ withSession })` to "run isolated work in a fresh session and return a
distilled summary." This is **wrong** and would have been a serious bug.

`ctx.newSession` and `ctx.fork` are **session-replacement** primitives: they
emit `session_shutdown` for the current session, tear down the runtime, and
switch the user *into* the replacement. Calling them from a tool mid-turn
would destroy the user's active session. They are for `/fork`-, `/clone`-,
`/resume`-style navigation, not for spawning a background sub-agent.

The real isolation primitive is the **headless child `pi` spawn** (same one
`examples/extensions/subagent/` uses):

```
pi --mode json -p --no-session --tools <allowlist> --append-system-prompt <file> "<task>"
```

This gives a fresh context window that runs to completion and returns a JSON
transcript (parse `message_end` events for messages + usage), without
touching the user's session. The `--append-system-prompt` flag accepts a file
path (pi's `resolvePromptInput` checks `existsSync` and reads the file if so).

**Generalization:** any future "run something in isolation and get a result
back" feature (sub-agent orchestrator #3, antagonist ensemble, background
tasks) should spawn a child pi process, not use the session-replacement API.
Corrected in roadmap.md (#3 and #4 entries) and docs/extensions/verify.md.

## 2026-07-07 — Typechecking pi extensions: synthetic tsconfig against the installed dist

The distro has no tsconfig/package.json of its own, and the sandbox blocks the
default npm cache (`~/.npm`). To typecheck an extension against pi's types:
use `npm_config_cache=/tmp/<dir> npx -y -p typescript@5.5 tsc -p <tsconfig>`
with a tsconfig that sets `baseUrl` to the pi install
(`/Users/dburkart/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`)
and `paths` for the `@earendil-works/*` packages to their `dist/index.d.ts`,
plus `typebox` → `node_modules/typebox/build/index.d.mts` (the typebox
package only exposes `.mts` types via its `exports` map). `Theme` is not
exported from `@earendil-works/pi-tui` — don't annotate render callbacks'
`theme` param; let it infer from the `ToolDefinition` signature.
