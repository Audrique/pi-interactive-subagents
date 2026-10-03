import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { commandWithCompletion, pollForExit, shellEscape } from "../pi-extension/subagents/herdr.ts";
import { reportOutcome, type Outcome } from "../pi-extension/subagents/orchestrator/outcome.ts";

function completionFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-completion-")), env = { ...process.env };
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "completion:parent" });
  t.after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });
  return { dir, completion: { file: join(dir, "completion 'quoted'.json"), runId: "current-run" } };
}

for (const exitCode of [0, 7, 137, 255]) {
  test(`wrapper publishes exit ${exitCode} only after its foreground child exits`, { timeout: 5000 }, async t => {
    const { completion } = completionFixture(t);
    const child = `printf 'ready\\n'; IFS= read -r answer; exit ${exitCode}`;
    const process = childProcess.spawn("bash", ["-e", "-c", commandWithCompletion(`bash -c ${shellEscape(child)}`, completion)]);
    t.after(() => { process.stdin.destroy(); process.kill("SIGKILL"); });
    const closed = once(process, "close");
    assert.equal(String((await once(process.stdout, "data"))[0]), "ready\n");
    assert.equal(existsSync(completion.file), false, "no completion while the child awaits input");
    process.stdin.end("finish\n");
    assert.deepEqual(await closed, [exitCode, null]);
    assert.deepEqual(JSON.parse(readFileSync(completion.file, "utf8")), { version: 1, runId: completion.runId, exitCode });
    assert.equal(statSync(completion.file).mode & 0o777, 0o600);
    assert.equal(existsSync(`${completion.file}.tmp`), false);
  });
}

test("wrapper preserves signal termination as the shell exit status", async t => {
  const { completion } = completionFixture(t);
  const result = childProcess.spawnSync("bash", ["-e", "-c", commandWithCompletion(`bash -c ${shellEscape("kill -TERM $$")}`, completion)]);
  assert.equal(result.status, 143);
  assert.deepEqual(JSON.parse(readFileSync(completion.file, "utf8")), { version: 1, runId: completion.runId, exitCode: 143 });
});

test("wrapper reports a failed cwd change without executing the child", async t => {
  const { dir, completion } = completionFixture(t);
  const ran = join(dir, "should-not-run");
  const result = childProcess.spawnSync("bash", ["-e", "-c", commandWithCompletion(
    `cd ${shellEscape(join(dir, "missing directory"))} && touch ${shellEscape(ran)}`, completion,
  )]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(ran), false);
  assert.deepEqual(JSON.parse(readFileSync(completion.file, "utf8")), { version: 1, runId: completion.runId, exitCode: 1 });
});

for (const [label, screen] of [
  ["blank pane", ""],
  ["narrow wrapped prompt hiding the marker", "ding-rs on\n main via\n Rust in\n impure\n> "],
  ["completion marker printed by a still-running child", "__SUBAGENT_DONE_0__"],
]) {
  test(`watcher uses process completion, not ${label}`, async t => {
    const { completion } = completionFixture(t);
    let ticks = 0, reads = 0;
    t.mock.method(childProcess, "execFile", (_file: string, _args: string[], _options: unknown, cb: Function) => {
      reads++; cb(null, screen);
    });
    const result = await pollForExit("completion:child", new AbortController().signal, {
      interval: 1, completion, onTick() {
        ticks++;
        writeFileSync(completion.file, JSON.stringify({ version: 1, runId: completion.runId, exitCode: 7 }));
      },
    });
    assert.deepEqual(result, { reason: "done", exitCode: 7 });
    assert.equal(ticks, 1); assert.equal(reads, 1);
  });
}

for (const [label, payload] of [
  ["malformed JSON", "{"],
  ["null", "null"],
  ["stale run", JSON.stringify({ version: 1, runId: "previous-run", exitCode: 0 })],
  ["unknown version", JSON.stringify({ version: 2, runId: "current-run", exitCode: 0 })],
  ["missing exit code", JSON.stringify({ version: 1, runId: "current-run" })],
  ["string exit code", JSON.stringify({ version: 1, runId: "current-run", exitCode: "0" })],
  ["negative exit code", JSON.stringify({ version: 1, runId: "current-run", exitCode: -1 })],
  ["fractional exit code", JSON.stringify({ version: 1, runId: "current-run", exitCode: 0.5 })],
  ["out-of-range exit code", JSON.stringify({ version: 1, runId: "current-run", exitCode: 256 })],
]) {
  test(`watcher ignores ${label} until a valid current-run record arrives`, async t => {
    const { completion } = completionFixture(t);
    writeFileSync(completion.file, payload);
    let ticks = 0;
    t.mock.method(childProcess, "execFile", (_file: string, _args: string[], _options: unknown, cb: Function) => cb(null, "__SUBAGENT_DONE_0__"));
    const result = await pollForExit("completion:child", new AbortController().signal, {
      interval: 1, completion, onTick() {
        ticks++;
        writeFileSync(completion.file, JSON.stringify({ version: 1, runId: completion.runId, exitCode: 19 }));
      },
    });
    assert.equal(ticks, 1);
    assert.deepEqual(result, { reason: "done", exitCode: 19 });
  });
}

for (const [label, payload] of [
  ["obsolete done", { type: "done" }],
  ["obsolete question ping", { type: "ping", question: "Continue?" }],
  ["unknown shape", {}],
  ["null", null],
]) {
  test(`legacy ${label} exit sidecar cannot finish a new run`, async t => {
    const { dir, completion } = completionFixture(t), sessionFile = join(dir, "child.jsonl");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
    let ticks = 0;
    t.mock.method(childProcess, "execFile", (_file: string, _args: string[], _options: unknown, cb: Function) => cb(null, ""));
    const result = await pollForExit("completion:child", new AbortController().signal, {
      interval: 1, completion, sessionFile, onTick() {
        ticks++;
        writeFileSync(completion.file, JSON.stringify({ version: 1, runId: completion.runId, exitCode: 7 }));
      },
    });
    assert.equal(ticks, 1); assert.deepEqual(result, { reason: "done", exitCode: 7 });
  });
}

test("watcher ignores unpublished temporary records", async t => {
  const { completion } = completionFixture(t);
  const record = JSON.stringify({ version: 1, runId: completion.runId, exitCode: 0 });
  writeFileSync(`${completion.file}.tmp`, record);
  let ticks = 0;
  t.mock.method(childProcess, "execFile", (_file: string, _args: string[], _options: unknown, cb: Function) => cb(null, ""));
  const result = await pollForExit("completion:child", new AbortController().signal, {
    interval: 1, completion, onTick() { ticks++; writeFileSync(completion.file, record); },
  });
  assert.equal(ticks, 1); assert.deepEqual(result, { reason: "done", exitCode: 0 });
});

test("completion published during a failing pane read still returns the process result", async t => {
  const { completion } = completionFixture(t);
  t.mock.method(childProcess, "execFile", (_file: string, _args: string[], _options: unknown, cb: Function) => {
    writeFileSync(completion.file, JSON.stringify({ version: 1, runId: completion.runId, exitCode: 23 }));
    cb(new Error("pane closed"));
  });
  assert.deepEqual(await pollForExit("completion:child", new AbortController().signal, { interval: 1, completion }),
    { reason: "done", exitCode: 23 });
});

for (const outcome of [
  { status: "failed", message: "provider overloaded" },
  { status: "stopped", code: "configured_limit", setting: "limits.maxTurnsPerRun", limit: 20, originLease: "worker" },
] satisfies Outcome[]) {
  test(`${outcome.status} outcome takes precedence over a successful process exit`, async t => {
    const { dir, completion } = completionFixture(t), sessionFile = join(dir, "child.jsonl");
    writeFileSync(completion.file, JSON.stringify({ version: 1, runId: completion.runId, exitCode: 0 }));
    reportOutcome(sessionFile, outcome);
    t.mock.method(childProcess, "execFile", () => assert.fail("terminal metadata must be sufficient"));
    const result = await pollForExit("completion:child", new AbortController().signal, { interval: 1, completion, sessionFile });
    assert.equal(result.reason, outcome.status === "stopped" ? "stopped" : "error");
    assert.equal(result.exitCode, 1); assert.deepEqual(result.outcome, outcome);
  });
}

test("watching an unfinished process remains cancellable", async t => {
  const { completion } = completionFixture(t), controller = new AbortController();
  t.mock.method(childProcess, "execFile", (_file: string, _args: string[], _options: unknown, cb: Function) => cb(null, "__SUBAGENT_DONE_0__"));
  await assert.rejects(pollForExit("completion:child", controller.signal, {
    interval: 1, completion, onTick: () => controller.abort(),
  }), { name: "AbortError" });
});
