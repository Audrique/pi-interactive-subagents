import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import subagents, { __test__ } from "../pi-extension/subagents/index.ts";
import { installOrchestrator } from "../pi-extension/subagents/orchestrator/index.ts";
import { RuntimeClient } from "../pi-extension/subagents/orchestrator/runtime.ts";
import { ACTIVITY_EVENT, ACTIVITY_REQUEST } from "../pi-extension/subagents/orchestrator/background-activity.ts";
import { fixture, mockPi } from "./fixtures.ts";

function observe(mock: ReturnType<typeof mockPi>) {
  let busy = true;
  const values: boolean[] = [];
  mock.pi.events.on(ACTIVITY_EVENT, (value: { busy: boolean }) => { busy = value.busy; values.push(busy); });
  return { values, snapshot() { mock.pi.events.emit(ACTIVITY_REQUEST, undefined); return busy; } };
}
function rootEnv(dir: string) {
  for (const key of ["PI_DOTFILES_SUBAGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_ORCHESTRATOR_LEASE", "PI_ORCHESTRATOR_TOKEN", "PI_ORCHESTRATOR_SOCKET"]) delete process.env[key];
  Object.assign(process.env, { PI_ORCHESTRATOR_CONFIG: join(dir, "config.json"), PI_CODING_AGENT_DIR: dir,
    PI_GUARDED_EXECUTABLE: process.execPath, HERDR_ENV: "1", HERDR_PANE_ID: "activity:parent" });
}

test("launch and resume stay busy before reserve resolves and after map deletion through delivery", async t => {
  const env = { ...process.env }, dir = mkdtempSync(join(tmpdir(), "background-launch-"));
  rootEnv(dir);
  const mock = mockPi(); subagents(mock.pi as any);
  const state = observe(mock);
  const ctx: any = { cwd: dir, hasUI: false, sessionManager: {
    getSessionFile: () => join(dir, "parent.jsonl"), getSessionId: () => "parent", getSessionDir: () => dir,
  } };
  t.after(async () => {
    await mock.emit("session_shutdown", { reason: "quit" }, ctx);
    __test__.setCoordinator(undefined); __test__.runningSubagents.clear();
    process.env = env; rmSync(dir, { recursive: true, force: true });
  });
  let reserve!: () => void, deliver!: () => void, deny = false, failDelivery = false, leaseNumber = 0;
  const runtime = new RuntimeClient(async (method, args) => {
    if (method === "reserve") {
      assert.equal(state.snapshot(), true);
      if (deny) throw new Error("launch denied");
      await new Promise<void>(resolve => { reserve = resolve; });
      return { id: `lease-${++leaseNumber}`, env: {} };
    }
    if (method === "launched") {
      writeFileSync(args.sessionFile, JSON.stringify({ type: "session", id: "child" }) + "\n");
      const completionDir = join(dir, "artifacts/parent/subagent-completions");
      mkdirSync(completionDir, { recursive: true });
      writeFileSync(join(completionDir, `${args.id}.json`), JSON.stringify({ version: 1, runId: args.id, exitCode: 0 }));
    }
  });
  __test__.setCoordinator({ client: runtime, config: fixture, humanCommand() {} });
  let pane = 0;
  t.mock.method(childProcess, "execFileSync", (_file: string, args: string[]) => {
    if (args[0] === "--version") return "herdr";
    if (args[1] === "run") return "";
    return JSON.stringify({ result: { pane: { pane_id: `activity:${++pane}` } } });
  });
  t.mock.method(childProcess, "execFile", () => assert.fail("completed runs must not depend on terminal reads"));
  t.mock.method(mock.pi, "sendMessage", async () => {
    assert.equal(__test__.runningSubagents.size, 0, "watch already removed the child");
    assert.equal(state.snapshot(), true, "delivery still owns a hold");
    await new Promise<void>(resolve => { deliver = resolve; });
    if (failDelivery) throw new Error("session replaced");
  });
  const spawn = mock.tools.find(tool => tool.name === "subagent");
  const resume = mock.tools.find(tool => tool.name === "subagent_message");
  for (const tool of [spawn, resume]) {
    state.values.length = 0;
    const launching = tool.execute("id", tool === spawn ? { agent: "scout", task: "task", name: "job" } : { name: "job", message: "again" }, undefined, undefined, ctx);
    assert.equal(state.snapshot(), true);
    await mock.emit("agent_settled", {}, ctx); assert.equal(state.snapshot(), true);
    reserve(); await launching; await setImmediate();
    assert.equal(state.snapshot(), true); assert(state.values.every(Boolean));
    deliver(); await setImmediate(); assert.equal(state.snapshot(), false);
  }
  deny = true;
  await assert.rejects(spawn.execute("id", { agent: "scout", task: "task", name: "denied" }, undefined, undefined, ctx), /launch denied/);
  assert.equal(state.snapshot(), false); deny = false;
  // Even a failing terminal delivery and its error report release the hold.
  failDelivery = true;
  const launching = resume.execute("id", { name: "job", message: "again" }, undefined, undefined, ctx);
  reserve(); await launching; await setImmediate(); deliver(); await setImmediate();
  assert.equal(state.snapshot(), true); deliver(); await setImmediate();
  assert.equal(state.snapshot(), false);
  // Shutdown invalidates the producer while an admitted launch is still pending.
  const cancelled = spawn.execute("id", { agent: "scout", task: "task", name: "cancelled" }, undefined, undefined, ctx);
  assert.equal(state.snapshot(), true);
  await mock.emit("session_shutdown", { reason: "quit" }, ctx);
  const count = state.values.length;
  reserve(); await assert.rejects(cancelled, /abort/i);
  state.snapshot(); assert.equal(state.values.length, count);
});

test("installed workflow producer covers admitted intent, step gaps, overlap, rejection and cancellation", async t => {
  const env = { ...process.env }, dir = mkdtempSync(join(tmpdir(), "background-workflow-")); rootEnv(dir);
  const config = fixture(); config.workflows.review.steps.push({ agent: "scout", task: "next" });
  writeFileSync(process.env.PI_ORCHESTRATOR_CONFIG!, JSON.stringify(config));
  const mock = mockPi(), state = observe(mock);
  const ctx: any = { cwd: dir, sessionManager: { getSessionId: () => "parent" },
    ui: { notify() {}, setStatus() {} }, abort() {}, shutdown() {} };
  t.after(async () => {
    await mock.emit("session_shutdown", { reason: "quit" });
    process.env = env; rmSync(dir, { recursive: true, force: true });
  });
  const ends: (() => void)[] = []; let steps = 0, deliver!: () => void;
  installOrchestrator(mock.pi as any, async () => {
    assert.equal(state.snapshot(), true); steps++;
    await new Promise<void>(resolve => ends.push(resolve));
    assert.equal(state.snapshot(), true);
    return { summary: "done", exitCode: 0 };
  });
  t.mock.method(mock.pi, "appendEntry", () => { assert.equal(state.snapshot(), true, "admitted runs before WorkflowRunner.active assignment"); });
  t.mock.method(mock.pi, "sendMessage", async () => {
    assert.equal(state.snapshot(), true);
    await new Promise<void>(resolve => { deliver = resolve; });
  });
  await mock.emit("session_start", {}, ctx); assert.equal(state.snapshot(), false);
  state.values.length = 0;
  await mock.commands.get("workflow")("review task", ctx);
  await assert.rejects(mock.commands.get("workflow")("review duplicate", ctx), /busy/);
  assert.equal(state.snapshot(), true);
  ends.shift()!(); await setImmediate(); assert.equal(steps, 2);
  ends.shift()!(); await setImmediate();
  assert.equal(state.snapshot(), true); assert(state.values.every(Boolean));
  deliver(); await setImmediate(); assert.equal(state.snapshot(), false);
  await mock.commands.get("workflow")("review cancel", ctx);
  await mock.emit("input", { source: "interactive" }); await setImmediate();
  deliver(); await setImmediate();
  assert.equal(state.snapshot(), true, "cancelled workflow's child has not finished cleanup");
  ends.shift()!(); await setImmediate(); assert.equal(state.snapshot(), false);
  assert.equal(steps, 3, "no subsequent step after cancellation");
  t.mock.method(mock.pi, "appendEntry", () => { throw new Error("admission rejected"); });
  await assert.rejects(mock.commands.get("workflow")("review task", ctx), /admission rejected/);
  assert.equal(state.snapshot(), false);
});
