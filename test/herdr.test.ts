import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as herdr from "../pi-extension/subagents/herdr.ts";
import { parseConfig } from "../pi-extension/subagents/orchestrator/config.ts";
import { RuntimeClient } from "../pi-extension/subagents/orchestrator/runtime.ts";
import { fixture, mockPi } from "./fixtures.ts";

test("Herdr contract: explicit no-focus splits, owned launch, literal scripts and closure", async t => {
  const oldEnv = { ...process.env }, dir = mkdtempSync(join(tmpdir(), "herdr-"));
  t.after(() => { process.env = oldEnv; rmSync(dir, { recursive: true, force: true }); });
  process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "w1:p1";
  const calls: string[][] = [];
  let reply: any = { pane: { pane_id: "w1:p2" } };
  let readReply = "__SUBAGENT_DONE_7__";
  let readError: Error | null = null;
  t.mock.method(childProcess, "execFileSync", (file: string, args: string[]) => {
    assert.equal(file, "herdr"); calls.push(args);
    if (args[1] === "run") return "";
    if (args[1] === "read") return readReply;
    return JSON.stringify({ result: reply });
  });
  t.mock.method(childProcess, "execFile", (file: string, args: string[], _options: unknown, cb: Function) => {
    assert.equal(file, "herdr"); calls.push(args); cb(readError, readReply);
  });
  assert.equal(herdr.isMuxAvailable(), true);
  herdr.createSurface("worker", "/project with spaces", { direction: "down", shellReadyDelayMs: 17 });
  assert.deepEqual(calls.at(-1), ["pane", "split", "--pane", "w1:p1", "--direction", "down", "--cwd", "/project with spaces", "--no-focus"]);
  assert.throws(() => herdr.createSurfaceSplit("worker", "left"), /right\/down/);
  assert.throws(() => herdr.closeSurface("w1:p1"), /unowned/);
  assert.throws(() => herdr.sendCommand("w1:p1", "exit"), /unowned/);
  reply = {}; assert.throws(() => herdr.createSurfaceSplit("worker", "right"), /pane_id/);
  const scriptPath = join(dir, "launch 'quoted'.sh");
  herdr.sendLongCommand("w1:p2", "true", { scriptPath, scriptPreamble: "label\ntouch /never" });
  assert.deepEqual(calls.at(-1), ["pane", "run", "w1:p2", `bash ${herdr.shellEscape(scriptPath)}`]);
  assert.match(readFileSync(scriptPath, "utf8"), /# label\n# touch \/never\ntrue/);
  readReply = "unwrapped screen";
  assert.equal(herdr.readScreen("w1:p2", 12), "unwrapped screen");
  assert.deepEqual(calls.at(-1), ["pane", "read", "w1:p2", "--source", "recent-unwrapped", "--lines", "12"]);
  const completion = { file: join(dir, "completion.json"), runId: "contract-run" };
  writeFileSync(completion.file, JSON.stringify({ version: 1, runId: completion.runId, exitCode: 7 }));
  assert.deepEqual(await herdr.pollForExit("w1:p2", new AbortController().signal, { interval: 1, completion }), { reason: "done", exitCode: 7 });
  rmSync(completion.file);
  readError = Object.assign(new Error("Command failed"), { stderr: JSON.stringify({ error: { code: "not_found", message: "pane not found" } }) });
  assert.match((await herdr.pollForExit("w1:p2", new AbortController().signal, { interval: 1, completion })).errorMessage!, /not_found/);
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: "provider overloaded" }));
  assert.deepEqual(await herdr.pollForExit("w1:p2", new AbortController().signal, { interval: 1, completion, sessionFile }),
    { reason: "error", exitCode: 1, errorMessage: "provider overloaded" });
  const controller = new AbortController(); readReply = ""; readError = null;
  await assert.rejects(herdr.pollForExit("w1:p2", controller.signal, { interval: 1, completion, onTick: () => controller.abort() }), /abort/i);
  reply = null; assert.throws(() => herdr.closeSurface("w1:p2"), /no result/);
  reply = { type: "ok" }; herdr.closeSurface("w1:p2");
  const count = calls.length; herdr.closeSurface("w1:p2"); assert.equal(calls.length, count);
  delete process.env.HERDR_ENV; assert.equal(herdr.isMuxAvailable(), false);
});

test("Herdr distinguishes JSON topology from plain reads, and confirms structured missing-pane errors", async t => {
  const oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "errors:p1";
  let output = "";
  let error: Error | undefined;
  t.mock.method(childProcess, "execFileSync", () => {
    if (error) throw error;
    return output;
  });
  assert.throws(() => herdr.createSurfaceSplit("test", "right"), /pane split returned empty output; expected JSON/);
  output = "{";
  assert.throws(() => herdr.createSurfaceSplit("test", "right"), /pane split returned invalid JSON/);
  output = JSON.stringify({ result: { pane: { pane_id: "errors:p2" } } });
  herdr.createSurfaceSplit("test", "right");
  output = ""; herdr.sendCommand("errors:p2", "true");
  assert.equal(herdr.readScreen("errors:p2"), "");
  output = '{"result":{"read":{"text":"literal terminal content"}}}';
  assert.equal(herdr.readScreen("errors:p2"), output);
  output = "";
  assert.throws(() => herdr.closeSurface("errors:p2"), /no result|expected JSON|invalid JSON/);
  error = Object.assign(new Error("Command failed"), { stderr: JSON.stringify({ error: { code: "unavailable", message: "server disconnected" } }) });
  assert.throws(() => herdr.sendCommand("errors:p2", "true"), /Herdr unavailable: server disconnected/);
  assert.throws(() => herdr.closeSurface("errors:p2"), /Herdr unavailable/);
  error = Object.assign(new Error("Command failed"), { stderr: JSON.stringify({ error: { code: "not_found", message: "pane not found" } }) });
  herdr.closeSurface("errors:p2");
  assert.throws(() => herdr.sendCommand("errors:p2", "true"), /unowned/);
});

test("local source launch, workflow, resume and IPC messages use current JSON", async t => {
  const mod = await import("../pi-extension/subagents/index.ts");
  const oldEnv = { ...process.env }, dir = mkdtempSync(join(tmpdir(), "herdr-launch-"));
  t.after(() => { process.env = oldEnv; mod.__test__.setCoordinator(undefined); rmSync(dir, { recursive: true, force: true }); });
  for (const key of ["PI_ORCHESTRATOR_LEASE", "PI_ORCHESTRATOR_SOCKET", "PI_ORCHESTRATOR_TOKEN", "PI_SUBAGENT_PARENT_SESSION", "PI_DOTFILES_SUBAGENT", "PI_SUBAGENT_ALLOWED"]) delete process.env[key];
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "launch:p1", PI_CODING_AGENT_DIR: dir, PI_GUARDED_EXECUTABLE: process.execPath });
  let config = parseConfig(fixture());
  const mock = mockPi(); mod.default(mock.pi as any);
  const ctx: any = { cwd: dir, hasUI: false, model: { provider: "test", id: "parent-model" }, sessionManager: {
    getSessionFile: () => join(dir, "parent.jsonl"), getSessionId: () => "parent", getSessionDir: () => dir,
  } };
  t.after(() => mock.emit("session_shutdown", { reason: "quit" }, ctx).then(() => {}));
  let pane = 10, deny = false, failClose = false, failSplit = false, failRun = false, failLaunched = false;
  let reserveGate: Promise<void> | undefined, script = "", resumed = false, leaseNumber = 0;
  const events: string[] = [], messages: string[] = [];
  const completions: herdr.CompletionSignal[] = [];
  const runtime = new RuntimeClient(async (method, args) => {
    events.push(method);
    if (method === "reserve") {
      if (deny) throw new Error("limit reached"); resumed = args.resume; await reserveGate;
      return { id: `lease-${++leaseNumber}`, env: { PI_TEST_ROOT: "root-session" } };
    }
    if (method === "launched") {
      if (failLaunched) throw new Error("registration failed");
      writeFileSync(args.sessionFile, [JSON.stringify({ type: "session", id: "child" }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Finished task" }] } })].join("\n"));
      const completionDir = join(dir, "artifacts/parent/subagent-completions");
      mkdirSync(completionDir, { recursive: true });
      const completion = { file: join(completionDir, `${args.id}.json`), runId: args.id };
      completions.push(completion);
      writeFileSync(completion.file, JSON.stringify({ version: 1, runId: completion.runId, exitCode: 0 }));
    }
    if (method === "message") messages.push(args.text);
  });
  const coordinator = { client: runtime, config: () => config, humanCommand() {} };
  mod.__test__.setCoordinator(coordinator);
  t.mock.method(childProcess, "execFileSync", (_file: string, args: string[]) => {
    if (args[0] === "--version") return "herdr";
    events.push(args[1]);
    if (args[1] === "close" && failClose) throw new Error("Herdr unavailable");
    if (args[1] === "split" && failSplit) throw new Error("Split response lost");
    if (args[1] === "run") {
      if (failRun) throw new Error("Run response lost");
      script = readFileSync(args[3].slice("bash '".length, -1), "utf8");
      return "";
    }
    return JSON.stringify({ result: { pane: { pane_id: `launch:p${++pane}` } } });
  });
  t.mock.method(childProcess, "execFile", () => assert.fail("completed runs must not depend on terminal reads"));
  const params = { agent: "worker", task: "/fork\nordinary task", name: "job" };
  mod.__test__.setCoordinator(undefined);
  await assert.rejects(mod.run(params, ctx), /requires.*orchestrator/);
  mod.__test__.setCoordinator(coordinator);
  await assert.rejects(mod.run({ ...params, agent: "claude" }, ctx), /Claude CLI.*disabled/);
  delete process.env.PI_GUARDED_EXECUTABLE;
  await assert.rejects(mod.run(params, ctx), /PI_GUARDED_EXECUTABLE/); process.env.PI_GUARDED_EXECUTABLE = process.execPath;
  deny = true; await assert.rejects(mod.run(params, ctx), /limit reached/); deny = false;
  assert.equal(events.includes("split"), false); events.length = 0;
  const result = await mod.run(params, ctx); assert.equal(result.summary, "Finished task"); assert.equal(result.exitCode, 0);
  assert.deepEqual(events, ["reserve", "split", "launched", "check", "run", "close", "paneClosed", "release"]);
  assert.match(script, /--no-extensions/); assert.match(script, /--model 'test\/parent-model' --thinking 'high'/);
  assert.match(script, /PI_TEST_ROOT='root-session'/); assert.equal(script.includes("/fork"), false);
  assert.match(script, /PI_SUBAGENT_ALLOWED='worker,scout'/);
  assert.doesNotMatch(script, /__SUBAGENT_DONE_/);
  await assert.rejects(mod.run(params, ctx), /already in use/);
  let unblock!: () => void; reserveGate = new Promise<void>(resolve => { unblock = resolve; });
  const concurrent = mod.run({ ...params, name: "parallel" }, ctx);
  await assert.rejects(mod.run({ ...params, name: "parallel" }, ctx), /already in use/);
  unblock(); await concurrent; reserveGate = undefined;

  // Persisted loadout is deliberately hostile. Only its agent identity and cwd are consulted.
  const registry = JSON.parse(readFileSync(join(dir, "artifacts/parent/subagent-registry.json"), "utf8"));
  const sessionPath = registry.job.sessionFile;
  const loadout = JSON.parse(readFileSync(`${sessionPath}.loadout.json`, "utf8"));
  Object.assign(loadout, { toolAllowlist: "bash,subagent", spawnable: ["worker"], identity: "STALE PRIVILEGED PROMPT", model: "stale/model", thinking: "max" });
  writeFileSync(`${sessionPath}.loadout.json`, JSON.stringify(loadout));
  const updated = fixture(); updated.agents.worker.canSpawn = []; updated.agents.worker.model = "test/current";
  updated.agents.worker.reasoning = "low"; updated.agents.worker.prompt = "CURRENT PROMPT"; config = parseConfig(updated);
  mkdirSync(join(dir, ".pi/agents"), { recursive: true });
  writeFileSync(join(dir, ".pi/agents/worker.md"), "---\ntools: bash\ncli: claude\n---\nProject override");
  const messageTool = mock.tools.find(tool => tool.name === "subagent_message");
  reserveGate = new Promise<void>(resolve => { unblock = resolve; });
  const resuming = messageTool.execute("id", { name: "job", message: "/quit\nfollow up" }, undefined, undefined, ctx);
  await assert.rejects(messageTool.execute("id", { name: "job", message: "duplicate" }, undefined, undefined, ctx), /already launching/);
  unblock(); await resuming; reserveGate = undefined;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumed, true); assert.match(script, /--model 'test\/current' --thinking 'low'/);
  assert.notEqual(completions[0].file, completions.at(-1)!.file);
  assert.notEqual(completions[0].runId, completions.at(-1)!.runId);
  assert.match(script, /--tools 'read,ask_question'/); assert.match(script, /PI_SUBAGENT_ALLOWED=''/);
  assert.equal(script.includes("STALE"), false); assert.equal(script.includes("/quit"), false);
  const promptPath = script.match(/--append-system-prompt '([^']+)'/)![1];
  assert.equal(readFileSync(promptPath, "utf8"), "CURRENT PROMPT");
  assert.deepEqual(await mod.__test__.steerSubagent({ sessionFile: "child.jsonl", name: "job" } as any, "/fork\nkeep literal"), { ok: true });
  assert.deepEqual(messages, ["/fork\nkeep literal"]);

  for (const failure of ["launched", "run", "split", "close"]) {
    failLaunched = failure === "launched"; failRun = failure === "run"; failSplit = failure === "split"; failClose = failure === "close";
    events.length = 0;
    const run = mod.run({ ...params, name: `failure-${failure}` }, ctx);
    if (failure === "close") {
      const result = await run;
      assert.equal(result.summary, "Finished task"); assert.equal(result.exitCode, 0);
      assert.deepEqual((result as any).cleanupErrors, [{ operation: "closeSurface", message: "Herdr unavailable" }]);
    } else await assert.rejects(run);
    if (failure === "split" || failure === "close") assert.equal(events.includes("release"), false);
    else assert.deepEqual(events.slice(-3), ["close", "paneClosed", "release"]);
    if (failure === "close") assert([...mod.__test__.runningSubagents.values()].some(running => running.name === "failure-close"));
  }
  failClose = false;
});

test("pending questions survive child result turns; IPC answers and queued messages control exit", async t => {
  const mod = await import("../pi-extension/subagents/subagent-done.ts");
  const oldEnv = { ...process.env }, dir = mkdtempSync(join(tmpdir(), "herdr-question-"));
  const countKey = Symbol.for("pi-subagents/running-children-count"), globals = globalThis as any, previous = globals[countKey];
  t.after(() => { process.env = oldEnv; globals[countKey] = previous; rmSync(dir, { recursive: true, force: true }); });
  globals[countKey] = () => 0;
  process.env.PI_SUBAGENT_AUTO_EXIT = "1"; process.env.PI_SUBAGENT_SESSION = join(dir, "child.jsonl");
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  const mock = mockPi(); mod.default(mock.pi as any); let shutdowns = 0, queued = false;
  const ctx = { shutdown: () => shutdowns++, hasPendingMessages: () => queued };
  await mock.emit("agent_start", {}, ctx);
  await mock.tools.find(tool => tool.name === "ask_question").execute("ask", { question: "Which option?" });
  const end = { messages: [{ role: "assistant", stopReason: "stop" }] };
  await mock.emit("agent_end", end, ctx); assert.equal(shutdowns, 0);
  await mock.emit("agent_start", {}, ctx); await mock.emit("agent_end", end, ctx); assert.equal(shutdowns, 0);
  mock.pi.events.emit("dotfiles:subagent-message", {});
  queued = true; await mock.emit("agent_end", end, ctx); assert.equal(shutdowns, 0);
  queued = false; await mock.emit("agent_end", end, ctx); assert.equal(shutdowns, 1);
  await mock.emit("session_shutdown", { reason: "quit" }, ctx);
});
