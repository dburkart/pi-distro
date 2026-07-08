# Background Shells Extension

`agent/extensions/bg/` adds **background shells** — a `bg` tool
(model-auto-invocable) and `/bg` command that run long commands *detached*
and let the agent keep working while they run, polling status and output
later. This is roadmap item **H2 (Background shells / async bash)** on the
[harness-engineering roadmap](../roadmap-harness-eng.md). Design resolved
via `/grilling`; see `plans/bg-extension` in project memory.

## Why background shells

The central operational lever in the harness-engineering essay: the agent
becomes *less patient* when it can spawn work in the background and continue.
Without background execution, a long test suite or build blocks the bash
tool — the agent sits idle, and the (potentially huge) stdout fills the
context window when it finally returns. `bg` removes that: spawn detached,
keep working, poll a compact tail for status, and `grep` the full log file
only when you need detail. Less blocked stdout, less context noise → more
concise work. Composes with the future H3 test-loop tool (run tests in `bg`,
poll for results).

## Execution model

A `bg start` spawns the command via Node `child_process.spawn` with
`detached: true` (its own process group), stdout and stderr piped to
**separate files** under a per-process directory
`$TMPDIR/pi-bg-<id>/shell-<handle>.{out,err}`. The child is `unref()`'d so
it doesn't keep pi's event loop alive.

Two consequences of this model:

- **The full output lives on disk, inspectable with existing tools.** `bg`
  returns the file paths in every result. `bg read` returns only a cheap
  status *tail*; for the full log the agent `grep`s/`read`s/`tail`s the file
  directly with the tools it already has. `bg` does not duplicate grep.
- **Process groups, not just the leader.** Kill targets `-pid` (the whole
  group), so a test runner's worker children die too — the same
  process-tree-termination discipline as the built-in bash tool.

## State model: fully ephemeral, session-runtime-scoped

The handle table is **in-memory only** — not persisted, not reconstructed
from the session file. All live children are SIGKILL'd on *every*
`session_shutdown` (quit, `/reload`, `/new`, `/resume`, `/fork`) and the
tmpdir is removed.

> **Ephemeral, not durable.** `bg` shells do **not** survive `/reload` or a
> session switch — by design. (PID reattachment across reload is fragile:
> PID reuse, dead processes, tmpdir cleanup.) `bg` is a "right now"
> scratchpad. If you need a command to outlive pi, run it in a real
> terminal or tmux session; `bg` is not that.

This mirrors the `todos` extension's ephemeral precedent; the `plan` skill is
the durable layer, not `bg`.

## The `bg` tool

One tool with an `action` enum (mirroring `todos` — one prompt entry, not
four separate tools):

- **`start`** — `command` (req), `cwd` (opt, default current cwd), `timeout`
  (opt, seconds). Returns the handle, pid, and the stdout/stderr file paths.
- **`read`** — `handle` (req), `wait` (opt, seconds, capped at 120), `lines`
  (opt, default 50, max 500), `stream` (`stdout` | `stderr` | `both`,
  default `both`). Returns status (`running`/`stopped`/`exited(code)`), a
  tail of each requested stream, and the file paths. `wait` blocks up to N
  seconds for completion (or new output) then returns — cuts poll churn for
  the common "spawn tests, wait for them" case. Tail is read from the end of
  the file (at most the last 256KB); no offset tracking (the file is the full
  record).
- **`list`** — all shells this session with status.
- **`stop`** — `handle` (req). SIGTERM → 3s grace → SIGKILL. **Leaves the
  output files** (cleaned only on `session_shutdown`) so the stop-then-grep
  pattern works: spawn tests → they hang → `stop` → `grep` the partial
  output for failures.

The tool is model-auto-invocable via `promptSnippet` + `promptGuidelines`,
with positive *and* exclusion signals to bound firing: use `bg` when a
command is expected to run long *and* you want to keep working while it
runs; do not use it for quick commands or when you need the result before
proceeding (use `bash`); and remember shells are ephemeral.

## The `/bg` command

`/bg` opens a read-only TUI status panel (mirroring `/todos`): each shell
with a status marker (● running / ✓ exited-0 / ✗ exited-nonzero / ■
stopped), handle, runtime, and command. TUI-only; in non-interactive modes
it notifies that it requires interactive mode.

## Configuration

Env vars (portability pattern, matches `verify`/`memory`/`web`):

- `PI_BG_MAX_LIFETIME` — hard wall-clock cap in seconds (default `1800` /
  30m). Clamps any explicit `timeout` on `start` and kills shells that
  exceed it.
- `PI_BG_DISABLED` — set to `1`/`true` to disable the extension entirely.

There is no `cwd`/`env` mutation surface beyond `start`'s `cwd` (commands
inherit pi's environment). The shell is `$SHELL` (or `/bin/sh`).

## Deferred: auto-backgrounding

Claude Code auto-backgrounds long `bash` calls (a `bash` that exceeds a
threshold returns a `bg` handle instead of blocking). This is **deliberately
out of scope for v1** — `bg` is model-invoked only. Auto-backgrounding would
require the `bg` extension to own the `bash` tool's execute path (`spawnHook`
can't see a running process mid-flight; `tool_call` can't take over
execution), which is more risk than the rest of H2 combined and would change
the `bash` tool's contract. Tracked as a future enhancement on the roadmap.
