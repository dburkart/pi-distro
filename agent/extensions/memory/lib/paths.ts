/**
 * Paths, scopes, and low-level filesystem helpers for the memory store.
 *
 * All memory lives as markdown under one of two roots:
 *
 *   project  -> <cwd>/.pi/memory/
 *   global   -> ~/.pi/memory/
 *
 * The project scope is intended to be committed alongside the repo (shared,
 * reviewable memory — treating memory writes like code writes, since memory
 * is a leak/trust surface per the survey's "trustworthy memory" section).
 * The global scope is user-wide and never committed.
 */

import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute, dirname, basename } from "node:path";
import {
	mkdir,
	readdir,
	readFile,
	writeFile,
	stat,
	rename,
	rm,
	access,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

export type MemoryScope = "project" | "global";

export const MEMORY_DIR_NAME = "memory";

/** Reserved filenames that are not ordinary memory pages. */
export const RESERVED_FILES = new Set(["MEMORY.md", "index.md", "log.md"]);

export function globalMemoryRoot(): string {
	return join(homedir(), ".pi", MEMORY_DIR_NAME);
}

export function projectMemoryRoot(cwd: string): string {
	return join(cwd, ".pi", MEMORY_DIR_NAME);
}

export function memoryRoot(scope: MemoryScope, cwd: string): string {
	return scope === "global" ? globalMemoryRoot() : projectMemoryRoot(cwd);
}

/**
 * Resolve a page name to an absolute path within a scope, guarding against
 * path traversal. Page names are relative, extension-stripped identifiers
 * like "decisions" or "lessons/debugging". `.md` is appended here.
 *
 * Returns null if the name is empty, absolute, or escapes the root.
 */
export function resolvePagePath(root: string, page: string): string | null {
	if (!page) return null;
	// Strip a leading "@" (models sometimes add it) and surrounding whitespace.
	let name = page.trim().replace(/^@/, "");
	if (!name) return null;
	// Disallow absolute paths and parent traversal in the raw input.
	if (isAbsolute(name) || name.includes("..")) return null;
	// Normalize .md: allow the user/agent to pass "foo.md" or "foo".
	name = name.replace(/\.md$/i, "");
	if (!name) return null;
	const full = join(root, `${name}.md`);
	// Final guard: resolved path must be under root.
	const rel = relative(root, full);
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	return full;
}

/** The page identifier (relative, no extension) for a given absolute path. */
export function pageId(root: string, absPath: string): string {
	const rel = relative(root, absPath).replace(/\.md$/i, "");
	return rel;
}

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function readText(path: string): Promise<string> {
	return readFile(path, "utf8");
}

export async function writeText(path: string, content: string): Promise<void> {
	await ensureDir(dirname(path));
	await writeFile(path, content, "utf8");
}

export async function appendText(path: string, content: string): Promise<void> {
	await ensureDir(dirname(path));
	// O_APPEND via writeFile flag.
	await writeFile(path, content, { flag: "a", encoding: "utf8" });
}

/** Recursively list all .md files under root, excluding reserved files. */
export async function listPages(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			let s;
			try {
				s = await stat(full);
			} catch {
				continue;
			}
			if (s.isDirectory()) {
				await walk(full);
			} else if (s.isFile() && entry.endsWith(".md") && !RESERVED_FILES.has(entry)) {
				out.push(full);
			}
		}
	}
	await walk(root);
	return out.sort();
}

/** Atomic-ish write: write to temp then rename. Avoids partial writes on crash. */
export async function atomicWrite(path: string, content: string): Promise<void> {
	await ensureDir(dirname(path));
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	await writeFile(tmp, content, "utf8");
	await rename(tmp, path);
}

export async function removeFile(path: string): Promise<void> {
	await rm(path, { force: true });
}
