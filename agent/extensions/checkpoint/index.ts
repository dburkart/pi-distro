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
 * loop (`before_agent_start`), keyed by the session leaf at that moment, and
 * on `/fork` / tree-navigation offers to restore the files to the checkpoint
 * for the target entry (resolved via parentId — see `resolveCheckpoint`).
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
 * ## State: in-memory (ephemeral)
 *
 * The `leafId → treeSHA` map is in-memory only. It is NOT persisted via
 * `pi.appendEntry`: that primitive inserts a custom entry as a child of the
 * leaf and advances the leaf, which would interpose a session node between
 * a turn's leaf (`L`) and the next user message (`U`) — breaking the
 * `U.parentId == L` link that restore relies on (see `resolveCheckpoint`).
 * So a `/reload` clears the map (rewind to pre-reload points is unavailable
 * until the next prompt re-captures); forked/resumed sessions re-capture
 * fresh. Persistence via a non-inserting scratch file is a deferred
 * enhancement. This mirrors the `bg` extension's ephemeral precedent.
 *
 * Why capture keys to the leaf, not the user message: pi persists the user
 * message only at `message_end`, which fires AFTER all earlier extension
 * events in the turn — so the leaf at `before_agent_start` is the prior
 * turn's last entry (`L`), not the user message (`U`) being submitted.
 * `/fork` (default position `"before"` on a user message) passes `U.id`;
 * since `U` is appended as a child of `L`, resolving `U -> U.parentId`
 * recovers `L`. `before_agent_start` is the capture point (not
 * `message_start`(assistant), where the leaf would be `U` directly) because
 * only `before_agent_start` is provably awaited before the agent edits
 * files — `_emit` is synchronous and agent events arrive via `subscribe`,
 * so a capture during streaming would race with tool calls.
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
 * to the tree-object primitive (stash can't rewind untracked files), with
 * leaf-keyed capture + parentId-resolved restore.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
 * Resolve the checkpoint SHA for a restore target entry id.
 *
 * Capture keys checkpoints to the session *leaf at `before_agent_start`*
 * (the prior turn's last entry, `L`). But `/fork` (default position
 * `"before"` on a user message `U`) and tree-navigation pass the *target*
 * entry id (`U`), not `L`. Since `U` is appended as a child of `L`, resolving
 * `U -> U.parentId` recovers `L`. Direct lookup handles fork `position: "at"`
 * and tree-nav to an entry that was itself a captured leaf.
 */
export async function resolveCheckpoint(
	ctx: ExtensionContext,
	checkpoints: Map<string, string>,
	targetEntryId: string,
): Promise<string | undefined> {
	let sha = checkpoints.get(targetEntryId);
	if (!sha) {
		const entry = ctx.sessionManager.getEntry(targetEntryId);
		if (entry?.parentId) sha = checkpoints.get(entry.parentId);
	}
	return sha;
}

export default function (pi: ExtensionAPI) {
	if (disabled()) return;

	// entryId → treeSHA. In-memory (ephemeral). See resolveCheckpoint for why
	// capture keys to the leaf at before_agent_start and restore resolves via
	// parentId: pi persists the user message only at `message_end`, AFTER all
	// extension events that fire earlier in the turn, so the leaf at
	// before_agent_start is the prior turn's last entry (L), not the user
	// message (U). /fork passes U.id; U.parentId = L recovers the key. This
	// resolution requires that NO session entry be interposed between L and U
	// (it would shift U.parentId), so checkpoints are NOT persisted via
	// `pi.appendEntry` — that primitive inserts a custom entry as a child of
	// the leaf and advances the leaf, which would break the parentId link.
	// The map is therefore ephemeral: a /reload clears it (rewind to
	// pre-reload points is unavailable until the next prompt re-captures).
	// Forked/resumed sessions re-capture fresh. Persistence via a scratch
	// file (no tree insertion) is a deferred enhancement.
	const checkpoints = new Map<string, string>();

	const capture = async (ctx: ExtensionContext) => {
		if (!(await isGitRepo(ctx.cwd))) return;
		const leafId = ctx.sessionManager.getLeafId();
		if (!leafId) return;
		// Always capture, even when the tree is clean: a clean tree at prompt
		// time still has a rewind target (HEAD), and the agent's subsequent
		// edits are what get rewound. When clean, write-tree returns HEAD's
		// tree SHA (always reachable, never gc'd, dedup'd by git).
		const sha = await captureTreeSHA(ctx.cwd);
		if (!sha) return;
		checkpoints.set(leafId, sha);
	};

	const maybeRestore = async (ctx: ExtensionContext, targetEntryId: string) => {
		if (!(await isGitRepo(ctx.cwd))) return;
		const targetSHA = await resolveCheckpoint(ctx, checkpoints, targetEntryId);
		if (!targetSHA) return;
		if (!(await treeExists(ctx.cwd, targetSHA))) {
			// Captured in-memory this session, so the object should still exist;
			// guard anyway in case of a concurrent gc.
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
		}

		const ok = await restoreTree(ctx.cwd, targetSHA);
		if (ctx.hasUI) {
			ctx.ui.notify(ok ? "Restored file state to checkpoint" : "Restore failed (see git)", ok ? "info" : "error");
		}
	};

	pi.on("before_agent_start", async (_event, ctx) => capture(ctx));
	pi.on("session_before_fork", async (event, ctx) => maybeRestore(ctx, event.entryId));
	pi.on("session_before_tree", async (event, ctx) => maybeRestore(ctx, event.preparation.targetId));
}
