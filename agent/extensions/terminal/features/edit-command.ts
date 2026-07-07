/**
 * `/edit [path]` — open a path in the user's $EDITOR via the secondary buffer.
 *
 * Path omitted opens the current directory (so `vim .`-style browsing works).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openPath } from "../lib/editor.ts";

export function registerEditCommand(pi: ExtensionAPI): void {
	pi.registerCommand("edit", {
		description: "Open a path (or the current directory) in $EDITOR",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const target = args?.trim() || ctx.cwd;

			const result = await openPath(ctx, target, { signal: ctx.signal });

			if (result.error) {
				ctx.ui.notify(`Editor failed: ${result.error.message}`, "error");
				return;
			}
			if (result.cancelled) {
				ctx.ui.notify("Editor cancelled", "info");
				return;
			}
			if (result.exitCode === 0) {
				ctx.ui.notify(`Edited ${target}`, "info");
			} else {
				ctx.ui.notify(`Editor exited with code ${result.exitCode}`, "warning");
			}
		},
	});
}
