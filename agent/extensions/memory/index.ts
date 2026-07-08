/**
 * Persistent agent memory extension.
 *
 * Gives the agent a durable, cross-session, agent-curated memory store made of
 * plain markdown files. This fills the gap pi's compaction leaves open:
 * compaction summaries live inside a session and die with it. Memory written
 * here survives across sessions, across compaction, and across the session
 * tree — and is human-inspectable, git-trackable, and editable directly.
 *
 * Design is grounded in the "Memory in the Age of AI Agents" survey (Hu et
 * al., 2025) three-axis framework, pruned to what's practical on hosted
 * frontier models (token-level memory only — latent/parametric memory is
 * unreachable through APIs):
 *
 *   - Storage: flat markdown. StructMemEval shows simple flat retrieval
 *     outperforms complex hierarchies until you hit specific multi-hop
 *     failures. No vector DB at v1.
 *   - Functions: both factual (decisions, state, preferences) AND experiential
 *     (lessons, dead-ends, what worked). Experiential is the most
 *     under-built, highest-leverage piece — most agents re-derive solutions
 *     every session.
 *   - Formation: agent writes via the `memory` tool. A schema contract
 *     (MEMORY.md convention) gives a maintainer contract — NOT a blank slate.
 *   - Evolution: a `lint` operation (orphan detection, contradiction flags,
 *     staleness) — production deployments of the wiki pattern call this
 *     non-optional. Conflict detection at write time.
 *   - Retrieval: agent-driven, just-in-time. We surface a pointer (not
 *     contents) in before_agent_start; the agent greps/reads as needed. This
 *     matches pi's "identifier not data" philosophy and keeps context lean
 *     and safe (memory is a leak surface; never auto-inject the full store).
 *
 * Two scopes:
 *   project  -> <cwd>/.pi/memory/      (committed with the repo, shared)
 *   global   -> ~/.pi/memory/           (user-wide, cross-project)
 *
 * Layout mirrors the Karpathy "llm-wiki" pattern (proven at ~4000 concepts):
 *   <scope>/
 *     MEMORY.md    the maintainer contract / schema (co-evolved with user)
 *     index.md     content catalog, one line per page (agent-maintained)
 *     log.md        append-only chronological record, grep-parseable
 *     <page>.md     individual memory pages
 *
 * Configuration is environment-variable based for portability:
 *   PI_MEMORY_DISABLED   if set ("1"/"true"), disable the extension entirely
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryTool } from "./tools.ts";
import { registerMemoryCommands } from "./commands.ts";
import { injectMemoryPointer } from "./inject.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_MEMORY_DISABLED === "1" || process.env.PI_MEMORY_DISABLED === "true") {
		return;
	}

	registerMemoryTool(pi);
	registerMemoryCommands(pi);
	pi.on("before_agent_start", injectMemoryPointer);
}
