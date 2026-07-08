# test-extension — Roadmap H3: test/CI loop as a first-class tool

Status: done
Goal: Ship a `test` tool (+ `/test` command) that runs the project's
test/build command, parses exit code + output into a *compact* summary
(pass/fail counts, failing test names + one-line messages — not raw stdout),
and exposes the full log as a file. Plus: add a real test suite for the
distro repo itself (exercising the tool end-to-end) and an AGENTS.md
"tests required for every change" principle. Design resolved via `/grilling`.

Steps:
  1. Build `agent/extensions/test/index.ts`:
     - Single `test` tool with action enum `run` | `parse` (no handle table —
       `test` is stateless, unlike `bg`). Mirrors the track's enum precedent.
     - Parser registry: `{ name, detect(manifestCtx): boolean, parse(stdout, stderr): Summary }`.
       v1 parsers: `jest` (jest/vitest spec output), `cargo`, `go`, `node`
       (TAP from `node --test --test-reporter=tap`), `generic` (exit-code-only
       fallback for Makefile `test` targets). The detector IS the registry
       entry — "add a parser" = drop in a registered object.
     - Config resolution (env > .pi/test.json > auto-detect):
       `PI_TEST_COMMAND` / `PI_TEST_PARSER` env override → `.pi/test.json`
       `{command, parser}` → auto-detect from manifest.
       Auto-detect probe order: package.json (sniff scripts.test content:
       contains `node --test`→node, `jest`→jest, `vitest`→jest-parser) →
       Cargo.toml (cargo) → go.mod (go) → Makefile (generic) → error.
     - `run` (action:run): resolves command + parser; `command` param
       OVERRIDES the resolved command (subset/filter runs), parser still
       resolved from config/detection. Spawns SYNCHRONOUSLY (block until
       exit) via Node child_process.spawn (reuse bg's spawn pattern: shell
       `-c`, separate stdout/stderr files under `$TMPDIR/pi-test-<id>/`,
       unref not needed since blocking). Writes full stdout+stderr to
       `output.log` in that tmpdir; returns compact summary to context +
       file path exposed. Nonzero exit → `status: fail` (NOT a thrown
       error). `PI_TEST_TIMEOUT` (default 120s) → breach kills + returns
       `status: timeout` (the nudge to use bg+parse for long suites).
     - `parse` (action:parse): takes `file` OR `text` (either satisfies);
       optional `parser` override (default = detected/configured). Returns
       the compact summary. Zero-noise bg→test handoff via `file`.
     - Return contract (both actions): `status` (pass|fail|timeout|error),
       `passed`/`failed`/`total` counts, `failures: [{name, message}]`,
       `durationMs`, `logFile` path. Compact text to content; full Summary
       in `details`.
  2. `/test` human command: stateless one-shot run + TUI summary panel
     (Esc to close), mirroring `/bg`. TUI-only; non-interactive notifies.
  3. Custom `renderCall`/`renderResult` (pass/fail counts, failing names;
     expanded = full summary + log path; collapsed = one-line status).
  4. Auto-invocation: `promptSnippet` + `promptGuidelines`. Positive:
     running the project's test/build suite wanting a compact pass/fail
     summary, esp. multi-test runs + iterative fix loops. Exclusion:
     one-off/non-test/raw output → bash; long suites → bg then test parse.
  5. Distro's own test suite (the "exercise it" ask):
     - `tests/load.mjs`: jiti alias-map helper (lessons recipe) that loads
       an extension by name and returns the factory.
     - `tests/extensions/test.test.mjs`: unit tests for the parsers (feed
       sample jest/cargo/go/node-TAP output → assert Summary fields) +
       an integration test that runs a tiny throwaway suite via the `test`
       tool's `run` and checks the compact summary + log file.
     - `tests/extensions/bg.test.mjs`: port the bg smoke script to
       node:test (start/read-wait/list/stop/shutdown-cleanup) — gives the
       repo a real suite AND exercises `node:test` for the distro.
     - Runner: `node --test --test-reporter=tap tests/` (TAP = stable,
       zero-install, parses with the `node` parser).
     - `.pi/test.json`: `{ "command": "node --test --test-reporter=tap tests/", "parser": "node" }`
       — exercises the config-file config path AND makes `test run` work on
       this repo (no manifest → auto-detect fails → config file supplies it).
  6. Typecheck the extension: synthetic tsconfig against the installed pi
     dist (lessons recipe; npm_config_cache=/tmp).
  7. Smoke-test under jiti (lessons recipe) to confirm load + register.
  8. Run the distro's own suite via the `test` tool's code path (parse the
     TAP output) to prove end-to-end.
  9. Doc: `docs/extensions/test.md`; add line to `docs/README.md` index.
  10. Update `docs/roadmap-harness-eng.md`: mark H3 ✅ done.
  11. AGENTS.md (project): add Principle 5 — "Every change ships with a
      test. Run `node --test --test-reporter=tap tests/` before considering
      a change done; add or extend tests in `tests/` alongside the code."
  12. Cleanup: the bg-extension plan page is still `Status: in-progress`
      despite its log saying "Shipped" + roadmap H2 ✅ — fix to `Status: done`.

Assumptions:
  - `node --test --test-reporter=tap` emits stable TAP 13 (it does across
    Node 20–25); parser grounded in real captured output, not a guess.
  - The macOS sandbox permits detached/sync spawn + $TMPDIR writes + reading
    cwd test files (bg's smoke test already proved the spawn/tmpdir path).
  - `node:test` runs `.test.mjs` files that jiti-import TS extensions; each
    test file builds its own jiti alias map (worker isolation per file).
  - jiti is resolvable from the repo (it is — pi ships it; resolve via the
    pi install's node_modules, same as the lessons smoke recipe).
Open questions:
  - none (all 12 grilling decisions resolved).

Decisions (mirrored into decisions.md):
  - Execution model: action enum `run`(sync exec+parse) + `parse`(post-hoc
    over file|text). Only `run` spawns (sync); bg stays the background
    runner — no spawn duplication.
  - Config: env > .pi/test.json > auto-detect from manifest.
  - Auto-detection IS the parser registry; probe package.json→Cargo→go→Makefile→err.
  - v1 parsers: jest/vitest, cargo, go, node(TAP), generic. (+node TAP is a
    justified scope expansion driven by the repo-tests requirement.)
  - Return: compact summary to context + full log to $TMPDIR file, path exposed.
  - Parser interface: registry {name,detect,parse}; add-on-demand = drop in object.
  - Nonzero exit = status:fail (never thrown); PI_TEST_TIMEOUT default 120s →
    status:timeout (nudge to bg+parse for long suites).
  - parse input: file OR text; optional parser override (default detected).
  - run accepts full command override (subset runs); parser resolved separately.
  - /test command: stateless one-shot run + TUI panel, mirrors /bg.
  - Auto-invocation: positive+exclusion calibrated (multi-test/fix loops;
    exclude one-off/non-test→bash, long→bg+parse).
  - Distro tests via node --test TAP; .pi/test.json configures the tool on this repo.

Log:
  - Grilling resolved 12 decisions (Q1–Q12). Design self-consistent; no open questions.
  - Scope expansion vs grilling: added `node` (TAP) parser — grilling's v1 set
    (jest/vitest+cargo+go+Makefile-generic) had no parser that fits a
    manifest-less jiti-TS repo, and the user explicitly asked for tests on
    this repo that exercise the tool. TAP chosen for version-stability; parser
    grounded in real captured non-TTY output. Logged as living-contract note.
  - Toolchain reality in the sandbox: `node --test` is the ONLY runner that
    works here — `cargo`'s linker is broken on this machine, and `go test`
    fails because the sandbox denies writes to `~/Library/Caches/go-build`.
    So the distro's own suite is `node:test` (TAP), the `node` parser gets a
    LIVE integration test, and the jest/vitest/cargo/go parsers get
    fixture-based unit tests from their documented output formats (can't run
    those toolchains here). This reinforces node:test as the distro runner
    and is the honest grounding story.
  - Shipped: agent/extensions/test/index.ts (run/parse tool + /test command,
    parser registry jest/vitest/node/cargo/go/generic, env>.pi/test.json>auto-detect,
    sync spawn-to-file, NODE_TEST_CONTEXT stripped so nested node --test runs
    independently, /test TUI panel), docs/extensions/test.md, README index
    line, roadmap H3 ✅, AGENTS.md Principle 5 (tests required for every
    change). Repo suite: tests/load.mjs (portable — resolves pi install from
    `which pi`, dynamic-imports jiti from the resolved install; no hardcoded
    paths, no node_modules needed) + 3 suites (parsers fixtures, test-ext
    config/run/parse/format/registration, bg registration+start/read/stop).
    tsc clean (synthetic tsconfig); 28/28 node:test tests pass; full execute
    path proven end-to-end (resolveConfig reads .pi/test.json → spawn → TAP
    parse → compact summary with named failures + log path; parse via text
    and via file both work).
  - Two bugs found + fixed during build, both worth remembering:
    (1) `node --test` treats ANY directory named `test` as a test dir and
    tries to run its contents as tests — so bare `node --test` (auto-discovery)
    grabbed `agent/extensions/test/index.ts`. Fix: the distro command uses an
    explicit glob `tests/extensions/*.test.mjs`, NOT bare `node --test`.
    (2) Running the `test` tool's own `run` from INSIDE the suite (a
    self-referential test in tests/) recurses infinitely (the suite runs the
    test that runs the suite…). The integration tests run throwaway suites in
    /tmp instead; the full-execute proof ran from a /tmp script with a
    command override pointing at a /tmp suite. Do NOT add a test that runs
    the repo's own suite via the `test` tool from inside `tests/`.
  - NODE_TEST_CONTEXT stripping in runCommand is a real general fix, not just
    a test artifact: any nested `node --test` (child spawned by the tool while
    pi happens to run under node --test, or a user's command that itself
    spawns node --test) would otherwise inherit the parent's test-runner
    context and produce no stdout / exit 0.
