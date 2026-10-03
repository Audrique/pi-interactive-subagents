import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { OutcomeError, isControlledStop, readOutcome, reportOutcome, type Outcome } from "../pi-extension/subagents/orchestrator/outcome.ts";
import { RootRuntime, connectRuntime } from "../pi-extension/subagents/orchestrator/runtime.ts";
import { installOrchestrator } from "../pi-extension/subagents/orchestrator/index.ts";
import { parseConfig } from "../pi-extension/subagents/orchestrator/config.ts";
import { executeWorkflow, WorkflowRunner } from "../pi-extension/subagents/orchestrator/workflow.ts";
import { __pollForExitTest__, createSurface, closeSurface, pollForExit } from "../pi-extension/subagents/herdr.ts";
import subagentDone from "../pi-extension/subagents/subagent-done.ts";
import subagents, { __test__ } from "../pi-extension/subagents/index.ts";
import { fixture, mockPi } from "./fixtures.ts";
import { createStatusState } from "../pi-extension/subagents/status.ts";

const stop: Outcome = { status: "stopped", code: "configured_limit", setting: "limits.maxTurnsPerRun", limit: 20, originLease: "parent" };
function directory(t: { after(fn: () => void | Promise<void>): void }, beforeRemove: () => void | Promise<void> = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "stop-test-"));
  // Node's after hooks run in registration order, not as a cleanup stack.
  // Finish runtime shutdown (which publishes outcomes) before removing storage.
  t.after(async () => {
    try { await beforeRemove(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return dir;
}

test("first cause survives consumed sidecar and late generic assistant abort; errors stay errors", async t => {
  const dir = directory(t), session = join(dir, "child.jsonl"), env = { ...process.env };
  t.after(() => { process.env = env; });
  Object.assign(process.env, { PI_SUBAGENT_AUTO_EXIT: "1", PI_SUBAGENT_SESSION: session });
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  reportOutcome(session, stop);
  const completion = { file: join(dir, "completion.json"), runId: "stopped-run" };
  const result = await pollForExit("unused", new AbortController().signal, { interval: 1, completion, sessionFile: session });
  assert.equal(result.reason, "stopped"); assert.equal(result.exitCode, 1);
  rmSync(`${session}.exit`, { force: true }); // Consumer removes the transient notification.
  const mock = mockPi(); subagentDone(mock.pi as any);
  await mock.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" }] }, { shutdown() {} });
  assert.deepEqual(readOutcome(session), stop);
  assert.deepEqual(JSON.parse(readFileSync(`${session}.exit`, "utf8")).outcome, stop);
  const failed = join(dir, "failed.jsonl");
  reportOutcome(failed, { status: "failed", message: "provider overloaded" });
  reportOutcome(failed, stop);
  assert.equal(readOutcome(failed)?.status, "failed");
  assert.equal((await pollForExit("unused", new AbortController().signal, { interval: 1, completion, sessionFile: failed })).reason, "error");
  assert.deepEqual(__pollForExitTest__.interpretExitSidecar({ type: "error", errorMessage: "This operation was aborted" }),
    { reason: "error", exitCode: 1, errorMessage: "This operation was aborted" });
  assert.equal(__pollForExitTest__.interpretExitSidecar({ type: "done" }), undefined);
});

test("turn limit crosses IPC, persists descendants before closure, and leaves siblings available", async t => {
  let root: RootRuntime | undefined;
  const dir = directory(t, () => root?.close()), closed: { pane: string; outcome?: Outcome }[] = [];
  root = new RootRuntime(parseConfig(fixture()), dir, "root-session", () => true, pane => {
    closed.push({ pane, outcome: readOutcome(join(dir, `${pane}.jsonl`)) });
  });
  const runtime = root;
  await root.listen(dir);
  const reserve = (owner: string | null, name: string) => {
    const lease = runtime.dispatch(owner, "reserve", { agent: "worker", name, cwd: dir });
    const sessionFile = join(dir, `${name}.jsonl`);
    runtime.dispatch(owner, "launched", { id: lease.id, paneId: name, sessionFile });
    runtime.dispatch(lease.id, "register", { pid: 1234, cwd: dir, sessionFile, rootSession: "root-session" }); return lease;
  };
  const parent = reserve(null, "parent"), descendant = reserve(parent.id, "descendant"), sibling = reserve(null, "sibling");
  const client = connectRuntime(parent.env);
  for (let i = 0; i < 20; i++) await client.call("turn");
  const expected = { ...stop, originLease: parent.id };
  await assert.rejects(client.call("turn"), error => {
    assert.deepEqual((error as OutcomeError).outcome, expected); return true;
  });
  // Assert outside the close callback: runtime transport-error handling must
  // not accidentally swallow a failed test assertion.
  assert.deepEqual(closed, [{ pane: "descendant", outcome: expected }]);
  assert.deepEqual(readOutcome(join(dir, "descendant.jsonl")), expected);
  assert.throws(() => runtime.dispatch(descendant.id, "check"), error => {
    assert.deepEqual((error as OutcomeError).outcome, expected); return true;
  });
  root.dispatch(sibling.id, "turn"); root.dispatch(null, "check");
  assert.equal(readOutcome(join(dir, "sibling.jsonl")), undefined);
  root.dispatch(null, "release", { id: parent.id });
  assert.deepEqual(readOutcome(join(dir, "descendant.jsonl")), expected);
});

test("workflow scope cancellation persists the cause on affected leases", async t => {
  let runtime: RootRuntime | undefined;
  const dir = directory(t, () => runtime?.close());
  const root = runtime = new RootRuntime(parseConfig(fixture()), dir, "root-session", () => true);
  const controller = new AbortController();
  const lease = root.scope.run(controller.signal, () => root.dispatch(null, "reserve", { agent: "worker", name: "scope", cwd: dir }));
  const sessionFile = join(dir, "scope.jsonl");
  root.dispatch(null, "launched", { id: lease.id, paneId: "scope", sessionFile });
  controller.abort(new OutcomeError(stop));
  assert.deepEqual(readOutcome(sessionFile), stop);
  assert.throws(() => root.dispatch(lease.id, "check"), error => {
    assert.deepEqual((error as OutcomeError).outcome, stop); return true;
  });
});

test("workflow limit stops subsequent stages and parallel cancellation preserves cause", async () => {
  const workflow = { description: "test", steps: [{ parallel: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }] }, { agent: "c", task: "z" }] };
  const controller = new AbortController(), calls: string[] = [];
  await assert.rejects(executeWorkflow(workflow, "task", async step => {
    calls.push(step.agent);
    if (step.agent === "b") return new Promise(() => {});
    return { summary: "partial", exitCode: 1, outcome: stop };
  }, controller), error => { assert.deepEqual((error as OutcomeError).outcome, stop); return true; });
  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual((controller.signal.reason as OutcomeError).outcome, stop);
  for (const [result, label] of [
    [{ summary: "partial", exitCode: 1, outcome: stop }, /Workflow Stopped: configured turn limit reached \(20\)/],
    [{ summary: "provider error", exitCode: 1 }, /Workflow failed:/],
    [{ summary: "done", exitCode: 0 }, /Workflow completed:/],
  ] as const) {
    const reports: string[] = [], runner = new WorkflowRunner();
    runner.start({ description: "test", steps: [{ agent: "a", task: "x" }] }, "task", async () => result, text => reports.push(text));
    await setImmediate(); assert.match(reports[0], label);
  }
});

const quotaFailure: Outcome = { status: "failed", message: "Codex error: The usage limit has been reached" };

for (const outcome of [stop, quotaFailure]) {
  for (const failure of ["close", "paneClosed", "release", "none"] as const) {
    test(`${outcome.status} survives cancellation and ${failure} cleanup failure`, async t => {
      let runtime: RootRuntime | undefined;
      const dir = directory(t, () => runtime?.close()), env = { ...process.env }, events: string[] = [];
      Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "cleanup:parent" });
      const surface = `cleanup:${outcome.status}-${failure}`;
      let failClose = failure === "close";
      t.mock.method(childProcess, "execFileSync", (_file: string, args: string[]) => {
        events.push(args[1]);
        if (args[1] === "close" && failClose) throw new Error("transport disconnected");
        return JSON.stringify({ result: { pane: { pane_id: surface } } });
      });
      const root = runtime = new RootRuntime(parseConfig(fixture()), dir, "root-session", () => false);
      const lease = root.dispatch(null, "reserve", { agent: "worker", name: surface, cwd: dir });
      const sessionFile = join(dir, "child.jsonl");
      createSurface(surface, dir, root.config.panes);
      root.dispatch(null, "launched", { id: lease.id, paneId: surface, sessionFile });
      reportOutcome(sessionFile, outcome);
      const running = { id: lease.id, name: surface, task: "task", surface, sessionFile, startTime: Date.now(),
        completion: { file: join(dir, "completion.json"), runId: lease.id }, interactive: false, statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
        releaseLease: async () => {
          for (const method of ["paneClosed", "release"]) {
            events.push(method);
            if (method === failure) throw new Error(`${method} disconnected`);
            root.dispatch(null, method, { id: lease.id });
          }
        } };
      __test__.runningSubagents.set(lease.id, running);
      t.after(() => {
        try { __test__.runningSubagents.delete(lease.id); failClose = false; closeSurface(surface); }
        finally { process.env = env; }
      });
      const controller = new AbortController(); controller.abort(new Error("late cancellation"));
      const result = await __test__.watchSubagent(running, controller.signal);
      assert.deepEqual(result.outcome, outcome); assert.deepEqual(readOutcome(sessionFile), outcome);
      assert.equal(result.exitCode, 1); assert.notEqual(result.summary, "Subagent cancelled.");
      assert.equal(isControlledStop(result.outcome), outcome.status === "stopped");
      if (outcome.status === "failed") {
        assert.equal(result.errorMessage, "Codex error: The usage limit has been reached");
        assert.equal(result.summary, outcome.message);
      }
      const content = __test__.resolveResultPresentation(result, surface);
      assert.match(content, outcome.status === "stopped" ? /Work is incomplete/ : /Codex error: The usage limit has been reached/);
      if (failure === "none") {
        assert.equal(result.cleanupErrors, undefined);
        assert.equal(__test__.runningSubagents.has(lease.id), false); assert.equal(root.leases.size, 0);
      } else {
        assert.equal(result.cleanupErrors?.[0].operation, failure === "close" ? "closeSurface" : "releaseLease");
        assert.match(content, /Cleanup warning/);
        assert.equal(__test__.runningSubagents.has(lease.id), true); assert.equal(root.leases.size, 1);
        assert.equal(root.leases.get(lease.id)?.closed === true, failure === "release");
        if (failure === "close") assert.deepEqual(events, ["split", "close"]);
        if (failure === "paneClosed") assert.deepEqual(events, ["split", "close", "paneClosed"]);
      }
    });
  }
}

for (const stale of [false, true]) {
  test(`root token stop reports ${stale ? "nothing after session replacement" : "exactly once without continuing execution"}`, async t => {
    let shutdown = async () => {};
    const dir = directory(t, () => shutdown()), env = { ...process.env };
    t.after(() => { process.env = env; });
    for (const key of ["PI_DOTFILES_SUBAGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_ORCHESTRATOR_LEASE", "PI_ORCHESTRATOR_TOKEN", "PI_ORCHESTRATOR_SOCKET"]) delete process.env[key];
    Object.assign(process.env, { PI_ORCHESTRATOR_CONFIG: join(dir, "config.json"), PI_CODING_AGENT_DIR: dir });
    const config = fixture(); config.limits.maxTokensPerSession = 10;
    config.workflows.review.steps.push({ agent: "worker", task: "must not run" });
    writeFileSync(process.env.PI_ORCHESTRATOR_CONFIG!, JSON.stringify(config));
    const mock = mockPi(); let shutdowns = 0, aborts = 0, executions = 0, signal!: AbortSignal, finish!: () => void;
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "root-session" },
      ui: { notify() {}, setStatus() {} }, abort() { aborts++; }, shutdown() { shutdowns++; } };
    const coordinator = installOrchestrator(mock.pi as any, async (_step, _ctx, currentSignal) => {
      executions++; signal = currentSignal;
      await new Promise<void>(resolve => { finish = resolve; });
      return { summary: "late success", exitCode: 0 };
    });
    shutdown = () => mock.emit("session_shutdown", { reason: "quit" }).then(() => {});
    await mock.emit("session_start", {}, ctx);
    await mock.commands.get("workflow")("review task", ctx);
    // accountUsage synchronously stops the root before its promise rejects.
    const accounting = coordinator.client.accountUsage({ tokens: 10 });
    if (stale) await mock.emit("session_shutdown", { reason: "new" });
    await assert.rejects(accounting, /maxTokensPerSession/);
    await setImmediate();
    const expected = { status: "stopped", code: "configured_limit", setting: "limits.maxTokensPerSession", limit: 10, originLease: "root" };
    assert.equal(signal.aborted, true); assert.equal(executions, 1);
    assert.equal(shutdowns, 1); assert.equal(aborts, 1);
    assert.equal(mock.reports.length, stale ? 0 : 1);
    if (!stale) {
      assert.deepEqual(mock.reports[0].details.outcome, expected);
      assert.match(mock.reports[0].content, /Workflow Stopped: configured token limit reached \(10\)/);
      assert.match(mock.reports[0].content, /Work is incomplete/);
      assert.deepEqual(mock.reportOptions, [{ triggerTurn: false, deliverAs: "followUp" }]);
    } else {
      // A replacement generation cannot receive a late result from this run.
      await mock.emit("session_start", {}, { ...ctx, sessionManager: { getSessionId: () => "replacement" } });
    }
    await assert.rejects(mock.commands.get("workflow")("review again", ctx));
    assert.equal((await mock.emit("tool_call", { toolName: "read" }))[0].block, true);
    await mock.emit("turn_start", {});
    finish(); await setImmediate();
    assert.equal(executions, 1); assert.equal(mock.reports.length, stale ? 0 : 1);
  });
}

test("collapsed and expanded result cards show warning stops, not failures or success", async t => {
  initTheme("dark", false);
  const mock = mockPi(); subagents(mock.pi as any);
  const workflowMock = mockPi(); installOrchestrator(workflowMock.pi as any);
  t.after(() => mock.emit("session_shutdown", { reason: "quit" }).then(() => {}));
  const renderer = mock.renderers.get("subagent_result")!;
  const colors: string[] = [];
  const theme = { fg(color: string, text: string) { colors.push(color); return text; }, bg(color: string, text: string) { colors.push(color); return text; }, bold: (text: string) => text };
  const details = { name: "worker", exitCode: 1, elapsed: 3, outcome: stop,
    cleanupErrors: [{ operation: "closeSurface" as const, message: "transport disconnected" }] };
  const content = __test__.resolveResultPresentation({ ...details, summary: "stale partial result" }, "worker");
  assert.match(content, /Work is incomplete/); assert.doesNotMatch(content, /failed|completed/);
  for (const expanded of [false, true]) {
    colors.length = 0;
    const text = renderer({ details, content }, { expanded }, theme).render(100).join("\n");
    assert.match(text, /Stopped: configured turn limit reached \(20\)/);
    assert.match(text, /limits.maxTurnsPerRun = 20/);
    assert.match(text, /Cleanup warning/); assert.match(text, /Pane closure is unconfirmed/);
    assert(colors.includes("warning")); assert(!colors.includes("error")); assert(!colors.includes("success"));
    assert(!colors.includes("toolSuccessBg")); assert(!colors.includes("toolErrorBg"));
  }
  colors.length = 0;
  renderer({ details: { name: "worker", exitCode: 1, outcome: quotaFailure,
    errorMessage: "Codex error: The usage limit has been reached" }, content: "failure" }, { expanded: false }, theme).render(100);
  assert(colors.includes("error")); assert(colors.includes("toolErrorBg"));
  const workflowRenderer = workflowMock.renderers.get("orchestrator-workflow")!;
  for (const [outcome, color] of [[stop, "warning"], [{ status: "failed", message: "provider error" }, "error"]] as const) {
    colors.length = 0;
    workflowRenderer({ details: { outcome }, content: "Workflow result" }, { expanded: false }, theme).render(100);
    assert(colors.includes(color));
  }
});
