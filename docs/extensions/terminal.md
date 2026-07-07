# Terminal Extension

A shared "secondary buffer" utility and the commands/tools built on it. Lives
at `agent/extensions/terminal/` and is auto-discovered by pi.

The core problem this extension solves: running an interactive program (an
editor, a pager, a TUI) that needs to *take over the terminal* while pi's own
TUI is suspended. There is exactly one correct lifecycle for that, and the
library wraps it so every future feature reuses it instead of reimplementing
the dance (and forgetting the restore-on-exit step).

## Commands & Tools

### `/edit [path]`

Opens a path in the user's `$EDITOR`, suspending pi's TUI while the editor
runs.

- `path` omitted → opens `ctx.cwd` (so `vim .`-style directory browsing works).
- `path` given → resolved relative to `ctx.cwd`, edited in place.
- Notifies the exit status on return. Performs no session mutation.

### `review` tool

A tool the LLM can call when it needs a human to review or edit text.

- Writes `content` to a temp file (extension taken from optional `pathHint`
  for editor syntax highlighting) and opens it in `$EDITOR`.
- Returns the **absolute path** of the edited file (not the text) so the agent
  can `read` it back. This keeps large edited content out of the tool result
  and lets follow-up workflows (e.g. committing reviewed text) reuse the path.
- Streams a "Waiting for review…" progress update; aborts the child editor via
  `ctx.signal` if the agent run is cancelled.

## Editor resolution

`resolveEditor()` matches pi's own `app.editor.external` (Ctrl+G) precedence:

1. `externalEditor` in user `settings.json` (best-effort read via
   `CONFIG_DIR_NAME`; project-local settings intentionally ignored — an editor
   is a personal preference, not a project concern)
2. `$VISUAL`
3. `$EDITOR`
4. `notepad` on Windows, `nano` elsewhere

## Library layout (reusable)

```
terminal/
├── index.ts              # composer: registers /edit + review
├── lib/
│   ├── buffer.ts         # runForeground() — the suspend/spawn/restore lifecycle
│   ├── tty.ts            # alt-screen, clearScreen, spawnWithTty()
│   ├── env.ts            # resolveEditor() — editor precedence + arg parsing
│   └── editor.ts         # openPath() / openContent() built on the above
└── features/
    ├── edit-command.ts   # /edit [path]
    └── review-tool.ts    # agent-callable review tool
```

The `lib/` split is deliberate: future terminal features drop a file in
`features/`, import `runForeground` (or `openPath`/`openContent`), and add one
line to `index.ts`. If this is ever published as a pi package, `lib/` can be
exported for *other* extensions to import.

### `runForeground(ctx, target, opts)`

The shared primitive. Wraps:

```
ctx.ui.custom(...) → tui.stop() → clearScreen → spawn(stdio: "inherit")
                  → finally { tui.start(); tui.requestRender(true) } → done(result)
```

`tui.start()` runs in a `finally`, so pi's TUI is never left suspended — even
on throw or abort. Callers never touch `ctx.ui.custom` directly; they get a
plain `RunResult` back. No-op (error result) outside TUI mode, so callers skip
their own `ctx.mode` guard.

## Design decisions

- **One primitive, not two.** An earlier draft proposed a `show()` helper for
  in-process full-screen components too. Only the editor actually needs a
  foreground buffer, so the speculative second entrypoint was dropped. Adding
  it later is a one-function addition to `buffer.ts`.
- **Whole-home sandbox writes, not two subpaths.** Editor children scatter
  writes across `~/.local/state`, `~/.local/share`, `~/.cache`, and sometimes
  `~/.config`. Narrowing to a couple of subpaths just produces the next
  denial (nvim alone hit swap, ShaDa, undo, and multiple plugin logs). The
  sandbox profile therefore allows `HOME_DIR` wholesale; see
  [Sandbox](#sandbox) below.
- **Review returns a path, not text.** Keeps potentially large edited content
  out of context and lets commit-style workflows reuse the file. Temp files
  are left in place under `os.tmpdir()/pi-terminal/` for that reason.
- **No `terminate: true` on `review`.** The agent should read the edited file
  and continue, not stop.

## Sandbox

This extension is the reason `.pi/sandbox.sb` allows writes under
`~/.local` and `~/.cache`. Without it, `$EDITOR` children of the sandboxed
pi process fail with `E303` (swap), `E886` (ShaDa), and plugin load errors
(checkmate, fidget, mason).

Writes are confined to those two subpaths, **not** the whole home.
`(subpath ...)` matches recursively, so allowing `$HOME` wholesale would also
permit writes to `~/.ssh/config`, `~/.zshrc`, `~/Library/LaunchAgents` (a
persistence vector), etc. — defeating the sandbox's write confinement. The
profile deliberately stays narrow; add a new subpath only when a concrete
tool needs it.

`sandbox-exec` profiles do not expand `~` or `$HOME` — the profile language
isn't shell-parsed and has no path-joining — so each writable subpath is
passed as its own `-D` param (`LOCAL_DIR`, `CACHE_DIR`) from `pi-sandbox`,
matching the existing `WORK_DIR`/`TMP_DIR` canonical-path convention. Reads
remain allowed everywhere by default.
