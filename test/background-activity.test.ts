import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { ACTIVITY_EVENT, ACTIVITY_REQUEST, installBackgroundActivity } from "../pi-extension/subagents/orchestrator/background-activity.ts";
import { WorkflowRunner } from "../pi-extension/subagents/orchestrator/workflow.ts";
import { mockPi } from "./fixtures.ts";

function harness() {
  const mock = mockPi(), snapshots: boolean[] = [];
  const activity = installBackgroundActivity(mock.pi as any);
  mock.pi.events.on(ACTIVITY_EVENT, (value: { busy: boolean }) => snapshots.push(value.busy));
  const snapshot = () => {
    const before = snapshots.length;
    mock.pi.events.emit(ACTIVITY_REQUEST, undefined);
    assert.equal(snapshots.length, before + 1, "request responds synchronously");
    return snapshots.at(-1);
  };
  return { ...mock, activity, snapshots, snapshot };
}

for (const producerFirst of [true, false]) {
  test(`snapshot handshake is fail-closed in either load order (producer first: ${producerFirst})`, async () => {
    const mock = mockPi();
    let busy = true, known = false;
    if (producerFirst) installBackgroundActivity(mock.pi as any);
    mock.pi.events.on(ACTIVITY_EVENT, (value: { busy: boolean }) => { busy = value.busy; known = true; });
    mock.pi.events.emit(ACTIVITY_REQUEST, undefined);
    assert.equal(known, producerFirst);
    assert.equal(busy, !producerFirst);
    if (!producerFirst) installBackgroundActivity(mock.pi as any);
    await mock.emit("session_start");
    assert.equal(known, true); assert.equal(busy, false);
    await mock.emit("session_shutdown");
  });
}

test("overlapping holds, settled parent, synchronous failure and rejected delivery", async () => {
  const h = harness();
  assert.equal(h.snapshot(), false);
  const finish = h.activity.begin(), other = h.activity.begin();
  assert.deepEqual(h.snapshots, [false, true]);
  await h.emit("agent_settled"); assert.equal(h.snapshot(), true);
  finish(); finish(); assert.equal(h.snapshot(), true);
  other(); assert.equal(h.snapshot(), false);
  await assert.rejects(h.activity.track(() => { throw new Error("launch failed"); }), /launch failed/);
  assert.equal(h.snapshot(), false);
  let release!: () => void;
  const delivery = h.activity.track(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    assert.equal(h.snapshot(), true);
    throw new Error("delivery rejected");
  });
  assert.equal(h.snapshot(), true); release();
  await assert.rejects(delivery, /delivery rejected/);
  assert.equal(h.snapshot(), false);
});

test("shutdown unsubscribes/reset silently and stale releases cannot clobber new work", async () => {
  const h = harness(), stale = h.activity.begin();
  await h.emit("session_shutdown");
  const count = h.snapshots.length;
  h.pi.events.emit(ACTIVITY_REQUEST, undefined); stale();
  assert.equal(h.snapshots.length, count);
  await h.emit("session_shutdown"); await h.emit("session_start");
  assert.equal(h.snapshot(), false);
  const fresh = h.activity.begin(); stale(); assert.equal(h.snapshot(), true);
  fresh(); assert.equal(h.snapshot(), false);
});

test("workflow holds span admission, empty child gaps and asynchronous terminal delivery", async () => {
  const h = harness(), runner = new WorkflowRunner();
  let steps = 0, deliver!: () => void;
  const finish = h.activity.begin();
  const completion = runner.start({ description: "two steps", steps: [
    { agent: "scout", task: "one" }, { agent: "scout", task: "two" },
  ] }, "task", async () => {
    assert.equal(h.snapshot(), true);
    const child = h.activity.begin(); steps++; child();
    // There are no child holds here, including the microtask gap between steps.
    await Promise.resolve(); assert.equal(h.snapshot(), true);
    return { summary: "done", exitCode: 0 };
  }, async () => {
    assert.equal(steps, 2); assert.equal(h.snapshot(), true);
    await new Promise<void>(resolve => { deliver = resolve; });
  }, () => { assert.equal(h.snapshot(), true); }).finally(finish);
  await setImmediate();
  assert.equal(h.snapshot(), true); assert(h.snapshots.every(Boolean));
  deliver(); await completion;
  assert.equal(h.snapshot(), false);
});
