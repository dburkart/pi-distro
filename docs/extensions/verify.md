# Verify Extension

`agent/extensions/verify/` adds an **independent, adversarial verifier** — a
`verify` tool (model-auto-invocable) and `/verify` command that spawn an
isolated headless `pi` run to re-derive whether a claim holds from ground
truth, returning a structured verdict (`confirmed` / `refuted` / `uncertain`).

This is roadmap item **#4 (Verification / antagonist sub-agents)**, in its
standalone single-verifier form. The general sub-agent orchestrator (#3) and
the multi-verifier antagonist ensemble are explicitly deferred — see
[roadmap.md](../roadmap.md).

## Why an independent verifier

Long-horizon agents accumulate hallucination, sycophancy, and (in coding)
reward-hacking. A self-grading pass ("are you sure?") inherits those same
failures. An *independent* verifier that re-derives a claim from source —
re-reading the files, re-running the commands/tests, rather than reasoning
over the claim's framing — is what makes verification meaningful. The verifier
runs in a fresh context window, so the primary agent's accumulated context
(its assumptions, its confidences, its drift) does not contaminate the check.

## The isolation primitive

The verifier is a **spawned headless child `pi` process**:

```
pi --mode json -p --no-session \
   --tools read,bash,grep,ls,find \
   --append-system-prompt <verifier-system-prompt> \
   "<task>"
```

This gives a fresh, isolated context window that runs to completion and returns
a distilled JSON verdict — without touching the user's active session.

> **Why not `ctx.newSession` / `ctx.fork`?** Those are *session-replacement*
> primitives: they tear down the user's active session (`session_shutdown`)
> and switch into the replacement. Calling them from a tool mid-turn would
> destroy the user's session. They are wrong for an inline verify. The
> headless child spawn is the real isolation primitive (the same one
> `examples/extensions/subagent` uses). This corrects a misleading note in
> the original roadmap entry.

## Read-only investigation

The verifier is constrained to *observation*, not mutation, via three layers:

1. **Tool allowlist** (`--tools read,bash,grep,ls,find`) — `write`, `edit`,
   and `memory` are omitted, so the verifier cannot mutate files or memory at
   the pi tool level. (The `verify` tool itself is also excluded, preventing
   recursive verification.)
2. **Adversarial system prompt** (`lib/prompt.ts`) — forbids state-changing
   commands and demands observation-only execution; network calls are allowed
   only when the call *is* the verification (e.g. GETting a live endpoint).
3. **OS-level read-only-filesystem sandbox** (optional, experimental) —
   `PI_VERIFY_SANDBOX=auto` wraps the child in a macOS `sandbox-exec` profile
   that denies file writes outside temp/cache. Off by default for
   portability; documented as defense-in-depth hardening.

Network is **fully open** at both the pi and OS levels: a verifier may
legitimately need to hit a deployed/live endpoint ("verify the API returns
200"), and forbidding network would block exactly the re-derivation the
contract demands for web/endpoint claims.

## The verifier contract

The verifier's system prompt mandates:

- **Re-derive from source.** For every evidence item, independently read the
  file or run the command. Never accept the claim's description of what the
  evidence says.
- **No grounding, no confirm.** `confirmed` is forbidden without fresh
  grounding. If evidence can't be re-derived, the verdict is `refuted` or
  `uncertain`.
- **No-evidence caps at uncertain.** Reasoning-only claims (architecture,
  trade-offs) can't be `confirmed` — at best `uncertain`.
- **Observation only.** No writes, edits, deletes, or state changes.
- **Be adversarial.** Actively look for the failure mode, the edge case, the
  error path.
- **Strict mode** (`strict: true`) demands at least one explicit
  counterfactual attempt before concluding.

The verifier's final assistant message must be a single JSON object:

```json
{
  "verdict": "confirmed" | "refuted" | "uncertain",
  "summary": "one line: conclusion + strongest reason",
  "findings": [
    { "evidence": "...", "result": "...", "supports": true | false | null }
  ],
  "counterfactuals": ["..."]
}
```

`lib/verdict.ts` extracts this leniently (strips code fences, finds the first
balanced object) and validates the verdict.

## Tool: `verify`

| Param      | Type           | Description                                                              |
|------------|----------------|--------------------------------------------------------------------------|
| `claim`    | string         | The assertion to verify (required)                                       |
| `evidence` | array          | Pointers to re-derive from: `file`/`command`/`test` items (optional)    |
| `focus`    | string         | A specific lens, e.g. "error paths" (optional)                           |
| `strict`   | boolean        | Require explicit counterfactuals (optional, default false)              |

`evidence` items:

| type      | fields                          | meaning                                          |
|-----------|---------------------------------|--------------------------------------------------|
| `file`    | `path`, `note?`                 | read it and judge whether it supports the claim  |
| `command` | `command`, `expect?`           | run it; `expect` is the caller's asserted outcome (verifier checks, doesn't trust) |
| `test`    | `command`                       | run it; pass/fail is the claim itself            |

### Output

A compact verdict rendered to the primary context (verdict, summary, findings,
counterfactuals, usage). The full transcript stays in `details`. A mild nudge
is appended on `refuted` / `uncertain` to overcome sycophancy. Operational
failures produce a distinct **`error` state** (not in the verdict enum),
rendered as "unverified — do not treat as confirmation."

### Auto-invocation

The tool is model-auto-invocable (primary — passive sycophancy catch). The
description carries positive + exclusion signals: fire after risky or
high-stakes work (multi-file refactors, security/auth changes, load-bearing
correctness claims, "is this done/correct?" moments); **not** for trivial
edits or routine reads. Each verify is a full isolated agent run (tokens +
latency), so reserve it for claims worth an independent check.

## Command: `/verify`

Manual entry to scope a verification interactively: `claim`, then optionally
evidence (comma- or newline-separated file paths / commands), `focus`, and
strict mode. Runs the same spawn path as the tool.

## Configuration

Environment-variable based for portability (matches the memory/web extensions):

| Env var                     | Default | Purpose                                                       |
|-----------------------------|---------|---------------------------------------------------------------|
| `PI_VERIFY_TIMEOUT`         | `120`   | Wall-clock cap in seconds                                     |
| `PI_VERIFY_COST_CAP_TOKENS` | `20000` | Cumulative output-token cap (aborts runaway verifier loops)   |
| `PI_VERIFY_SANDBOX`         | unset   | `auto` or a path to a `sandbox-exec` profile (macOS, optional)|
| `PI_VERIFY_DISABLED`        | unset   | `1`/`true` to disable the extension                           |

## Composition with memory and plan

- **With memory** — a `refuted`/`uncertain` verdict is worth persisting as an
  experiential lesson ("the X claim was refuted by re-derivation: ..."), so
  future sessions don't re-litigate it.
- **With the plan skill** — `verify` is the natural complement to a plan: the
  plan governs execution; `verify` independently checks the load-bearing
  claims a step rests on.

## File Layout

```
agent/extensions/verify/
├── index.ts            factory: registers the tool + command
├── tools.ts            the `verify` tool
├── commands.ts         the `/verify` command
└── lib/
    ├── prompt.ts       the adversarial verifier system prompt + task builder
    ├── verdict.ts      verdict types, JSON extraction + validation
    └── spawn.ts        headless pi spawn: timeout/cost-cap/abort, sandbox
```
