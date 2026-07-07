/**
 * Secondary buffer: a foreground terminal session that takes over the screen
 * while pi's TUI is suspended.
 *
 * This wraps the one correct lifecycle every "run an interactive program in
 * the terminal" feature needs:
 *
 *   ctx.ui.custom(...) -> tui.stop() -> clear -> spawn(stdio: inherit)
 *                                  -> tui.start() -> tui.requestRender(true)
 *
 * `tui.start()` always runs, even on throw, so pi's TUI is never left
 * suspended. Callers don't touch `ctx.ui.custom` directly — they call
 * {@link runForeground} and get back a plain result.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearScreen, spawnWithTty, type SpawnOptions, type SpawnResult } from "./tty.ts";
import type { EditorCommand } from "./env.ts";

export interface Spawnable {
	command: string;
	args: string[];
}

export type RunOptions = SpawnOptions;

export interface RunResult extends SpawnResult {}

/**
 * Suspend pi's TUI and run a foreground process with full terminal access.
 *
 * No-op (returns an error result) outside interactive TUI mode, so callers
 * don't need their own `ctx.mode` guard.
 *
 * @param ctx     an extension context (command, tool, or event handler)
 * @param target  the editor command to invoke, or a raw `{ command, args }`
 * @param opts    cwd / env / signal forwarded to the child
 */
export async function runForeground(
	ctx: ExtensionContext,
	target: EditorCommand | Spawnable,
	opts: RunOptions = {},
): Promise<RunResult> {
	if (ctx.mode !== "tui") {
		return {
			exitCode: null,
			signal: null,
			error: new Error("foreground terminal requires interactive (TUI) mode"),
			cancelled: false,
		};
	}

	return ctx.ui.custom<RunResult>((tui, _theme, _keybindings, done) => {
		let resolved = false;
		const finish = (r: RunResult) => {
			if (!resolved) {
				resolved = true;
				done(r);
			}
		};

		void (async () => {
			let result: RunResult;
			try {
				tui.stop();
				clearScreen();
				result = await spawnWithTty(target.command, target.args, opts);
			} catch (error) {
				result = { exitCode: null, signal: null, error: error as Error, cancelled: false };
			} finally {
				// Always restore pi's TUI, even on throw. The editor used the
				// alternate screen, so force a full re-render.
				tui.start();
				tui.requestRender(true);
			}
			finish(result);
		})();

		// Immediately disposed — the real work happens in the async IIFE.
		return { render: () => [], invalidate: () => {} };
	});
}
