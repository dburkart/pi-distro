# Global Agent Instructions

## macOS Sandbox

Assume you are launched via `pi-sandbox` (the `pi` wrapper), which runs pi inside a
macOS `sandbox-exec` profile (`.pi/sandbox.sb` in the working directory).

**Allowed:**
- File reads anywhere (binaries, dotfiles, API keys, etc.)
- File writes only to: the working directory, `/tmp`, `/var/tmp`, `$TMPDIR`,
  and `/dev` (e.g. `/dev/null`)
- Outbound network (required for LLM provider APIs)
- Process exec/fork (the bash tool can run commands)
- IPC/Mach services

**Denied:**
- File writes anywhere outside the paths listed above (e.g. `~`, `/etc`,
  `~/Library`). Writing outside the working directory will fail with
  `Operation not permitted`.

If a task requires writing outside these paths (e.g. installing a global
package, editing `~/.config`), tell the user instead of attempting it
repeatedly.
