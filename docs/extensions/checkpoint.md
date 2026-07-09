# Checkpoint Extension

`agent/extensions/checkpoint/` is a **pure-passive** git working-tree
checkpoint/rewind safety net (harness-engineering roadmap **H4a, cheap
form**). No tool, no command — the model never invokes it. Design resolved
via `/grilling`; see `plans/checkpoint-extension` in project memory.

## The gap it closes

pi's `/fork` and tree-navigation rewind the *conversation* but not the
*files* — jumping back to an earlier exchange leaves a working tree that no
longer matches the session point you returned to. This extension snapshots
the working tree into a git tree object before each agent loop and, on
`/fork` / tree-navigation, offers to restore the files to the checkpoint
for the target entry.

## Primitive: tree objects (not stash, not patches)

The roadmap and pi's `examples/extensions/git-checkpoint.ts` use `git stash`.
That is **broken for this use case**, verified during design:

- `git stash create` does **not** capture untracked files (the stash commit
  tree contains only tracked files; no third parent). Since the agent's
  primary mutation is *creating* files, stash can't rewind them.
- `git stash apply` **aborts** on a dirty tree ("Your local changes would be
  overwritten by merge").

Instead this extension uses git tree objects:

- **Capture:** a temp `GIT_INDEX_FILE` → `git add -A` (stages tracked
  modifications + untracked additions + deletions, respects `.gitignore`) →
  `git write-tree` → a dangling tree SHA. The real index is untouched (a
  temp index file is used and removed). Captures the **full** working-tree
  state, including in repos with no commits yet.
- **Restore:** `git read-tree -u --reset <sha>` overwrites index + working
  tree to the snapshot (tracked + untracked + deletions in one op). It
  **leaves post-snapshot untracked "intruder" files alone** — the safe
  default: it will not delete a file the user genuinely created after the
  checkpoint; agent-rolled-back files are removed because they are deletions
  recorded in the snapshot.

Cost: one gc-able dangling tree object per checkpoint. It doesn't appear in
`git log`, `git status`, or any branch; `git gc` reclaims it.

> The **worktree-per-turn** model (each fork point = a real git worktree at
> a real commit) is the elegant long-term architecture and dissolves both
> problems above, but it requires an upstream pi change — mutable cwd
> (`ExtensionContext.cwd` is readonly; no setter) — plus sandbox re-scoping
> and per-turn commits. It is deferred as the upgrade path if/when git
> checkpoints prove insufficient (== the cognition roadmap's #2 tree-rewind
> reservation). The patch-series alternative (rewind via reverse-patch-apply)
> captures untracked but has brittle restore — `git apply` needs matching
> index/worktree preconditions and fails on diverged trees.

## State: session-persistent via custom entries

The `entryId → treeSHA` map is persisted with `pi.appendEntry` (custom
session entries, **not sent to the LLM** — the purpose-built persistence
primitive). On `session_start` / `session_tree` the map is reconstructed by
scanning the branch's custom entries, and each SHA is validated with
`git cat-file -e` so a garbage-collected object is dropped cleanly. This
survives `/reload` and `/resume` and **forks correctly with the session
tree** (custom entries are children of the leaf, so a fork inherits the
checkpoints on its branch). Compaction may prune them — the same caveat the
`todos` extension ships with.

This is more durable than `bg`'s purely-ephemeral model. The justification:
git tree SHAs are stable content addresses, not reuse-prone PIDs, so the
fragility rationale that made `bg` ephemeral does not transfer.

## Behavior

- **Capture** on `before_agent_start` (once per prompt), keyed by the
  user-message leaf entry — the natural "rewind to when I sent this prompt"
  target. Always captures, even when the worktree is clean: a clean tree at
  prompt time still has a rewind target (HEAD), and the agent's subsequent
  edits are what get rewound (when clean, `write-tree` returns HEAD's tree
  SHA, which is always reachable and never gc'd). Skipped only when `cwd`
  is not a git repo.
- **Restore** on `session_before_fork` *and* `session_before_tree` (both
  rewind the conversation; the file-state mismatch is identical). Only when
  the current working-tree SHA **differs** from the target checkpoint
  (no prompt on a no-op navigation). The user is prompted
  (`ctx.ui.select`); navigation is often read-only, so silent auto-restore
  would be too magic for a thing that rewrites files. **Non-interactive mode
  skips restore** (no human to ask).
- **Data safety:** before any restore, the *current* state is snapshotted
  too (a rescue checkpoint keyed to the current leaf, via the same
  `appendEntry` path) so nothing is silently lost — including manual edits
  that drifted the tree off the last checkpoint.

After restore, index = worktree = snapshot (the correct semantic; `git
status` will show the snapshot's diff vs `HEAD` as staged — expected, not a
bug).

## Configuration

- `PI_CHECKPOINT_DISABLED` — set to `1`/`true` to disable the extension
  (no hooks register; matches `PI_BG_DISABLED` / `PI_VERIFY_DISABLED`).

Env-var configuration for portability, matching the `verify` / `bg` /
`memory` extensions.
