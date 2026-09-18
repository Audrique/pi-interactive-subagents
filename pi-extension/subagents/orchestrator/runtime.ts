import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensure, text, type Config } from "./config.ts";
import { OutcomeError, errorOutcome, isControlledStop, reportOutcome, type Outcome } from "./outcome.ts";

// The reviewer is a separate extension loader instance, so only its usage hook
// crosses the global symbol boundary. Launchers use the Coordinator directly.
export const KEY = Symbol.for("dotfiles.pi.orchestrator");
export const MESSAGE_EVENT = "dotfiles:subagent-message";
export interface Reservation { agent: string; name: string; cwd: string; resume?: boolean }
interface Lease {
  id: string; token: string; owner: string | null; agent: string; depth: number; cwd: string;
  pid?: number; sessionFile?: string; paneId?: string; closed?: boolean; releasing?: boolean;
  stopped?: boolean; outcome?: Outcome; scope?: AbortSignal; turns: number; messages: string[];
}
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export class RootRuntime {
  readonly leases = new Map<string, Lease>();
  readonly scope = new AsyncLocalStorage<AbortSignal>();
  readonly config: Config;
  readonly cwd: string;
  rootSession: string;
  socketPath = "";
  totalTokens = 0;
  launches = 0;
  turns = 0;
  stopped = "";
  paused = false;
  outcome?: Outcome;
  onStop: (reason: unknown) => void = () => {};
  private server?: Server;
  private sockets = new Set<Socket>();
  private processAlive: (pid: number) => boolean;

  constructor(config: Config, cwd: string, rootSession: string, processAlive = alive,
    private closePane?: (pane: string) => void) {
    this.config = config; this.cwd = realpathSync(cwd); this.rootSession = rootSession; this.processAlive = processAlive;
  }
  stop(reason: unknown): void {
    if (!this.stopped) { this.stopped = String(reason); this.outcome = errorOutcome(reason); this.reset(this.rootSession); this.onStop(reason); }
  }
  private markStopped(lease: Lease, outcome?: Outcome): void {
    lease.stopped = true;
    if (outcome && !lease.outcome) {
      lease.outcome = lease.sessionFile ? reportOutcome(lease.sessionFile, outcome) : outcome;
    }
  }
  check(lease?: Lease): void {
    if (lease?.outcome) throw new OutcomeError(lease.outcome);
    if (this.outcome) throw new OutcomeError(this.outcome);
    ensure(!this.stopped, this.stopped);
    ensure(!this.paused, "root session is changing");
    ensure(!lease?.stopped && !lease?.scope?.aborted, "child run cancelled");
    // A stopped/dead intermediate parent must not leave orphaned grandchildren.
    if (lease?.owner) {
      const owner = this.leases.get(lease.owner);
      ensure(owner && (!owner.pid || this.processAlive(owner.pid)), "parent run ended");
      this.check(owner);
    }
  }
  reset(session: string): void {
    // Persist the entire tree before closing any ancestor process.
    for (const lease of this.leases.values()) this.markStopped(lease, this.outcome);
    for (const lease of this.leases.values()) {
      if (lease.paneId && !lease.closed && this.closePane) {
        try { this.closePane(lease.paneId); lease.closed = true; lease.releasing = true; }
        catch { /* Unknown/live panes retain capacity. Children also stop through polling. */ }
      }
    }
    this.rootSession = session;
  }
  input(source: string): void {
    if (source === "interactive") { this.launches = 0; this.turns = 0; }
  }
  private stopDescendants(owner: string, outcome?: Outcome): void {
    for (const lease of this.leases.values()) {
      if (lease.owner !== owner) continue;
      this.markStopped(lease, outcome);
      this.stopDescendants(lease.id, lease.outcome);
      if (lease.paneId && !lease.closed && this.closePane) {
        try { this.closePane(lease.paneId); lease.closed = true; lease.releasing = true; }
        catch { /* No capacity refund without confirmation. */ }
      }
    }
  }
  reap(): void {
    for (const [id, l] of this.leases) {
      if (l.releasing && l.closed && (!l.pid || !this.processAlive(l.pid))) this.leases.delete(id);
    }
  }
  // No awaits: validation and admission are atomic, and capacity failure never queues.
  dispatch(caller: string | null, method: string, args: any = {}): any {
    const parent = caller === null ? undefined : this.leases.get(caller);
    ensure(caller === null || parent, "unknown lease");
    if (!["release", "paneClosed", "launched", "accountUsage", "status"].includes(method)) this.check(parent);
    const owned = () => {
      const l = this.leases.get(args.id);
      ensure(l && l.owner === caller, "unauthorized lease ownership"); return l;
    };
    switch (method) {
      case "reserve": {
        ensure(!parent || parent.pid, "child must register before spawning");
        text(args.agent, 100);
        ensure(Object.hasOwn(this.config.agents, args.agent), "unknown agent");
        ensure(!parent || this.config.agents[parent.agent].canSpawn.includes(args.agent), "spawn target forbidden");
        text(args.name, 100); text(args.cwd, 4096);
        ensure(args.resume === undefined || typeof args.resume === "boolean", "invalid resume flag");
        const cwd = realpathSync(resolve(parent?.cwd ?? this.cwd, args.cwd));
        const rel = relative(this.cwd, cwd);
        ensure(!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`), "cwd outside root");
        const depth = (parent?.depth ?? 0) + 1;
        ensure(depth <= this.config.limits.maxDepth, "depth limit reached");
        const scope = parent?.scope ?? this.scope.getStore();
        ensure(!scope?.aborted, "workflow cancelled");
        this.reap();
        ensure(this.leases.size < this.config.limits.maxOpenPanes, "pane capacity reached (no queue)");
        ensure(this.launches < this.config.limits.maxLaunchesPerTurn, "launch budget reached");
        const id = randomUUID(), token = randomUUID();
        this.leases.set(id, { id, token, owner: caller, agent: args.agent, cwd, depth, scope, turns: 0, messages: [] });
        scope?.addEventListener("abort", () => {
          const lease = this.leases.get(id), outcome = errorOutcome(scope.reason);
          if (lease && isControlledStop(outcome)) {
            this.markStopped(lease, outcome);
            this.stopDescendants(id, lease.outcome);
          }
        }, { once: true });
        this.launches++;
        return { id, env: { PI_ORCHESTRATOR_SOCKET: this.socketPath, PI_ORCHESTRATOR_LEASE: id,
          PI_ORCHESTRATOR_TOKEN: token, PI_ORCHESTRATOR_CONFIG: process.env.PI_ORCHESTRATOR_CONFIG ?? "",
          PI_SUBAGENT_PARENT_SESSION: this.rootSession, PI_DOTFILES_SUBAGENT: "1" } };
      }
      case "launched": {
        const l = owned(); text(args.paneId, 200); text(args.sessionFile, 4096);
        ensure(isAbsolute(args.sessionFile), "session file must be absolute");
        ensure(!l.closed, "cannot launch a closed lease");
        ensure(![...this.leases.values()].some(other => other.id !== l.id && other.sessionFile === args.sessionFile), "session endpoint already owned");
        ensure(!l.sessionFile || l.sessionFile === args.sessionFile, "session identity mismatch");
        ensure(!l.paneId || l.paneId === args.paneId, "pane identity mismatch");
        l.paneId = args.paneId; l.sessionFile = args.sessionFile; return;
      }
      case "paneClosed": owned().closed = true; return;
      case "release": {
        const l = owned(); l.releasing = true; l.stopped = true;
        this.stopDescendants(l.id, l.outcome);
        this.reap(); return;
      }
      case "register": {
        ensure(parent, "root cannot register as child");
        ensure(Number.isSafeInteger(args.pid) && args.pid > 1 && this.processAlive(args.pid), "invalid child pid");
        text(args.sessionFile, 4096); ensure(isAbsolute(args.sessionFile), "invalid child session");
        ensure(![...this.leases.values()].some(other => other.id !== parent.id && other.sessionFile === args.sessionFile), "session endpoint already owned");
        ensure(!parent.pid || parent.pid === args.pid, "lease already registered");
        ensure(!parent.sessionFile || parent.sessionFile === args.sessionFile, "session identity mismatch");
        ensure(realpathSync(args.cwd) === parent.cwd, "child cwd mismatch");
        ensure(args.rootSession === this.rootSession, "root session mismatch");
        parent.pid = args.pid; parent.sessionFile = args.sessionFile;
        return { config: this.config, agent: parent.agent, rootSession: this.rootSession };
      }
      case "message": {
        text(args.text); text(args.sessionFile, 4096);
        const l = [...this.leases.values()].find(l => l.sessionFile === args.sessionFile && (caller === null || l.owner === caller));
        ensure(l?.pid && this.processAlive(l.pid), "unknown or unauthorized message endpoint"); this.check(l);
        ensure(l.messages.length < 16 && JSON.stringify([...l.messages, args.text]).length <= 98304,
          "message mailbox full"); l.messages.push(args.text); return;
      }
      case "poll": ensure(parent?.pid, "unregistered endpoint"); return parent.messages.splice(0);
      case "turn": {
        if (parent) parent.turns++; else this.turns++;
        if (parent && parent.turns > this.config.limits.maxTurnsPerRun) {
          this.markStopped(parent, { status: "stopped", code: "configured_limit", setting: "limits.maxTurnsPerRun",
            limit: this.config.limits.maxTurnsPerRun, originLease: parent.id });
          this.stopDescendants(parent.id, parent.outcome);
        }
        this.check(parent); return;
      }
      case "accountUsage": {
        ensure(Number.isSafeInteger(args.tokens) && args.tokens >= 0, "invalid token usage");
        this.totalTokens += args.tokens;
        const limit = this.config.limits.maxTokensPerSession;
        if (limit !== null && this.totalTokens >= limit) this.stop(new OutcomeError({ status: "stopped", code: "configured_limit",
          setting: "limits.maxTokensPerSession", limit, originLease: caller ?? "root" }));
        this.check(parent); return;
      }
      case "check": return;
      case "status": this.reap(); return { limits: this.config.limits, open: this.leases.size, launches: this.launches,
        turns: this.turns, totalTokens: this.totalTokens, stopped: this.stopped, outcome: this.outcome, rootSession: this.rootSession };
      default: throw new Error("Orchestrator: unknown IPC method");
    }
  }
  async listen(agentDir: string): Promise<void> {
    const dir = join(agentDir, "orchestrator", randomUUID());
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    this.socketPath = join(dir, "root.sock");
    ensure(Buffer.byteLength(this.socketPath) < 104, "runtime socket path too long");
    this.server = createServer(socket => {
      this.sockets.add(socket); socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => {}); socket.setTimeout(1500, () => socket.destroy());
      let buffer = "", done = false;
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        if (done) return;
        buffer += chunk;
        if (buffer.length > 131072) { socket.destroy(); return; }
        if (!buffer.includes("\n")) return;
        done = true;
        try {
          const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          const lease = this.leases.get(request.lease);
          ensure(lease && lease.token === request.token, "unauthorized IPC token");
          const value = this.dispatch(lease.id, request.method, request.args);
          socket.end(JSON.stringify({ value }) + "\n");
        } catch (e) { socket.end(JSON.stringify({ error: String(e), outcome: errorOutcome(e) }) + "\n"); }
      });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.socketPath, resolve); });
    chmodSync(this.socketPath, 0o600);
    this.server.on("error", e => this.stop(`runtime socket failed: ${e.message}`));
    this.server.unref();
  }
  async close(): Promise<void> {
    this.stop("root runtime shut down");
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if (this.socketPath) rmSync(join(this.socketPath, ".."), { recursive: true, force: true });
  }
}

export class RuntimeClient {
  constructor(readonly call: (method: string, args?: any) => Promise<any>) {}
  checkBudget(): Promise<void> { return this.call("check"); }
  status(): Promise<any> { return this.call("status"); }
  reserve(request: Reservation): Promise<{ id: string; env: Record<string, string> }> { return this.call("reserve", request); }
  release(id: string): Promise<void> { return this.call("release", { id }); }
  paneClosed(id: string): Promise<void> { return this.call("paneClosed", { id }); }
  launched(id: string, info: { paneId: string; sessionFile: string }): Promise<void> { return this.call("launched", { id, ...info }); }
  message(sessionFile: string, text: string): Promise<void> { return this.call("message", { sessionFile, text }); }
  accountUsage(usage: { tokens: number }): Promise<void> { return this.call("accountUsage", usage); }
}

export function connectRuntime(env: NodeJS.ProcessEnv): RuntimeClient {
  const path = env.PI_ORCHESTRATOR_SOCKET, lease = env.PI_ORCHESTRATOR_LEASE, token = env.PI_ORCHESTRATOR_TOKEN;
  ensure(path && isAbsolute(path) && lease && token && env.PI_SUBAGENT_PARENT_SESSION, "child runtime environment missing");
  return new RuntimeClient((method, args) => new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "", settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Orchestrator: root IPC timed out")), 1500);
    socket.setEncoding("utf8"); socket.on("error", e => finish(e));
    socket.on("close", () => finish(new Error("Orchestrator: root IPC closed")));
    socket.on("connect", () => socket.write(JSON.stringify({ lease, token, method, args }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 131072) return finish(new Error("Orchestrator: oversized IPC reply"));
      if (!buffer.includes("\n")) return;
      try { const reply = JSON.parse(buffer); finish(reply.error ? (reply.outcome ? new OutcomeError(reply.outcome) : new Error(reply.error)) : undefined, reply.value); }
      catch (e) { finish(e as Error); }
    });
  }));
}
