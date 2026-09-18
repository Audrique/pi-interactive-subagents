import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { loadConfig, parseConfig } from "../pi-extension/subagents/orchestrator/config.ts";
import { connectRuntime, KEY, MESSAGE_EVENT, RootRuntime, RuntimeClient } from "../pi-extension/subagents/orchestrator/runtime.ts";
import orchestrator, { installOrchestrator } from "../pi-extension/subagents/orchestrator/index.ts";
import { fixture, mockPi } from "./fixtures.ts";

function setup(t: { after(fn: () => void | Promise<void>): void }, raw = fixture(), alive = (_pid: number) => true) {
  const dir = mkdtempSync(join(tmpdir(), "orch-"));
  const root = new RootRuntime(parseConfig(raw), dir, "root-session", alive);
  const client = new RuntimeClient(async (method, args) => root.dispatch(null, method, args));
  t.after(async () => { await root.close(); rmSync(dir, { recursive: true, force: true }); });
  const reserve = (agent = "worker") => client.reserve({ agent, name: agent, cwd: dir });
  const register = (lease: { id: string }, sessionFile = join(dir, `${lease.id}.jsonl`)) => {
    root.dispatch(lease.id, "register", { pid: 1234, cwd: dir, sessionFile, rootSession: "root-session" }); return sessionFile;
  };
  return { root, client, dir, reserve, register };
}

test("strict immutable config rejects missing, unknown and malformed fields", () => {
  const raw = fixture(), parsed = parseConfig(raw);
  assert(Object.isFrozen(parsed.agents.worker.tools)); raw.agents.worker.tools.push("bash");
  assert.deepEqual(parsed.agents.worker.tools, ["read"]);
  for (const mutate of [
    (c: any) => { c.extra = 1; }, (c: any) => { c.limits.maxDepth = 17; },
    (c: any) => { c.permissions.yoloMode = true; }, (c: any) => { c.agents.worker.canSpawn = ["missing"]; },
    (c: any) => { c.reviewer.timeoutMs = "1000"; }, (c: any) => { c.permissions.permission.bash = { "*": true }; },
    (c: any) => { c.workflows.review.steps = [{ agent: "scout", task: "{{shell}}" }]; },
    (c: any) => { c.workflows.review.steps = [{ command: "rm -rf /" }]; },
    (c: any) => { c.agents.worker.cli = "claude"; },
  ]) { const config = fixture(); mutate(config); assert.throws(() => parseConfig(config)); }
  const before = process.env.PI_ORCHESTRATOR_CONFIG;
  delete process.env.PI_ORCHESTRATOR_CONFIG;
  try {
    assert.throws(loadConfig, /mandatory/); process.env.PI_ORCHESTRATOR_CONFIG = "config/pi/config.json";
    assert.throws(loadConfig, /absolute central config/);
  } finally { if (before !== undefined) process.env.PI_ORCHESTRATOR_CONFIG = before; else delete process.env.PI_ORCHESTRATOR_CONFIG; }
});

test("config supports raised limits and 1000-step workflows within sanity bounds", () => {
  const config = fixture(), maxima = { maxOpenPanes: 64, maxDepth: 16, maxLaunchesPerTurn: 1000, maxTurnsPerRun: 1000 };
  Object.assign(config.limits, maxima);
  config.workflows.review.steps = Array.from({ length: 1000 }, () => ({ agent: "scout", task: "{{task}}" }));
  assert.equal(parseConfig(config).workflows.review.steps.length, 1000);
  for (const [name, max] of Object.entries(maxima)) {
    for (const value of [max + 1, 0, -1, 1.5, "3"]) {
      const bad = fixture(); Object.assign(bad.limits, { [name]: value }); assert.throws(() => parseConfig(bad));
    }
  }
  config.limits.maxLaunchesPerTurn = 999; assert.throws(() => parseConfig(config), /workflow steps/);
});

test("concurrent reservations respect configured capacity, including above defaults", async t => {
  for (const capacity of [3, 5]) {
    const config = fixture(); config.limits.maxOpenPanes = capacity;
    const { root, reserve } = setup(t, config);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => reserve()));
    assert.equal(results.filter(r => r.status === "fulfilled").length, capacity);
    assert.equal(root.leases.size, capacity); assert.equal(root.launches, capacity);
  }
});

test("root computes descendant depth, spawn whitelist and parent cancellation", async t => {
  const { root, client, dir, reserve, register } = setup(t);
  const first = await reserve(); register(first);
  const second = root.dispatch(first.id, "reserve", { agent: "worker", name: "x", cwd: dir, depth: 0 }); register(second);
  assert.equal(root.leases.get(second.id)?.depth, 2);
  assert.equal(second.env.PI_SUBAGENT_PARENT_SESSION, "root-session");
  assert.throws(() => root.dispatch(second.id, "reserve", { agent: "worker", name: "x", cwd: dir }), /depth/);
  const leaf = await reserve("scout"); register(leaf);
  assert.throws(() => root.dispatch(leaf.id, "reserve", { agent: "worker", name: "x", cwd: dir }), /forbidden/);
  await client.release(first.id); assert.throws(() => root.dispatch(second.id, "check"), /cancelled/);
});

test("release requires confirmed closure and dead child; failed launches consume budget", async t => {
  let live = true;
  const { root, client, reserve, register } = setup(t, fixture(), () => live);
  const first = await reserve(); register(first);
  await client.release(first.id); assert.equal(root.leases.size, 1);
  await client.paneClosed(first.id); root.reap(); assert.equal(root.leases.size, 1);
  live = false; root.reap(); assert.equal(root.leases.size, 0);
  for (let i = 1; i < 8; i++) { const lease = await reserve(); await client.paneClosed(lease.id); await client.release(lease.id); }
  root.input("extension"); root.input("rpc"); assert.equal(root.launches, 8);
  root.reset("new-session"); await assert.rejects(reserve, /launch budget/);
  root.input("interactive"); await reserve(); assert.equal(root.launches, 1);
});

test("lease owners alone may close/release/message; cwd resolves symlinks", async t => {
  const { root, dir, reserve, register, client } = setup(t);
  const first = await reserve(), second = await reserve(); register(first); const endpoint = register(second);
  assert.throws(() => register(first, endpoint), /endpoint already owned/);
  for (const method of ["launched", "paneClosed", "release"]) assert.throws(() => root.dispatch(first.id, method, { id: second.id }), /unauthorized/);
  assert.throws(() => root.dispatch(first.id, "message", { sessionFile: endpoint, text: "hello" }), /unauthorized/);
  await client.message(endpoint, "/quit\nordinary task text");
  assert.deepEqual(root.dispatch(second.id, "poll"), ["/quit\nordinary task text"]);
  assert.deepEqual(root.dispatch(second.id, "poll"), []);
  symlinkSync(tmpdir(), join(dir, "escape")); mkdirSync(join(dir, "inside"));
  for (const cwd of [join(dir, ".."), join(dir, "escape")]) await assert.rejects(client.reserve({ agent: "worker", name: "x", cwd }), /outside root/);
  await client.reserve({ agent: "worker", name: "x", cwd: join(dir, "inside", "..") });
});

test("shared root, descendant and reviewer tokens survive resets and stop the tree", async t => {
  const config = fixture(); config.limits.maxTokensPerSession = 10;
  const { root, client, reserve, register } = setup(t, config);
  const lease = await reserve(); register(lease);
  await client.accountUsage({ tokens: 3 }); root.dispatch(lease.id, "accountUsage", { tokens: 4 });
  root.input("interactive"); root.reset("new-session"); assert.equal(root.totalTokens, 7);
  await assert.rejects(client.accountUsage({ tokens: 3 }), /maxTokensPerSession/);
  assert.equal(root.totalTokens, 10); assert.throws(() => root.dispatch(lease.id, "check"), /maxTokensPerSession/);
  await assert.rejects(reserve, /maxTokensPerSession/); await assert.rejects(client.accountUsage({ tokens: -1 }), /invalid token/);
});

test("turn 21 stops exhausted child only; root/sibling/accounting stay available", async t => {
  const { root, client, reserve, register } = setup(t); const lease = await reserve(); register(lease);
  const sibling = await reserve(); register(sibling);
  for (let i = 0; i < 20; i++) root.dispatch(lease.id, "turn");
  assert.throws(() => root.dispatch(lease.id, "turn"), /maxTurnsPerRun/);
  for (let i = 0; i < 30; i++) root.dispatch(null, "turn");
  root.dispatch(sibling.id, "turn"); await client.checkBudget(); await client.accountUsage({ tokens: 3 });
  assert.throws(() => root.dispatch(lease.id, "accountUsage", { tokens: 4 }), /maxTurnsPerRun/);
  assert.equal((await client.status()).totalTokens, 7); assert.equal(root.stopped, "");
});

test("private IPC authenticates tokens and fails closed after root exit", async t => {
  const { root, dir, reserve } = setup(t); await root.listen(dir);
  assert.equal(statSync(root.socketPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(root.socketPath, "..")).mode & 0o777, 0o700);
  const lease = await reserve(), child = connectRuntime(lease.env);
  const response = await child.call("register", { pid: 1234, cwd: dir, rootSession: "root-session", sessionFile: join(dir, "child.jsonl") });
  assert.equal(response.agent, "worker"); await child.checkBudget();
  await assert.rejects(connectRuntime({ ...lease.env, PI_ORCHESTRATOR_TOKEN: "wrong" }).checkBudget(), /unauthorized IPC token/);
  await root.close(); await assert.rejects(child.checkBudget());
});

test("cancelled workflow scopes revoke delayed admission and descendant tool calls", async t => {
  const { root, reserve, register } = setup(t); const controller = new AbortController();
  const lease = await root.scope.run(controller.signal, reserve); register(lease); controller.abort();
  await assert.rejects(root.scope.run(controller.signal, reserve), /workflow cancelled/);
  assert.throws(() => root.dispatch(lease.id, "check"), /cancelled/); assert.equal(root.leases.size, 1);
});

test("session reset closes known panes, retaining failed closures and live PIDs", async t => {
  const { root, dir } = setup(t);
  let live = true;
  const closed: string[] = [];
  const managed = new RootRuntime(root.config, dir, "root-session", () => live, pane => {
    if (pane === "lost") throw new Error("transport failed"); closed.push(pane);
  });
  for (const pane of ["confirmed", "lost"]) {
    const lease = managed.dispatch(null, "reserve", { agent: "worker", name: pane, cwd: dir });
    managed.dispatch(null, "launched", { id: lease.id, paneId: pane, sessionFile: join(dir, `${pane}.jsonl`) });
    managed.dispatch(lease.id, "register", { pid: 1234, cwd: dir, sessionFile: join(dir, `${pane}.jsonl`), rootSession: "root-session" });
  }
  managed.reset("next-session"); managed.reap();
  assert.deepEqual(closed, ["confirmed"]); assert.equal(managed.leases.size, 2);
  live = false; managed.reap(); assert.equal(managed.leases.size, 1);
  assert.equal([...managed.leases.values()][0].paneId, "lost");
});

test("child extension enforces tools, polls literal messages and reports exhaustion", async t => {
  const { root, dir, reserve, client } = setup(t); await root.listen(dir);
  const environment = { ...process.env }; t.after(() => { process.env = environment; });
  const lease = await reserve("scout"); Object.assign(process.env, lease.env);
  process.env.PI_ORCHESTRATOR_CONFIG = join(dir, "config.json");
  writeFileSync(process.env.PI_ORCHESTRATOR_CONFIG, JSON.stringify(root.config));
  const mock = mockPi(); let shutdowns = 0;
  const notifications: Array<[string, string]> = [];
  const ctx = { cwd: dir, sessionManager: { getSessionFile: () => join(dir, "child.jsonl") },
    ui: { notify(message: string, level: string) { notifications.push([message, level]); }, setStatus() {} }, abort() {}, shutdown: () => shutdowns++ };
  orchestrator(mock.pi as any); await mock.emit("session_start", {}, ctx);
  t.after(() => mock.emit("session_shutdown", { reason: "quit" }).then(() => {}));
  assert.deepEqual(mock.activeTools(), ["read", "ask_question"]);
  let delivered = ""; mock.pi.events.on(MESSAGE_EVENT, ({ text }: any) => { delivered = text; });
  await client.message(join(dir, "child.jsonl"), "/quit\nnot a command");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(delivered, "/quit\nnot a command");
  assert.deepEqual(mock.sent, [[delivered, { deliverAs: "steer", expandPromptTemplates: false }]]);
  for (let i = 0; i < 21; i++) await mock.emit("turn_start", {});
  assert.equal(shutdowns, 1); assert.equal(root.stopped, "");
  assert.equal(notifications.at(-1)?.[1], "warning");
  assert.match(notifications.at(-1)![0], /Stopped: configured turn limit reached \(20\)/);
  assert.match(JSON.parse(readFileSync(join(dir, "child.jsonl.exit"), "utf8")).errorMessage, /maxTurnsPerRun/);
  assert.equal((await mock.emit("tool_call", { toolName: "read" }))[0].block, true);
});

test("root lifecycle reuses budgets, fails closed, and records only admitted command intent", async t => {
  const dir = mkdtempSync(join(tmpdir(), "orch-root-")), environment = { ...process.env };
  t.after(() => { process.env = environment; rmSync(dir, { recursive: true, force: true }); });
  for (const key of ["PI_DOTFILES_SUBAGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_ORCHESTRATOR_LEASE", "PI_ORCHESTRATOR_TOKEN", "PI_ORCHESTRATOR_SOCKET"]) delete process.env[key];
  process.env.PI_ORCHESTRATOR_CONFIG = join(dir, "config.json"); process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(process.env.PI_ORCHESTRATOR_CONFIG, JSON.stringify(fixture()));
  let shutdowns = 0, finishTask: () => void = () => {};
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => "root-session" },
    ui: { notify(message: string, level: string) { notifications.push({ message, level }); }, setStatus() {} }, abort() {}, shutdown() { shutdowns++; } };
  let mock = mockPi();
  const runner = async () => { await new Promise<void>(resolve => { finishTask = resolve; }); return { summary: "reviewed", exitCode: 0 }; };
  let coordinator = installOrchestrator(mock.pi as any, runner);
  await mock.emit("session_start", {}, ctx);
  const spend = async () => {
    const lease = await coordinator.client.reserve({ agent: "worker", name: "x", cwd: dir });
    await coordinator.client.paneClosed(lease.id); await coordinator.client.release(lease.id);
  };
  for (let i = 0; i < 8; i++) await spend();
  await coordinator.client.accountUsage({ tokens: 4 });
  await mock.commands.get("workflow")("list", ctx);
  assert.match(notifications.at(-1)!.message, /Usage: \/workflow <name> <task>/);
  await assert.rejects(mock.commands.get("workflow")("missing task", ctx), /unknown workflow/);
  for (const args of ["review", "review   "]) {
    await mock.commands.get("workflow")(args, ctx);
    assert.match(notifications.at(-1)!.message, /A task is required\. Usage: \/workflow review <task>/);
    assert.equal(notifications.at(-1)!.level, "warning");
  }
  assert.equal((await coordinator.client.status()).launches, 8); assert.deepEqual(mock.entries, []);
  await mock.commands.get("workflow")("review actual human request", ctx);
  assert.deepEqual(mock.entries, [["orchestrator-user-intent", { text: "actual human request" }]]);
  assert.equal((await coordinator.client.status()).launches, 0);
  await spend();
  await assert.rejects(mock.commands.get("workflow")("review duplicate", ctx), /busy/);
  assert.equal((await coordinator.client.status()).launches, 1); assert.equal(mock.entries.length, 1);
  finishTask(); await setImmediate();
  await mock.tools.find(tool => tool.name === "workflow").execute("id", { name: "review", task: "worker text" }, undefined, undefined, ctx);
  assert.equal(mock.entries.length, 1); assert.equal((await coordinator.client.status()).launches, 1);
  finishTask(); await setImmediate();
  await mock.emit("input", { source: "extension" }); assert.equal((await coordinator.client.status()).launches, 1);
  await mock.emit("session_shutdown", { reason: "reload" });
  mock = mockPi(); coordinator = installOrchestrator(mock.pi as any, runner);
  await mock.emit("session_start", {}, ctx);
  assert.equal((await coordinator.client.status()).totalTokens, 4); assert.equal((await coordinator.client.status()).launches, 1);
  await mock.emit("input", { source: "interactive" }); assert.equal((await coordinator.client.status()).launches, 0);
  const root = (globalThis as any)[Symbol.for("pi-subagents/orchestrator-host")] as RootRuntime;
  await mock.emit("session_shutdown", { reason: "quit" }); assert.equal(existsSync(root.socketPath), false);
  delete process.env.PI_ORCHESTRATOR_CONFIG;
  const blocked = mockPi(); installOrchestrator(blocked.pi as any);
  await blocked.emit("session_start", {}, ctx);
  assert.equal(shutdowns, 1); assert.equal((await blocked.emit("tool_call", {}))[0].block, true);
  delete (globalThis as any)[KEY];
});
