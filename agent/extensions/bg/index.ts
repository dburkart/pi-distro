/**
 * `bg` extension — background shells / async bash (harness-eng roadmap H2).
 *
 * Registers the `bg` tool (model-auto-invocable) and `/bg` command. A long
 * command is spawned *detached* (its own process group), with stdout/stderr
 * piped to files under a per-process `$TMPDIR/pi-bg-<id>/` dir. The model
 * keeps working and polls status/output with `bg read`, or greps the full
 * log files directly with its existing `bash`/`read`/`grep` tools.
 *
 * State is fully ephemeral and session-runtime-scoped:
 *   - handle table is in-memory only (not persisted, not reconstructed);
 *   - all live children are SIGKILL'd on every `session_shutdown`
 *     (quit/reload/new/resume/fork) and the tmpdir is removed;
 *   - shells do NOT survive `/reload` or a session switch — by design.
 * If you need a command to outlive pi, run it in a real terminal/tmux; `bg`
 * is a "right now" scratchpad, not a durable runner.
 *
 * Configuration (env vars, for portability — matches verify/memory/web):
 *   PI_BG_MAX_LIFETIME   hard wall-clock cap in seconds (default 1800 / 30m).
 *                        Clamps any explicit `timeout` on `start` and kills
 *                        shells that exceed it.
 *   PI_BG_DISABLED       set to 1/true to disable the extension.
 *
 * Single `bg` tool with an `action` enum (start/read/list/stop), mirroring
 * the `todos` extension's enum pattern — one prompt entry, not four tools.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, defineTool, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_LIFETIME_DEFAULT = 1800; // seconds
const READ_WAIT_CAP_S = 120;
const READ_LINES_DEFAULT = 50;
const READ_LINES_MAX = 500;
const STOP_GRACE_MS = 3000;
const TAIL_MAX_BYTES = 256 * 1024; // read at most the last 256KB when peeking

function maxLifetimeS(): number {
	const v = Number(process.env.PI_BG_MAX_LIFETIME);
	return Number.isFinite(v) && v > 0 ? Math.floor(v) : MAX_LIFETIME_DEFAULT;
}
function disabled(): boolean {
	return /^(1|true)$/i.test(process.env.PI_BG_DISABLED ?? "");
}

interface Shell {
	handle: number;
	child: ChildProcess;
	pid: number;
	command: string;
	cwd: string;
	startedAt: number;
	endedAt?: number;
	outPath: string;
	errPath: string;
	status: "running" | "stopped" | "exited" | "errored";
	exitCode: number | null;
	errorMsg?: string;
	lifetimeTimer?: NodeJS.Timeout;
	killTimer?: NodeJS.Timeout;
}

interface ShellInfo {
	handle: number;
	pid: number;
	command: string;
	cwd: string;
	status: Shell["status"];
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	outPath: string;
	errPath: string;
}

interface BgDetails {
	action: "start" | "read" | "list" | "stop";
	shell?: ShellInfo;
	shells?: ShellInfo[];
	outTail?: string;
	errTail?: string;
	error?: string;
}

const BgParams = Type.Object({
	action: StringEnum(["start", "read", "list", "stop"] as const, {
		description:
			"start: spawn a detached command. read: poll status + tail (optional wait). list: all shells this session. stop: kill a shell (SIGTERM→SIGKILL).",
	}),
	command: Type.Optional(Type.String({ description: "Command to run (action:start)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (action:start); default current cwd" })),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Max lifetime in seconds (action:start); clamped to PI_BG_MAX_LIFETIME (default 1800). No default = unbounded up to the cap.",
		}),
	),
	handle: Type.Optional(Type.Number({ description: "Shell handle (action:read, action:stop)" })),
	wait: Type.Optional(
		Type.Number({
			description: `Seconds to block for completion before returning (action:read); capped at ${READ_WAIT_CAP_S}. Default 0 (non-blocking).`,
		}),
	),
	lines: Type.Optional(
		Type.Number({
			description: `Tail lines per stream to return (action:read); default ${READ_LINES_DEFAULT}, max ${READ_LINES_MAX}.`,
		}),
	),
	stream: Type.Optional(
		StringEnum(["stdout", "stderr", "both"] as const, {
			description: "Which stream's tail to return (action:read); default both",
		}),
	),
});

function shellInfo(s: Shell): ShellInfo {
	return {
		handle: s.handle,
		pid: s.pid,
		command: s.command,
		cwd: s.cwd,
		status: s.status,
		exitCode: s.exitCode,
		startedAt: s.startedAt,
		endedAt: s.endedAt,
		outPath: s.outPath,
		errPath: s.errPath,
	};
}

/** Read the last `lines` lines of `path`, scanning at most TAIL_MAX_BYTES from the end. */
function readTail(path: string, maxLines: number): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
	} catch {
		return "";
	}
	try {
		const stat = fstatSync(fd);
		if (stat.size === 0) return "";
		const bytes = Math.min(stat.size, TAIL_MAX_BYTES);
		const buf = Buffer.alloc(bytes);
		readSync(fd, buf, 0, bytes, stat.size - bytes);
		let text = buf.toString("utf8");
		// If we truncated from the front, drop the partial first line.
		if (bytes < stat.size) {
			const nl = text.indexOf("\n");
			if (nl >= 0) text = text.slice(nl + 1);
		}
		const all = text.split("\n");
		return all.slice(-Math.min(maxLines, READ_LINES_MAX)).join("\n").trimEnd();
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(t);
			resolve();
		};
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function fmtRuntime(s: Shell): string {
	const end = s.endedAt ?? Date.now();
	const sec = Math.max(0, Math.round((end - s.startedAt) / 1000));
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const r = sec % 60;
	return r ? `${m}m${r}s` : `${m}m`;
}

/**
 * TUI component for the /bg command — read-only status panel mirroring /todos.
 */
class BgListComponent {
	private shells: Shell[];
	private theme: Theme;
	private onClose: () => void;

	constructor(shells: Shell[], theme: Theme, onClose: () => void) {
		this.shells = shells;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		lines.push("");
		const title = th.fg("accent", " Background shells ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 22)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.shells.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No background shells. Ask the agent to bg start one.")}`, width));
		} else {
			const running = this.shells.filter((s) => s.status === "running").length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${running}/${this.shells.length} running`)}`, width));
			lines.push("");
			for (const s of this.shells) {
				const mark =
					s.status === "running"
						? th.fg("accent", "●")
						: s.status === "exited"
							? s.exitCode === 0
								? th.fg("success", "✓")
								: th.fg("error", "✗")
							: th.fg("dim", "■");
				const id = th.fg("accent", `#${s.handle}`);
				const status = th.fg("dim", `${s.status}${s.status === "exited" ? `(${s.exitCode})` : ""} ${fmtRuntime(s)}`);
				const cmd = th.fg("text", s.command.length > 50 ? `${s.command.slice(0, 49)}…` : s.command);
				lines.push(truncateToWidth(`  ${mark} ${id} ${status} ${cmd}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");
		return lines;
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	if (disabled()) return;

	let shells: Shell[] = [];
	let nextHandle = 1;
	let tmpRoot: string | undefined;

	const ensureTmpRoot = (): string => {
		if (tmpRoot) return tmpRoot;
		const base = process.env.TMPDIR || tmpdir();
		tmpRoot = join(base, `pi-bg-${randomUUID().slice(0, 8)}`);
		mkdirSync(tmpRoot, { recursive: true });
		return tmpRoot;
	};

	/** Kill a shell's process group. hard=true → SIGKILL, else SIGTERM. */
	const killGroup = (s: Shell, hard: boolean) => {
		try {
			process.kill(-s.pid, hard ? "SIGKILL" : "SIGTERM");
		} catch {
			// already dead
		}
	};

	const clearTimers = (s: Shell) => {
		if (s.lifetimeTimer) {
			clearTimeout(s.lifetimeTimer);
			s.lifetimeTimer = undefined;
		}
		if (s.killTimer) {
			clearTimeout(s.killTimer);
			s.killTimer = undefined;
		}
	};

	/** Graceful termination: SIGTERM, then SIGKILL after the grace period. */
	const terminate = (s: Shell) => {
		if (s.status !== "running") return;
		s.status = "stopped";
		clearTimers(s);
		killGroup(s, false);
		s.killTimer = setTimeout(() => killGroup(s, true), STOP_GRACE_MS);
		s.killTimer.unref?.();
		s.endedAt = Date.now();
	};

	const onExit = (s: Shell, code: number | null) => {
		clearTimers(s);
		s.endedAt = Date.now();
		s.exitCode = code;
		if (s.status === "running") s.status = "exited"; // natural exit
		// else: stop()/lifetime already set status "stopped"; keep it.
	};

	// Finalize all shells + remove the tmpdir on any session teardown.
	pi.on("session_shutdown", async () => {
		for (const s of shells) {
			clearTimers(s);
			if (s.status === "running") killGroup(s, true); // hard kill — we're tearing down
		}
		shells = [];
		nextHandle = 1;
		if (tmpRoot) {
			try {
				rmSync(tmpRoot, { recursive: true, force: true });
			} catch {
				// best effort
			}
			tmpRoot = undefined;
		}
	});

	const start = (
		command: string,
		cwd: string,
		timeoutS: number | undefined,
	): { shell?: Shell; error?: string } => {
		if (!command?.trim()) return { error: "command required" };
		try {
			accessSync(cwd, constants.X_OK);
		} catch {
			return { error: `cwd does not exist or is not accessible: ${cwd}` };
		}

		const root = ensureTmpRoot();
		const handle = nextHandle++;
		const outPath = join(root, `shell-${handle}.out`);
		const errPath = join(root, `shell-${handle}.err`);

		let outFd: number | undefined;
		let errFd: number | undefined;
		let child: ChildProcess;
		try {
			outFd = openSync(outPath, "a");
			errFd = openSync(errPath, "a");
			const shellPath = process.env.SHELL || "/bin/sh";
			child = spawn(shellPath, ["-c", command], {
				cwd,
				env: process.env,
				detached: true,
				stdio: ["ignore", outFd, errFd],
			});
		} catch (e) {
			if (outFd !== undefined) closeSync(outFd);
			if (errFd !== undefined) closeSync(errFd);
			return { error: `failed to spawn: ${e instanceof Error ? e.message : String(e)}` };
		}
		// Child has dup'd the fds; close the parent's copies.
		closeSync(outFd);
		closeSync(errFd);

		if (typeof child.pid !== "number") {
			return { error: "spawn did not produce a pid" };
		}

		const s: Shell = {
			handle,
			child,
			pid: child.pid,
			command,
			cwd,
			startedAt: Date.now(),
			outPath,
			errPath,
			status: "running",
			exitCode: null,
		};

		child.on("exit", (code) => onExit(s, code));
		child.on("error", (err) => {
			if (s.status !== "running") return;
			clearTimers(s);
			s.status = "errored";
			s.errorMsg = err.message;
			s.endedAt = Date.now();
		});
		child.unref();

		// Lifetime ceiling: clamp explicit timeout to the env cap, then kill.
		const cap = maxLifetimeS();
		const lifetime = Math.min(timeoutS ?? cap, cap);
		if (lifetime > 0) {
			s.lifetimeTimer = setTimeout(() => terminate(s), lifetime * 1000);
			s.lifetimeTimer.unref?.();
		}

		shells.push(s);
		return { shell: s };
	};

	const read = async (
		handle: number,
		waitS: number | undefined,
		lines: number,
		stream: "stdout" | "stderr" | "both",
		signal: AbortSignal | undefined,
	): Promise<{ shell?: Shell; error?: string }> => {
		const s = shells.find((x) => x.handle === handle);
		if (!s) return { error: `shell #${handle} not found` };
		const wait = Math.max(0, Math.min(waitS ?? 0, READ_WAIT_CAP_S));
		const deadline = Date.now() + wait * 1000;
		while (s.status === "running" && Date.now() < deadline && !signal?.aborted) {
			await sleep(200, signal);
		}
		return { shell: s };
	};

	const stop = (handle: number): { shell?: Shell; error?: string } => {
		const s = shells.find((x) => x.handle === handle);
		if (!s) return { error: `shell #${handle} not found` };
		terminate(s);
		return { shell: s };
	};

	const bg = defineTool({
		name: "bg",
		label: "Background shell",
		description: [
			"Run long commands in the background and poll them while you keep working. One tool, action enum: start (spawn detached), read (status + tail, optional wait), list (all shells), stop (kill).",
			"Use bg when a command is expected to run long (test suites, builds, dev servers, watchers, tail -f, migrations) AND you want to continue working while it runs — poll with bg read.",
			"Do NOT use bg for quick commands (seconds) or when you need the result before proceeding — use bash. bg shells are EPHEMERAL: killed on /reload, session switch, or quit; they do not persist or survive restart.",
			"stdout/stderr are piped to files whose paths bg returns; grep/read/tail those files directly for the full log beyond the tail bg read returns.",
		].join(" "),
		promptSnippet: "Spawn long commands in the background and poll them (start/read/list/stop)",
		promptGuidelines: [
			"Use bg with action:start for commands expected to run long (tests, builds, watchers, dev servers) when you want to keep working while they run; poll with bg action:read (optionally with wait).",
			"Don't use bg for quick commands or when you need the result before proceeding — use bash. bg shells are ephemeral (killed on /reload, session switch, or quit) and do not persist.",
		],
		parameters: BgParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				case "start": {
					const cwd = params.cwd || ctx.cwd;
					const { shell, error } = start(params.command ?? "", cwd, params.timeout);
					if (error || !shell) {
						return {
							content: [{ type: "text", text: `Error: ${error}` }],
							details: { action: "start", error } as BgDetails,
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Started shell #${shell.handle} (pid ${shell.pid}, ${maxLifetimeS()}s cap): ${shell.command}\nstdout: ${shell.outPath}\nstderr: ${shell.errPath}`,
							},
						],
						details: { action: "start", shell: shellInfo(shell) } as BgDetails,
					};
				}

				case "read": {
					if (params.handle === undefined) {
						return {
							content: [{ type: "text", text: "Error: handle required for read" }],
							details: { action: "read", error: "handle required" } as BgDetails,
						};
					}
					const lines = Math.min(params.lines ?? READ_LINES_DEFAULT, READ_LINES_MAX);
					const stream = (params.stream ?? "both") as "stdout" | "stderr" | "both";
					const { shell, error } = await read(params.handle, params.wait, lines, stream, signal);
					if (error || !shell) {
						return {
							content: [{ type: "text", text: `Error: ${error}` }],
							details: { action: "read", error } as BgDetails,
						};
					}
					const outTail = stream !== "stderr" ? readTail(shell.outPath, lines) : undefined;
					const errTail = stream !== "stdout" ? readTail(shell.errPath, lines) : undefined;
					let text = `Shell #${shell.handle}: ${shell.status}${shell.status === "exited" ? ` (code ${shell.exitCode})` : ""}${shell.status === "running" ? ` (pid ${shell.pid}, ${fmtRuntime(shell)})` : ""}`;
					if (outTail) text += `\nstdout (tail, last ${lines}):\n${outTail}`;
					if (errTail) text += `\nstderr (tail, last ${lines}):\n${errTail}`;
					text += `\nfiles: ${shell.outPath} | ${shell.errPath}`;
					return {
						content: [{ type: "text", text }],
						details: { action: "read", shell: shellInfo(shell), outTail, errTail } as BgDetails,
					};
				}

				case "list": {
					return {
						content: [
							{
								type: "text",
								text: shells.length
									? shells
											.map(
												(s) =>
													`#${s.handle} ${s.status}${s.status === "exited" ? `(${s.exitCode})` : ""} ${fmtRuntime(s)} pid=${s.pid}: ${s.command}`,
											)
											.join("\n")
									: "No background shells",
							},
						],
						details: { action: "list", shells: shells.map(shellInfo) } as BgDetails,
					};
				}

				case "stop": {
					if (params.handle === undefined) {
						return {
							content: [{ type: "text", text: "Error: handle required for stop" }],
							details: { action: "stop", error: "handle required" } as BgDetails,
						};
					}
					const { shell, error } = stop(params.handle);
					if (error || !shell) {
						return {
							content: [{ type: "text", text: `Error: ${error}` }],
							details: { action: "stop", error } as BgDetails,
						};
					}
					return {
						content: [{ type: "text", text: `Stopped shell #${shell.handle} (SIGTERM→SIGKILL)` }],
						details: { action: "stop", shell: shellInfo(shell) } as BgDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: { action: "list", error: `unknown action: ${params.action}` } as BgDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("bg ")) + theme.fg("muted", args.action);
			if (args.command)
				text += ` ${theme.fg("dim", `"${args.command.length > 40 ? `${args.command.slice(0, 39)}…` : args.command}"`)}`;
			if (args.handle !== undefined) text += ` ${theme.fg("accent", `#${args.handle}`)}`;
			if (args.wait) text += ` ${theme.fg("dim", `wait ${args.wait}s`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as BgDetails | undefined;
			const th = theme;
			if (!details) {
				const c = result.content[0];
				return new Text(c?.type === "text" ? c.text : "", 0, 0);
			}
			if (details.error) return new Text(th.fg("error", `Error: ${details.error}`), 0, 0);

			const markFor = (s: ShellInfo) =>
				s.status === "running"
					? th.fg("accent", "●")
					: s.status === "exited"
						? s.exitCode === 0
							? th.fg("success", "✓")
							: th.fg("error", "✗")
						: th.fg("dim", "■");

			switch (details.action) {
				case "start":
					return new Text(
						th.fg("success", "✓ Started ") +
							th.fg("accent", `#${details.shell!.handle}`) +
							" " +
							th.fg("dim", `pid=${details.shell!.pid}`),
						0,
						0,
					);

				case "read": {
					const s = details.shell!;
					if (!expanded) {
						return new Text(
							`${markFor(s)} ${th.fg("accent", `#${s.handle}`)} ${th.fg("muted", s.status)}${s.status === "exited" ? `(${s.exitCode})` : ""} ${th.fg("dim", `pid=${s.pid}`)}`,
							0,
							0,
						);
					}
					let t = `${markFor(s)} ${th.fg("accent", `#${s.handle}`)} ${th.fg("muted", s.status)}${s.status === "exited" ? `(${s.exitCode})` : ""} ${th.fg("dim", `pid=${s.pid}`)}`;
					if (details.outTail) t += `\n${th.fg("dim", "stdout:")}\n${th.fg("text", details.outTail)}`;
					if (details.errTail) t += `\n${th.fg("dim", "stderr:")}\n${th.fg("text", details.errTail)}`;
					return new Text(t, 0, 0);
				}

				case "stop":
					return new Text(
						th.fg("success", "✓ Stopped ") + th.fg("accent", `#${details.shell!.handle}`),
						0,
						0,
					);

				case "list": {
					const list = details.shells ?? [];
					if (!list.length) return new Text(th.fg("dim", "No background shells"), 0, 0);
					let t = th.fg("muted", `${list.length} shell(s):`);
					const display = expanded ? list : list.slice(0, 8);
					for (const s of display) {
						t += `\n${markFor(s)} ${th.fg("accent", `#${s.handle}`)} ${th.fg("muted", s.status)} ${th.fg("dim", `pid=${s.pid}`)} ${th.fg("text", s.command)}`;
					}
					if (!expanded && list.length > 8) t += `\n${th.fg("dim", `... ${list.length - 8} more`)}`;
					return new Text(t, 0, 0);
				}
			}
		},
	});

	pi.registerTool(bg);

	pi.registerCommand("bg", {
		description: "Show background shells and their status",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/bg requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new BgListComponent(shells, theme, () => done());
			});
		},
	});
}
