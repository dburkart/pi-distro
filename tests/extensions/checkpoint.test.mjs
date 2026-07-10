/**
 * Tests for the `checkpoint` extension (roadmap H4a) — loads it under jiti
 * and exercises both the pure git helpers (capture/restore/clean/non-git/
 * empty-repo) and the factory wiring (capture at before_agent_start keyed to
 * the leaf; restore on fork/tree-navigation resolving the target via
 * parentId; mismatch prompt + rescue; the non-interactive / no-mismatch /
 * no-checkpoint guards).
 *
 * The factory tests use a stub sessionManager with a real-ish entry tree
 * (entries with parentId) to model pi's turn flow: before_agent_start fires
 * while the leaf is the prior turn's last entry L (the user message U is
 * appended only at message_end, later). So capture keys to L, and restore
 * for a fork on U resolves U -> U.parentId == L.
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
	resolveCheckpoint,
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

/** A minimal stub sessionManager holding an entry tree (id -> {id,parentId}). */
function makeSessionTree() {
	const entries = new Map();
	let leafId = undefined;
	return {
		entries,
		leafId,
		setLeaf(id) {
			leafId = id;
		},
		getLeafId: () => leafId,
		getEntry: (id) => entries.get(id),
		addEntry(id, parentId) {
			entries.set(id, { id, parentId, type: "message" });
			leafId = id;
		},
	};
}

function makeStub() {
	const events = {};
	const pi = {
		on: (ev, fn) => void (events[ev] = fn),
	};
	return { pi, events };
}

function makeCtx(cwd, sm, { hasUI = true, select = async () => undefined } = {}) {
	const notified = [];
	const ctx = {
		cwd,
		hasUI,
		ui: { select, notify: (m, t) => void notified.push({ m, t }) },
		sessionManager: sm,
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
		s("printf v2 > tracked.txt");
		s("printf NEW > newfile.txt");
		s("git rm -q sub/keep.txt");
	});
	try {
		const sha = await captureTreeSHA(d);
		assert.match(sha, /^[0-9a-f]{40}$/i);
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
		sh("printf diverged > tracked.txt");
		sh("rm -f newfile.txt");
		sh("printf junk > intruder.txt");
		assert.equal(await restoreTree(d, sha), true);
		assert.equal(sh("cat tracked.txt").trim(), "v2", "tracked restored to snapshot");
		assert.ok(existsSync(join(d, "newfile.txt")), "untracked newfile restored");
		assert.ok(existsSync(join(d, "intruder.txt")), "post-snapshot intruder left (safe default)");
		assert.ok(!existsSync(join(d, "sub", "keep.txt")), "deleted file stays deleted");
	} finally {
		cleanup();
	}
});

// ── resolveCheckpoint (pure, on a Map + stub ctx) ───────────────────────────

test("resolveCheckpoint: direct hit when target was a captured leaf", async () => {
	const { d, cleanup } = gitRepo();
	try {
		const sm = makeSessionTree();
		sm.addEntry("L", null);
		const { ctx } = makeCtx(d, sm);
		const map = new Map([["L", "deadbeef"]]);
		assert.equal(await resolveCheckpoint(ctx, map, "L"), "deadbeef");
	} finally {
		cleanup();
	}
});

test("resolveCheckpoint: resolves via parentId for a user-message fork target", async () => {
	const { d, cleanup } = gitRepo();
	try {
		const sm = makeSessionTree();
		sm.addEntry("L", null); // prior leaf at before_agent_start
		sm.addEntry("U", "L"); // user message, child of L
		const { ctx } = makeCtx(d, sm);
		const map = new Map([["L", "cafebabe"]]);
		assert.equal(await resolveCheckpoint(ctx, map, "U"), "cafebabe");
	} finally {
		cleanup();
	}
});

test("resolveCheckpoint: returns undefined when no checkpoint reachable", async () => {
	const { d, cleanup } = gitRepo();
	try {
		const sm = makeSessionTree();
		sm.addEntry("X", null);
		const { ctx } = makeCtx(d, sm);
		assert.equal(await resolveCheckpoint(ctx, new Map(), "X"), undefined);
	} finally {
		cleanup();
	}
});

// ── Factory wiring ───────────────────────────────────────────────────────────

test("factory registers 3 hooks (capture + 2 restore triggers)", () => {
	const { pi, events } = makeStub();
	factory(pi);
	assert.deepEqual(Object.keys(events).sort(), [
		"before_agent_start",
		"session_before_fork",
		"session_before_tree",
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

test("before_agent_start: captures (even when clean) keyed to the leaf; restore via parentId works", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf v1 > a.txt && git add -A && git commit -qm i"));
	try {
		const { pi, events } = makeStub();
		factory(pi);
		const sm = makeSessionTree();
		sm.addEntry("L", null); // leaf at before_agent_start (prior turn)
		const { ctx } = makeCtx(d, sm, { select: async () => "Yes — restore files to the checkpoint" });
		await events.before_agent_start({}, ctx);
		// now pi would append the user message U (child of L)
		sm.addEntry("U", "L");
		// agent edits during the turn
		sh("printf diverged > a.txt && printf new > b.txt");
		// fork "before" on U → resolve U.parentId=L → restore to capture state
		await events.session_before_fork({ entryId: "U" }, ctx);
		assert.equal(sh("cat a.txt").trim(), "v1", "tracked restored to checkpoint (HEAD)");
		// b.txt is untracked vs the clean-tree checkpoint; read-tree --reset leaves
		// untracked intruders (the documented safe default), so it persists.
		assert.ok(existsSync(join(d, "b.txt")), "agent-created untracked left (intruder-safe default)");
	} finally {
		cleanup();
	}
});

test("before_agent_start: no-ops outside a git repo", async () => {
	const ng = mkdtempSync(join(tmpdir(), "pi-cp-ng3-"));
	const { pi, events } = makeStub();
	try {
		factory(pi);
		const sm = makeSessionTree();
		sm.addEntry("L", null);
		const { ctx } = makeCtx(ng, sm);
		await events.before_agent_start({}, ctx);
		// nothing captured — restore is a no-op
		sm.addEntry("U", "L");
		await events.session_before_fork({ entryId: "U" }, ctx);
	} finally {
		rmSync(ng, { recursive: true, force: true });
	}
});

test("maybeRestore: mismatch → prompts, rescues current, restores target", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf base > a.txt && git add -A && git commit -qm i"));
	const selectCalls = [];
	try {
		// checkpoint state (dirty), then diverge
		sh("printf cp-state > a.txt && printf new > b.txt");
		const cpSHA = await captureTreeSHA(d);
		sh("printf diverged > a.txt && rm -f b.txt");
		const { pi, events } = makeStub();
		factory(pi);
		const sm = makeSessionTree();
		// simulate: before_agent_start captured leaf L = cpSHA
		sm.addEntry("L", null);
		const { ctx } = makeCtx(d, sm, {
			select: async (title) => (selectCalls.push(title), "Yes — restore files to the checkpoint"),
		});
		await events.before_agent_start({}, ctx); // captures diverged? no — capture uses current tree
		// NOTE: the capture above captured the DIVERGED state (current tree), not cpSHA.
		// To test restore-to-cpSHA, seed the map directly via a prior capture at the cp-state.
		// Redo: reset tree to cp-state, capture, then diverge.
		sh("printf cp-state > a.txt && printf new > b.txt");
		await events.before_agent_start({}, ctx); // now captures cp-state under leaf L
		sh("printf diverged > a.txt && rm -f b.txt"); // diverge
		// fork on U (child of L)
		sm.addEntry("U", "L");
		await events.session_before_fork({ entryId: "U" }, ctx);
		assert.equal(selectCalls.length, 1, "prompted once on mismatch");
		assert.equal(sh("cat a.txt").trim(), "cp-state", "restored to checkpoint");
		assert.ok(existsSync(join(d, "b.txt")), "restored untracked b.txt");
		// rescue: current (diverged) state captured under the current leaf.
		// Fork to the current leaf → should restore the diverged state.
		await events.session_before_fork({ entryId: "U" }, ctx); // current leaf is still U; rescue stored under U
		assert.equal(sh("cat a.txt").trim(), "diverged", "rescue checkpoint restores pre-restore (diverged) state");
	} finally {
		cleanup();
	}
});

test("maybeRestore: no mismatch → no prompt, no restore", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf same > a.txt && git add -A && git commit -qm i"));
	const selectCalls = [];
	try {
		const { pi, events } = makeStub();
		factory(pi);
		const sm = makeSessionTree();
		sm.addEntry("L", null);
		const { ctx } = makeCtx(d, sm, { select: async () => (selectCalls.push("x"), "Yes") });
		await events.before_agent_start({}, ctx); // captures current (clean == HEAD)
		sm.addEntry("U", "L");
		// tree unchanged since capture → currentSHA == targetSHA → no-op
		await events.session_before_tree({ preparation: { targetId: "U" } }, ctx);
		assert.equal(selectCalls.length, 0, "no prompt when current == target");
	} finally {
		cleanup();
	}
});

test("maybeRestore: non-interactive (hasUI=false) skips restore silently", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf base > a.txt && git add -A && git commit -qm i"));
	try {
		sh("printf cp > a.txt && printf n > b.txt");
		const { pi, events } = makeStub();
		factory(pi);
		const sm = makeSessionTree();
		sm.addEntry("L", null);
		const { ctx, notified } = makeCtx(d, sm, { hasUI: false });
		await events.before_agent_start({}, ctx); // captures cp-state under L
		sh("printf diverged > a.txt && rm -f b.txt");
		sm.addEntry("U", "L");
		await events.session_before_fork({ entryId: "U" }, ctx);
		assert.equal(sh("cat a.txt").trim(), "diverged", "tree untouched in non-interactive mode");
		assert.equal(notified.length, 0, "no notification in non-interactive mode");
	} finally {
		cleanup();
	}
});

test("maybeRestore: no reachable checkpoint for target → no-op, no prompt", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf base > a.txt && git add -A && git commit -qm i"));
	const selectCalls = [];
	try {
		const { pi, events } = makeStub();
		factory(pi);
		const sm = makeSessionTree();
		sm.addEntry("L", null);
		const { ctx } = makeCtx(d, sm, { select: async () => (selectCalls.push("x"), "Yes") });
		await events.before_agent_start({}, ctx); // captures under L
		// fork to an entry whose ancestry has no checkpoint
		sm.addEntry("U", "L");
		sm.addEntry("X", null); // unrelated branch point, no capture
		await events.session_before_fork({ entryId: "X" }, ctx);
		assert.equal(selectCalls.length, 0, "no prompt when no checkpoint reachable");
	} finally {
		cleanup();
	}
});

test("maybeRestore: 'No' choice keeps current files, records a rescue only", async () => {
	const { d, sh, cleanup } = gitRepo((_, s) => s("printf base > a.txt && git add -A && git commit -qm i"));
	try {
		sh("printf cp > a.txt && printf n > b.txt");
		const { pi, events } = makeStub();
		factory(pi);
		const sm = makeSessionTree();
		sm.addEntry("L", null);
		const { ctx } = makeCtx(d, sm, {
			leafId: "L",
			select: async () => "No — keep current files",
		});
		await events.before_agent_start({}, ctx); // captures cp-state under L
		sh("printf diverged > a.txt && rm -f b.txt");
		sm.addEntry("U", "L");
		await events.session_before_fork({ entryId: "U" }, ctx);
		assert.equal(sh("cat a.txt").trim(), "diverged", "user said No → tree kept");
		assert.ok(!existsSync(join(d, "b.txt")), "b.txt not restored");
		// rescue: a fork to the current leaf (U) restores the diverged state
		await events.session_before_fork({ entryId: "U" }, ctx);
		assert.equal(sh("cat a.txt").trim(), "diverged", "rescue under U still restores diverged (no-op here, already diverged)");
	} finally {
		cleanup();
	}
});
