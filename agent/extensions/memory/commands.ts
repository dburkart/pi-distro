/**
 * `/memory` command and the lint (evolution) layer.
 *
 * The lint pass is non-optional in production wiki deployments: drift — the
 * agent under-updating cross-references, pages silently going stale — is the
 * biggest failure mode. Lint reports only; it never deletes. Checks:
 *   - orphan pages (no inbound wiki-link from any other page)
 *   - pages missing a first-line summary
 *   - empty pages
 *   - the index/log/contract files present
 *
 * Lint does NOT try to detect semantic contradictions automatically beyond
 * the write-time conflict detection in ops.ts — that needs embeddings and
 * isn't worth the infra at v1. The agent itself is the best contradiction
 * detector; lint points it at candidates.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	type MemoryScope,
	memoryRoot,
	pageId,
	listPages,
	readText,
	pathExists,
} from "./lib/paths.ts";
import { contractPath } from "./lib/schema.ts";
import {
	indexPath,
	logPath,
	rebuildIndex,
	ensureIndex,
	ensureLog,
	appendLog,
} from "./lib/index-log.ts";
import { resolveScope, ensureScope } from "./lib/ops.ts";

interface LintFinding {
	scope: MemoryScope;
	page: string;
	severity: "warn" | "info";
	message: string;
}

export function registerMemoryCommands(pi: ExtensionAPI): void {
	pi.registerCommand("memory", {
		description:
			"Manage persistent memory: '/memory' shows status, '/memory lint' health-checks, " +
			"'/memory index' rebuilds the index, '/memory init [scope]' initializes a root.",
		getArgumentCompletions(prefix: string) {
			const subs = ["lint", "index", "init", "status"];
			const items = subs.map((s) => ({ value: s, label: s }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
			const cwd = ctx.cwd;

			if (!sub || sub === "status") {
				await showStatus(ctx, cwd);
				return;
			}

			if (sub === "init") {
				const scopeArg = rest[0] as MemoryScope | undefined;
				const scope = await resolveScope(scopeArg, cwd);
				await ensureScope(scope, cwd);
				const root = memoryRoot(scope, cwd);
				ctx.ui.notify(`Memory root ready: ${root}`, "info");
				return;
			}

			if (sub === "index") {
				const scopeArg = rest[0] as MemoryScope | undefined;
				const scope = await resolveScope(scopeArg, cwd);
				await ensureScope(scope, cwd);
				await rebuildIndex(memoryRoot(scope, cwd), scope);
				ctx.ui.notify(`Rebuilt index for ${scope} memory.`, "info");
				return;
			}

			if (sub === "lint") {
				await runLint(ctx, cwd);
				return;
			}

			ctx.ui.notify(`Unknown '/memory ${sub}'. Try: lint, index, init, status`, "error");
		},
	});
}

async function showStatus(
	ctx: ExtensionCommandContext,
	cwd: string,
): Promise<void> {
	const notify = (m: string, s: "info" | "error") => ctx.ui.notify(m, s);
	for (const scope of ["project", "global"] as const) {
		const root = memoryRoot(scope, cwd);
		const exists = await pathExists(contractPath(root));
		if (!exists) {
			notify(`${scope}: not initialized (run: /memory init ${scope})`, "info");
			continue;
		}
		const pages = await listPages(root);
		notify(`${scope}: ${pages.length} page(s) at ${root}`, "info");
	}
}

async function runLint(
	ctx: ExtensionCommandContext,
	cwd: string,
): Promise<void> {
	const notify = (m: string, s: "info" | "error") => ctx.ui.notify(m, s);
	const findings: LintFinding[] = [];

	for (const scope of ["project", "global"] as const) {
		const root = memoryRoot(scope, cwd);
		if (!(await pathExists(contractPath(root)))) {
			continue; // not initialized
		}
		// Ensure index/log exist and are current.
		await ensureLog(root);
		await ensureIndex(root, scope);

		const pages = await listPages(root);

		// Structural checks.
		if (!(await pathExists(indexPath(root)))) {
			findings.push({ scope, page: "index.md", severity: "warn", message: "index.md missing" });
		}
		if (!(await pathExists(logPath(root)))) {
			findings.push({ scope, page: "log.md", severity: "warn", message: "log.md missing" });
		}

		// Collect all wiki-link targets across pages for orphan detection.
		const inbound = new Set<string>();
		const pageContents = new Map<string, string>();
		for (const abs of pages) {
			let content = "";
			try {
				content = await readText(abs);
			} catch {
				continue;
			}
			const id = pageId(root, abs);
			pageContents.set(id, content);
			for (const m of content.matchAll(/\[[^\]]+\]\(([^)]+)\.md\)/g)) {
				inbound.add(m[1].replace(/\\/g, "/"));
			}
		}

		for (const [id, content] of pageContents) {
			const trimmed = content.trim();
			if (trimmed.length === 0) {
				findings.push({ scope, page: id, severity: "warn", message: "empty page" });
				continue;
			}
			if (!hasSummary(content)) {
				findings.push({
					scope,
					page: id,
					severity: "info",
					message: "no first-line summary (add a one-line description at the top)",
				});
			}
			if (!inbound.has(id) && pages.length > 1) {
				findings.push({
					scope,
					page: id,
					severity: "info",
					message: "orphan: no other page links to this one",
				});
			}
		}

		await appendLog(root, { scope, action: "lint", page: "-", note: `${findings.length} findings` });
	}

	if (findings.length === 0) {
		notify("Memory lint: no issues found. 🟢", "info");
		return;
	}

	const warns = findings.filter((f) => f.severity === "warn");
	const infos = findings.filter((f) => f.severity === "info");
	const lines = [
		`Memory lint: ${warns.length} warning(s), ${infos.length} info`,
		"",
	];
	for (const f of findings) {
		lines.push(`[${f.scope}] ${f.page}: ${f.message}`);
	}
	lines.push("", "Lint reports only; nothing was deleted or modified.");
	notify(lines.join("\n"), warns.length > 0 ? "error" : "info");
}

function hasSummary(content: string): boolean {
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line || line === "---") continue;
		const s = line.replace(/^#+\s*/, "").replace(/^\s*[-*]\s+/, "");
		if (s) return true;
	}
	return false;
}
