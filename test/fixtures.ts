import type { Config } from "../pi-extension/subagents/orchestrator/config.ts";

export function fixture(): Config {
  const agent = { description: "Test", model: null, reasoning: "high" as const, tools: ["read"],
    canSpawn: ["worker", "scout"], prompt: "Do the task", sessionMode: "standalone" as const };
  return { schemaVersion: 1,
    reviewer: { mode: "auto", provider: null, model: null, reasoning: "high", timeoutMs: 1000, maxTokens: 100 },
    permissions: { authorizerChain: ["ai-authorizer"], yoloMode: false, permission: { "*": "ask", bash: { "*": "ask" } } },
    limits: { maxOpenPanes: 3, maxDepth: 2, maxLaunchesPerTurn: 8, maxTurnsPerRun: 20, maxTokensPerSession: null },
    panes: { direction: "right", shellReadyDelayMs: 0 },
    agents: { worker: agent, scout: { ...agent, canSpawn: [] } },
    workflows: { review: { description: "Review", steps: [{ agent: "scout", task: "{{task}}" }] } } };
}

export function mockPi() {
  const handlers = new Map<string, Function[]>(), bus = new Map<string, Function[]>();
  const tools: any[] = [], commands = new Map<string, any>(), reports: any[] = [], entries: any[] = [], sent: any[] = [];
  const renderers = new Map<string, Function>();
  const reportOptions: any[] = [];
  let activeTools: string[] = [];
  const pi = {
    on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    events: {
      on(name: string, fn: Function) {
        bus.set(name, [...(bus.get(name) ?? []), fn]);
        return () => bus.set(name, bus.get(name)!.filter(item => item !== fn));
      },
      emit(name: string, value: unknown) { for (const fn of bus.get(name) ?? []) fn(value); },
    },
    registerTool(tool: any) { tools.push(tool); },
    registerCommand(name: string, value: any) { commands.set(name, value.handler); },
    registerMessageRenderer(name: string, renderer: Function) { renderers.set(name, renderer); }, registerShortcut() {},
    sendMessage(message: any, options?: any) { reports.push(message); reportOptions.push(options); },
    sendUserMessage(...args: any[]) { sent.push(args); },
    appendEntry(...args: any[]) { entries.push(args); },
    setActiveTools(names: string[]) { activeTools = names; },
    getAllTools() { return tools; },
  };
  return { pi, tools, commands, reports, reportOptions, entries, sent, renderers, activeTools: () => activeTools,
    async emit(name: string, ...args: any[]) {
      const results = [];
      for (const fn of handlers.get(name) ?? []) results.push(await fn(...args));
      return results;
    } };
}
