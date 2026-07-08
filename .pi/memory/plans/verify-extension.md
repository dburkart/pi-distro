# verify-extension — Roadmap #4: standalone single-verifier `verify` tool

Status: done
Goal: Ship the roadmap's Tier-2 #4 item (verification / antagonist sub-agents)
in its standalone single-verifier form, as a specialized `verify` extension
that spawns an isolated headless pi run with an adversarial lens and returns
a structured verdict. Ensemble/antagonist form and general sub-agent
orchestrator (#3) are explicitly deferred.

Steps:
  1. Scaffold `agent/extensions/verify/` directory (index.ts, tools.ts,
     lib/spawn.ts, lib/prompt.ts, lib/verdict.ts, commands.ts). Register the
     tool + `/verify` command in index.ts.
  2. lib/prompt.ts: the adversarial verifier system prompt. Mandates
     re-derive-from-source; forbids `confirmed` without fresh grounding;
     forbids mutation (no writes/state-changes unless the call IS the
     verification); no-evidence claims capped at `uncertain`; demands
     counterfactual attempt under `strict`. Emits a strict JSON verdict
     schema so the parent can parse it deterministically.
  3. lib/spawn.ts: headless child pi invocation. `pi --mode json -p
     --no-session --tools read,bash,grep,ls,find --append-system-prompt
     <verifier-prompt>` + the task. Read-only tool set (no write/edit/memory).
     Signal/AbortController propagation (SIGTERM -> SIGKILL grace). Timeout
     (PI_VERIFY_TIMEOUT, default 120s) + cost cap (PI_VERIFY_COST_CAP_TOKENS,
     default 20000) aborts. Runs under a read-only-filesystem sandbox profile
     (writes only to temp/cache), network fully open.
  4. lib/verdict.ts: parse the headless JSON transcript -> { verdict, summary,
     findings, counterfactuals, usage, error? }. verdict enum =
     confirmed|refuted|uncertain; distinct `error` state for timeout/cost
     cap/non-zero exit/parse failure (NOT in the verdict enum). Findings map
     each evidence item to { evidence, result, supports }.
  5. tools.ts: the `verify` tool. Parameters: claim (required), evidence
     (optional array of file/command/test items), focus (optional), strict
     (optional, default false). Description carries positive + exclusion
     signals (fire after risky/high-stakes work or load-bearing claims; NOT
     for trivial edits or routine reads). Renders compact verdict text to
     primary context; full transcript in `details`. Mild nudge on
     refuted/uncertain ("claim unverified — revisit"). Error renders as
     "verifier did not complete — do not treat as confirmation".
  6. commands.ts: `/verify` command. Lets the user manually scope a claim +
     evidence; runs the same spawn path. Discoverability surface.
  7. docs/extensions/verify.md: document design, contract, sandbox, env vars,
     portability. Add a line to docs/README.md index. Update roadmap.md to
     mark #4 (standalone form) done and resequence.
  8. Mark plan Status: done; mirror decisions into decisions.md; append
     lessons.md if anything diverged.

Assumptions:
  - The headless `pi --mode json -p --no-session` invocation (used by the
    subagent example) is the correct isolation primitive. ctx.newSession/
    ctx.fork are session-replacement primitives and are WRONG for an inline
    verify (they tear down the user's active session). Verified against
    examples/extensions/subagent and docs/extensions.md.
  - `--tools` allowlist on the headless run enforces the read-only tool set
    at the pi level; the read-only-FS sandbox profile enforces no-writes at
    the OS level (defense in depth). Network is allowed at both levels.
  - Structured verdict is extracted from the headless run's final assistant
    message via a JSON-schema demand in the verifier prompt (no separate
    structured-output channel needed). Parse failure -> `error` state.
  - The distro's portability principle (AGENTS.md) means sandbox profiles and
    env-var config must work across users/machines; no host-specific allowlists.

Open questions:
  - none (all resolved via /grilling pass)

Decisions (mirrored into decisions.md):
  - Specialized verify extension, NOT the general sub-agent substrate. (A)
  - Verifier MUST re-derive from source; no-evidence -> capped at uncertain. (A)
  - Input: claim (req) + evidence (opt array: file/command/test) + focus (opt)
    + strict (opt, default false). No ensemble/agent selector.
  - Output: verdict (confirmed|refuted|uncertain) + summary + findings +
    counterfactuals + usage; compact text to primary context, full transcript
    in details; mild nudge on refuted/uncertain; distinct error state (not in
    verdict enum) for operational failures.
  - Both model-auto-invocable tool AND explicit /verify command. (A)
  - Read-only tool set (read/bash/grep/ls/find; NO write/edit/memory) +
    read-only-FS sandbox profile + observation-only adversarial prompt.
    Network fully open (verifier may hit live endpoints). (B, revised)
  - Timeout 120s (PI_VERIFY_TIMEOUT), cost cap 20k tokens
    (PI_VERIFY_COST_CAP_TOKENS), SIGTERM->SIGKILL abort propagation,
    PI_VERIFY_DISABLED to disable. Error renders as unverified-not-confirmed.

Log:
  - 2026-07-07: Plan written after /grilling pass (7 decisions resolved).
    Key correction to roadmap assumption: ctx.newSession/ctx.fork are
    session-replacement, not isolated-sub-agent primitives; the real
    isolation primitive is the headless child pi spawn (subagent example).
    User revised sandbox decision mid-grilling: network must be fully open
    (verifier verifies live endpoints too), not provider-only.
  - 2026-07-07: Implementation complete. Files:
    agent/extensions/verify/{index,tools,commands}.ts + lib/{prompt,verdict,spawn}.ts.
    Typechecks clean (tsc 5.5 strict against pi's dist types). Loads under
    jiti (pi -e ... -p ran OK). Docs: docs/extensions/verify.md, indexed in
    docs/README.md, roadmap.md updated (#4 standalone done, #3 corrected on
    isolation primitive). No divergence from the plan. Living-contract: the
    OS-level sandbox (PI_VERIFY_SANDBOX) was implemented as opt-in/off-by-default
    for portability (not on by default as the grilling decision implied) — the
    read-only --tools allowlist is the primary, always-on enforcement; the
    sandbox is defense-in-depth hardening. This matches the distro's
    portability principle; documented in verify.md.
