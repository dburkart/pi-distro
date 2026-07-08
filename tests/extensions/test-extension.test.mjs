/**
 * Integration tests for the `test` extension: config resolution (env > file >
 * auto-detect), a LIVE end-to-end run through runCommand + the node/TAP
 * parser (proves the spawn-to-file + parse path), formatSummary shapes, and
 * that the factory registers the `test` tool + `/test` command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExt } from "../load.mjs";

const mod = await loadExt("agent/extensions/test/index.ts");
const { resolveConfig, runCommand, parseOutput, formatSummary, PARSERS } = mod;

function tempDir(prefix = "pi-test-cfg-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

// ── Config resolution: env > file > detect ─────────────────────────────────

test("resolveConfig: env PI_TEST_COMMAND overrides everything", () => {
	const prev = process.env.PI_TEST_COMMAND;
	const prevP = process.env.PI_TEST_PARSER;
	process.env.PI_TEST_COMMAND = "my-runner --foo";
	process.env.PI_TEST_PARSER = "generic";
	try {
		const d = resolveConfig(tmpdir());
		assert.ok(d.config, "config resolved from env");
		assert.equal(d.config.command, "my-runner --foo");
		assert.equal(d.config.source, "env");
		assert.equal(d.config.parser, "generic");
	} finally {
		if (prev === undefined) delete process.env.PI_TEST_COMMAND;
		else process.env.PI_TEST_COMMAND = prev;
		if (prevP === undefined) delete process.env.PI_TEST_PARSER;
		else process.env.PI_TEST_PARSER = prevP;
	}
});

test("resolveConfig: .pi/test.json supplies command + parser", () => {
	const d = tempDir("pi-test-json-");
	mkdirSync(join(d, ".pi"));
	writeFileSync(join(d, ".pi", "test.json"), JSON.stringify({ command: "node --test", parser: "node" }));
	const r = resolveConfig(d);
	assert.ok(r.config);
	assert.equal(r.config.command, "node --test");
	assert.equal(r.config.parser, "node");
	assert.equal(r.config.source, "file");
});

test("resolveConfig: auto-detect package.json with node --test script", () => {
	const d = tempDir("pi-test-pkg-");
	writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "node --test tests/" } }));
	const r = resolveConfig(d);
	assert.ok(r.config);
	assert.equal(r.config.parser, "node");
	assert.equal(r.config.command, "node --test --test-reporter=tap");
	assert.equal(r.config.source, "detect");
});

test("resolveConfig: auto-detect Cargo.toml → cargo test", () => {
	const d = tempDir("pi-test-cargo-");
	writeFileSync(join(d, "Cargo.toml"), "[package]\nname = \"x\"\nversion = \"0\"\n");
	const r = resolveConfig(d);
	assert.ok(r.config);
	assert.equal(r.config.parser, "cargo");
	assert.equal(r.config.command, "cargo test");
});

test("resolveConfig: auto-detect go.mod → go test ./...", () => {
	const d = tempDir("pi-test-go-");
	writeFileSync(join(d, "go.mod"), "module x\ngo 1.23\n");
	const r = resolveConfig(d);
	assert.ok(r.config);
	assert.equal(r.config.parser, "go");
	assert.equal(r.config.command, "go test ./...");
});

test("resolveConfig: Makefile → make test (generic)", () => {
	const d = tempDir("pi-test-mk-");
	writeFileSync(join(d, "Makefile"), "test:\n\techo hi\n");
	const r = resolveConfig(d);
	assert.ok(r.config);
	assert.equal(r.config.parser, "generic");
	assert.equal(r.config.command, "make test");
});

test("resolveConfig: no manifest + no config → error", () => {
	const d = tempDir("pi-test-none-");
	const r = resolveConfig(d);
	assert.ok(!r.config);
	assert.ok(r.error && /no test command configured/.test(r.error), r.error);
});

// ── Live run: runCommand + node/TAP parser end-to-end ─────────────────────

test("runCommand + parse: real failing node:test suite → status fail", async () => {
	const suiteDir = tempDir("pi-test-live-");
	writeFileSync(
		join(suiteDir, "fail.test.mjs"),
		`import { test } from "node:test"; import assert from "node:assert";
test("ok one", () => assert.equal(1, 1));
test("bad one", () => assert.equal(2, 3));
test("boom", () => { throw new Error("boom: bad value"); });
`,
	);
	const outRoot = tempDir("pi-test-out-");
	const rr = await runCommand(
		`node --test --test-reporter=tap ${join(suiteDir, "fail.test.mjs")}`,
		suiteDir,
		30,
		undefined,
		outRoot,
	);
	assert.ok(!rr.error, rr.error);
	assert.notEqual(rr.exitCode, 0, "nonzero exit on failure");
	const stdout = readFileSync(rr.outPath, "utf8");
	assert.match(stdout, /TAP version 13/);
	const s = parseOutput("node", { stdout, stderr: "", exitCode: rr.exitCode, timedOut: false });
	// Build a full Summary (like the tool does) and check status.
	const status = s.failed > 0 ? "fail" : "pass";
	assert.equal(status, "fail");
	assert.ok(s.failed >= 2, `failed>=2, got ${s.failed}`);
	assert.ok(s.failures.some((f) => f.name === "boom"), `boom in ${s.failures.map((f) => f.name).join("|")}`);
	const boom = s.failures.find((f) => f.name === "boom");
	assert.equal(boom.message, "boom: bad value");
	// The log file must exist and be readable (the escape hatch).
	assert.ok(rr.outPath && readFileSync(rr.outPath, "utf8").length > 0);
	rmSync(suiteDir, { recursive: true, force: true });
	rmSync(outRoot, { recursive: true, force: true });
});

test("runCommand: passing suite → exit 0, parser status pass", async () => {
	const suiteDir = tempDir("pi-test-pass-");
	writeFileSync(
		join(suiteDir, "ok.test.mjs"),
		`import { test } from "node:test"; import assert from "node:assert";
test("ok", () => assert.ok(true));
`,
	);
	const outRoot = tempDir("pi-test-outp-");
	const rr = await runCommand(`node --test --test-reporter=tap ${join(suiteDir, "ok.test.mjs")}`, suiteDir, 30, undefined, outRoot);
	assert.equal(rr.exitCode, 0);
	const stdout = readFileSync(rr.outPath, "utf8");
	const s = parseOutput("node", { stdout, stderr: "", exitCode: 0, timedOut: false });
	assert.equal(s.failed, 0);
	assert.ok(s.passed >= 1);
	rmSync(suiteDir, { recursive: true, force: true });
	rmSync(outRoot, { recursive: true, force: true });
});

// ── formatSummary shapes ───────────────────────────────────────────────────

test("formatSummary: fail includes FAILURES block + log path", () => {
	const s = {
		status: "fail", total: 5, passed: 3, failed: 2, skipped: 0,
		failures: [{ name: "a", message: "boom" }, { name: "b", message: "" }],
		parser: "node", logFile: "/tmp/x.log",
	};
	const out = formatSummary(s);
	assert.match(out, /Tests: FAIL/);
	assert.match(out, /2 failed/);
	assert.match(out, /FAILURES \(2\)/);
	assert.match(out, /• a — boom/);
	assert.match(out, /log: \/tmp\/x\.log/);
});

test("formatSummary: timeout nudges toward bg + parse", () => {
	const s = { status: "timeout", total: 2, passed: 1, failed: 1, skipped: 0, failures: [], parser: "node" };
	const out = formatSummary(s);
	assert.match(out, /Tests: TIMEOUT/);
	assert.match(out, /bg for long suites/);
});

test("formatSummary: error is a single line", () => {
	const out = formatSummary({ status: "error", total: 0, passed: 0, failed: 0, skipped: 0, failures: [], parser: "generic", error: "no command" });
	assert.match(out, /Tests: ERROR — no command/);
});

// ── Factory registers tool + command ───────────────────────────────────────

test("factory registers the `test` tool and `/test` command", () => {
	const tools = [];
	const commands = [];
	const events = {};
	const stub = {
		registerTool: (t) => void tools.push(t),
		registerCommand: (n, c) => void commands.push([n, c]),
		on: (ev, fn) => void (events[ev] = fn),
	};
	const factory = mod.default ?? mod;
	factory(stub);
	assert.equal(tools.length, 1, `one tool, got ${tools.length}`);
	assert.equal(tools[0].name, "test");
	assert.ok(commands.some(([n]) => n === "test"), "registers /test command");
	assert.equal(typeof events.session_shutdown, "function", "registers session_shutdown cleanup");
});

test("factory is a no-op when PI_TEST_DISABLED is set", () => {
	const prev = process.env.PI_TEST_DISABLED;
	process.env.PI_TEST_DISABLED = "1";
	const tools = [];
	const stub = { registerTool: (t) => void tools.push(t), registerCommand: () => {}, on: () => {} };
	try {
		(mod.default ?? mod)(stub);
		assert.equal(tools.length, 0, "disabled → registers nothing");
	} finally {
		if (prev === undefined) delete process.env.PI_TEST_DISABLED;
		else process.env.PI_TEST_DISABLED = prev;
	}
});
