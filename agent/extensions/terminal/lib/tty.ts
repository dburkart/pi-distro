/**
 * Low-level terminal primitives for taking over the screen.
 *
 * No pi types here — just raw escape sequences and a tty-inheriting spawn
 * helper, so this module can be reused by anything that needs a foreground
 * subprocess with full terminal access.
 */
import { spawn } from "node:child_process";

/** Enter the terminal's alternate screen buffer. */
export function enterAltScreen(): void {
	process.stdout.write("\x1b[?1049h");
}

/** Leave the terminal's alternate screen buffer. */
export function leaveAltScreen(): void {
	process.stdout.write("\x1b[?1049l");
}

/** Clear the visible screen and home the cursor. */
export function clearScreen(): void {
	process.stdout.write("\x1b[2J\x1b[H");
}

export interface SpawnOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

export interface SpawnResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
	cancelled: boolean;
}

/**
 * Spawn a process with stdio inherited from the controlling terminal, so
 * interactive programs (editors, pagers, TUIs) get full keyboard + screen
 * access.
 *
 * Uses async `spawn` (not `spawnSync`) for portability: on Windows, sync
 * child_process calls keep libuv's console-input read active and race the
 * child editor for the input buffer.
 *
 * If `signal` aborts, the child is sent SIGTERM and the result is marked
 * cancelled.
 */
export function spawnWithTty(
	command: string,
	args: string[],
	opts: SpawnOptions = {},
): Promise<SpawnResult> {
	return new Promise((resolve) => {
		let cancelled = false;

		const child = spawn(command, args, {
			stdio: "inherit",
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			// Windows needs shell resolution for bare commands like "notepad".
			shell: process.platform === "win32",
		});

		const onAbort = () => {
			cancelled = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// Process may already be gone; ignore.
			}
		};

		if (opts.signal) {
			if (opts.signal.aborted) {
				onAbort();
			} else {
				opts.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		const cleanup = () => {
			if (opts.signal) {
				opts.signal.removeEventListener("abort", onAbort);
			}
		};

		child.on("error", (error) => {
			cleanup();
			resolve({ exitCode: null, signal: null, error, cancelled });
		});

		child.on("close", (code, signal) => {
			cleanup();
			resolve({ exitCode: code, signal: signal ?? null, cancelled });
		});
	});
}
