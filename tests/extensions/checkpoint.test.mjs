/**
 * Tests for the `checkpoint` extension (roadmap H4a) — loads it under jiti
 * and exercises both the pure git helpers (capture/restore/clean/non-git/
 * empty-repo) and the factory wiring (hook registration, capture→appendEntry,
 * reconstruct-from-custom-entries, restore-on-mismatch with rescue, and the
 * non-interactive / no-mismatch / missing-SHA guards).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExt } from "../load.mjs";

const mod = await loadExt("agent/extensions/checkpoint/index.ts");
const {
	default: factory,
	isGitRepo,
	worktreeClean,
	captureTreeSHA,
	treeExists,
	restoreTree,
	reconstructMap,
} = mod;

function gitRepo(setup) {
	const d = mkdtempSync(join(tmpdir(), "pi-cp-test-"));
	const sh = (s) => execSync(s, { cwd: d, encoding: "utf8" });
	sh("git init -q");
	sh("git config user.email a@b.c");
	sh("git config user.name t");
	if (setup) setup(d, sh);
	return { d, sh, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

function makeStub() {
	const events = {};
	const appended = [];
	const pi = {
		on: (ev, fn) => void (events[ev] = fn),
		appendEntry: (type, data) => void appended.push({ type, data }),
	};
	return { pi, events, appended };
}

function makeCtx(cwd, { hasUI = true, branch = [], leafId = "leaf1", select = async () => undefined } = {}) {
	const notified = [];
	const ctx = {
		cwd,
		hasUI,
		ui: { select, notify: (m, t) => void notified.push({ m, t }) },
		sessionManager: { getLeafId: () => leafId, getBranch: () => branch },
	};
	return { ctx, notified };
}

// ── Pure helpers ───────────────────────────────────────────────────────────

test("isGitRepo: true in a repo, false outside", async () => {
	const { d, cleanup } = gitRepo();
	const ng = mkdtempSync(join(tmpdir(), "pi-cp-ng-"));
	try {
		assert.equal(await isGitRepo(d), true);
		assert.equal(await isGitRepo(ng), false);
	} finally {
		cleanup();
		rmSync(ng, { recursive: true, force: true });
	}
});

test("worktreeClean: true after commit, false when dirty", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf x > a.txt && git add -A && git commit -qm i"));
	try {
		assert.equal(await worktreeClean(d), true);
		sh("printf y > a.txt");
		assert.equal(await worktreeClean(d), false);
	} finally {
		cleanup();
	}
});

test("captureTreeSHA: captures tracked mod + untracked + deletion", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => {
		s("printf v1 > tracked.txt");
		s("mkdir -p sub && printf keep > sub/keep.txt");
		s("git add -A && git commit -qm init");
		// checkpoint state: modify tracked, add untracked, delete a file
		s("printf v2 > tracked.txt");
		s("printf NEW > newfile.txt");
		s("git rm -q sub/keep.txt");
	});
	try {
		const sha = await captureTreeSHA(d);
		assert.match(sha, /^[0-9a-f]{40}$/i);
		// tree contains the modified tracked + the new untracked file; the
		// deleted file is absent (its deletion is part of the snapshot).
		const tree = sh(`git ls-tree -r ${sha}`);
		assert.match(tree, /tracked\.txt/);
		assert.match(tree, /newfile\.txt/);
		assert.doesNotMatch(tree, /sub\/keep\.txt/);
		assert.equal(await treeExists(d, sha), true);
	} finally {
		cleanup();
	}
});

test("captureTreeSHA: works in an empty repo (no commits)", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf only > u.txt"));
	try {
		const sha = await captureTreeSHA(d);
		assert.match(sha, /^[0-9a-f]{40}$/i);
		assert.match(sh(`git ls-tree -r ${sha}`), /u\.txt/);
	} finally {
		cleanup();
	}
});

test("captureTreeSHA: returns null outside a git repo", async () => {
	const ng = mkdtempSync(join(tmpdir(), "pi-cp-ng2-"));
	try {
		assert.equal(await captureTreeSHA(ng), null);
	} finally {
		rmSync(ng, { recursive: true, force: true });
	}
});

test("restoreTree: restores tracked+untracked+deletions; leaves intruders", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => {
		s("printf v1 > tracked.txt");
		s("mkdir -p sub && printf keep > sub/keep.txt");
		s("git add -A && git commit -qm init");
		s("printf v2 > tracked.txt");
		s("printf NEW > newfile.txt");
		s("git rm -q sub/keep.txt");
	});
	try {
		const sha = await captureTreeSHA(d);
		// diverge: change tracked, drop newfile, add an intruder
		sh("printf diverged > tracked.txt");
		sh("rm -f newfile.txt");
		sh("printf junk > intruder.txt");
		assert.equal(await restoreTree(d, sha), true);
		assert.equal(sh("cat tracked.txt").trim(), "v2", "tracked restored to snapshot");
		assert.ok(existsSync(join(d, "newfile.txt")), "untracked newfile restored");
		assert.ok(existsSync(join(d, "intruder.txt")), "post-snapshot intruder left (safe default)");
		// sub/keep.txt stays deleted (it's a deletion in the snapshot)
		assert.ok(!existsSync(join(d, "sub", "keep.txt")), "deleted file stays deleted");
	} finally {
		cleanup();
	}
});

// ── Factory wiring ─────────────────────────────────────────────────────────

test("factory registers the 5 hooks", () => {
	const { pi, events } = makeStub();
	factory(pi);
	assert.deepEqual(Object.keys(events).sort(), [
		"before_agent_start",
		"session_before_fork",
		"session_before_tree",
		"session_start",
		"session_tree",
	]);
});

test("factory is a no-op when PI_CHECKPOINT_DISABLED", () => {
	const prev = process.env.PI_CHECKPOINT_DISABLED;
	process.env.PI_CHECKPOINT_DISABLED = "1";
	try {
		const { pi, events } = makeStub();
		factory(pi);
		assert.equal(Object.keys(events).length, 0, "no hooks registered when disabled");
	} finally {
		if (prev === undefined) delete process.env.PI_CHECKPOINT_DISABLED;
		else process.env.PI_CHECKPOINT_DISABLED = prev;
	}
});

test("before_agent_start: captures dirty tree + appends a pi-checkpoint entry keyed by leaf", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => {
		s("printf v1 > a.txt && git add -A && git commit -qm i");
		s("printf v2 > a.txt"); // dirty
	});
	const { pi, appended, events } = makeStub();
	try {
		factory(pi);
		const { ctx } = makeCtx(d);
		await events.before_agent_start({}, ctx);
		assert.equal(appended.length, 1, "one checkpoint appended");
		assert.equal(appended[0].type, "pi-checkpoint");
		assert.equal(appended[0].data.entryId, "leaf1");
		assert.match(appended[0].data.treeSHA, /^[0-9a-f]{40}$/i);
		assert.equal(await treeExists(d, appended[0].data.treeSHA), true);
	} finally {
		cleanup();
	}
});

test("before_agent_start: captures even when the worktree is clean (rewind-to-HEAD)", async () => {
	// Clean at prompt time still has a rewind target (HEAD); the agent's
	// subsequent edits are what get rewound. So we always capture.
	const { d, cleanup } = gitRepo((_, s) => s("printf x > a.txt && git add -A && git commit -qm i"));
	const { pi, appended, events } = makeStub();
	try {
		factory(pi);
		const { ctx } = makeCtx(d);
		await events.before_agent_start({}, ctx);
		assert.equal(appended.length, 1, "clean tree still captures (rewind-to-HEAD)");
		assert.match(appended[0].data.treeSHA, /^[0-9a-f]{40}$/i);
		assert.equal(await treeExists(d, appended[0].data.treeSHA), true);
	} finally {
		cleanup();
	}
});

test("before_agent_start: no-ops outside a git repo", async () => {
	const ng = mkdtempSync(join(tmpdir(), "pi-cp-ng3-"));
	const { pi, appended, events } = makeStub();
	try {
		factory(pi);
		const { ctx } = makeCtx(ng);
		await events.before_agent_start({}, ctx);
		assert.equal(appended.length, 0);
	} finally {
		rmSync(ng, { recursive: true, force: true });
	}
});

// ── Reconstruct + restore ──────────────────────────────────────────────────

test("reconstructMap: rebuilds entryId→sha from custom entries, drops gc'd", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf v1 > a.txt && git add -A && git commit -qm i"));
	try {
		const sha = await captureTreeSHA(d);
		// simulate a session branch carrying one valid + one gc'd checkpoint
		const branch = [
			{ type: "custom", customType: "pi-checkpoint", data: { entryId: "e-valid", treeSHA: sha, ts: 1 } },
			{ type: "custom", customType: "pi-checkpoint", data: { entryId: "e-gone", treeSHA: "0".repeat(40), ts: 2 } },
			{ type: "custom", customType: "other-ext", data: {} },
		];
		const { ctx } = makeCtx(d, { branch });
		const map = await reconstructMap(ctx);
		assert.equal(map.size, 1, "gc'd + other-ext dropped");
		assert.equal(map.get("e-valid"), sha);
	} finally {
		cleanup();
	}
});

test("maybeRestore: mismatch → prompts, rescues current, restores target", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf base > a.txt && git add -A && git commit -qm i"));
	const selectCalls = [];
	try {
		// snapshot a checkpoint state, then diverge
		sh("printf cp-state > a.txt && printf new > b.txt");
		const targetSHA = await captureTreeSHA(d);
		sh("printf diverged > a.txt && rm -f b.txt"); // now differs from target
		// seed the map via reconstruct (branch carries the checkpoint)
		const branch = [
			{ type: "custom", customType: "pi-checkpoint", data: { entryId: "target", treeSHA: targetSHA, ts: 1 } },
		];
		const { pi, appended, events } = makeStub();
		factory(pi);
		const { ctx } = makeCtx(d, {
			branch,
			leafId: "current-leaf",
			select: async (title, _opts) => (selectCalls.push(title), "Yes — restore files to the checkpoint"),
		});
		await events.session_start({}, ctx); // reconstruct
		await events.session_before_fork({ entryId: "target" }, ctx);

		assert.equal(selectCalls.length, 1, "prompted once on mismatch");
		assert.equal(sh("cat a.txt").trim(), "cp-state", "restored to checkpoint a.txt");
		assert.ok(existsSync(join(d, "b.txt")), "restored untracked b.txt");
		// rescue: current state snapshotted + appended under the current leaf
		const rescue = appended.find((a) => a.data.entryId === "current-leaf");
		assert.ok(rescue, "rescue checkpoint appended for current leaf");
		assert.equal(await treeExists(d, rescue.data.treeSHA), true);
	} finally {
		cleanup();
	}
});

test("maybeRestore: no mismatch → no prompt, no restore, no rescue", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf same > a.txt && git add -A && git commit -qm i"));
	const selectCalls = [];
	try {
		// tree state == target state (capture then leave unchanged)
		const targetSHA = await captureTreeSHA(d); // captures current state
		const branch = [
			{ type: "custom", customType: "pi-checkpoint", data: { entryId: "target", treeSHA: targetSHA, ts: 1 } },
		];
		const { pi, appended, events } = makeStub();
		factory(pi);
		const { ctx } = makeCtx(d, { branch, select: async () => (selectCalls.push("x"), "Yes") });
		await events.session_start({}, ctx);
		await events.session_before_tree({ preparation: { targetId: "target" } }, ctx);
		assert.equal(selectCalls.length, 0, "no prompt when current == target");
		assert.equal(appended.length, 0, "no rescue appended");
	} finally {
		cleanup();
	}
});

test("maybeRestore: non-interactive (hasUI=false) skips restore silently", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf base > a.txt && git add -A && git commit -qm i"));
	try {
		sh("printf cp-state > a.txt");
		const targetSHA = await captureTreeSHA(d);
		sh("printf diverged > a.txt");
		const branch = [
			{ type: "custom", customType: "pi-checkpoint", data: { entryId: "target", treeSHA: targetSHA, ts: 1 } },
		];
		const { pi, events } = makeStub();
		factory(pi);
		const { ctx, notified } = makeCtx(d, { branch, hasUI: false });
		await events.session_start({}, ctx);
		await events.session_before_fork({ entryId: "target" }, ctx);
		assert.equal(sh("cat a.txt").trim(), "diverged", "tree untouched in non-interactive mode");
		assert.equal(notified.length, 0, "no notification in non-interactive mode");
	} finally {
		cleanup();
	}
});

test("maybeRestore: missing target SHA → notify + drop, no restore", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf base > a.txt && git add -A && git commit -qm i"));
	try {
		const branch = [
			{ type: "custom", customType: "pi-checkpoint", data: { entryId: "target", treeSHA: "0".repeat(40), ts: 1 } },
		];
		const { pi, events } = makeStub();
		factory(pi);
		const { ctx, notified } = makeCtx(d, { branch, select: async () => "Yes" });
		await events.session_start({}, ctx); // reconstruct drops the gc'd entry
		await events.session_before_fork({ entryId: "target" }, ctx);
		// target was dropped by reconstruct → maybeRestore finds nothing → no-op
		assert.equal(sh("cat a.txt").trim(), "base", "tree untouched");
		assert.equal(notified.length, 0, "no notification (silently dropped during reconstruct)");
	} finally {
		cleanup();
	}
});

test("maybeRestore: 'No' choice keeps current files, records a rescue only", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf base > a.txt && git add -A && git commit -qm i"));
	try {
		sh("printf cp-state > a.txt && printf new > b.txt");
		const targetSHA = await captureTreeSHA(d);
		sh("printf diverged > a.txt && rm -f b.txt");
		const branch = [
			{ type: "custom", customType: "pi-checkpoint", data: { entryId: "target", treeSHA: targetSHA, ts: 1 } },
		];
		const { pi, appended, events } = makeStub();
		factory(pi);
		const { ctx } = makeCtx(d, { branch, leafId: "cur", select: async () => "No — keep current files" });
		await events.session_start({}, ctx);
		await events.session_before_fork({ entryId: "target" }, ctx);
		assert.equal(sh("cat a.txt").trim(), "diverged", "user said No → tree kept");
		assert.ok(!existsSync(join(d, "b.txt")), "b.txt not restored");
		assert.equal(appended.length, 0, "No choice → no rescue (nothing changed, nothing to rescue)");
	} finally {
		cleanup();
	}
});
