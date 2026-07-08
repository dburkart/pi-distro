/**
 * index.md and log.md maintenance — the navigational substrate.
 *
 * index.md is content-oriented: one line per page (id + one-line summary).
 * log.md is chronological: append-only, parseable with grep.
 *
 * Both are agent-facing aids, kept simple. Per the Karpathy wiki pattern,
 * the index alone works "surprisingly well at moderate scale (~100 sources,
 * ~hundreds of pages) and avoids the need for embedding-based RAG
 * infrastructure."
 */

import { join } from "node:path";
import {
	pageId,
	listPages,
	readText,
	writeText,
	pathExists,
	appendText,
	type MemoryScope,
	memoryRoot,
} from "./paths.ts";

const INDEX_FILENAME = "index.md";
const LOG_FILENAME = "log.md";

export function indexPath(root: string): string {
	return join(root, INDEX_FILENAME);
}
export function logPath(root: string): string {
	return join(root, LOG_FILENAME);
}

/**
 * Extract a one-line summary from a page: the first non-empty line that
 * isn't a frontmatter delimiter or heading marker, truncated.
 */
function extractSummary(content: string): string {
	const lines = content.split("\n");
	let inFrontmatter = false;
	let frontmatterSeen = false;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		if (line === "---" && !frontmatterSeen) {
			inFrontmatter = !inFrontmatter;
			frontmatterSeen = true;
			continue;
		}
		if (inFrontmatter) continue;
		// Strip leading markdown heading hashes.
		const summary = line.replace(/^#+\s*/, "").replace(/^\s*[-*]\s+/, "");
		if (!summary) continue;
		return summary.length > 100 ? summary.slice(0, 97) + "…" : summary;
	}
	return "(no summary)";
}

/** Rebuild index.md from the current set of pages. */
export async function rebuildIndex(root: string, scope: MemoryScope): Promise<void> {
	const pages = await listPages(root);
	const lines: string[] = [
		`# Memory index (${scope})`,
		"",
		"One line per page. Maintained by the agent — read this first, then",
		"drill into specific pages. Run \`/memory lint\` to health-check.",
		"",
	];
	if (pages.length === 0) {
		lines.push("_(no pages yet)_");
	} else {
		for (const abs of pages) {
			const id = pageId(root, abs);
			let summary = "(no summary)";
			try {
				summary = extractSummary(await readText(abs));
			} catch {
				// leave default
			}
			lines.push(`- [${id}](${id}.md) — ${summary}`);
		}
	}
	lines.push("");
	await writeText(indexPath(root), lines.join("\n"));
}

/** Ensure index.md exists, rebuilding if missing. */
export async function ensureIndex(root: string, scope: MemoryScope): Promise<void> {
	if (!(await pathExists(indexPath(root)))) {
		await rebuildIndex(root, scope);
	}
}

export interface LogEntry {
	scope: MemoryScope;
	action: "write" | "update" | "delete" | "lint" | "init";
	page: string;
	note?: string;
}

function today(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function appendLog(root: string, entry: LogEntry): Promise<void> {
	const stamp = today();
	const tag = entry.action.padEnd(6);
	const page = entry.page || "-";
	const note = entry.note ? ` | ${entry.note}` : "";
	const line = `## [${stamp}] ${entry.scope}/${tag} | ${page}${note}\n`;
	await appendText(logPath(root), line);
}

/** Ensure log.md exists with a header. */
export async function ensureLog(root: string): Promise<void> {
	if (!(await pathExists(logPath(root)))) {
		await writeText(
			logPath(root),
			"# Memory log\n\nAppend-only chronological record. Parse with:\n" +
				'`grep "^## \\[" log.md | tail -5`\n\n',
		);
	}
}

/**
 * Initialize a memory root if it doesn't exist: contract, empty index, log.
 * Returns true if initialization happened.
 */
export async function initRoot(scope: MemoryScope, cwd: string): Promise<boolean> {
	const root = memoryRoot(scope, cwd);
	const { contractPath, DEFAULT_CONTRACT, MEMORY_CONTRACT_FILENAME } =
		await import("./schema.ts");
	const cPath = contractPath(root);
	if (await pathExists(cPath)) {
		// Already initialized; just make sure index/log exist.
		await ensureLog(root);
		await ensureIndex(root, scope);
		return false;
	}
	await writeText(cPath, DEFAULT_CONTRACT);
	await ensureLog(root);
	await rebuildIndex(root, scope);
	await appendLog(root, { scope, action: "init", page: MEMORY_CONTRACT_FILENAME });
	return true;
}
