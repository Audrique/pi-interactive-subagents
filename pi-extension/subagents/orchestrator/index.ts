import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { OutcomeError, errorOutcome, describeOutcome, isControlledStop, reportOutcome, type Outcome } from "./outcome.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentTools, ensure, loadConfig, parseConfig, type Config, type TaskStep } from "./config.ts";
import { connectRuntime, KEY, MESSAGE_EVENT, RootRuntime, RuntimeClient } from "./runtime.ts";
import { WorkflowRunner } from "./workflow.ts";
import { installBackgroundActivity, type BackgroundActivity } from "./background-activity.ts";
import { closeLeasedSurface } from "../herdr.ts";

// Reload persistence only, never the launcher/reviewer communication channel.
const HOST = Symbol.for("pi-subagents/orchestrator-host");
type Host = typeof globalThis & { [HOST]?: RootRuntime; [KEY]?: RuntimeClient };
const host = globalThis as Host;
export type Runner = (step: TaskStep, ctx: ExtensionContext, signal: AbortSignal) => Promise<{ summary: string; exitCode: number; outcome?: Outcome }>;

export interface Coordinator {
  client: RuntimeClient;
  config(): Config;
  humanCommand(): void;
}

export function isChild(): boolean {
  return process.env.PI_DOTFILES_SUBAGENT === "1" || !!process.env.PI_ORCHESTRATOR_LEASE ||
    !!process.env.PI_SUBAGENT_PARENT_SESSION || !!process.env.PI_ORCHESTRATOR_SOCKET || !!process.env.PI_ORCHESTRATOR_TOKEN;
}

// The mandatory wrapper entry owns child lifecycle hooks. The optional launcher
// needs only a typed IPC client; no shared extension-loader module state is needed.
export function childCoordinator(): Coordinator {
  let config: Config | undefined;
  return { client: connectRuntime(process.env), config: () => config ??= loadConfig(),
    humanCommand: () => { throw new Error("Orchestrator: human commands are root-only"); } };
}

export function installOrchestrator(pi: ExtensionAPI, run?: Runner, activity?: BackgroundActivity): Coordinator {
  const child = isChild();
  // The root launcher passes its producer; the mandatory child guard owns none.
  activity ??= child ? undefined : installBackgroundActivity(pi);
  let runtime: RuntimeClient | undefined, root: RootRuntime | undefined, config: Config | undefined;
  let context: ExtensionContext | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let problem = "runtime not initialized", active = true, ready = false, generation = 0;
  let terminalGeneration: number | undefined;
  const workflows = new WorkflowRunner();
  const stop = (reason: unknown) => {
    if (!active) return; // Abort/accounting/cleanup must not replace the first cause.
    active = false;
    terminalGeneration = generation;
    let outcome = errorOutcome(reason);
    problem = describeOutcome(outcome); ready = false; workflows.cancel(new OutcomeError(outcome));
    if (timer) clearTimeout(timer);
    if (child) {
      const sessionFile = context?.sessionManager.getSessionFile();
      if (sessionFile) {
        try { outcome = reportOutcome(sessionFile, outcome); }
        catch (e) { context?.ui.notify(`Could not report child failure: ${String(e)}`, "error"); }
      }
    } else root?.stop(reason);
    const controlled = isControlledStop(outcome);
    problem = describeOutcome(outcome);
    context?.ui.notify(controlled ? problem : `Orchestrator BLOCKED: ${problem}`, controlled ? "warning" : "error");
    context?.ui.setStatus("orchestrator", controlled ? problem.split("\n")[0] : `Orchestrator BLOCKED: ${problem}`);
    context?.abort(); context?.shutdown();
  };
  const guard = async () => {
    ensure(active && ready && runtime, problem || "runtime unavailable");
    await runtime.checkBudget();
  };
  const published = new RuntimeClient(async (method, args) => {
    ensure(runtime && ((active && ready) || ["release", "paneClosed", "launched", "accountUsage"].includes(method)), problem);
    try { return await runtime.call(method, args); }
    catch (e) { if (method === "accountUsage") stop(e); throw e; }
  });
  host[KEY] = published;
  const coordinator: Coordinator = {
    client: published,
    config: () => { ensure(ready && config, problem); return config; },
    humanCommand: () => { ensure(!child && ready && root, "human commands are root-only"); root.input("interactive"); },
  };
  pi.on("tool_call", async event => {
    try {
      await guard();
      if (child) {
        const agent = config!.agents[process.env.PI_SUBAGENT_AGENT!];
        ensure(agent && agentTools(agent).includes(event.toolName), "tool outside current central agent tools");
      }
    } catch (e) { stop(e); return { block: true, reason: problem }; }
  });
  pi.on("turn_start", async () => {
    try { await guard(); await runtime!.call("turn"); } catch (e) { stop(e); }
  });
  pi.on("message_end", async event => {
    if (event.message.role !== "assistant") return;
    const usage = event.message.usage;
    try { await published.accountUsage({ tokens: usage.totalTokens ?? (usage.input + usage.output + usage.cacheRead + usage.cacheWrite) }); }
    catch (e) { stop(e); }
  });
  pi.on("input", event => {
    if (!child && event.source === "interactive") {
      workflows.cancel("new root user input"); root?.input(event.source);
    }
    return { action: "continue" };
  });
  pi.on("session_start", async (_event, ctx) => {
    context = ctx; active = true; ready = false; const current = ++generation;
    if (timer) clearTimeout(timer);
    try {
      const local = loadConfig();
      if (child) {
        runtime = connectRuntime(process.env);
        const registration = await runtime.call("register", { pid: process.pid, cwd: ctx.cwd,
          sessionFile: ctx.sessionManager.getSessionFile(), rootSession: process.env.PI_SUBAGENT_PARENT_SESSION });
        config = parseConfig(registration.config);
        ensure(JSON.stringify(local) === JSON.stringify(config), "child config differs from immutable root config");
        const agent = config.agents[registration.agent];
        ensure(agent, "unknown child identity");
        process.env.PI_SUBAGENT_AGENT = registration.agent;
        pi.setActiveTools(agentTools(agent));
        const poll = async () => {
          try {
            const messages: string[] = await runtime!.call("poll");
            if (!active || current !== generation || !ready) return;
            for (const text of messages) {
              pi.events.emit(MESSAGE_EVENT, { text });
              pi.sendUserMessage(text, { deliverAs: "steer", expandPromptTemplates: false });
            }
            timer = setTimeout(() => void poll(), 250); timer.unref();
          } catch (e) { if (active && current === generation) stop(e); }
        };
        ready = true; void poll();
      } else {
        root = host[HOST];
        if (!root) {
          root = new RootRuntime(local, ctx.cwd, ctx.sessionManager.getSessionId(), undefined, closeLeasedSurface);
          await root.listen(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
          host[HOST] = root;
        } else {
          ensure(JSON.stringify(local) === JSON.stringify(root.config), "config changed; restart Pi to apply it");
          root.reset(ctx.sessionManager.getSessionId());
        }
        root.paused = false; root.onStop = stop; config = root.config;
        runtime = new RuntimeClient(async (method, args) => root!.dispatch(null, method, args));
        root.check(); ready = true;
      }
      problem = "";
      ctx.ui.setStatus("orchestrator", `Orchestrator guarded | panes ${config.limits.maxOpenPanes} | depth ${config.limits.maxDepth}`);
    } catch (e) { stop(isControlledStop(errorOutcome(e)) ? e : `startup failed: ${String(e)}`); }
  });
  pi.on("session_shutdown", async event => {
    active = false; ready = false; generation++; workflows.cancel("session ended");
    if (timer) clearTimeout(timer);
    if (root) {
      root.paused = true; root.reset(root.rootSession);
      if (event.reason === "quit") {
        root.onStop = () => {}; await root.close();
        if (host[HOST] === root) delete host[HOST];
      }
    }
  });
  pi.registerCommand("orchestrator", {
    description: "Show root admission and resource limits",
    handler: async (args, ctx) => {
      ensure(!args.trim() || args.trim() === "status", "usage: /orchestrator status");
      ctx.ui.notify(runtime ? JSON.stringify(await runtime.status(), null, 2) : `BLOCKED: ${problem}`, ready ? "info" : "error");
    },
  });
  const startWorkflow = (name: string, task: string, ctx: ExtensionContext, humanCommand = false) => {
    ensure(!child, "workflows are root-only"); ensure(ready && root && config, problem);
    ensure(Object.hasOwn(config.workflows, name), "unknown workflow");
    ensure(run, "interactive subagent runner unavailable");
    const current = generation;
    let reported = false;
    // Acquire before start(): its admitted callback runs before active is set.
    const finish = activity!.begin();
    try {
      void workflows.start(config.workflows[name], task,
      (step, signal) => activity!.track(() => root!.scope.run(signal, () => {
        root!.check(); signal.throwIfAborted(); return run(step, ctx, signal);
      })),
      (content, outcome) => {
        // Stopping disables execution, not the current workflow's terminal
        // report. Shutdown/session replacement still invalidates this closure.
        if (reported || current !== generation || (!active && !(outcome && terminalGeneration === current))) return;
        reported = true;
        return pi.sendMessage({ customType: "orchestrator-workflow", content, details: { outcome }, display: true },
          { triggerTurn: false, deliverAs: "followUp" });
      },
      () => {
        if (humanCommand) {
          // Reviewer integration: accepted slash-command intent, not worker output.
          pi.appendEntry("orchestrator-user-intent", { text: task });
          coordinator.humanCommand();
        }
      }).finally(finish);
    } catch (error) { finish(); throw error; }
  };
  pi.registerMessageRenderer("orchestrator-workflow", (message, _options, theme) => {
    const outcome = (message.details as any)?.outcome;
    const color = isControlledStop(outcome) ? "warning" : outcome?.status === "failed" ? "error" : "muted";
    return new Text(theme.fg(color, String(message.content)), 0, 0);
  });
  pi.registerTool({
    name: "workflow", label: "Workflow", description: "Start a configured root-only workflow; completion arrives asynchronously.",
    parameters: { type: "object", properties: { name: { type: "string" }, task: { type: "string" } },
      required: ["name", "task"], additionalProperties: false } as any,
    execute: async (_id, params, signal, _update, ctx) => {
      const { name, task } = params as { name: string; task: string };
      await guard(); signal?.throwIfAborted(); startWorkflow(name, task, ctx);
      return { content: [{ type: "text", text: `Workflow ${name} started; completion will be reported.` }], details: {} };
    },
  });
  pi.registerCommand("workflow", {
    description: "List or run JSON-configured workflows: /workflow [list|name task]",
    handler: async (args, ctx) => {
      await guard(); ensure(!child, "workflows are root-only");
      const match = args.trim().match(/^(\S+)(?:\s+([\s\S]+))?$/);
      if (!match || match[1] === "list") {
        const listing = Object.entries(config!.workflows).map(([name, w]) => `${name}: ${w.description}`).join("\n") || "No workflows configured";
        ctx.ui.notify(`${listing}\n\nUsage: /workflow <name> <task>`, "info");
      } else if (!match[2]?.trim()) {
        ctx.ui.notify(`A task is required. Usage: /workflow ${match[1]} <task>\nDescribe what you want the workflow to work on after its name.`, "warning");
      } else startWorkflow(match[1], match[2], ctx, true);
    },
  });
  return coordinator;
}

// Mandatory in every child, including children that also load the launcher.
export default function orchestrator(pi: ExtensionAPI): void {
  installOrchestrator(pi);
}
