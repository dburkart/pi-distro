/**
 * `test` extension — test/CI loop as a first-class tool (harness-eng roadmap H3).
 *
 * Registers the `test` tool (model-auto-invocable) and `/test` command. The
 * tool runs the project's configured test command and returns a *compact*
 * pass/fail summary (counts + failing-test names + one-line messages) instead
 * of raw stdout, with the full log written to an inspectable file. This is
 * the harness-eng essay's inner-loop discipline: keep tests <1min, parse
 * results structurally, don't drown in stdout.
 *
 * Two actions (one tool, action enum — mirrors `bg`/`todos`):
 *   - `run`    — exec the resolved command SYNCHRONOUSLY, parse, return the
 *                compact summary + the full-log file path. The common <1min
 *                inner-loop path. Nonzero exit = status:fail (never a thrown
 *                error); PI_TEST_TIMEOUT (default 120s) breach = status:timeout,
 *                the nudge to switch to `bg` + `test parse` for long suites.
 *   - `parse`  — distill existing output (a `file` path OR inline `text`)
 *                into the same compact summary. The zero-noise `bg`→`test`
 *                handoff: `bg start` a long suite, later `test parse --file`.
 *
 * State is fully ephemeral and session-runtime-scoped: the run tmpdir (full
 * logs) is in-memory tracked and removed on `session_shutdown`. No handle
 * table (unlike `bg`) — `test` is stateless.
 *
 * Configuration (env > project file > auto-detect; portability pattern):
 *   PI_TEST_COMMAND    overrides the test command (and bypasses auto-detect).
 *   PI_TEST_PARSER     overrides the parser name (jest|vitest|cargo|go|node|generic).
 *   PI_TEST_TIMEOUT    run timeout in seconds (default 120; 0 = unbounded).
 *   PI_TEST_DISABLED   set to 1/true to disable the extension.
 *   .pi/test.json      project file: { "command": "...", "parser": "..." }.
 *
 * Auto-detection (the detector IS the parser registry entry) probes, in
 * order: package.json (sniff scripts.test content → node/jest/vitest, else
 * `npm test` + generic), Cargo.toml (cargo test), go.mod (go test), Makefile
 * (make test, generic). First match wins; else error.
 *
 * Parser registry: `{ name, detect(ctx), parse(input): Summary }`. v1 parsers:
 * jest, vitest, cargo, go, node (TAP from `node --test --test-reporter=tap`),
 * generic (exit-code fallback). Add a framework = drop in a registered object.
 *
 * Design resolved via `/grilling`; see plans/test-extension in project memory.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, defineTool, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TIMEOUT_DEFAULT = 120; // seconds
const MAX_FAILURES_SHOWN = 20;

function disabled(): boolean {
	return /^(1|true)$/i.test(process.env.PI_TEST_DISABLED ?? "");
}
function timeoutS(): number {
	const v = Number(process.env.PI_TEST_TIMEOUT);
	return Number.isFinite(v) && v >= 0 ? Math.floor(v) : TIMEOUT_DEFAULT;
}

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type TestStatus = "pass" | "fail" | "timeout" | "error";

export interface Failure {
	name: string;
	message: string;
}

export interface Summary {
	status: TestStatus;
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	durationMs?: number;
	failures: Failure[];
	parser: string;
	logFile?: string;
	errFile?: string;
	error?: string;
}

export interface ParseInput {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

export interface DetectCtx {
	cwd: string;
	pkgJson: PkgJson | null;
	hasCargo: boolean;
	hasGoMod: boolean;
	hasMakefile: boolean;
}

interface PkgJson {
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

export interface Parser {
	name: string;
	/** Whether this project uses this framework. Returns the default command if so. */
	detect(ctx: DetectCtx): string | null;
	/** Parse runner output into a compact summary (without status/log fields). */
	parse(input: ParseInput): Omit<Summary, "status" | "parser" | "logFile" | "errFile" | "error">;
}

// ────────────────────────────────────────────────────────────────────────────
// Parser helpers
// ────────────────────────────────────────────────────────────────────────────

/** Strip surrounding quotes (single or double) from a TAP/YAML-ish value. */
function unquote(s: string): string {
	s = s.trim();
	if (
		(s.startsWith("'") && s.endsWith("'")) ||
		(s.startsWith('"') && s.endsWith('"'))
	) {
		return s.slice(1, -1);
	}
	return s;
}

function int(s: string | undefined | null): number {
	const n = s ? Number.parseInt(s, 10) : NaN;
	return Number.isFinite(n) ? n : 0;
}

/** First non-empty line at or after `idx` that is more indented than `baseIndent`. */
function nextIndented(lines: string[], idx: number, baseIndent: number): string | undefined {
	for (let i = idx + 1; i < lines.length; i++) {
		const raw = lines[i];
		if (raw.trim() === "") continue;
		const ind = raw.length - raw.trimStart().length;
		if (ind <= baseIndent) break;
		return raw.trim();
	}
	return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Parsers
// ────────────────────────────────────────────────────────────────────────────

/** node — TAP 13 from `node --test --test-reporter=tap`. */
const nodeParser: Parser = {
	name: "node",
	detect(ctx) {
		const t = ctx.pkgJson?.scripts?.test ?? "";
		if (/\bnode\s+--?test\b/.test(t)) return "node --test --test-reporter=tap";
		return null;
	},
	parse(input) {
		const lines = input.stdout.split("\n");
		let total = 0,
			passed = 0,
			failed = 0,
			skipped = 0,
			durationMs: number | undefined;
		const failures: Failure[] = [];

		for (const line of lines) {
			const m = line.match(/^#\s+(tests|pass|fail|skipped|cancelled|duration_ms)\s+(\d+(?:\.\d+)?)/);
			if (m) {
				const v = Number(m[2]);
				switch (m[1]) {
					case "tests": total = v; break;
					case "pass": passed = v; break;
					case "fail": failed = v; break;
					case "skipped":
					case "cancelled": skipped += v; break;
					case "duration_ms": durationMs = v; break;
				}
			}
		}

		// Collect every `not ok N - name` (top-level + nested) with its error line.
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(/^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/);
			if (!m) continue;
			const name = m[1].trim();
			const indent = lines[i].length - lines[i].trimStart().length;
			// Look for an `error: <val>` in the following indented YAML block.
			let message = "";
			for (let j = i + 1; j < lines.length; j++) {
				const raw = lines[j];
				if (raw.trim() === "") continue;
				const ind = raw.length - raw.trimStart().length;
				if (ind <= indent) break;
				const em = raw.match(/^\s*error:\s*(.*)$/);
				if (em) {
					message = unquote(em[1]);
					break;
				}
			}
			failures.push({ name, message });
		}

		// Fall back to counting ok/not-ok lines if no summary pragmas.
		if (total === 0) {
			let ok = 0,
				notOk = 0;
			for (const line of lines) {
				if (/^\s*ok\s+\d+/.test(line)) ok++;
				else if (/^\s*not ok\s+\d+/.test(line)) notOk++;
			}
			total = ok + notOk;
			passed = ok;
			failed = notOk;
		}
		if (failures.length > 0 && failed === 0) failed = failures.length;

		return { total, passed, failed, skipped, durationMs, failures };
	},
};

/** jest — default reporter (`Tests: N failed, M passed, T total`, `● Name`). */
const jestParser: Parser = {
	name: "jest",
	detect(ctx) {
		const t = ctx.pkgJson?.scripts?.test ?? "";
		const deps = { ...(ctx.pkgJson?.devDependencies ?? {}), ...(ctx.pkgJson?.dependencies ?? {}) };
		if (/\bjest\b/.test(t) || "jest" in deps) {
			return ctx.pkgJson?.scripts?.test ? "npm test" : "npx jest";
		}
		return null;
	},
	parse(input) {
		const lines = input.stdout.split("\n");
		let total = 0,
			passed = 0,
			failed = 0,
			skipped = 0,
			durationMs: number | undefined;
		const failures: Failure[] = [];

		for (const line of lines) {
		const tm = line.match(/Tests:\s+(\d+)\s+failed(?:,\s+(\d+)\s+todo)?,\s+(\d+)\s+passed(?:,\s+(\d+)\s+skipped)?,\s+(\d+)\s+total/i);
			if (tm) {
				failed = int(tm[1]);
				passed = int(tm[3]);
				skipped = int(tm[4]);
				total = int(tm[5]);
				continue;
			}
			const dm = line.match(/Time:\s+([\d.]+)\s*s/i);
			if (dm) durationMs = Math.round(Number(dm[1]) * 1000);
		}

		// `  ● Name › subtest (X ms)` lines mark failures.
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(/^\s*●\s+(.+?)\s*\(\d+\s*ms\)\s*$/);
			if (!m) continue;
			const name = m[1].trim();
			const message = nextIndented(lines, i, 2) ?? "";
			failures.push({ name, message });
		}

		if (failed === 0 && failures.length > 0) failed = failures.length;
		if (total === 0) total = passed + failed + skipped;

		return { total, passed, failed, skipped, durationMs, failures };
	},
};

/** vitest — default reporter (`Tests  N failed | M passed (T)`, `× Name`). */
const vitestParser: Parser = {
	name: "vitest",
	detect(ctx) {
		const t = ctx.pkgJson?.scripts?.test ?? "";
		const deps = { ...(ctx.pkgJson?.devDependencies ?? {}), ...(ctx.pkgJson?.dependencies ?? {}) };
		if (/\bvitest\b/.test(t) || "vitest" in deps) {
			return ctx.pkgJson?.scripts?.test ? "npm test" : "npx vitest run";
		}
		return null;
	},
	parse(input) {
		const lines = input.stdout.split("\n");
		let total = 0,
			passed = 0,
			failed = 0,
			skipped = 0,
			durationMs: number | undefined;
		const failures: Failure[] = [];

		for (const line of lines) {
			const tm = line.match(/Tests\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed\s*\((\d+)\)/i);
			if (tm) {
				failed = int(tm[1]);
				passed = int(tm[2]);
				total = int(tm[3]);
				continue;
			}
			const dm = line.match(/Duration\s+([\d.]+)\s*s/i);
			if (dm) durationMs = Math.round(Number(dm[1]) * 1000);
		}

		// ` × Name (N ms)` lines mark failures; the ` → message` after is the assertion.
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(/^\s*×\s+(.+?)(?:\s+\d+\s*ms)?\s*$/);
			if (!m) continue;
			const name = m[1].trim();
			let message = "";
			for (let j = i + 1; j < lines.length; j++) {
				const mm = lines[j].match(/^\s*→\s+(.+?)\s*$/);
				if (mm) {
					message = mm[1].trim();
					break;
				}
				if (lines[j].trim() !== "" && !/^\s*→/.test(lines[j])) break;
			}
			failures.push({ name, message });
		}

		if (failed === 0 && failures.length > 0) failed = failures.length;
		skipped = Math.max(0, total - passed - failed);

		return { total, passed, failed, skipped, durationMs, failures };
	},
};

/** cargo — `cargo test` (`test result: FAILED. N passed; M failed;`). */
const cargoParser: Parser = {
	name: "cargo",
	detect(ctx) {
		return ctx.hasCargo ? "cargo test" : null;
	},
	parse(input) {
		const text = input.stdout + "\n" + input.stderr;
		const lines = text.split("\n");
		let total = 0,
			passed = 0,
			failed = 0,
			skipped = 0;
		const failures: Failure[] = [];

		for (const line of lines) {
			const m = line.match(/test result:\s+\w+\.?\s+(\d+)\s+passed;\s+(\d+)\s+failed(?:;\s+(\d+)\s+ignored)?/i);
			if (m) {
				passed += int(m[1]);
				failed += int(m[2]);
				skipped += int(m[3]);
			}
		}
		total = passed + failed + skipped;

		// `failures:` section lists `---- name stdout ----`; the panic line is the message.
		let inFailures = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/^failures:\s*$/i.test(line)) {
				inFailures = true;
				continue;
			}
			if (inFailures) {
				const m = line.match(/^----\s+(.+?)\s+stdout\b/);
				if (m) {
					const name = m[1].trim();
					let message = "";
					for (let j = i + 1; j < lines.length; j++) {
						const pm = lines[j].match(/thread\s+'[^']*'\s+panicked at\b/);
						if (pm) {
							// The panic message is the next non-empty line after the header.
							for (let k = j + 1; k < lines.length; k++) {
								const t = lines[k].trim();
								if (t === "") continue;
								if (/^note:/.test(t)) break;
								message = t;
								break;
							}
							break;
						}
						if (/^----\s/.test(lines[j]) || /^test result:/.test(lines[j])) break;
					}
					failures.push({ name, message });
				}
				if (/^test result:/.test(line)) inFailures = false;
			}
		}

		return { total, passed, failed, skipped, durationMs: undefined, failures };
	},
};

/** go — `go test`/`go test -v` (`--- PASS: name`, `--- FAIL: name`). */
const goParser: Parser = {
	name: "go",
	detect(ctx) {
		return ctx.hasGoMod ? "go test ./..." : null;
	},
	parse(input) {
		const lines = input.stdout.split("\n");
		let passed = 0,
			failed = 0,
			skipped = 0,
			durationMs: number | undefined;
		const failures: Failure[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const pm = line.match(/^---\s+PASS:\s+(.+?)\s+\([\d.]+s\)/);
			const fm = line.match(/^---\s+FAIL:\s+(.+?)\s+\([\d.]+s\)/);
			const sm = line.match(/^---\s+SKIP:\s+(.+?)\s+\([\d.]+s\)/);
			if (pm) passed++;
			else if (sm) skipped++;
			else if (fm) {
				failed++;
				const name = fm[1].trim();
				// The failure message is the preceding indented `file:line: msg` line.
				let message = "";
				for (let j = i - 1; j >= 0; j--) {
					const mm = lines[j].match(/^\s+\S+:\d+:\s*(.+)$/);
					if (mm) {
						message = mm[1].trim();
						break;
					}
					if (/^---\s/.test(lines[j]) || /^===/.test(lines[j])) break;
				}
				failures.push({ name, message });
			}
			const dm = line.match(/^(?:ok|FAIL)\s+\S+\s+([\d.]+)s/);
			if (dm) durationMs = Math.round(Number(dm[1]) * 1000);
		}

		return { total: passed + failed + skipped, passed, failed, skipped, durationMs, failures };
	},
};

/** generic — exit-code-only fallback (e.g. `make test`); no structured parsing. */
const genericParser: Parser = {
	name: "generic",
	detect(ctx) {
		return ctx.hasMakefile ? "make test" : null;
	},
	parse(input) {
		// No structured per-test data; the exit code carries pass/fail. The full
		// log is in the file for the model to grep.
		return { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: undefined, failures: [] };
	},
};

/** Ordered registry: detection probes in this order. */
export const PARSERS: Parser[] = [jestParser, vitestParser, nodeParser, cargoParser, goParser, genericParser];

export function parserByName(name: string | undefined): Parser | undefined {
	if (!name) return undefined;
	return PARSERS.find((p) => p.name === name);
}

// ────────────────────────────────────────────────────────────────────────────
// Config resolution: env > .pi/test.json > auto-detect
// ────────────────────────────────────────────────────────────────────────────

function readPkgJson(cwd: string): PkgJson | null {
	const p = join(cwd, "package.json");
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8")) as PkgJson;
	} catch {
		return null;
	}
}

function buildDetectCtx(cwd: string): DetectCtx {
	return {
		cwd,
		pkgJson: readPkgJson(cwd),
		hasCargo: existsSync(join(cwd, "Cargo.toml")),
		hasGoMod: existsSync(join(cwd, "go.mod")),
		hasMakefile: existsSync(join(cwd, "Makefile")) || existsSync(join(cwd, "makefile")),
	};
}

export interface ResolvedConfig {
	command: string;
	parser: string;
	source: "env" | "file" | "detect";
}

export interface ResolveResult {
	config?: ResolvedConfig;
	error?: string;
}

/** Read `.pi/test.json` if present. */
function readTestJson(cwd: string): { command?: string; parser?: string } | null {
	const p = join(cwd, ".pi", "test.json");
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

export function resolveConfig(cwd: string): ResolveResult {
	const ctx = buildDetectCtx(cwd);

	// 1. Env override.
	const envCommand = process.env.PI_TEST_COMMAND?.trim();
	if (envCommand) {
		return { config: { command: envCommand, parser: process.env.PI_TEST_PARSER?.trim() || detectParserName(ctx) || "generic", source: "env" } };
	}

	// 2. Project file.
	const tj = readTestJson(cwd);
	if (tj?.command?.trim()) {
		return { config: { command: tj.command.trim(), parser: tj.parser?.trim() || detectParserName(ctx) || "generic", source: "file" } };
	}

	// 3. Auto-detect.
	for (const p of PARSERS) {
		const cmd = p.detect(ctx);
		if (cmd) return { config: { command: cmd, parser: p.name, source: "detect" } };
	}

	return { error: "no test command configured (set PI_TEST_COMMAND, create .pi/test.json, or add a recognized manifest)" };
}

/** Resolve just a parser name via auto-detection (for config that omits one). */
function detectParserName(ctx: DetectCtx): string | undefined {
	for (const p of PARSERS) {
		if (p.detect(ctx)) return p.name;
	}
	return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Run + parse core (exported for testing)
// ────────────────────────────────────────────────────────────────────────────

export interface RunResult {
	exitCode: number | null;
	timedOut: boolean;
	outPath: string;
	errPath: string;
	error?: string;
}

function ensureTmp(root: string): string {
	mkdirSync(root, { recursive: true });
	return root;
}

/** Synchronously run a command, piping stdout/stderr to files; await exit. */
export function runCommand(
	command: string,
	cwd: string,
	timeoutSec: number,
	signal: AbortSignal | undefined,
	tmpRoot: string,
): Promise<RunResult> {
	return new Promise((resolve) => {
		const id = randomUUID().slice(0, 8);
		const outPath = join(tmpRoot, `test-${id}.log`);
		const errPath = join(tmpRoot, `test-${id}.err`);
		ensureTmp(tmpRoot);

		let outFd: number | undefined;
		let errFd: number | undefined;
		let child: ChildProcess;
		try {
			outFd = openSync(outPath, "a");
			errFd = openSync(errPath, "a");
			const shellPath = process.env.SHELL || "/bin/sh";
			// Strip Node's internal test-runner context var so a nested `node --test`
			// child runs as an independent runner (not a sub-reporter of this
			// process), producing real output + a nonzero exit on failure.
			const childEnv = { ...process.env };
			delete childEnv.NODE_TEST_CONTEXT;
			child = spawn(shellPath, ["-c", command], {
				cwd,
			env: childEnv,
				stdio: ["ignore", outFd, errFd],
			});
		} catch (e) {
			if (outFd !== undefined) closeSync(outFd);
			if (errFd !== undefined) closeSync(errFd);
			resolve({ exitCode: null, timedOut: false, outPath, errPath, error: `failed to spawn: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}
		closeSync(outFd);
		closeSync(errFd);

		let done = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (r: RunResult) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(r);
		};
		const onAbort = () => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already dead */
			}
			finish({ exitCode: null, timedOut: false, outPath, errPath, error: "aborted" });
		};
		if (timeoutSec > 0) {
			timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already dead */
				}
				finish({ exitCode: null, timedOut: true, outPath, errPath });
			}, timeoutSec * 1000);
			timer.unref?.();
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("exit", (code) => finish({ exitCode: code, timedOut: false, outPath, errPath }));
		child.on("error", (err) => finish({ exitCode: null, timedOut: false, outPath, errPath, error: err.message }));
	});
}

/** Dispatch parse through a named parser (with generic fallback). */
export function parseOutput(parserName: string | undefined, input: ParseInput): Omit<Summary, "status" | "parser" | "logFile" | "errFile" | "error"> {
	const p = parserByName(parserName) ?? genericParser;
	try {
		return p.parse(input);
	} catch {
		return { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: undefined, failures: [] };
	}
}

/** Derive status from a parsed result + run metadata. */
function deriveStatus(parsed: Omit<Summary, "status" | "parser" | "logFile" | "errFile" | "error">, timedOut: boolean, exitCode: number | null): TestStatus {
	if (timedOut) return "timeout";
	if (parsed.failed > 0) return "fail";
	if (exitCode !== null && exitCode !== 0 && parsed.failed === 0 && parsed.total === 0) return "fail";
	return "pass";
}

// ────────────────────────────────────────────────────────────────────────────
// Formatting (compact summary to context)
// ────────────────────────────────────────────────────────────────────────────

function fmtDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	return `${m}m${Math.round(s % 60)}s`;
}

export function formatSummary(s: Summary): string {
	const dur = fmtDuration(s.durationMs);
	const durStr = dur ? ` ${dur}` : "";
	switch (s.status) {
		case "error":
			return `Tests: ERROR — ${s.error ?? "unknown error"}`;
		case "timeout": {
			const parts = [`Tests: TIMEOUT after ${timeoutS()}s${durStr} — ${s.passed} passed, ${s.failed} failed so far (${s.parser})`];
			parts.push(`log: ${s.logFile ?? "(none)"}`);
			parts.push("(partial — switch to bg for long suites: bg start the command, then test parse --file)");
			return parts.join("\n");
		}
		case "pass":
		case "fail":
		default: {
			const mark = s.status === "pass" ? "PASS" : "FAIL";
			const lines = [`Tests: ${mark}  ${s.passed} passed, ${s.failed} failed${s.skipped ? `, ${s.skipped} skipped` : ""}${s.total ? `, ${s.total} total` : ""} (${s.parser})${durStr}`];
			if (s.logFile) lines.push(`log: ${s.logFile}${s.errFile ? ` | stderr: ${s.errFile}` : ""}`);
			if (s.failures.length > 0) {
				lines.push("");
				lines.push(`FAILURES (${s.failures.length}):`);
				const shown = s.failures.slice(0, MAX_FAILURES_SHOWN);
				for (const f of shown) {
					const msg = f.message ? ` — ${f.message}` : "";
					lines.push(`  • ${f.name}${msg}`);
				}
				if (s.failures.length > MAX_FAILURES_SHOWN) {
					lines.push(`  ... ${s.failures.length - MAX_FAILURES_SHOWN} more (see log)`);
				}
			}
			return lines.join("\n");
		}
	}
}

// ────────────────────────────────────────────────────────────────────────────
// TUI component for /test
// ────────────────────────────────────────────────────────────────────────────

class TestSummaryComponent {
	private summary: Summary;
	private theme: Theme;
	private onClose: () => void;

	constructor(summary: Summary, theme: Theme, onClose: () => void) {
		this.summary = summary;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		const th = this.theme;
		const s = this.summary;
		const lines: string[] = [];
		lines.push("");

		const title = th.fg("accent", " Test results ");
		const headerLine = th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 14)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		const mark =
			s.status === "pass" ? th.fg("success", "✓ PASS") : s.status === "fail" ? th.fg("error", "✗ FAIL") : s.status === "timeout" ? th.fg("warning", "⏱ TIMEOUT") : th.fg("error", "⚠ ERROR");
		const counts = th.fg("muted", `${s.passed} passed, ${s.failed} failed${s.skipped ? `, ${s.skipped} skipped` : ""}`);
		lines.push(truncateToWidth(`  ${mark}  ${counts} ${th.fg("dim", `(${s.parser})`)}`, width));
		if (s.durationMs !== undefined) lines.push(truncateToWidth(`  ${th.fg("dim", fmtDuration(s.durationMs))}`, width));
		if (s.logFile) lines.push(truncateToWidth(`  ${th.fg("dim", "log:")} ${th.fg("text", s.logFile)}`, width));
		if (s.error) lines.push(truncateToWidth(`  ${th.fg("error", s.error)}`, width));

		if (s.failures.length > 0) {
			lines.push("");
			const shown = s.failures.slice(0, MAX_FAILURES_SHOWN);
			for (const f of shown) {
				const msg = f.message ? ` ${th.fg("dim", `— ${f.message}`)}` : "";
				lines.push(truncateToWidth(`  ${th.fg("error", "•")} ${th.fg("text", f.name)}${msg}`, width));
			}
			if (s.failures.length > MAX_FAILURES_SHOWN) {
				lines.push(truncateToWidth(`  ${th.fg("dim", `... ${s.failures.length - MAX_FAILURES_SHOWN} more`)}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");
		return lines;
	}

	invalidate(): void {}
}

// ────────────────────────────────────────────────────────────────────────────
// Tool params
// ────────────────────────────────────────────────────────────────────────────

const TestParams = Type.Object({
	action: StringEnum(["run", "parse"] as const, {
		description: "run: exec the project's test command and parse. parse: distill existing output (file or text) into a summary.",
	}),
	command: Type.Optional(Type.String({ description: "run: override the test command (subset/filter runs). Parser still resolved from config/detection." })),
	parser: Type.Optional(Type.String({ description: "Override the parser (jest|vitest|cargo|go|node|generic). run: applies to the run; parse: applies to the input." })),
	cwd: Type.Optional(Type.String({ description: "run: working directory (default current cwd)" })),
	timeout: Type.Optional(Type.Number({ description: `run: timeout in seconds (default ${TIMEOUT_DEFAULT}, env PI_TEST_TIMEOUT; 0 = unbounded)` })),
	file: Type.Optional(Type.String({ description: "parse: path to stdout (e.g. a bg output file) to parse" })),
	stderrFile: Type.Optional(Type.String({ description: "parse: path to stderr to include" })),
	text: Type.Optional(Type.String({ description: "parse: inline stdout text to parse" })),
	stderrText: Type.Optional(Type.String({ description: "parse: inline stderr text to include" })),
	exitCode: Type.Optional(Type.Number({ description: "parse: exit code if known (else inferred from parsed fail count)" })),
});

interface TestDetails {
	action: "run" | "parse";
	summary?: Summary;
	error?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Extension factory
// ────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	if (disabled()) return;

	let tmpRoot: string | undefined;
	let lastSummary: Summary | undefined;

	const ensureRoot = (): string => {
		if (tmpRoot) return tmpRoot;
		const base = process.env.TMPDIR || tmpdir();
		tmpRoot = join(base, `pi-test-${randomUUID().slice(0, 8)}`);
		return ensureTmp(tmpRoot);
	};

	pi.on("session_shutdown", async () => {
		if (tmpRoot) {
			try {
				rmSync(tmpRoot, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
			tmpRoot = undefined;
		}
		lastSummary = undefined;
	});

	const test = defineTool({
		name: "test",
		label: "Test runner",
		description: [
			"Run the project's test/build suite and get a compact pass/fail summary (counts + failing-test names + one-line messages), not raw stdout. One tool, action enum: run (exec + parse) or parse (distill existing output).",
			"Use test when running the project's test suite and you want a compact pass/fail summary — especially multi-test runs or iterative fix loops. Nonzero exit = status:fail (not an error).",
			"For a one-off command, a non-test command, or when you need raw/interactive output, use bash. For long suites you'd background, use bg to spawn it, then test parse --file <bg stdout file> to distill.",
			"The full log is written to a file whose path test returns; grep/read/tail that file for stack traces and detail beyond the summary.",
		].join(" "),
		promptSnippet: "Run the project's test suite and get a compact pass/fail summary (run/parse)",
		promptGuidelines: [
			"Use test with action:run for the project's test/build suite when you want a compact pass/fail summary, especially multi-test runs or iterative fix loops; nonzero exit is status:fail, not an error.",
			"Don't use test for a one-off/non-test command or when you need raw output — use bash. For long suites, bg start the command and then test parse --file <path> rather than blocking on a long run.",
		],
		parameters: TestParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				case "run": {
					const cwd = params.cwd || ctx.cwd;
					const { config, error } = resolveConfig(cwd);
					const command = params.command?.trim() || config?.command;
					const parserName = params.parser?.trim() || config?.parser;
					if (!command) {
						const err = error ?? "no test command resolved";
						const summary: Summary = { status: "error", total: 0, passed: 0, failed: 0, skipped: 0, failures: [], parser: parserName ?? "generic", error: err };
						lastSummary = summary;
						return { content: [{ type: "text", text: formatSummary(summary) }], details: { action: "run", summary, error: err } as TestDetails };
					}
					// Validate cwd.
					try {
						accessSync(cwd, constants.X_OK);
					} catch {
						const err = `cwd not accessible: ${cwd}`;
						const summary: Summary = { status: "error", total: 0, passed: 0, failed: 0, skipped: 0, failures: [], parser: parserName ?? "generic", error: err };
						return { content: [{ type: "text", text: formatSummary(summary) }], details: { action: "run", summary, error: err } as TestDetails };
					}
					const to = params.timeout !== undefined ? Math.max(0, params.timeout) : timeoutS();
					const root = ensureRoot();
					const rr = await runCommand(command, cwd, to, signal, root);
					if (rr.error) {
						const summary: Summary = { status: "error", total: 0, passed: 0, failed: 0, skipped: 0, failures: [], parser: parserName ?? "generic", error: rr.error };
						return { content: [{ type: "text", text: formatSummary(summary) }], details: { action: "run", summary, error: rr.error } as TestDetails };
					}
					const stdout = existsSync(rr.outPath) ? readFileSync(rr.outPath, "utf8") : "";
					const stderr = existsSync(rr.errPath) ? readFileSync(rr.errPath, "utf8") : "";
					const parsed = parseOutput(parserName, { stdout, stderr, exitCode: rr.exitCode, timedOut: rr.timedOut });
					const status = deriveStatus(parsed, rr.timedOut, rr.exitCode);
					const summary: Summary = {
						...parsed,
						status,
						parser: parserName ?? "generic",
						logFile: rr.outPath,
						errFile: rr.errPath,
					};
					lastSummary = summary;
					return { content: [{ type: "text", text: formatSummary(summary) }], details: { action: "run", summary } as TestDetails };
				}

				case "parse": {
					const cwd = ctx.cwd;
					const file = params.file?.trim();
					const text = params.text;
					let stdout = "";
					let stderr = params.stderrText ?? "";
					if (file) {
						try {
							stdout = readFileSync(file, "utf8");
						} catch (e) {
							const err = `could not read file: ${e instanceof Error ? e.message : String(e)}`;
							const summary: Summary = { status: "error", total: 0, passed: 0, failed: 0, skipped: 0, failures: [], parser: "generic", error: err };
							return { content: [{ type: "text", text: formatSummary(summary) }], details: { action: "parse", summary, error: err } as TestDetails };
						}
						if (params.stderrFile) {
							try {
								stderr = readFileSync(params.stderrFile, "utf8");
							} catch {
								/* ignore */
							}
						}
					} else if (text !== undefined) {
						stdout = text;
					} else {
						const err = "parse requires either file or text";
						const summary: Summary = { status: "error", total: 0, passed: 0, failed: 0, skipped: 0, failures: [], parser: "generic", error: err };
						return { content: [{ type: "text", text: formatSummary(summary) }], details: { action: "parse", summary, error: err } as TestDetails };
					}
					const parserName = params.parser?.trim() || resolveConfig(cwd).config?.parser || "generic";
					const exitCode = params.exitCode !== undefined ? params.exitCode : 0;
					const parsed = parseOutput(parserName, { stdout, stderr, exitCode, timedOut: false });
					const status = deriveStatus(parsed, false, exitCode);
					const summary: Summary = { ...parsed, status, parser: parserName, logFile: file };
					return { content: [{ type: "text", text: formatSummary(summary) }], details: { action: "parse", summary } as TestDetails };
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: { action: "run", error: `unknown action` } as TestDetails };
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("test ")) + theme.fg("muted", args.action);
			if (args.command) text += ` ${theme.fg("dim", `"${args.command.length > 40 ? `${args.command.slice(0, 39)}…` : args.command}"`)}`;
			if (args.file) text += ` ${theme.fg("dim", args.file)}`;
			if (args.parser) text += ` ${theme.fg("accent", args.parser)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TestDetails | undefined;
			const th = theme;
			if (!details) {
				const c = result.content[0];
				return new Text(c?.type === "text" ? c.text : "", 0, 0);
			}
			if (details.error && !details.summary) return new Text(th.fg("error", `Error: ${details.error}`), 0, 0);
			const s = details.summary!;
			const mark = s.status === "pass" ? th.fg("success", "✓") : s.status === "fail" ? th.fg("error", "✗") : s.status === "timeout" ? th.fg("warning", "⏱") : th.fg("error", "⚠");
			const head = `${mark} ${th.fg("muted", s.status.toUpperCase())} ${th.fg("dim", `${s.passed}p/${s.failed}f`)} ${th.fg("accent", s.parser)}`;
			if (!expanded || s.failures.length === 0) {
				return new Text(head, 0, 0);
			}
			let t = head;
			for (const f of s.failures.slice(0, MAX_FAILURES_SHOWN)) {
				t += `\n${th.fg("error", "•")} ${th.fg("text", f.name)}${f.message ? ` ${th.fg("dim", `— ${f.message}`)}` : ""}`;
			}
			if (s.failures.length > MAX_FAILURES_SHOWN) t += `\n${th.fg("dim", `... ${s.failures.length - MAX_FAILURES_SHOWN} more`)}`;
			if (s.logFile) t += `\n${th.fg("dim", s.logFile)}`;
			return new Text(t, 0, 0);
		},
	});

	pi.registerTool(test);

	pi.registerCommand("test", {
		description: "Run the project's test suite and show a compact summary",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/test requires interactive mode", "error");
				return;
			}
			const { config, error } = resolveConfig(ctx.cwd);
			if (!config || error) {
				ctx.ui.notify(error ?? "no test command configured", "error");
				return;
			}
			ctx.ui.notify(`Running: ${config.command}`, "info");
			const root = ensureRoot();
			const rr = await runCommand(config.command, ctx.cwd, timeoutS(), undefined, root);
			if (rr.error) {
				ctx.ui.notify(`test run failed: ${rr.error}`, "error");
				return;
			}
			const stdout = existsSync(rr.outPath) ? readFileSync(rr.outPath, "utf8") : "";
			const stderr = existsSync(rr.errPath) ? readFileSync(rr.errPath, "utf8") : "";
			const parsed = parseOutput(config.parser, { stdout, stderr, exitCode: rr.exitCode, timedOut: rr.timedOut });
			const summary: Summary = { ...parsed, status: deriveStatus(parsed, rr.timedOut, rr.exitCode), parser: config.parser, logFile: rr.outPath, errFile: rr.errPath };
			lastSummary = summary;
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TestSummaryComponent(summary, theme, () => done());
			});
		},
	});
}
