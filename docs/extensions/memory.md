# Memory Extension

`agent/extensions/memory/` gives the agent a **persistent, cross-session,
agent-curated memory store** made of plain markdown files. This fills the gap
pi's compaction leaves open: compaction summaries live inside a session and
die with it. Memory written here survives across sessions, across
compaction, and across the session tree — and is human-inspectable,
git-trackable, and editable directly.

The design is grounded in the "Memory in the Age of AI Agents" survey (Hu et
al., 2025) three-axis framework (Forms / Functions / Dynamics), pruned to
what's practical on hosted frontier models — token-level memory only, since
latent (KV-cache) and parametric (weight) memory are unreachable through
APIs.

## What it adds

- **`memory` tool** — the agent reads, writes, updates, lists, deletes, and
  searches memory pages. Returns pointers/summaries rather than dumping full
  contents, so context stays lean.
- **`/memory` command** — `status` (per-scope page counts), `init [scope]`
  (bootstrap a root), `index [scope]` (rebuild the catalog), `lint`
  (health-check).
- **`before_agent_start` injection** — appends a short pointer to the system
  prompt telling the agent that memory exists and where, so a fresh session
  knows to consult it. Injects a *pointer*, never the contents (memory is a
  leak surface; never auto-inject the full store).

## Two scopes

| Scope    | Path                      | Purpose                                  |
|----------|---------------------------|------------------------------------------|
| project  | `<cwd>/.pi/memory/`       | Committed with the repo, shared, reviewable |
| global   | `~/.pi/memory/`           | User-wide, cross-project, never committed |

When `scope` is omitted, the tool uses the project root if it exists, else
global.

## Layout (per scope)

```
<root>/
├── MEMORY.md    the maintainer contract / schema (co-evolved with the user)
├── index.md     content catalog, one line per page (agent-maintained)
├── log.md       append-only chronological record, grep-parseable
└── <page>.md    individual memory pages (e.g. decisions.md, lessons.md)
```

This mirrors the Karpathy "llm-wiki" pattern, proven at ~4000 interlinked
concepts in production. The index alone works "surprisingly well at moderate
scale" and avoids embedding-based RAG infrastructure.

## Functions: factual + experiential

The store covers both, not just factual:

- **Factual** — project state, decisions and why, preferences, environment
  facts. ("We chose PostgreSQL, not MySQL.")
- **Experiential** — lessons, dead-ends, what worked. ("Retry logic was a
  red herring; the connection pool config was the bug.") This is the
  most under-built, highest-leverage kind: it stops the agent re-deriving
  solutions every session.

## Design decisions (and why)

- **Flat markdown, no vector DB.** StructMemEval shows simple flat/lexical
  retrieval outperforms complex memory hierarchies on standard benchmarks
  until you hit specific multi-hop failures. The agent handles multi-hop for
  free via repeated `search` calls (iterative retrieval). Move to graphs only
  if you observe failures flat search can't solve.
- **Pointer, not contents, in the system prompt.** Auto-injecting the full
  store pollutes context, wastes the attention budget, and is a leak
  surface. The agent pulls just-in-time via the `memory` tool. Matches
  Anthropic's "identifier not data" principle.
- **Schema contract, not a blank slate.** Every production wiki deployment
  reports the single most important file is a co-evolved schema/config. The
  `MEMORY.md` contract gives the agent a maintainer contract (page
  conventions, when to create vs. update, what belongs) rather than a blank
  slate. The user edits it; the agent follows and proposes changes.
- **Write-time conflict detection.** `write`/`update` flag pages with similar
  names or overlapping headings (a cheap lexical approximation of the
  survey's 0.6–0.9 cosine "similar topic, possibly different facts" band).
  The agent is told to resolve them. This is one of the cheapest
  high-leverage things — retrieval quality is bounded by formation quality.
- **Lint (the evolution layer).** `/memory lint` flags orphans (no inbound
  wiki-links), empty pages, missing summaries, and structural file gaps.
  Non-optional in production: drift (under-updated cross-references, stale
  pages silently going wrong) is the biggest failure mode. Lint reports only;
  it never deletes.
- **Soft-touch on trust.** Memory writes go to the working directory or
  `~/.pi`, both inside the pi sandbox's writable paths. Project memory is
  meant to be committed (treat memory writes like code writes — reviewable,
  diffable), which also makes them auditable.

## Configuration

Environment-variable based for portability:

| Env var              | Default | Purpose                          |
|----------------------|---------|----------------------------------|
| `PI_MEMORY_DISABLED` | unset   | Set to `1`/`true` to disable     |

## Composition with pi

- **Survives compaction** — memory is on disk, not in the session. The
  compaction summary handles the window; memory handles the days.
- **Survives the session tree** — forking/rewinding the session tree does not
  touch memory. Memory persists and can remember *why* you rewound (write a
  lesson to experiential memory after a dead-end).
- **Future sub-agent substrate** — a future orchestrator/sub-agent extension
  can delegate focused memory writes/reads to this store.

## File Layout

```
agent/extensions/memory/
├── index.ts              factory: registers tool, commands, injection
├── tools.ts              the `memory` tool (read/write/update/list/delete/search)
├── commands.ts           `/memory` command (status/init/index/lint)
├── inject.ts             before_agent_start pointer injection
└── lib/
    ├── paths.ts          scopes, path resolution, traversal guards, fs helpers
    ├── schema.ts         the MEMORY.md maintainer contract (default)
    ├── index-log.ts      index.md + log.md maintenance, root initialization
    └── ops.ts            core ops + write-time conflict detection
```
