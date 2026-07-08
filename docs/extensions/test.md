# Test / CI Loop Extension

`agent/extensions/test/` adds the **test/CI loop** — a `test` tool
(model-auto-invocable) and `/test` command that runs the project's test
command and returns a *compact* pass/fail summary (counts + failing-test
names + one-line messages) instead of raw stdout, with the full log written
to an inspectable file. This is roadmap item **H3 (Test/CI loop as a
first-class tool)** on the
[harness-engineering roadmap](../roadmap-harness-eng.md). Design resolved
via `/grilling`; see `plans/test-extension` in project memory.

## Why a test tool

The harness-engineering essay's central operational invariant: keep the
inner loop under one minute, and when it breaches, treat that as a signal
to decompose. The agent must *parse* test results and act on failures — not
drown in raw stdout. A 500-line test log in the context window is exactly
the noise this track removes. `test` returns the *signal* (pass/fail counts,
failing test names + one-line messages) and keeps the *detail* (full log) on
disk, reachable with `read`/`grep`/`tail` only when a failure needs a stack
trace. Less blocked stdout, less context noise → more concise work. Composes
with [H2 background shells](bg.md): long suites run in `bg`, then `test parse`
distills the output.

## Execution model

`test` is **one tool with an `action` enum** (`run` | `parse`), mirroring
`bg`/`todos` — one prompt entry, not two tools.

- **`run`** — exec the resolved test command *synchronously*, parse its
  output, return the compact summary + the full-log file path. This is the
  common <1min inner-loop path. Nonzero exit is `status: fail` (never a
  thrown error — failing tests are the tool's happy path, not an error). A
  `command` param overrides the resolved command (for subset/filter runs like
  `jest path/to/file` or `cargo test --test foo`); the parser is still
  resolved from config/detection, decoupled from the command string.
- **`parse`** — distill *existing* output into the same compact summary.
  Takes `file` *or* `text` (either satisfies). This is the zero-noise
  `bg`→`test` handoff: `bg start` a long suite, later `test parse --file
  <bg stdout path>`. Optional `parser` override (default = detected/configured).

`run` spawns via Node `child_process.spawn` (shell `-c`), stdout and stderr
piped to **separate files** under a per-session `$TMPDIR/pi-test-<id>/`
directory (same pattern as `bg`). The child's `NODE_TEST_CONTEXT` env var is
stripped so a nested `node --test` runs as an independent runner, not a
sub-reporter of the parent.

## Return contract

Both actions return a structured `Summary` (rendered compactly to context;
full detail in tool-result `details`):

- `status` — `pass` | `fail` | `timeout` | `error`
- counts — `passed` / `failed` / `total` (+ `skipped`)
- `failures` — `[{ name, message }]`, capped at 20 shown (rest in the log)
- `parser` — which parser produced the summary
- `logFile` / `errFile` — paths to the full stdout/stderr (the escape hatch
  for stack traces; `read`/`grep` them, no re-run needed)

## State model: fully ephemeral

`test` is stateless (no handle table, unlike `bg`). The run tmpdir (full
logs) is in-memory tracked and removed on `session_shutdown`, mirroring the
`bg`/`todos` ephemeral precedent. Logs persist for the session so a
run-then-grep workflow works; they do not survive `/reload` or a session
switch.

## Configuration: env > project file > auto-detect

Resolution order (portability pattern, matches `verify`/`bg`/`memory`):

1. **Env vars** — `PI_TEST_COMMAND` (overrides the command, bypasses
   auto-detect) and `PI_TEST_PARSER` (overrides the parser).
2. **Project file** — `.pi/test.json`: `{ "command": "...", "parser": "..." }`.
3. **Auto-detect** from the project manifest (see below).

Other env vars:

- `PI_TEST_TIMEOUT` — run timeout in seconds (default `120`; `0` = unbounded).
  On breach, `run` kills the child and returns `status: timeout` — the nudge
  to switch to `bg` + `test parse` for long suites (encodes the essay's
  <1min invariant as a machine-readable signal).
- `PI_TEST_DISABLED` — set to `1`/`true` to disable the extension.

## Auto-detection & the parser registry

Auto-detection **is** the parser registry: each parser is an object
`{ name, detect(manifestCtx), parse(output): Summary }`, and detection probes
parsers in order. "Add a framework" = drop in a registered object. Probe
order:

1. **`package.json`** — sniff `scripts.test` content: contains `node --test`
   → `node` parser; `jest` → `jest`; `vitest` → `vitest`; else `npm test` with
   the `generic` parser.
2. **`Cargo.toml`** → `cargo test` (cargo parser).
3. **`go.mod`** → `go test ./...` (go parser).
4. **`Makefile`** → `make test` (generic parser — exit-code-only fallback).
5. else → error ("no test command configured").

v1 parsers:

| parser | runner | output format |
|--------|--------|--------------|
| `node` | `node --test --test-reporter=tap` | TAP 13 (version-stable) |
| `jest` | jest | `Tests: N failed, M passed, T total` + `● Name` |
| `vitest` | vitest | `Tests  N failed \| M passed (T)` + `× Name` |
| `cargo` | `cargo test` | `test result: FAILED. N passed; M failed;` |
| `go` | `go test` | `--- PASS:` / `--- FAIL:` |
| `generic` | (any) | exit-code only (no named failures) |

> **Grounding note:** the `node` (TAP) parser is grounded in real captured
> `node --test` output and live-tested. The `jest`/`vitest`/`cargo`/`go`
> parsers are tested against representative fixtures of their documented
> formats (those toolchains can't run in this sandbox). Add a parser on
> demand by registering an object — the registry makes it mechanical.

## The `/test` command

`/test` runs the resolved command once and shows a read-only TUI summary
panel (Esc to close), mirroring `/bg` — the human gets the same distilled
view the model gets. TUI-only; in non-interactive modes it notifies that it
requires interactive mode.

## This repo's own suite

The distro has no `package.json`/`Cargo.toml`/`go.mod`, so auto-detection
yields to a project file: `.pi/test.json` runs the repo's `node:test` suite
under the TAP reporter, parsed by the `node` parser. The suite lives in
`tests/` (jiti-loaded extensions driven via `tests/load.mjs`). Run it with:

```
node --test --test-reporter=tap tests/extensions/*.test.mjs
```

(An explicit glob, not bare `node --test`, because Node treats *any*
directory named `test` — including `agent/extensions/test/` — as a test dir
and would try to run the extension source as a test.)
