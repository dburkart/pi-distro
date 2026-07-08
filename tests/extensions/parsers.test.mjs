/**
 * Unit tests for the `test` extension's parsers — each fed a representative
 * fixture of a real runner's output (node TAP captured live; jest/vitest/
 * cargo/go from their documented formats, since those toolchains can't run in
 * this sandbox). Asserts the compact Summary fields the tool returns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExt } from "../load.mjs";

const mod = await loadExt("agent/extensions/test/index.ts");
const parseOutput = mod.parseOutput;
const PARSERS = mod.PARSERS;

function parse(name, stdout, exitCode = 1, stderr = "") {
	return parseOutput(name, { stdout, stderr, exitCode, timedOut: false });
}

const TAP_FIXTURE = `TAP version 13
# Subtest: passes ok
ok 1 - passes ok
  ---
  duration_ms: 0.679084
  ...
# Subtest: group
    # Subtest: nested pass
    ok 1 - nested pass
      ---
      duration_ms: 0.084791
      ...
    # Subtest: nested fail
    not ok 2 - nested fail
      ---
      duration_ms: 0.541416
      error: '2 == 3'
      ...
    1..2
not ok 2 - group
  ---
  duration_ms: 0.856208
  error: '1 subtest failed'
  ...
# Subtest: throws
not ok 3 - throws
  ---
  duration_ms: 0.050583
  error: 'boom: bad value'
  ...
1..3
# tests 5
# suites 0
# pass 2
# fail 3
# cancelled 0
# skipped 0
# duration_ms 76.340375
`;

test("node parser: TAP summary + failures", () => {
	const s = parse("node", TAP_FIXTURE, 1);
	assert.equal(s.total, 5, "total from # tests");
	assert.equal(s.passed, 2);
	assert.equal(s.failed, 3);
	assert.equal(s.failures.length, 3);
	const names = s.failures.map((f) => f.name);
	assert.ok(names.includes("throws"), `throws in ${names}`);
	assert.ok(names.includes("nested fail"), `nested fail in ${names}`);
	assert.ok(names.includes("group"), `group in ${names}`);
	const throwsF = s.failures.find((f) => f.name === "throws");
	assert.equal(throwsF.message, "boom: bad value");
	const nested = s.failures.find((f) => f.name === "nested fail");
	assert.equal(nested.message, "2 == 3");
});

test("node parser: passing run", () => {
	const ok = `TAP version 13
ok 1 - a
ok 2 - b
1..2
# tests 2
# pass 2
# fail 0
`;
	const s = parse("node", ok, 0);
	assert.equal(s.total, 2);
	assert.equal(s.passed, 2);
	assert.equal(s.failed, 0);
	assert.equal(s.failures.length, 0);
});

test("node parser: missing summary pragmas fall back to ok/not-ok counting", () => {
	const bare = `TAP version 13
ok 1 - a
not ok 2 - b
1..2
`;
	const s = parse("node", bare, 1);
	assert.equal(s.total, 2);
	assert.equal(s.passed, 1);
	assert.equal(s.failed, 1);
	assert.equal(s.failures.length, 1);
	assert.equal(s.failures[0].name, "b");
});

const JEST_FIXTURE = `PASS  src/a.test.ts
FAIL  src/b.test.ts
  ● b suite › fails on purpose (5 ms)

    expect(received).toBe(expected)

      Expected: 3
      Received: 2

  ● b suite › throws (2 ms)

Test Suites: 1 failed, 1 passed, 2 total
Tests:       2 failed, 3 passed, 5 total
Snapshots:   0 total
Time:        1.23 s
`;

test("jest parser: summary + named failures", () => {
	const s = parse("jest", JEST_FIXTURE, 1);
	assert.equal(s.total, 5);
	assert.equal(s.passed, 3);
	assert.equal(s.failed, 2);
	assert.equal(s.failures.length, 2);
	const names = s.failures.map((f) => f.name);
	assert.ok(names.some((n) => n.includes("fails on purpose")), names.join("|"));
	assert.ok(names.some((n) => n.includes("throws")), names.join("|"));
	assert.equal(s.durationMs, 1230);
});

const VITEST_FIXTURE = ` ❯ src/b.test.ts (2 tests | 2 failed) 4ms
   × fails on purpose 2 ms
     → expected 3 to be 2
   × throws 1 ms
     → oops
 ⎯⎯⎯ Failed Tests ⎯⎯⎯
 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 3 passed (5)
   Duration  1.23s
`;

test("vitest parser: summary + named failures + messages", () => {
	const s = parse("vitest", VITEST_FIXTURE, 1);
	assert.equal(s.total, 5);
	assert.equal(s.passed, 3);
	assert.equal(s.failed, 2);
	assert.equal(s.failures.length, 2);
	const fp = s.failures.find((f) => f.name === "fails on purpose");
	assert.ok(fp, `fails on purpose in ${s.failures.map((f) => f.name).join("|")}`);
	assert.equal(fp.message, "expected 3 to be 2");
	const th = s.failures.find((f) => f.name === "throws");
	assert.equal(th.message, "oops");
	assert.equal(s.durationMs, 1230);
});

const CARGO_FIXTURE = `running 3 tests
test it_passes ... ok
test it_fails ... FAILED
test group ... ok

failures:

---- it_fails stdout ----
thread 'it_fails' panicked at src/lib.rs:5:9:
assertion \`left == right\` failed
  left and right have the same value
  left: 4
 right: 5
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
`;

test("cargo parser: result line + panic message", () => {
	const s = parse("cargo", CARGO_FIXTURE, 101);
	assert.equal(s.passed, 2);
	assert.equal(s.failed, 1);
	assert.equal(s.total, 3);
	assert.equal(s.failures.length, 1);
	assert.equal(s.failures[0].name, "it_fails");
	assert.ok(s.failures[0].message.includes("assertion"), s.failures[0].message);
});

const GO_FIXTURE = `=== RUN   TestPass
--- PASS: TestPass (0.00s)
=== RUN   TestFail
    main_test.go:5: expected 3 got 2
--- FAIL: TestFail (0.00s)
=== RUN   TestSub
=== RUN   TestSub/ok
--- PASS: TestSub/ok (0.00s)
=== RUN   TestSub/bad
    main_test.go:9: sub bad value
--- FAIL: TestSub/bad (0.00s)
--- FAIL: TestSub (0.00s)
FAIL
FAIL	gotest	0.123s
`;

test("go parser: pass/fail counts + failure messages", () => {
	const s = parse("go", GO_FIXTURE, 1);
	assert.equal(s.passed, 2, "TestPass + TestSub/ok");
	assert.equal(s.failed, 3, "TestFail + TestSub/bad + TestSub");
	assert.equal(s.total, 5);
	const tf = s.failures.find((f) => f.name === "TestFail");
	assert.ok(tf, `TestFail in ${s.failures.map((f) => f.name).join("|")}`);
	assert.equal(tf.message, "expected 3 got 2");
	const sub = s.failures.find((f) => f.name === "TestSub/bad");
	assert.equal(sub.message, "sub bad value");
	assert.equal(s.durationMs, 123);
});

test("generic parser: exit-code-only fallback, no structured data", () => {
	const s = parse("generic", "some make output\nexit 1\n", 2);
	assert.equal(s.total, 0);
	assert.equal(s.failed, 0);
	assert.equal(s.failures.length, 0);
});

test("unknown parser name falls back to generic", () => {
	const s = parseOutput("nope", { stdout: "x", stderr: "", exitCode: 1, timedOut: false });
	assert.equal(s.failed, 0); // generic returns 0 — status is derived upstream
	assert.equal(s.total, 0);
});

test("PARSERS registry is ordered for detection", () => {
	const names = PARSERS.map((p) => p.name);
	assert.deepEqual(names, ["jest", "vitest", "node", "cargo", "go", "generic"]);
});
