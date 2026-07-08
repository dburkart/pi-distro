/**
 * Headless verifier runner.
 *
 * Spawns an isolated `pi` process (`pi --mode json -p --no-session --tools
 * read,bash,grep,ls,find --append-system-prompt <verifier-prompt-file>`) with a
 * read-only tool set, captures the JSON transcript, and returns the parsed
 * verdict.
 *
 * Why spawn and not ctx.newSession/ctx.fork: those are *session-replacement*
 * primitives — they tear down the user's active session. Wrong for an inline
 * verify. The headless child spawn is the real isolation primitive (same one
 * the subagent example uses): a fresh context window that runs to completion
 * and returns a distilled result, without touching the user's session.
 *
 * Enforcement of read-only investigation:
 *  - `--tools read,bash,grep,ls,find` omits write/edit/memory (pi-level);
 *  - the verifier system prompt forbids mutation (prompt-level);
 *  - an optional OS-level read-only-filesystem sandbox (PI_VERIFY_SANDBOX)
 *    provides defense-in-depth. Off by default for portability; documented as
 *    experimental hardening in docs/extensions/verify.md.
 *
 * Cost/abort:
 *  - PI_VERIFY_TIMEOUT (default 120s) wall-clock cap;
 *  - PI_VERIFY_COST_CAP_TOKENS (default 20000) cumulative output-token cap;
 *  - the parent tool's AbortSignal propagates SIGTERM -> SIGKILL (5s grace).
 */

import { spawn } from "node:child_process";
import { mkdtemp, unlink, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

import type { Message } from "@earendil-works/pi-ai";
import {
	type VerifierResult,
	type VerifierUsage,
	emptyUsage,
	extractJsonObject,
	normalizeVerdict,
} from "./verdict.ts";
import { buildVerifierSystemPrompt, buildVerifierTask, type VerifierPromptOptions } from "./prompt.ts";

export interface RunVerifierOptions extends VerifierPromptOptions {
	cwd: string;
	signal?: AbortSignal;
	onUpdate?: (partial: VerifierResult) => void;
}

export interface VerifierConfig {
	timeoutMs: number;
	costCapTokens: number;
	disabled: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_COST_CAP_TOKENS = 20_000;

/** Read env-var configuration (portable, matches memory/web extension convention). */
export function loadVerifierConfig(): VerifierConfig {
	const timeout = envInt("PI_VERIFY_TIMEOUT", 120);
	const cap = envInt("PI_VERIFY_COST_CAP_TOKENS", DEFAULT_COST_CAP_TOKENS);
	const disabled = /^(1|true)$/i.test(process.env.PI_VERIFY_DISABLED ?? "");
	return {
		timeoutMs: Math.max(1, timeout) * 1000,
		costCapTokens: Math.max(1, cap),
		disabled,
	};
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

/** The read-only tool set the verifier is allowed to use. */
const VERIFIER_TOOLS = "read,bash,grep,ls,find";

/**
 * Run the verifier. Returns a {@link VerifierResult}. Never throws —
 * operational failures become `error` states so the tool can render them
 * uniformly.
 */
export async function runVerifier(
	opts: RunVerifierOptions,
	config: VerifierConfig,
): Promise<VerifierResult> {
	const systemPrompt = buildVerifierSystemPrompt();
	const task = buildVerifierTask(opts);

	let tmpDir: string | null = null;
	let promptPath: string | null = null;

	try {
		tmpDir = await mkdtemp(join(tmpdir(), "pi-verify-"));
		promptPath = join(tmpDir, "verifier-prompt.md");
		await writeFile(promptPath, systemPrompt, { encoding: "utf-8", mode: 0o600 });

		const args = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--tools", VERIFIER_TOOLS,
			"--append-system-prompt", promptPath,
			task,
		];

		const invocation = piInvocation(args);
		const wrapped = wrapWithSandbox(invocation);

		const usage = emptyUsage();
		const messages: Message[] = [];
		let stderr = "";

		const run = await new Promise<{ exitCode: number; aborted: boolean; timedOut: boolean; costCapped: boolean }>((resolveRun) => {
			const proc = spawn(wrapped.command, wrapped.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			let aborted = false;
			let timedOut = false;
			let costCapped = false;
			let killed = false;

			const kill = (reason: "abort" | "timeout" | "cost") => {
				if (killed) return;
				killed = true;
				if (reason === "abort") aborted = true;
				else if (reason === "timeout") timedOut = true;
				else costCapped = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					try {
						if (!proc.killed) proc.kill("SIGKILL");
					} catch {
						/* already dead */
					}
				}, 5000);
			};

			// Wall-clock timeout.
			const timer = setTimeout(() => kill("timeout"), config.timeoutMs);

			// Parent abort signal.
			if (opts.signal) {
				if (opts.signal.aborted) kill("abort");
				else opts.signal.addEventListener("abort", () => kill("abort"), { once: true });
			}

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					messages.push(msg);
					if (msg.role === "assistant") {
						usage.turns++;
						const u = (msg as any).usage;
						if (u) {
							usage.input += u.input || 0;
							usage.output += u.output || 0;
							usage.cacheRead += u.cacheRead || 0;
							usage.cacheWrite += u.cacheWrite || 0;
							usage.cost += u.cost?.total || 0;
							usage.contextTokens = u.totalTokens || 0;
						}
						// Cost cap check: cumulative output tokens.
						if (usage.output >= config.costCapTokens) kill("cost");
						if (opts.onUpdate) {
							const partial = buildPartialResult(messages, usage);
							opts.onUpdate(partial);
						}
					}
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("error", () => resolveRun({ exitCode: 1, aborted, timedOut, costCapped }));
			proc.on("close", (code) => {
				clearTimeout(timer);
				if (buffer.trim()) processLine(buffer);
				resolveRun({ exitCode: code ?? 0, aborted, timedOut, costCapped });
			});
		});

		return finalizeResult({
			messages,
			usage,
			stderr,
			...run,
		});
	} catch (err) {
		return errorResult("spawn", `verifier failed to start: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		if (promptPath) await safeUnlink(promptPath);
		if (tmpDir) await safeRmdir(tmpDir);
	}
}

function buildPartialResult(messages: Message[], usage: VerifierUsage): VerifierResult {
	const raw = finalText(messages);
	return {
		summary: "",
		findings: [],
		counterfactuals: [],
		usage,
		rawOutput: raw,
	};
}

function finalizeResult(args: {
	messages: Message[];
	usage: VerifierUsage;
	stderr: string;
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	costCapped: boolean;
}): VerifierResult {
	const { messages, usage, stderr, exitCode, aborted, timedOut, costCapped } = args;

	if (aborted) return errorResult("aborted", "verifier run was aborted (parent turn cancelled).", usage, messages);
	if (timedOut) return errorResult("timeout", "verifier exceeded the time limit.", usage, messages);
	if (costCapped) return errorResult("cost_cap", "verifier exceeded the output-token cost cap.", usage, messages);
	if (exitCode !== 0) {
		const detail = stderr.trim() || finalText(messages) || `exit code ${exitCode}`;
		return errorResult("exit_nonzero", `verifier process exited with code ${exitCode}: ${detail.slice(0, 500)}`, usage, messages);
	}

	const raw = finalText(messages);
	const model = lastAssistantModel(messages);
	const parsed = extractJsonObject(raw);
	const result = normalizeVerdict(parsed, usage, raw, model);
	if (!result) {
		return errorResult("parse", "verifier completed but its final message was not a valid JSON verdict.", usage, messages, raw);
	}
	return result;
}

function errorResult(
	reason: "timeout" | "cost_cap" | "aborted" | "exit_nonzero" | "parse" | "spawn",
	message: string,
	usage?: VerifierUsage,
	messages?: Message[],
	rawOutput?: string,
): VerifierResult {
	return {
		summary: "",
		findings: [],
		counterfactuals: [],
		usage: usage ?? emptyUsage(),
		rawOutput: rawOutput ?? (messages ? finalText(messages) : ""),
		error: { reason, message },
	};
}

function finalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}

function lastAssistantModel(messages: Message[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as any;
		if (msg.role === "assistant" && msg.model) return msg.model;
	}
	return undefined;
}

async function safeUnlink(p: string): Promise<void> {
	try {
		await unlink(p);
	} catch {
		/* ignore */
	}
}
async function safeRmdir(p: string): Promise<void> {
	try {
		await rmdir(p);
	} catch {
		/* ignore */
	}
}

/** Resolve how to invoke pi, mirroring the subagent example. */
function piInvocation(extraArgs: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extraArgs] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args: extraArgs };
	}
	return { command: "pi", args: extraArgs };
}

/**
 * Optionally wrap the pi invocation in an OS-level read-only-filesystem
 * sandbox. Off by default for portability; enable via PI_VERIFY_SANDBOX:
 *   - "auto"                  use the bundled default profile (macOS only)
 *   - "/path/to/profile.sb"    use an external sandbox-exec profile via -f
 * Network remains fully open in the bundled profile (external profiles
 * govern their own network policy).
 *
 * When sandbox-exec is unavailable or no profile is configured, the pi
 * invocation runs directly — read-only enforcement then relies on the
 * `--tools` allowlist (no write/edit/memory) and the adversarial prompt.
 */
function wrapWithSandbox(invocation: { command: string; args: string[] }): { command: string; args: string[] } {
	const setting = process.env.PI_VERIFY_SANDBOX;
	if (!setting) return invocation;
	if (!existsSync("/usr/bin/sandbox-exec")) return invocation;

	// External profile file -> sandbox-exec -f <file>.
	if (setting !== "auto" && existsSync(setting)) {
		return {
			command: "/usr/bin/sandbox-exec",
			args: ["-f", setting, "--", invocation.command, ...invocation.args],
		};
	}

	// Bundled inline profile -> sandbox-exec -p <profile>.
	const profile = setting === "auto" ? defaultSandboxProfile() : null;
	if (!profile) return invocation;
	return {
		command: "/usr/bin/sandbox-exec",
		args: ["-p", profile, "--", invocation.command, ...invocation.args],
	};
}

/**
 * The bundled read-only-FS profile (macOS). Allows reads everywhere, network
 * fully open, writes only to temp dirs. This is defense-in-depth on top of
 * the --tools allowlist; it is intentionally permissive about reads/network
 * and strict about writes.
 */
function defaultSandboxProfile(): string | null {
	if (process.platform !== "darwin") return null;
	const tmp = tmpdir();
	return [
		`(version 1)`,
		`(allow default)`,
		// Deny file writes broadly, then re-allow temp + caches.
		`(deny file-write*)`,
		`(allow file-write* (subpath "${tmp}"))`,
		`(allow file-write* (subpath "${join(tmp, "")}"))`,
		// Network stays open (verifier may hit live endpoints).
		`(allow network*)`,
	].join("\n");
}

// (External sandbox files are handled via -f in wrapWithSandbox; no inline
// resolution needed here.)

// Re-exported for the tool/command layer.
export { buildVerifierSystemPrompt, buildVerifierTask };
export type { VerifierPromptOptions };
