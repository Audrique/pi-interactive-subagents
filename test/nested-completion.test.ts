import assert from "node:assert/strict";
import childProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import subagents, { __test__ } from "../pi-extension/subagents/index.ts";
import subagentDone from "../pi-extension/subagents/subagent-done.ts";
import { RootRuntime } from "../pi-extension/subagents/orchestrator/runtime.ts";
import { fixture, mockPi } from "./fixtures.ts";

for (const [label, screen] of [["narrow wrapped prompt", "ading-rs\non main\nimpure\n> "], ["blank pane", ""]]) {
  test(`nested scout completion closes its ${label} and queues a result without exiting its worker`, { timeout: 5000 }, async t => {
    const env = { ...process.env }, dir = mkdtempSync(join(tmpdir(), "nested-completion-"));
    const config = fixture(), configFile = join(dir, "config.json"), workerFile = join(dir, "worker.jsonl");
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(workerFile, JSON.stringify({ type: "session", id: "worker-session" }) + "\n");
    process.env.PI_ORCHESTRATOR_CONFIG = configFile;
    const root = new RootRuntime(config, dir, "root-session");
    const mock = mockPi();
    let child: ChildProcessWithoutNullStreams | undefined;
    let ready: Promise<any[]> | undefined, closed: Promise<any[]> | undefined;
    let queued = false, shutdowns = 0;
    const ctx: any = { cwd: dir, hasUI: false, ui: { setWidget() {} },
      hasPendingMessages: () => queued, shutdown: () => shutdowns++, sessionManager: {
        getSessionFile: () => workerFile, getSessionId: () => "worker-session", getSessionDir: () => dir,
      } };
    t.after(async () => {
      try {
        await mock.emit("session_shutdown", { reason: "quit" }, ctx);
        child?.stdin.destroy(); child?.kill("SIGKILL");
        await root.close();
      } finally {
        __test__.runningSubagents.clear(); __test__.setCoordinator(undefined);
        process.env = env; rmSync(dir, { recursive: true, force: true });
      }
    });
    await root.listen(dir);
    const worker = root.dispatch(null, "reserve", { agent: "worker", name: "worker", cwd: dir });
    root.dispatch(null, "launched", { id: worker.id, paneId: "nested:worker", sessionFile: workerFile });
    root.dispatch(worker.id, "register", { pid: process.pid, cwd: dir, sessionFile: workerFile, rootSession: "root-session" });
    const bash = childProcess.execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
    const fakePi = join(dir, "fake-pi");
    writeFileSync(fakePi, `#!${bash}\n` + [
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = --session ]; then shift; session=$1; fi',
      "  shift",
      "done",
      `printf '%s\\n' '${JSON.stringify({ type: "session", id: "scout-session" })}' '${JSON.stringify({
        type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Nested scout findings" }] },
      })}' > "$session"`,
      "printf 'ready\\n'",
      "IFS= read -r answer",
      "exit 0",
    ].join("\n") + "\n", { mode: 0o700 });
    Object.assign(process.env, worker.env, {
      PI_GUARDED_EXECUTABLE: fakePi, PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_AGENT: "worker",
      PI_SUBAGENT_AUTO_EXIT: "1", PI_SUBAGENT_SESSION: workerFile, HERDR_ENV: "1", HERDR_PANE_ID: "nested:worker",
    });
    delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
    subagents(mock.pi as any); subagentDone(mock.pi as any);
    await mock.emit("session_start", {}, ctx);
    await mock.emit("agent_start", {}, ctx);
    const closedPanes: string[] = [];
    t.mock.method(childProcess, "execFileSync", (file: string, args: string[]) => {
      assert.equal(file, "herdr");
      if (args[0] === "--version") return "herdr";
      if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "nested:scout" } } });
      if (args[1] === "run") {
        child = childProcess.spawn(bash, ["-c", args[3]]);
        ready = once(child.stdout, "data"); closed = once(child, "close");
        return "";
      }
      assert.equal(args[1], "close"); closedPanes.push(args[2]);
      return JSON.stringify({ result: { type: "ok" } });
    });
    t.mock.method(childProcess, "execFile", (_file: string, _args: string[], _options: unknown, cb: Function) => cb(null, screen));
    let delivered!: () => void;
    const resultQueued = new Promise<void>(resolve => { delivered = resolve; });
    const sendMessage = mock.pi.sendMessage.bind(mock.pi);
    t.mock.method(mock.pi, "sendMessage", (message: any, options: any) => {
      sendMessage(message, options);
      if (message.customType === "subagent_result") { queued = true; delivered(); }
    });
    const spawn = mock.tools.find(tool => tool.name === "subagent");
    await spawn.execute("spawn", { agent: "scout", name: "scout", task: "Investigate" }, undefined, undefined, ctx);
    assert.equal(String((await ready!)[0]), "ready\n");
    const running = [...__test__.runningSubagents.values()][0];
    assert.equal(existsSync(running.completion.file), false);
    assert.equal(root.dispatch(null, "status").open, 2);
    const end = { messages: [{ role: "assistant", stopReason: "stop" }] };
    await mock.emit("agent_end", end, ctx);
    assert.equal(shutdowns, 0, "worker must survive yielding to its scout");
    child!.stdin.end("finish\n");
    assert.deepEqual(await closed!, [0, null]);
    assert.deepEqual(JSON.parse(readFileSync(running.completion.file, "utf8")), {
      version: 1, runId: running.completion.runId, exitCode: 0,
    });
    await resultQueued;
    assert.deepEqual(closedPanes, ["nested:scout"]);
    assert.equal(root.dispatch(null, "status").open, 1);
    assert.equal(__test__.runningSubagents.size, 0);
    assert.equal(mock.reports.length, 1);
    assert.match(mock.reports[0].content, /Nested scout findings/);
    assert.equal(mock.reports[0].details.exitCode, 0);
    assert.deepEqual(mock.reportOptions, [{ triggerTurn: true, deliverAs: "steer" }]);
    await mock.emit("agent_end", end, ctx);
    assert.equal(shutdowns, 0, "queued result must keep the worker alive until consumed");
    queued = false;
    await mock.emit("agent_start", {}, ctx); await mock.emit("agent_end", end, ctx);
    assert.equal(shutdowns, 1, "worker may exit after consuming the result and finishing");
  });
}
