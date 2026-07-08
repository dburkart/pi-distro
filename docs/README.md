# Documentation Index

Entry point for all docs in this distro. When adding a doc, add a line here
under the right category with a one-sentence summary so it can be discovered
without recursively listing the tree.

## Extensions

- [extensions/terminal.md](extensions/terminal.md) — `/edit` command and
  `review` tool; shared "secondary buffer" primitive for suspending pi's TUI
  and running a foreground program (e.g. `$EDITOR`). Includes the sandbox
  rationale for `~/.local`/`~/.cache` writes.
- [extensions/web.md](extensions/web.md) — `web_search` and `web_fetch` tools
  with a pluggable search backend registry (Marginalia implemented); env-var
  configuration and HTML-to-text fetching.
- [extensions/memory.md](extensions/memory.md) — persistent cross-session agent
  memory as markdown (`memory` tool + `/memory` command); flat file-based store
  covering factual + experiential memory, with write-time conflict detection
  and a lint pass. Grounded in the memory-systems survey, pruned to what's
  practical on hosted models.
