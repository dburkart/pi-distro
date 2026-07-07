/**
 * Terminal utilities extension.
 *
 * Provides a shared "secondary buffer" (foreground terminal session) and
 * builds on it:
 *   - `/edit [path]`   open a path (or cwd) in $EDITOR
 *   - `review` tool    the agent hands text to a human for editing
 *
 * Library layout (reusable by future features):
 *   lib/buffer.ts   runForeground() — the one correct suspend/spawn/restore lifecycle
 *   lib/tty.ts      alt-screen, clear, spawnWithTty()
 *   lib/env.ts      resolveEditor() — $VISUAL/$EDITOR/externalEditor/​fallback
 *   lib/editor.ts   openPath() / openContent() built on the above
 *   features/*.ts   commands and tools composed in index.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEditCommand } from "./features/edit-command.ts";
import { registerReviewTool } from "./features/review-tool.ts";

export default function (pi: ExtensionAPI) {
	registerEditCommand(pi);
	registerReviewTool(pi);
}
