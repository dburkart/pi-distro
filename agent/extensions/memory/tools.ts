/**
 * The `memory` tool — the agent's interface to persistent memory.
 *
 * Actions: read, write, update, list, delete, search.
 *
 * The tool deliberately returns pointers and small summaries rather than
 * dumping full page contents into context. Full pages are returned only on
 * explicit `read`. This matches pi's "identifier not data" philosophy and
 * the survey's trust guidance: memory is a leak surface, so never
 * auto-inject the whole store. The agent pulls just-in-time.
 *
 * `search` does a cheap case-insensitive substring scan across pages
 * (filename + body). No embeddings — StructMemEval shows flat lexical
 * retrieval holds up well at moderate scale, and the agent can refine with
 * repeated calls (iterative retrieval handles multi-hop for free).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type MemoryScope,
	memoryRoot,
	pageId,
	listPages,
	readText,
} from "./lib/paths.ts";
import {
	readMemory,
	writeMemory,
	updateMemory,
	listMemory,
	deleteMemory,
	resolveScope,
} from "./lib/ops.ts";
import { rebuildIndex } from "./lib/index-log.ts";

interface SearchHit {
	page: string;
	scope: MemoryScope;
	line: string;
}

export function registerMemoryTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Read and write persistent, cross-session memory as markdown files. " +
			"Memory survives across sessions, compaction, and the session tree " +
			"(unlike the in-session todo list). Two scopes: 'project' " +
			"(<cwd>/.pi/memory/, committed with the repo) and 'global' " +
			"(~/.pi/memory/, user-wide). Store two kinds of things: factual " +
			"(decisions, state, preferences) and experiential (lessons, dead-ends, " +
			"what worked). Always search/list before writing a new page — prefer " +
			"updating an existing page over creating a duplicate. The memory root " +
			"has a MEMORY.md contract describing conventions; read it on first use.",
		promptSnippet: "Read/write persistent cross-session memory (markdown)",
		promptGuidelines: [
			"Use memory to persist decisions, lessons, and project facts that should " +
				"survive across sessions — not ephemeral session state. Search or list " +
				"before creating a new page; update existing pages instead of duplicating.",
			"When a memory write returns conflicts, resolve them: either update the " +
				"flagged existing page instead, or deliberately keep both and note why " +
				"in log.md.",
		],
		parameters: Type.Object({
			action: StringEnum([
				"read",
				"write",
				"update",
				"list",
				"delete",
				"search",
			] as const),
			page: Type.Optional(
				Type.String({
					description:
						"Page name (relative id, no .md). e.g. 'decisions', 'lessons', " +
						"'debugging/auth'. Required for read/write/update/delete.",
				}),
			),
			content: Type.Optional(
				Type.String({
					description: "Full page content for 'write' (markdown).",
				}),
			),
			oldText: Type.Optional(
				Type.String({
					description: "Exact text to replace for 'update'.",
				}),
			),
			newText: Type.Optional(
				Type.String({
					description: "Replacement text for 'update'.",
				}),
			),
			scope: Type.Optional(
				StringEnum(["project", "global"] as const, {
					description:
						"Scope: 'project' (<cwd>/.pi/memory) or 'global' (~/.pi/memory). " +
						"If omitted, uses project when it exists, else global.",
				}),
			),
			query: Type.Optional(
				Type.String({ description: "Search query for 'search'." }),
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const scope = await resolveScope(params.scope as MemoryScope | undefined, cwd);

			switch (params.action) {
				case "read": {
					if (!params.page) return err("page is required for read");
					const r = await readMemory(scope, params.page, cwd);
					if (!r.exists) {
						return {
							content: [txt(`No memory page "${params.page}" in ${scope} scope.`)],
							details: r,
						};
					}
					return {
						content: [txt(r.content)],
						details: r,
					};
				}

				case "write": {
					if (!params.page) return err("page is required for write");
					if (params.content === undefined) return err("content is required for write");
					const r = await writeMemory(scope, params.page, params.content, cwd);
					const lines: string[] = [
						r.created
							? `Created memory page "${params.page}" (${scope}).`
							: `Updated memory page "${params.page}" (${scope}).`,
						`Path: ${r.path}`,
					];
					if (r.conflicts.length > 0) {
						lines.push("", "Potential conflicts detected:");
						for (const c of r.conflicts) {
							lines.push(`  - ${c.page}: ${c.hint}`);
						}
						lines.push(
							"",
							"Consider updating one of these instead, or note in log.md why both exist.",
						);
					}
					return {
						content: [txt(lines.join("\n"))],
						details: r,
					};
				}

				case "update": {
					if (!params.page) return err("page is required for update");
					if (params.oldText === undefined || params.newText === undefined) {
						return err("oldText and newText are required for update");
					}
					const r = await updateMemory(
						scope,
						params.page,
						params.oldText,
						params.newText,
						cwd,
					);
					if (!r.updated) {
						return {
							content: [
								{
									type: "text",
									text: `Could not update "${params.page}" (${scope}). ` +
										`The page may not exist, or oldText was not found.`,
								},
							],
							details: r,
						};
					}
					const lines = [`Updated memory page "${params.page}" (${scope}).`];
					if (r.conflicts.length > 0) {
						lines.push("", "Potential conflicts:");
						for (const c of r.conflicts) {
							lines.push(`  - ${c.page}: ${c.hint}`);
						}
					}
					return {
						content: [txt(lines.join("\n"))],
						details: r,
					};
				}

				case "list": {
					const r = await listMemory(scope, cwd);
					const lines: string[] = [`Memory pages (${scope}):`];
					if (r.pages.length === 0) {
						lines.push("  (none yet)");
					} else {
						for (const p of r.pages) {
							lines.push(`  - ${p.page} — ${p.summary}`);
						}
					}
					lines.push(
						"",
						`Read index.md or MEMORY.md in ${memoryRoot(scope, cwd)} for full context.`,
					);
					return {
						content: [txt(lines.join("\n"))],
						details: r,
					};
				}

				case "delete": {
					if (!params.page) return err("page is required for delete");
					const r = await deleteMemory(scope, params.page, cwd);
					return {
						content: [
							{
								type: "text",
								text: r.deleted
									? `Deleted memory page "${params.page}" (${scope}).`
									: `No memory page "${params.page}" to delete (${scope}).`,
							},
						],
						details: r,
					};
				}

				case "search": {
					if (!params.query) return err("query is required for search");
					const hits = await searchMemory(scope, params.query, cwd);
					if (hits.length === 0) {
						return {
							content: [
								txt(`No matches for "${params.query}" in ${scope} memory.`),
							],
							details: { scope, query: params.query, hits: [] },
						};
					}
					const lines = [`Matches for "${params.query}" (${scope}, ${hits.length}):`];
					for (const h of hits) {
						lines.push(`  - ${h.page}: ${h.line}`);
					}
					return {
						content: [txt(lines.join("\n"))],
						details: { scope, query: params.query, hits },
					};
				}

				default:
					return err(`unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme, _ctx) {
			let text = theme.fg("toolTitle", theme.bold("memory "));
			text += theme.fg("muted", args.action);
			if (args.page) text += ` ${theme.fg("accent", args.page)}`;
			if (args.scope) text += theme.fg("dim", ` [${args.scope}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme, _ctx) {
			const details = result.details as { conflicts?: unknown[] } | undefined;
			const text = result.content[0];
			const body = text?.type === "text" ? text.text : "";
			if (details?.conflicts && details.conflicts.length > 0) {
				return new Text(theme.fg("warning", `⚠ ${details.conflicts.length} conflict(s)`) + "\n" + theme.fg("muted", body), 0, 0);
			}
			return new Text(theme.fg("muted", body), 0, 0);
		},
	});
}

function err(msg: string) {
	return {
		content: [txt(`Error: ${msg}`)],
		details: { error: msg },
	};
}

function txt(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

async function searchMemory(
	scope: MemoryScope,
	query: string,
	cwd: string,
): Promise<SearchHit[]> {
	const root = memoryRoot(scope, cwd);
	const pages = await listPages(root);
	const q = query.toLowerCase();
	const hits: SearchHit[] = [];
	for (const abs of pages) {
		const id = pageId(root, abs);
		if (id.toLowerCase().includes(q)) {
			hits.push({ page: id, scope, line: "(page name match)" });
			continue;
		}
		let content: string;
		try {
			content = await readText(abs);
		} catch {
			continue;
		}
		const lower = content.toLowerCase();
		const idx = lower.indexOf(q);
		if (idx >= 0) {
			const start = Math.max(0, idx - 40);
			const snippet = content.slice(start, idx + q.length + 60).replace(/\n+/g, " ").trim();
			hits.push({ page: id, scope, line: snippet });
		}
	}
	return hits.slice(0, 50);
}

/** Re-export so commands can rebuild the index. */
export { rebuildIndex };
