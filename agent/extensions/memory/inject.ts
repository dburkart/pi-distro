/**
 * before_agent_start injection.
 *
 * The survey and Anthropic's context-engineering guidance converge on the
 * same rule: surface a *pointer* to memory, not its contents. Auto-injecting
 * the full store pollutes context, wastes the attention budget, and is a
 * leak surface. The agent reads the index (or specific pages) just-in-time
 * via the `memory` tool when it judges them relevant.
 *
 * So this hook appends a short reminder to the system prompt: that memory
 * exists, where it lives, and that the agent should consult it before
 * non-trivial work and update it when it makes a decision or hits a
 * dead-end. That's it. Cheap, safe, and keeps the agent from forgetting
 * that the substrate exists across the boundary of a new session.
 *
 * This mirrors the CLAUDE.md / AGENTS.md "context file" pattern but for
 * agent-maintained memory rather than human-maintained rules.
 */
import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { memoryRoot, pathExists } from "./lib/paths.ts";
import { contractPath } from "./lib/schema.ts";

const POINTER = (projectPath: string, globalPath: string, hasProject: boolean, hasGlobal: boolean) => {
	const lines: string[] = [
		"",
		"<memory>",
		"You have persistent cross-session memory, written as markdown files. It",
		"survives across sessions, compaction, and the session tree. Before",
		"non-trivial work, check whether relevant memory already exists (use the",
		"`memory` tool with action `list` or `search`). When you make a decision,",
		"learn a lesson, or hit a dead-end worth remembering, write it to memory",
		"(action `write` or `update`) so future sessions don't re-derive it.",
		"Store both factual (decisions, state, preferences) and experiential",
		"(lessons, what worked, dead-ends) memory. See MEMORY.md in each root for",
		"conventions. Prefer updating an existing page over creating a duplicate.",
	];
	if (hasProject) {
		lines.push(`Project memory: ${projectPath}`);
	}
	if (hasGlobal) {
		lines.push(`Global memory: ${globalPath}`);
	}
	if (!hasProject && !hasGlobal) {
		lines.push(
			"No memory root is initialized yet. Run `/memory init` (or create a page",
			"with the `memory` tool) to bootstrap one.",
		);
	}
	lines.push("</memory>");
	return lines.join("\n");
};

export async function injectMemoryPointer(
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
): Promise<{ systemPrompt: string }> {
	const cwd = ctx.cwd;
	const projectRoot = memoryRoot("project", cwd);
	const globalRoot = memoryRoot("global", cwd);
	const [hasProject, hasGlobal] = await Promise.all([
		pathExists(contractPath(projectRoot)),
		pathExists(contractPath(globalRoot)),
	]);

	const pointer = POINTER(projectRoot, globalRoot, hasProject, hasGlobal);
	return { systemPrompt: event.systemPrompt + "\n" + pointer };
}
