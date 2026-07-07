/**
 * High-level editor invocation built on the secondary buffer.
 *
 * Two entry points:
 *   - {@link openPath}: edit a path in place (used by `/edit`)
 *   - {@link openContent}: seed a temp file with text, edit it, and return
 *     the file path so a caller (e.g. the agent) can read back the result
 *     (used by the `review` tool)
 *
 * Temp files are intentionally left in place after editing — callers like the
 * review tool return the path to the agent, which reads it back. Cleanup is
 * the caller's responsibility.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveEditor } from "./env.ts";
import { runForeground, type RunOptions, type RunResult } from "./buffer.ts";

/** Edit an existing path in place. */
export async function openPath(
	ctx: ExtensionContext,
	path: string,
	opts: RunOptions = {},
): Promise<RunResult> {
	const abs = resolve(ctx.cwd, path);
	const editor = resolveEditor();
	return runForeground(ctx, { ...editor, args: [...editor.args, abs] }, { ...opts, cwd: opts.cwd ?? ctx.cwd });
}

export interface OpenContentResult {
	/** Absolute path to the (temp) file that was edited. */
	path: string;
	/** Underlying foreground run result. */
	result: RunResult;
}

/**
 * Seed a temp file with `content`, open it in the user's editor, and return
 * the file path. The file is kept so the caller can read back the edited
 * text.
 *
 * @param ctx        extension context
 * @param content    text to prefill the editor with
 * @param pathHint   optional filename used only for the temp file extension
 *                   (drives editor syntax highlighting / ftplugins)
 */
export async function openContent(
	ctx: ExtensionContext,
	content: string,
	opts: RunOptions & { pathHint?: string } = {},
): Promise<OpenContentResult> {
	const ext = opts.pathHint ? extname(opts.pathHint) : ".txt";
	const name = `pi-review-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
	const tmp = join(tmpdir(), "pi-terminal", name);

	await mkdir(dirname(tmp), { recursive: true });
	await writeFile(tmp, content, "utf-8");

	const result = await openPath(ctx, tmp, opts);
	return { path: tmp, result };
}
