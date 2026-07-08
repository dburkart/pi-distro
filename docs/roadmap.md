# Roadmap

High-value, unimplemented items indicated by the long-horizon agent and
memory-systems research. Ordered by evidence-to-effort ratio. Each item lists
its research basis, concrete shape, prerequisites, and a rough effort
estimate.

Implemented to date:

- **Persistent cross-session agent memory** ([extensions/memory.md](extensions/memory.md))
  — the `memory` tool, `/memory` command, pointer injection, write-time
  conflict detection, lint. Covers factual + experiential memory in a flat
  markdown store.
- **Plan-before-execute skill** ([skills/plan.md](skills/plan.md)) — the
  `plan` skill: light brainstorm → durable plan in memory → living-contract
  execution. Escalates to `/grilling` on high-stakes signals; resumes
  in-progress plans after compaction.
- **Independent verifier** ([extensions/verify.md](extensions/verify.md)) —
  the `verify` tool + `/verify` command: spawns an isolated headless pi run
  that re-derives a claim from source and returns a structured verdict
  (confirmed/refuted/uncertain). Standalone single-verifier form of #4.
  Shipped ahead of #2 by user direction. Notable correction: the real
  isolation primitive is the headless child `pi` spawn, NOT
  `ctx.newSession`/`ctx.fork` (those are session-replacement primitives).

## Tier 1 — highest leverage, lowest effort

### 2. Checkpoint / rewind

**Basis:** Backtracking and dead-end recovery is the second-most-cited lever
after context/memory management. Pi is unusually well-positioned because the
session tree already exists (`/fork`, `/clone`, `ctx.fork(entryId)`,
`ctx.navigateTree(...)`) — most agents have no such primitive. The lever is
underbuilt everywhere; pi has the substrate but no ergonomics on top.

**Shape:** A small extension that:

- Auto-forks (a labeled checkpoint) before risky operations via the
  `tool_call` event — multi-file edits, `git`-mutating bash, large refactors.
  Use `pi.setLabel(entryId, ...)` to mark checkpoints in the tree.
- Exposes `/rewind` (and `/checkpoint`) commands wrapping `ctx.navigateTree`
  / `ctx.fork`.
- Optionally auto-prunes old checkpoints (configurable retention).

Composes with memory: when you rewind, persistent notes remember *why*.
This turns pi's latent tree into an explicit safety net.

**Prerequisites:** None. Uses existing pi primitives rather than reinventing.

**Effort:** Medium. The hard part is deciding *which* operations warrant
auto-checkpointing — a poor heuristic forks too often (tree bloat) or too
rarely (misses the risky moment). Start with a conservative, explicit
`/checkpoint` command and add auto-detection later.

## Tier 2 — highest ceiling, more build

### 3. Orchestrator + sub-agent architecture

**Basis:** The single most-cited architectural pattern (Anthropic's
multi-agent research system, the "deep agents" framing). An orchestrator
delegates to specialized sub-agents (search, code, retrieve, verify, write),
each with a clean context window. Each sub-agent may burn tens of thousands
of tokens but returns a 1–2k token distilled summary. Anthropic reports
substantial improvement over single-agent on complex research. Benefits:
context multiplication (total work far exceeds one window) and separation
of concerns (exploration context stays isolated; lead agent focuses on
synthesis).

**Shape:** A sub-agent extension that spawns isolated headless `pi` runs
(same primitive the `verify` extension uses: `pi --mode json -p --no-session`),
NOT `ctx.newSession`/`ctx.fork` (those are session-replacement primitives
that tear down the user's active session — see [extensions/verify.md](extensions/verify.md)).
The orchestrator could be a tool the LLM calls (`delegate`) or a command.
Sub-agents should write durable results to the memory extension so they
survive even if the sub-session is discarded.

**Prerequisites:** Memory extension (shipped) so sub-agents have somewhere
durable to hand off. Checkpoint/rewind (#2) desirable so sub-agent failures
can be cleanly abandoned.

**Effort:** Large. The real work is in the orchestration contract — when to
delegate, how to scope a sub-agent's task, how to verify its output. The
verification angle (next item) is the natural complement.

### 4. Verification / antagonist sub-agents

**Basis:** Multiple sources flag verification as critical but underbuilt.
Options: LLM-as-a-judge, dedicated verifier sub-agents, human-in-the-loop
checkpoints. One practitioner report splits the verifier into multiple
"antagonist" sub-agents and reports a quality spike with small cycle-time
cost. Long-horizon agents accumulate hallucination, sycophancy, and (in
coding) reward-hacking; verification is what makes them production-grade.

**Shape:** A `verify` tool or sub-agent role that takes a claim/artifact and
runs an independent check — re-reading the relevant files, re-running tests,
or posing counterfactuals. Could be a specialization of the sub-agent
extension (#3). The antagonists framing: spawn N verifiers with distinct
critique lenses rather than one self-grading pass.

**Status:** The **standalone single-verifier form is shipped** as the
`verify` extension ([extensions/verify.md](extensions/verify.md)). It spawns
an isolated headless `pi` run (the real isolation primitive — note this
corrects the earlier suggestion to use `ctx.newSession`/`ctx.fork`, which are
session-replacement primitives, not isolated-sub-agent ones). The
multi-verifier antagonist ensemble remains open and would build on the
sub-agent orchestrator (#3).

**Prerequisites:** Sub-agent architecture (#3) for the multi-verifier
version. A single-verifier `verify` tool is buildable standalone.

**Effort:** Medium (single verifier) to Large (antagonist ensemble).

## Tier 3 — memory evolution deepening

These improve the memory extension already shipped. Only worth doing when
observed failures justify them — the current flat lexical approach is
empirically adequate at moderate scale (StructMemEval).

### 5. Better retrieval: HyDE + hybrid search

**Basis:** The survey's most-cited practitioner insight on retrieval: the
query you have is the wrong query (questions and answers don't look alike in
embedding space). HyDE (hypothetical document embeddings) generates an
answer-shaped hypothetical to retrieve against. Hybrid retrieval (BM25 +
semantic) outperforms any single method.

**Trigger:** When `memory search` starts returning poor results at scale —
the agent frequently can't find a page that clearly exists.

**Shape:** Add an optional semantic layer to `memory search`: generate a
hypothetical answer with a small fast model, embed it + the query, search
against page embeddings. Keep BM25 (lexical) as the exact-match leg. This is
where a vector store finally earns its place — only after flat search fails.

**Prerequisites:** A small fast model for hypotheticals; an embedding store
(local, e.g. sqlite-vss or a file-backed index). Keep it optional and
fallback to lexical when unavailable, so the extension stays portable.

**Effort:** Medium. Defer until flat search demonstrably underperforms.

### 6. Background consolidation + forgetting

**Basis:** The survey's dynamics lifecycle: consolidation (merge
near-duplicates), updating (resolve contradictions — soft-delete with
timestamps rather than hard-delete), forgetting (time decay / access
frequency / LLM-judged value). Production guidance: LLM-assisted evolution is
"sufficient for most use cases"; RL-driven is research frontier, not
practitioner-ready.

**Trigger:** When the store grows enough that near-duplicates and stale
entries accumulate faster than lint catches them.

**Shape:** A `/memory consolidate` command (or a periodic hook) that uses the
LLM to judge merge/update candidates flagged by conflict detection, with
soft-delete (timestamped supersession) rather than hard-delete. Warn against
pure frequency-based eviction — it kills rare-but-essential long-tail
knowledge.

**Prerequisites:** Memory extension (shipped). Lint (shipped) already
surfaces candidates; this automates the resolution.

**Effort:** Medium. Defer until the store is large enough to need it.

### 7. Knowledge graph / hierarchical memory

**Basis:** For genuine multi-hop queries ("which API does the project use
that's built by the company Steve used to work at?"), flat search fails. The
survey's honest options: let the agent iterate (free, already works) or
build structural connections (knowledge graph — entity-relationship triples
with graph traversal). Knowledge graphs consistently win on multi-hop
benchmarks but are a significant engineering commitment.

**Trigger:** Only when specific multi-hop failures that iterative retrieval
can't solve are observed in practice. Do not build speculatively.

**Shape:** Entity/relationship extraction at write time (metadata tags on
pages), graph traversal for retrieval. Consider the enrichment-at-write-time
middle ground (tag entities without a full graph) before committing to a
graph backend.

**Prerequisites:** Memory extension (shipped). Clear evidence of multi-hop
failures.

**Effort:** Large. Explicitly deferred until needed.

## Explicitly deferred / not building

- **Latent memory (KV-cache manipulation)** — unreachable through hosted
  model APIs. Only viable with self-hosted models and PyTorch/HuggingFace
  internals. Off the table for a pi distro targeting hosted frontier models.
- **Parametric memory (fine-tuning / knowledge editing)** — requires weight
  access; provider fine-tuning services don't support the incremental updates
  a memory system needs.
- **RL-driven memory management** (Memory-R1, Mem-α) — research frontier,
  not practitioner-ready. The Verlog finding that current RL mostly
  *sharpens existing skills* rather than teaching new ones is a cautionary
  signal.
- **Custom compaction** — pi's built-in compaction is already good and has a
  `session_before_compact` hook. Only worth customizing if a specific
  failure mode is found.
- **Multi-agent shared memory governance** — relevant only when sub-agent
  orchestration (#3) is real and multi-tenant. Single-user pi distro doesn't
  need it yet.

## Sequencing

The recommended order, by evidence-to-effort:

1. **Plan skill** (#1) — cheap same-day win. ✅ Done.
2. **Checkpoint/rewind** (#2) — leverages pi's unique tree substrate.
3. **Single-verifier `verify` tool** (#4, standalone form) — modest build,
   meaningful reliability gain. ✅ Done (shipped ahead of #2 by user direction).
4. **Sub-agent orchestrator** (#3) — unlocks #4's antagonist form and is the
   natural substrate for complex delegation.
5. Memory evolution items (#5–#7) — only as observed failures demand them.
