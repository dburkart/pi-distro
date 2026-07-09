/**
 * `checkpoint` extension — git working-tree checkpoint/rewind (harness-eng
 * roadmap H4a, cheap form).
 *
 * Pure-passive: no tool, no command. The model never invokes it.
 *
 * pi's `/fork` and tree-navigation rewind the *conversation* but not the
 * *files* — so jumping back to an earlier exchange leaves a working tree
 * that no longer matches the session point. This extension closes that gap:
 * it snapshots the working tree into a git tree object before each agent
 * loop (`before_agent_start`), keyed by the user-message entry, and on
 * `/fork` / tree-navigation offers to restore the files to the checkpoint
 * for the target entry.
 *
 * ## Primitive: tree objects (not stash, not patches)
 *
 * The roadmap/example's `git stash` is broken for this: `git stash create`
 * does NOT capture untracked files, and `git stash apply` aborts on a dirty
 * tree (verified). Since the agent's primary mutation is *creating* files,
 * stash can't rewind them. Instead:
 *
 *   - Capture: a temp `GIT_INDEX_FILE` → `git add -A` (stages tracked mods +
 *     untracked additions + deletions, respects .gitignore) → `git write-tree`
 *     → a dangling tree SHA. The real index is untouched.
 *   - Restore: `git read-tree -u --reset <sha>` overwrites index + working
 *     tree to the snapshot (handles tracked + untracked + deletions in one
 *     op). It leaves post-snapshot untracked "intruder" files alone — the
 *     safe default: it won't delete a file the user genuinely created after
 *     the checkpoint; agent-rolled-back files are removed because they are
 *     deletions recorded in the snapshot.
 *
 * Cost: one gc-able dangling tree object per checkpoint. Doesn't appear in
 * `git log`/`git status`/any branch; `git gc` reclaims it.
 *
 * ## State: session-persistent via custom entries
 *
 * The `entryId → treeSHA` map is persisted with `pi.appendEntry` (custom
 * session entries, not sent to the LLM — the purpose-built persistence
 * primitive). On `session_start` / `session_tree` the map is reconstructed
 * by scanning the branch's custom entries and validated (`git cat-file -e`,
 * so a gc'd object is dropped cleanly). This survives `/reload` and
 * `/resume` and forks correctly with the session tree (custom entries are
 * children of the leaf, so a fork inherits the checkpoints on its branch).
 * Compaction may prune them — the same caveat `todos` ships with.
 *
 * ## Restore behavior
 *
 * On fork / navigate, if the current working-tree SHA differs from the
 * target checkpoint, the user is prompted (`ctx.ui.select`); navigation is
 * often read-only, so silent auto-restore would be too magic for a thing
 * that rewrites files. Non-interactive mode skips restore. Before any
 * restore, the *current* state is snapshotted too (a rescue checkpoint keyed
 * to the current leaf) so nothing is silently lost — including manual edits
 * that drifted the tree off the last checkpoint.
 *
 * Configuration (env, for portability — matches bg/verify/memory):
 *   PI_CHECKPOINT_DISABLED   set to 1/true to disable the extension.
 *
 * Based on pi's `examples/extensions/git-checkpoint.ts`, reworked from stash
 * to the tree-object primitive (stash can't rewind untracked files) and made
 * session-persistent.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "pi-checkpoint";

interface CheckpointData {
	entryId: string;
	treeSHA: string;
	ts: number;
}

function disabled(): boolean {
	return /^(1|true)$/i.test(process.env.PI_CHECKPOINT_DISABLED ?? "");
}

/**
 * Run `git` in `cwd` with an optional extra environment, returning stdout /
 * stderr / exit code. Uses `child_process.spawn` (not `pi.exec`) because the
 * capture path needs a per-call `GIT_INDEX_FILE` env, which `pi.exec`'s
 * `ExecOptions` does not expose. Runs under the same sandbox profile as the
 * rest of pi (it's the same process).
 */
export function runGit(
	cwd: string,
	args: string[],
	envExtra: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const child = spawn("git", args, {
			cwd,
			env: { ...process.env, ...envExtra },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", () => resolve({ stdout, stderr: stderr || "spawn error", code: -1 }));
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
	});
}

/** True if `cwd` is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
	const { code } = await runGit(cwd, ["rev-parse", "--git-dir"]);
	return code === 0;
}

/** True if the working tree has no changes (no modified/staged/untracked files). */
export async function worktreeClean(cwd: string): Promise<boolean> {
	const { stdout, code } = await runGit(cwd, ["status", "--porcelain"]);
	return code === 0 && stdout.trim().length === 0;
}

/**
 * Capture the full working-tree state (tracked mods + untracked additions +
 * deletions, respecting .gitignore) as a dangling tree SHA. The real index
 * is untouched (a temp index file is used and removed). Returns null if the
 * capture failed (e.g. git unavailable).
 */
export async function captureTreeSHA(cwd: string): Promise<string | null> {
	const idxDir = mkdtempSync(join(tmpdir(), "pi-cp-idx-"));
	const idxFile = join(idxDir, "index");
	try {
		let r = await runGit(cwd, ["add", "-A"], { GIT_INDEX_FILE: idxFile });
		if (r.code !== 0) return null;
		r = await runGit(cwd, ["write-tree"], { GIT_INDEX_FILE: idxFile });
		if (r.code !== 0) return null;
		const sha = r.stdout.trim();
		return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
	} finally {
		rmSync(idxDir, { recursive: true, force: true });
	}
}

/** True if `sha` resolves to a tree object in the repo (false if gc'd). */
export async function treeExists(cwd: string, sha: string): Promise<boolean> {
	const { code } = await runGit(cwd, ["cat-file", "-e", `${sha}^{tree}`]);
	return code === 0;
}

/** Overwrite index + working tree to match `sha` (tracked + untracked + deletions). */
export async function restoreTree(cwd: string, sha: string): Promise<boolean> {
	const { code } = await runGit(cwd, ["read-tree", "-u", "--reset", sha]);
	return code === 0;
}

/**
 * Reconstruct the in-memory checkpoint map from the session branch's custom
 * entries. Drops entries whose tree object has been gc'd.
 */
export async function reconstructMap(
	ctx: ExtensionContext,
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== CUSTOM_TYPE) continue;
		const data = entry.data as CheckpointData | undefined;
		if (!data?.entryId || !data?.treeSHA) continue;
		if (await treeExists(ctx.cwd, data.treeSHA)) {
			map.set(data.entryId, data.treeSHA);
		}
	}
	return map;
}

export default function (pi: ExtensionAPI) {
	if (disabled()) return;

	// entryId → treeSHA. Reconstructed on session start / tree navigation.
	let checkpoints: Map<string, string> = new Map();

	const reconstruct = async (ctx: ExtensionContext) => {
		if (!(await isGitRepo(ctx.cwd))) {
			checkpoints = new Map();
			return;
		}
		checkpoints = await reconstructMap(ctx);
	};

	const capture = async (ctx: ExtensionContext) => {
		if (!(await isGitRepo(ctx.cwd))) return;
		const leafId = ctx.sessionManager.getLeafId();
		if (!leafId) return;
		// Nothing to rewind to if the tree is clean.
		if (await worktreeClean(ctx.cwd)) return;
		const sha = await captureTreeSHA(ctx.cwd);
		if (!sha) return;
		checkpoints.set(leafId, sha);
		pi.appendEntry<CheckpointData>(CUSTOM_TYPE, { entryId: leafId, treeSHA: sha, ts: Date.now() });
	};

	const maybeRestore = async (ctx: ExtensionContext, targetEntryId: string) => {
		if (!(await isGitRepo(ctx.cwd))) return;
		const targetSHA = checkpoints.get(targetEntryId);
		if (!targetSHA) return;
		if (!(await treeExists(ctx.cwd, targetSHA))) {
			checkpoints.delete(targetEntryId);
			if (ctx.hasUI) {
				ctx.ui.notify("Checkpoint for this point is no longer available (garbage-collected)", "warning");
			}
			return;
		}
		const currentSHA = await captureTreeSHA(ctx.cwd);
		if (!currentSHA) return;
		if (currentSHA === targetSHA) return; // no mismatch — nothing to restore
		if (!ctx.hasUI) return; // non-interactive: skip restore (can't prompt)

		const choice = await ctx.ui.select("Restore file state to this session point?", [
			"Yes — restore files to the checkpoint",
			"No — keep current files",
		]);
		if (!choice || !choice.startsWith("Yes")) return;

		// Rescue: snapshot the current state (keyed to the current leaf) so
		// nothing is silently lost — including manual edits that drifted the
		// tree off the last checkpoint.
		const leafId = ctx.sessionManager.getLeafId();
		if (leafId && currentSHA) {
			checkpoints.set(leafId, currentSHA);
			pi.appendEntry<CheckpointData>(CUSTOM_TYPE, {
				entryId: leafId,
				treeSHA: currentSHA,
				ts: Date.now(),
			});
		}

		const ok = await restoreTree(ctx.cwd, targetSHA);
		if (ctx.hasUI) {
			ctx.ui.notify(ok ? "Restored file state to checkpoint" : "Restore failed (see git)", ok ? "info" : "error");
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
	pi.on("before_agent_start", async (_event, ctx) => capture(ctx));
	pi.on("session_before_fork", async (event, ctx) => maybeRestore(ctx, event.entryId));
	pi.on("session_before_tree", async (event, ctx) => maybeRestore(ctx, event.preparation.targetId));
}
