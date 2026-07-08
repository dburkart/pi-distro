/**
 * Core memory operations: read, write (create/update), update, list, delete.
 *
 * Write-time conflict detection is implemented here because the survey is
 * emphatic that retrieval quality is bounded by formation/evolution
 * quality, and that surfacing conflicts at write time (the 0.6–0.9
 * "similar topic, possibly different facts" band) is one of the cheapest
 * high-leverage things you can do. We do a cheap lexical approximation
 * rather than embeddings: normalize, tokenize, and compare. It catches
 * near-duplicate page names and overlapping headings without any infra.
 */

import { basename } from "node:path";
import {
	type MemoryScope,
	memoryRoot,
	resolvePagePath,
	pageId,
	listPages,
	readText,
	atomicWrite,
	removeFile,
	pathExists,
} from "./paths.ts";
import {
	rebuildIndex,
	ensureIndex,
	appendLog,
	ensureLog,
	initRoot,
} from "./index-log.ts";

export interface PageRef {
	scope: MemoryScope;
	page: string;
}

export interface MemoryPage extends PageRef {
	summary: string;
	exists: boolean;
}

export interface ReadResult {
	scope: MemoryScope;
	page: string;
	content: string;
	exists: boolean;
}

export interface WriteResult {
	scope: MemoryScope;
	page: string;
	created: boolean;
	conflicts: ConflictFlag[];
	path: string;
}

export interface UpdateResult {
	scope: MemoryScope;
	page: string;
	updated: boolean;
	conflicts: ConflictFlag[];
}

export interface ListResult {
	scope: MemoryScope;
	pages: MemoryPage[];
}

export interface DeleteResult {
	scope: MemoryScope;
	page: string;
	deleted: boolean;
}

export interface ConflictFlag {
	/** The page id that conflicts. */
	page: string;
	/** Why it conflicts. */
	reason: "similar-name" | "overlapping-heading";
	/** A short hint. */
	hint: string;
}

/** Normalize text for comparison: lowercase, alnum only, collapse spaces. */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Token set for jaccard-ish comparison. */
function tokens(text: string): Set<string> {
	const n = normalize(text);
	const out = new Set<string>();
	for (const t of n.split(" ")) {
		if (t.length > 2) out.add(t);
	}
	return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
}

/**
 * Extract headings (lines starting with #) from a page, lowercased.
 * Used for overlapping-heading conflict detection.
 */
function headings(content: string): string[] {
	const out: string[] = [];
	for (const raw of content.split("\n")) {
		const m = raw.match(/^\s*#{1,6}\s+(.+?)\s*$/);
		if (m) out.push(m[1].toLowerCase());
	}
	return out;
}

/**
 * Detect potential conflicts for a write: pages with similar names or
 * significant heading overlap. Cheap, lexical, no embeddings.
 */
export async function detectConflicts(
	root: string,
	page: string,
	content: string,
): Promise<ConflictFlag[]> {
	const flags: ConflictFlag[] = [];
	const targetTokens = tokens(page);
	const targetHeadings = new Set(headings(content));

	const pages = await listPages(root);
	for (const abs of pages) {
		const id = pageId(root, abs);
		if (id === page) continue; // self
		const idTokens = tokens(id);
		const nameSim = jaccard(targetTokens, idTokens);
		if (nameSim >= 0.5 && targetTokens.size > 0 && idTokens.size > 0) {
			flags.push({
				page: id,
				reason: "similar-name",
				hint: `page name "${page}" is similar to existing "${id}"`,
			});
			continue;
		}
		let existingContent = "";
		try {
			existingContent = await readText(abs);
		} catch {
			continue;
		}
		const existingHeadings = new Set(headings(existingContent));
		let overlap = 0;
		for (const h of targetHeadings) if (existingHeadings.has(h)) overlap++;
		// Flag if multiple shared headings — likely the same topic.
		if (overlap >= 2) {
			flags.push({
				page: id,
				reason: "overlapping-heading",
				hint: `${overlap} shared headings with "${id}"`,
			});
		}
	}
	return flags;
}

/** Resolve scope with a fallback: "project" if a project root exists, else "global". */
export async function resolveScope(
	requested: MemoryScope | undefined,
	cwd: string,
): Promise<MemoryScope> {
	if (requested) return requested;
	// Prefer project if it's already initialized; otherwise global.
	const projectRoot = memoryRoot("project", cwd);
	if (await pathExists(projectRoot)) return "project";
	return "global";
}

/** Ensure a scope's root is initialized. */
export async function ensureScope(scope: MemoryScope, cwd: string): Promise<void> {
	await initRoot(scope, cwd);
	await ensureLog(memoryRoot(scope, cwd));
	await ensureIndex(memoryRoot(scope, cwd), scope);
}

export async function readMemory(
	scope: MemoryScope,
	page: string,
	cwd: string,
): Promise<ReadResult> {
	await ensureScope(scope, cwd);
	const root = memoryRoot(scope, cwd);
	const path = resolvePagePath(root, page);
	if (!path) {
		return { scope, page, content: "", exists: false };
	}
	const exists = await pathExists(path);
	return {
		scope,
		page,
		content: exists ? await readText(path) : "",
		exists,
	};
}

export async function writeMemory(
	scope: MemoryScope,
	page: string,
	content: string,
	cwd: string,
): Promise<WriteResult> {
	await ensureScope(scope, cwd);
	const root = memoryRoot(scope, cwd);
	const path = resolvePagePath(root, page);
	if (!path) {
		throw new Error(`Invalid memory page name: ${page}`);
	}
	const existed = await pathExists(path);
	const conflicts = await detectConflicts(root, page, content);
	await atomicWrite(path, content);
	await rebuildIndex(root, scope);
	await appendLog(root, {
		scope,
		action: existed ? "update" : "write",
		page,
		note: existed ? "updated" : "created",
	});
	return { scope, page, created: !existed, conflicts, path };
}

/**
 * Update in place: apply oldText->newText replacements (like pi's edit tool).
 * Useful for targeted edits without rewriting a whole page.
 */
export async function updateMemory(
	scope: MemoryScope,
	page: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<UpdateResult> {
	await ensureScope(scope, cwd);
	const root = memoryRoot(scope, cwd);
	const path = resolvePagePath(root, page);
	if (!path) {
		return { scope, page, updated: false, conflicts: [] };
	}
	if (!(await pathExists(path))) {
		return { scope, page, updated: false, conflicts: [] };
	}
	const original = await readText(path);
	if (!original.includes(oldText)) {
		return { scope, page, updated: false, conflicts: [] };
	}
	const next = original.replace(oldText, newText);
	const conflicts = await detectConflicts(root, page, next);
	await atomicWrite(path, next);
	await rebuildIndex(root, scope);
	await appendLog(root, { scope, action: "update", page });
	return { scope, page, updated: true, conflicts };
}

export async function listMemory(
	scope: MemoryScope,
	cwd: string,
): Promise<ListResult> {
	await ensureScope(scope, cwd);
	const root = memoryRoot(scope, cwd);
	const abs = await listPages(root);
	const pages: MemoryPage[] = [];
	for (const p of abs) {
		const id = pageId(root, p);
		let summary = "(no summary)";
		try {
			const content = await readText(p);
			summary = extractFirstLine(content);
		} catch {
			// leave default
		}
		pages.push({ scope, page: id, summary, exists: true });
	}
	return { scope, pages };
}

function extractFirstLine(content: string): string {
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (line === "---") continue;
		const s = line.replace(/^#+\s*/, "").replace(/^\s*[-*]\s+/, "");
		if (s) return s.length > 100 ? s.slice(0, 97) + "…" : s;
	}
	return "(no summary)";
}

export async function deleteMemory(
	scope: MemoryScope,
	page: string,
	cwd: string,
): Promise<DeleteResult> {
	await ensureScope(scope, cwd);
	const root = memoryRoot(scope, cwd);
	const path = resolvePagePath(root, page);
	if (!path || !(await pathExists(path))) {
		return { scope, page, deleted: false };
	}
	await removeFile(path);
	await rebuildIndex(root, scope);
	await appendLog(root, { scope, action: "delete", page });
	return { scope, page, deleted: true };
}
