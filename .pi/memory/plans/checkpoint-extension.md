# checkpoint-extension — Roadmap H4a: git checkpoint (cheap form)

Status: done
Goal: Ship a pure-passive `checkpoint` extension that snapshots the working
tree per prompt (`before_agent_start`) and restores file state on
`/fork` or tree-navigation — closing the gap that pi's session rewind
rewinds the *conversation* but not the *files*. Design resolved via
`/grilling` (Q1–Q7). `/pr` is deferred to a separate H4b pass.

Steps:
  1. Build `agent/extensions/checkpoint/index.ts` (pure-passive, no tool,
     no command):
     - State: in-memory `Map<entryId, treeSHA>` + rescue entries. Persisted
       via `pi.appendEntry("pi-checkpoint", {entryId, treeSHA, ts})`.
     - Reconstruct on `session_start` + `session_tree`: scan session entries
       for `type:"custom"` of customType `"pi-checkpoint"`, rebuild the map,
       validate each SHA with `git cat-file -e` (drop gc'd).
     - Capture on `before_agent_start`: key = leaf entry id (the user
       message just sent). Non-git repo (`git rev-parse --git-dir` fails) →
       silent no-op. Clean tree (no diff vs HEAD) → skip capture. Otherwise:
       temp `GIT_INDEX_FILE` → `git read-tree HEAD` → `git add -A` (captures
       tracked mods + untracked + deletions; respects .gitignore) →
       `git write-tree` → SHA. Real index untouched. Store SHA +
       `appendEntry`.
     - Restore on `session_before_fork` AND `session_before_tree`: look up
       `checkpoint[event.entryId]`. If absent → no-op. Compute current tree
       SHA (same temp-index write-tree). If == target SHA → no-op (no
       mismatch). If differs AND `ctx.hasUI` → `ctx.ui.select`
       "Restore file state to this session point?" (Yes/No). Non-interactive
       → skip restore. On Yes: rescue first (refresh
       `checkpoint[currentLeafId]` = current SHA + appendEntry, capturing
       any drifted/manual state so nothing is lost), then
       `git read-tree -u --reset <targetSHA>`. If target SHA missing
       (`cat-file -e` fails) → `ctx.ui.notify` "checkpoint unavailable" +
       skip.
     - `PI_CHECKPOINT_DISABLED` env → disable all hooks (matches
       `PI_BG_DISABLED`/`PI_VERIFY_DISABLED`).
  2. Typecheck the extension: synthetic tsconfig against the installed pi
     dist (lessons recipe; npm_config_cache=/tmp).
  3. Smoke-test under jiti (lessons recipe): load extension, confirm hooks
     register without throwing.
  4. Tests: `tests/extensions/checkpoint.test.mjs` via `tests/load.mjs` +
     a temp git repo (created per-test). Cases:
     - capture correctness: given tracked mod + untracked file + deletion,
       `write-tree` SHA's tree contains all three (ls-tree assertions).
     - restore correctness: after dirty divergence, `read-tree -u --reset`
       restores tracked+untracked+deletions; post-snapshot intruder file
       is LEFT (safe default).
     - mismatch detection: equal SHAs → no-op; different → (prompt path
       mocked / the pure git mechanics asserted).
     - reconstruct-from-entries: simulate appendEntry replay → map rebuilt.
     - clean-tree skip: no checkpoint stored when worktree == HEAD.
     - non-git no-op: rev-parse fails → no capture, no throw.
     Runner: `node --test --test-reporter=tap tests/extensions/*.test.mjs`
     (existing distro suite).
  5. Doc: `docs/extensions/checkpoint.md` (why, model: tree-object capture/
     restore, state/persistence, the intruder-file safe-default, the
     compaction caveat, env var). Add line to `docs/README.md` index.
  6. Roadmap: update `docs/roadmap-harness-eng.md` — mark H4 cheap form
     shipped; note `/pr` deferred to H4b.
  7. Run the distro's own suite via the `test` tool to prove nothing broke.

Assumptions:
  - `pi.appendEntry` creates a `type:"custom"` session entry that persists
    across /reload + /resume and forks with the session tree (verified in
    grilling from types.d.ts + agent-session.js:1787). Compaction may prune
    (matches `todos` durability profile).
  - `git read-tree -u --reset <tree>` overwrites index+worktree to the
    snapshot, handles tracked+untracked+deletions, leaves untracked
    intruders (verified in grilling, Model A).
  - Temp `GIT_INDEX_FILE` leaves the real index untouched (verified).
  - macOS sandbox permits the git subprocess + `.git/objects` writes in the
    project cwd (git operations run in-cwd; `bg`/`test` already spawn git
    under the profile).
  - `before_agent_start` fires after the user message is the leaf entry
    (so keying by leaf = the user message). Verify in build; if leaf is not
    yet the user msg at that event, fall back to `turn_start` (Q5's (b)).

Open questions:
  - none (Q1–Q7 resolved; the `before_agent_start` leaf-timing is a
    verify-in-build assumption, not an open decision).

Decisions (mirrored into decisions.md):
  - Split H4: checkpoint now (H4a), `/pr` later (H4b). [Q1]
  - Restore on BOTH fork + tree-navigation. [Q2]
  - Primitive: tree-object (temp-index write-tree capture; read-tree -u
    --reset restore). NOT stash (stash create does NOT capture untracked;
    stash apply aborts on dirty tree — verified). NOT patches (brittle
    apply) / NOT commit-to-ref (most intrusive). [Q3]
  - Restore: prompt-on-mismatch; snapshot-current-first for data safety;
    non-interactive skips. [Q4]
  - Cadence: before_agent_start, keyed by user-message leaf. [Q5]
  - State: persist via appendEntry; reconstruct + validate on load. [Q6]
  - Surface: pure-passive, no tool/command. [Q7]

Log:
  - Grilling resolved Q1–Q7. Two factual corrections during grilling, both
    load-bearing: (1) `git stash create` does NOT capture untracked files
    (verified — the stash commit tree contains only tracked files, no
    third parent), and `git stash apply` ABORTS on a dirty tree. So the
    stash primitive (roadmap/example's choice) is broken for the rewind
    use case — agent-created files wouldn't be rewound. (2) The patch
    model (user's proposal) captures untracked fine but has brittle
    restore (apply needs matching index/worktree preconditions; fails on
    diverged trees even after a reset-to-HEAD preamble). Tree-object model
    (write-tree/read-tree) is the git-native robust alternative — captures
    everything, restores with git's own machinery, leaves a gc-able
    dangling object. The worktree-per-turn idea is the elegant long-term
    architecture but requires an upstream pi change (mutable cwd —
    `ExtensionContext.cwd` is readonly; no setter) + sandbox re-scoping +
    per-turn commits; deferred as the upgrade path if git checkpoints
    prove insufficient (== the roadmap's "tree-rewind" reservation).
  - Shipped: agent/extensions/checkpoint/index.ts (pure-passive, 5 hooks:
    session_start + session_tree for reconstruct, before_agent_start for
    capture, session_before_fork + session_before_tree for restore).
    Tree-object primitive (temp GIT_INDEX_FILE → git add -A → git write-tree
    capture; git read-tree -u --reset restore). Persists via pi.appendEntry
    ("pi-checkpoint", {entryId, treeSHA, ts}); reconstructMap scans the
    branch's type:"custom" entries and validates SHAs (cat-file -e) on load.
    Prompt-on-mismatch restore (ctx.ui.select); snapshot-current-first
    rescue; non-interactive skips. PI_CHECKPOINT_DISABLED env. Clean-tree
    skip; non-git no-op; empty-repo capture works (no HEAD needed — git
    add -A into a fresh index captures the full state).
    docs/extensions/checkpoint.md + README index line + roadmap H4a ✅
    (H4b /pr deferred). tsc clean (synthetic tsconfig); 17/17 checkpoint
    node:test tests pass + full distro suite 45/45 green.
    Auto-discovered by pi (lives at ~/.pi/agent/extensions/checkpoint/index.ts
    = the global extension scan path); loads on /reload.
  - before_agent_start leaf-timing assumption held up trivially: keyed by
    ctx.sessionManager.getLeafId() at before_agent_start (the user message
    is the leaf by then). No fallback to turn_start needed.
  - Capture simplification vs the grilling's Model A: the grilling test used
    `git read-tree HEAD` to seed the temp index before `git add -A`. Verified
    in build that the seed is UNNECESSARY — `git add -A` into a fresh
    (non-existent) GIT_INDEX_FILE creates the index and captures the full
    working-tree state directly. Dropping the seed also makes capture work
    in repos with NO commits (no HEAD). Smaller, more general. Logged as a
    living-contract refinement.
  - LIVING-CONTRACT FIX during live-test setup: the grilling's "skip
    capture when the worktree is clean (nothing to rewind to)" decision was
    WRONG. A clean tree at prompt time still has a rewind target (HEAD), and
    the agent's subsequent edits are what get rewound. Skipping clean trees
    broke rewind for the most common starting condition (first prompt of a
    session, or right after a commit) — verified via a simulation: clean at
    prompt A → no checkpoint captured → fork back to A → restore is a no-op
    → agent's edits NOT rewound. Fix: ALWAYS capture, even when clean. When
    clean, write-tree returns HEAD's tree SHA (always reachable, never gc'd,
    dedup'd by git), so rewind-to-a-clean-prompt correctly reverts the
    agent's edits back to HEAD. Cost is trivial (one dedup'd object + one
    small session entry per prompt; todos stores comparable entries per
    action). Updated the test (clean-tree now asserts capture happens), the
    doc, and this plan. The grilling's reasoning confused "clean tree" with
    "nothing to rewind" — clean means "rewind target is HEAD," not "no
    target."
  - Known limitation surfaced during live-test setup (NOT fixed — deliberate
    tradeoff): read-tree -u --reset reverts tracked-file mods + deletions but
    LEAVES untracked files. So agent-created files from the rewound turn
    persist after restore (the intruder-safe default from grilling). This is
    the safe choice (won't delete user's genuinely-new files) but means a
    full byte-exact rewind requires a manual `git clean -fd`. A targeted
    clean (remove untracked files not in the checkpoint tree, with a second
    prompt) is a possible enhancement but riskier — deferred. Documented in
    the live-test walkthrough.
  - MAJOR LIVING-CONTRACT DIVERGENCE (found in live test, Q6 overturned): the
    `pi.appendEntry` persistence decision was WRONG and broke restore. Two
    intertwined bugs surfaced when the user /forked and got no restore prompt:
    (1) KEYING: at `before_agent_start` the session leaf is the PRIOR turn's
    last entry L (pi persists the user message only at `message_end`, which
    fires AFTER all earlier extension events — verified in agent-session.js:
    line 818 emitBeforeAgentStart runs before line ~309 appendMessage). So
    capture keyed to getLeafId() = L, but `/fork` (default position "before"
    on a user message U) passes entryId = U.id. U was never a capture key →
    lookup returned undefined → no restore → no prompt.
    (2) appendEntry BREAKS THE FIX: the natural fix for (1) is resolve
    U -> U.parentId (== L). But `pi.appendEntry` inserts a custom entry as a
    child of the leaf and ADVANCES THE LEAF, so U.parentId becomes the
    checkpoint entry, not L. The session file confirmed this: checkpoint
    32afafe1 was keyed to entryId 4b91ac74 — the PREVIOUS checkpoint entry,
    not the user message. So appendEntry persistence is incompatible with
    correct parentId resolution.
    FIX: dropped appendEntry entirely; the map is now in-memory (ephemeral),
    matching `bg`'s precedent. Capture stays at before_agent_start (the only
    point provably awaited before the agent edits files — `_emit` is
    synchronous and agent events arrive via `subscribe`, so capturing at
    message_start(assistant) where leaf==U would race with tool calls).
    Restore resolves the fork/navigate target via direct lookup, falling back
    to target.parentId. This means /reload clears the map (rewind to
    pre-reload points unavailable until next prompt re-captures); forked/
    resumed sessions re-capture fresh. Persistence via a non-inserting
    scratch file (no tree node) is a deferred enhancement. Q6's reasoning
    ("git SHAs are stable, not reuse-prone PIDs, so persist") was right about
    the *objects* but missed that the persistence *mechanism* (appendEntry)
    corrupts the keying. Updated extension, tests (18/18), doc, README,
    roadmap. The grilling's "verify before_agent_start leaf-timing in build"
    assumption is the one that bit — it was wrong, and the fallback note
    ("turn_start") would ALSO have been wrong (turn_start has the same
    prior-leaf timing).
