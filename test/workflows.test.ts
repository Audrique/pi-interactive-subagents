import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { executeWorkflow, SUMMARY_LIMIT, WorkflowRunner } from "../pi-extension/subagents/orchestrator/workflow.ts";
import type { TaskStep, Workflow } from "../pi-extension/subagents/orchestrator/config.ts";

const workflow: Workflow = { description: "Review", steps: [{ agent: "scout", task: "Investigate {{task}}" },
  { parallel: [{ agent: "worker", task: "Review {{previous}}" }, { agent: "researcher", task: "Check {{previous}}" }] },
  { agent: "worker", task: "Conclude {{previous}}" }] };

test("sequential and parallel workflows interpolate bounded summaries as literal text", async () => {
  const calls: TaskStep[] = []; let active = 0, peak = 0;
  const summary = await executeWorkflow(workflow, "/quit $HOME {{previous}}", async step => {
    calls.push(step); active++; peak = Math.max(peak, active); await setImmediate(); active--;
    return { summary: "x".repeat(SUMMARY_LIMIT * 2), exitCode: 0 };
  }, new AbortController());
  assert.equal(calls[0].task, "Investigate /quit $HOME {{previous}}");
  assert.equal(calls[1].task, `Review ${"x".repeat(SUMMARY_LIMIT)}`);
  assert.equal(peak, 2); assert.equal(summary.length, SUMMARY_LIMIT); assert.equal(calls.length, 4);
});

test("parallel failure aborts siblings immediately and prevents subsequent steps", async () => {
  const controller = new AbortController(); const calls: string[] = [];
  await assert.rejects(executeWorkflow(workflow, "task", async step => {
    calls.push(step.task);
    if (step.agent === "researcher") return new Promise(() => {});
    return { summary: "failure", exitCode: step.agent === "worker" ? 1 : 0 };
  }, controller), /failed/);
  assert(controller.signal.aborted); assert.equal(calls.length, 3);
});

test("root cancellation settles even an executor ignoring abort, without further launches", async () => {
  const controller = new AbortController(); let calls = 0;
  const result = executeWorkflow(workflow, "task", async () => { calls++; return new Promise(() => {}); }, controller);
  controller.abort(new Error("new root input")); await assert.rejects(result, /new root input/);
  assert.equal(calls, 1);
});

test("workflow starts nonblocking, rejects busy before admission, and reports cancellation", async () => {
  const runner = new WorkflowRunner(); const reports: string[] = []; let admitted = 0;
  const execute = async () => new Promise<{ summary: string; exitCode: number }>(() => {});
  runner.start(workflow, "task", execute, text => reports.push(text), () => admitted++);
  assert.throws(() => runner.start(workflow, "task", execute, () => {}, () => admitted++), /busy/);
  assert.equal(admitted, 1);
  runner.cancel("session reset"); await setImmediate(); assert.match(reports[0], /session reset/);
});
