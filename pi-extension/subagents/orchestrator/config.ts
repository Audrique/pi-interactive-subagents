import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export type Reasoning = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface AgentConfig {
  description: string; model: string | null; reasoning: Reasoning; tools: string[];
  canSpawn: string[]; prompt: string; sessionMode: "standalone" | "lineage-only" | "fork";
}
export interface TaskStep { agent: string; task: string }
export interface Workflow { description: string; steps: (TaskStep | { parallel: TaskStep[] })[] }
export interface Config {
  schemaVersion: 1;
  reviewer: { mode: "auto" | "manual"; provider: string | null; model: string | null;
    reasoning: Reasoning; timeoutMs: number; maxTokens: number };
  permissions: { authorizerChain: string[]; yoloMode: false; permission: Record<string, unknown> };
  limits: { maxOpenPanes: number; maxDepth: number; maxLaunchesPerTurn: number;
    maxTurnsPerRun: number; maxTokensPerSession: number | null };
  panes: { direction: "right" | "down"; shellReadyDelayMs: number };
  agents: Record<string, AgentConfig>;
  workflows: Record<string, Workflow>;
}

export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Orchestrator: ${message}`);
}
export function text(value: unknown, max = 32768): asserts value is string {
  ensure(typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0"), "invalid text");
}
function object(value: unknown, keys?: string): asserts value is Record<string, any> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "expected object");
  if (keys) ensure(Object.keys(value).sort().join(",") === keys.split(" ").sort().join(","), `expected exactly: ${keys}`);
  ensure(!Object.keys(value).some(k => ["__proto__", "constructor", "prototype"].includes(k)), "unsafe object key");
}
function integer(value: unknown, max: number, min = 1): void {
  ensure(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max, `expected integer ${min}..${max}`);
}
function names(value: unknown): asserts value is string[] {
  ensure(Array.isArray(value) && value.length <= 100, "expected name list");
  for (const name of value) { text(name, 100); ensure(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name), "invalid name"); }
  ensure(new Set(value).size === value.length, "duplicate names");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function parseConfig(input: unknown): Config {
  ensure((JSON.stringify(input)?.length ?? Infinity) <= 98304, "config exceeds 96 KiB IPC limit");
  const raw = structuredClone(input);
  object(raw, "schemaVersion reviewer permissions limits panes agents workflows");
  ensure(raw.schemaVersion === 1, "schemaVersion must be 1");
  const r = raw.reviewer;
  object(r, "mode provider model reasoning timeoutMs maxTokens");
  ensure(["auto", "manual"].includes(r.mode), "invalid reviewer mode");
  for (const v of [r.provider, r.model]) if (v !== null) text(v, 200);
  const reasoning = (v: unknown) => ensure(["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(v as string), "invalid reasoning");
  reasoning(r.reasoning); integer(r.timeoutMs, 120000); integer(r.maxTokens, 16384);
  const p = raw.permissions;
  object(p, "authorizerChain yoloMode permission");
  ensure(p.yoloMode === false && JSON.stringify(p.authorizerChain) === '["ai-authorizer"]', "central authorizer required; yolo forbidden");
  object(p.permission);
  for (const rule of Object.values(p.permission)) {
    const action = (v: unknown) => ensure(["allow", "ask", "deny"].includes(v as string), "invalid permission action");
    if (typeof rule === "string") action(rule);
    else { object(rule); Object.values(rule).forEach(action); }
  }
  const l = raw.limits;
  object(l, "maxOpenPanes maxDepth maxLaunchesPerTurn maxTurnsPerRun maxTokensPerSession");
  integer(l.maxOpenPanes, 64); integer(l.maxDepth, 16); integer(l.maxLaunchesPerTurn, 1000); integer(l.maxTurnsPerRun, 1000);
  if (l.maxTokensPerSession !== null) integer(l.maxTokensPerSession, Number.MAX_SAFE_INTEGER);
  object(raw.panes, "direction shellReadyDelayMs");
  ensure(["right", "down"].includes(raw.panes.direction), "invalid pane direction");
  integer(raw.panes.shellReadyDelayMs, 10000, 0);
  object(raw.agents); names(Object.keys(raw.agents)); ensure(Object.keys(raw.agents).length, "agents required");
  for (const a of Object.values(raw.agents)) {
    object(a, "description model reasoning tools canSpawn prompt sessionMode");
    text(a.description); text(a.prompt); if (a.model !== null) text(a.model, 200);
    reasoning(a.reasoning); names(a.tools); names(a.canSpawn);
    ensure(a.canSpawn.every((n: string) => Object.hasOwn(raw.agents, n)), "unknown spawn target");
    ensure(["standalone", "lineage-only", "fork"].includes(a.sessionMode), "invalid session mode");
  }
  object(raw.workflows); names(Object.keys(raw.workflows));
  const step = (s: unknown) => {
    object(s, "agent task"); text(s.agent, 100); ensure(Object.hasOwn(raw.agents, s.agent), "unknown workflow agent"); text(s.task);
    ensure(!/{{|}}/.test(s.task.replace(/{{(task|previous)}}/g, "")), "unknown template placeholder");
  };
  for (const w of Object.values(raw.workflows)) {
    object(w, "description steps"); text(w.description);
    ensure(Array.isArray(w.steps) && w.steps.length > 0 && w.steps.length <= l.maxLaunchesPerTurn, "invalid workflow steps");
    let launches = 0;
    for (const s of w.steps) {
      object(s);
      if (Object.hasOwn(s, "parallel")) {
        object(s, "parallel"); ensure(Array.isArray(s.parallel) && s.parallel.length > 0 && s.parallel.length <= l.maxOpenPanes, "invalid parallel group");
        s.parallel.forEach(step); launches += s.parallel.length;
      } else { step(s); launches++; }
    }
    ensure(launches <= l.maxLaunchesPerTurn, "workflow exceeds launch budget");
  }
  return freeze(raw as unknown as Config);
}

export function loadConfig(): Config {
  const path = process.env.PI_ORCHESTRATOR_CONFIG;
  ensure(path, "PI_ORCHESTRATOR_CONFIG is mandatory");
  ensure(isAbsolute(path), "PI_ORCHESTRATOR_CONFIG must name the absolute central config file");
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

export const SPAWNING_TOOLS = ["subagent", "subagent_message", "subagents_list"] as const;
export function agentTools(agent: AgentConfig): string[] {
  return [...new Set([...agent.tools.filter(tool => tool !== "workflow" && !(SPAWNING_TOOLS as readonly string[]).includes(tool)),
    "ask_question", ...(agent.canSpawn.length ? SPAWNING_TOOLS : [])])];
}
