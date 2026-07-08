# bg-extension — Roadmap H2: background shells / async bash

Status: in-progress
Goal: Ship a `bg` tool (+ `/bg` command) that runs long commands detached in the
background, pipes stdout/stderr to inspectable files, and lets the model poll
status/output while continuing to work — removing the "blocked on stdout"
context-noise category. Design resolved via `/grilling`.

Steps:
  1. Build `agent/extensions/bg/index.ts`: single `bg` tool (action enum
     start/read/list/stop), in-memory handle table, detached spawn via
     `createLocalBashOperations()`, stdout/stderr to per-process
     `$TMPDIR/pi-bg-<random>/shell-<handle>.{out,err}`, SIGTERM→3s→SIGKILL
     stop, kill+cleanup on `session_shutdown`.
  2. `start` params: command(req), cwd(opt, ctx.cwd), timeout(opt s, no
     default), `PI_BG_MAX_LIFETIME` env ceiling (default 1800s) clamps.
  3. `read` params: handle(req), wait(opt 0 max 120), lines(opt 50 max 500),
     stream(opt stdout|stderr|both, default both); tail-from-end, no offset;
     return file paths + running/exitCode + tails.
  4. `list` returns all session handles w/ status (running/stopped/exited code)
     + file paths.
  5. `/bg` human command: TUI status panel mirroring `/todos` (read-only list,
     Esc to close).
  6. Auto-invocation: `promptSnippet` + 2 `promptGuidelines` (positive: long +
     want to keep working; exclusion: quick/blocking→bash; ephemerality warn).
  7. Custom `renderCall`/`renderResult` for the tool (status + tail preview).
  8. Doc: `docs/extensions/bg.md`; add line to `docs/README.md` index.
  9. Update `docs/roadmap-harness-eng.md`: mark H2 ✅ done; add deferred
     auto-backgrounding note under H2 (would require owning `bash` execute).
  10. Manual smoke test: spawn a sleeper, poll, grep the output file, stop,
      verify cleanup on shutdown.

Assumptions:
  - `createLocalBashOperations()` exposes enough of the spawn/exec surface to
    pipe child stdout/stderr to files and track the PID; if not, fall back to
    Node `child_process.spawn` directly (still reusing shell/env resolution).
  - The sandbox profile (`pi-sandbox`) permits writing under `$TMPDIR` (it
    does, per AGENTS.md) and detached child processes survive the parent's
    sandbox — verify in smoke test; if detached children are killed by the
    sandbox, document the constraint.
  - `ctx.ui.custom` TUI-component pattern from `todos` ports cleanly to a
    read-only status panel.

Open questions:
  - Whether detached child processes survive the macOS sandbox-exec profile:
    RESOLVED — the jiti smoke test (run inside the bash tool, which runs under
    the sandbox-exec profile) spawned detached children, wrote to $TMPDIR,
    and killed process groups successfully. No constraint.

Decisions:
  - Backend: detached process + $TMPDIR files, no tmux (deferred). [→ decisions.md]
  - Fully ephemeral; kill on every session_shutdown; no PID reattachment. [→ decisions.md]
  - Poll model; `read` optional `wait` cap 120s. [→ decisions.md]
  - Separate stdout/stderr files under per-process tmpdir; paths exposed;
    cleaned only on session_shutdown. [→ decisions.md]
  - Single `bg` tool w/ action enum (not separate tools). [→ decisions.md]
  - start: cwd opt (ctx.cwd), timeout opt, PI_BG_MAX_LIFETIME=1800 ceiling. [→ decisions.md]
  - read: tail-from-end, no offset; lines 50/500; stream default both. [→ decisions.md]
  - stop: SIGTERM→3s→SIGKILL, leaves files; list shows all handles+status. [→ decisions.md]
  - Auto-backgrounding OUT of scope v1; tracked as deferred enhancement. [→ decisions.md]
  - Incrementing-integer handles; `/bg` command in v1 mirroring /todos. [→ decisions.md]
  - Auto-invocation signals: positive (long+keep working) + exclusion
    (quick/blocking→bash, ephemerality warn). [→ decisions.md]

Log:
  - Design resolved via /grilling (12 decisions). Auto-backgrounding was
    briefly pulled in then walked back as scope bloat — recorded as deferred.
  - Assumption #1 resolved: `BashOperations.exec` is blocking-until-exit
    (no PID/detachable handle), so the spawn backend is Node
    `child_process.spawn({detached:true, stdio:['ignore',fd,fd]})` + file-FD
    output + `unref()`, with $SHELL env reuse. Kill via process group
    (`-pid`). Not a divergence — the assumption hedged exactly this fallback.
  - Open question resolved: detached children + $TMPDIR writes + process-group
    kills all work under the macOS sandbox-exec profile (smoke test ran inside
    the bash tool, which runs under the profile).
  - Shipped: agent/extensions/bg/index.ts + docs/extensions/bg.md + README
    index + roadmap H2 ✅. tsc clean (synthetic tsconfig), 17/17 jiti smoke
    tests pass (start/read-wait/grep/list/stop/bad-inputs/shutdown-cleanup,
    plus the kill-running-children-on-shutdown no-orphan path).
  - Open question resolved: detached children + $TMPDIR writes + process-group
    kills all work under the macOS sandbox-exec profile (smoke test ran inside
    the bash tool, which runs under the profile).
  - Shipped: agent/extensions/bg/index.ts + docs/extensions/bg.md + README
    index + roadmap H2 ✅. tsc clean (synthetic tsconfig), 17/17 jiti smoke
    tests pass (start/read-wait/grep/list/stop/bad-inputs/shutdown-cleanup,
    plus the kill-running-children-on-shutdown no-orphan path).
