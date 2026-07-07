# Global Agent Instructions

## macOS Sandbox

Assume you are launched via `pi-sandbox` (the `pi` wrapper), which runs pi inside a
macOS `sandbox-exec` profile (`.pi/sandbox.sb` in the working directory).

**Allowed:**
- File reads anywhere (binaries, dotfiles, API keys, etc.)
- File writes only to: the working directory, `/tmp`, `/var/tmp`, `$TMPDIR`,
  `~/.local` and `~/.cache` (via the `LOCAL_DIR`/`CACHE_DIR` sandbox params —
  needed so `$EDITOR` children can write swap/undo/state), and `/dev`
  (e.g. `/dev/null`)
- Outbound network (required for LLM provider APIs)
- Process exec/fork (the bash tool can run commands)
- IPC/Mach services

**Denied:**
- File writes anywhere outside the paths listed above (e.g. `~/.ssh`,
  `~/.zshrc`, `~/Library`, `/etc`). Writing outside the working directory,
  temp dirs, or `~/.local`/`~/.cache` will fail with `Operation not permitted`.

If a task requires writing outside these paths, tell the user instead of
attempting it repeatedly.

Note: `~/.local` and `~/.cache` writes are allowed specifically so editors
(and similar interactive tools launched via the `terminal` extension) can
persist their state. This is deliberately narrow (not the whole home);
see `docs/extensions/terminal.md` and `.pi/sandbox.sb` for rationale.

## Commit Messages

When writing a commit message, ensure there is always a Co-authored-by line,
of the following form:

```
Co-authored-by: Pi <noreply@pi.dev>
```

