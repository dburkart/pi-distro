/**
 * Tests for the `bg` extension (roadmap H2) — loads it under jiti and drives
 * the real `bg` tool's execute path (start → read → stop) to exercise
 * detached spawn, file output, the read tail, and session_shutdown cleanup.
 * Also doubles as a second node:test suite for the distro repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadExt } from "../load.mjs";

const mod = await loadExt("agent/extensions/bg/index.ts");

function makeStub() {
	const tools = [];
	const commands = [];
	const events = {};
	const stub = {
		registerTool: (t) => void tools.push(t),
		registerCommand: (n, c) => void commands.push([n, c]),
		on: (ev, fn) => void (events[ev] = fn),
	};
	return { stub, tools, commands, events };
}

test("bg factory registers the `bg` tool and `/bg` command", () => {
	const { stub, tools, commands, events } = makeStub();
	(mod.default ?? mod)(stub);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "bg");
	assert.ok(commands.some(([n]) => n === "bg"));
	assert.equal(typeof events.session_shutdown, "function");
});

test("bg tool: start a sleeper, read its output, stop it", async () => {
	const { stub, tools, events } = makeStub();
	(mod.default ?? mod)(stub);
	const bg = tools[0];
	const cwd = tmpdir();

	// start
	const startRes = await bg.execute("t", { action: "start", command: "echo hello-from-bg; sleep 0.2" }, undefined, undefined, { cwd });
	assert.ok(startRes.details?.shell, "start returns a shell");
	const handle = startRes.details.shell.handle;
	const outPath = startRes.details.shell.outPath;
	assert.ok(existsSync(outPath), "stdout file created");

	// read with a wait long enough for the echo to flush
	const readRes = await bg.execute("t", { action: "read", handle, wait: 2, lines: 50, stream: "both" }, undefined, undefined, { cwd });
	assert.ok(readRes.details.outTail?.includes("hello-from-bg"), `tail has output: ${readRes.details.outTail}`);

	// give the sleep time to finish, then read status
	await new Promise((r) => setTimeout(r, 400));
	const finalRes = await bg.execute("t", { action: "read", handle, wait: 0, lines: 10 }, undefined, undefined, { cwd });
	assert.match(finalRes.details.shell.status, /exited|stopped/);

	// stop is idempotent-ish on a finished shell
	const stopRes = await bg.execute("t", { action: "stop", handle }, undefined, undefined, { cwd });
	assert.equal(stopRes.details.shell.handle, handle);

	// shutdown cleanup removes the tmpdir
	await events.session_shutdown();
	assert.ok(!existsSync(outPath), "tmpdir cleaned on shutdown");
});

test("bg tool: read on a missing handle errors cleanly", async () => {
	const { stub, tools } = makeStub();
	(mod.default ?? mod)(stub);
	const bg = tools[0];
	const res = await bg.execute("t", { action: "read", handle: 99999 }, undefined, undefined, { cwd: tmpdir() });
	assert.ok(res.details.error, "missing handle → error");
	assert.match(res.content[0].text, /not found/);
});

test("bg tool: list with no shells", async () => {
	const { stub, tools } = makeStub();
	(mod.default ?? mod)(stub);
	const bg = tools[0];
	const res = await bg.execute("t", { action: "list" }, undefined, undefined, { cwd: tmpdir() });
	assert.equal(res.content[0].text, "No background shells");
});
