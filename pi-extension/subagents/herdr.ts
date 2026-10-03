/** Herdr pane control. Only launch scripts use pane/run; messages use Pi IPC. */
import childProcess from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readOutcome, isControlledStop, type Outcome } from "./orchestrator/outcome.ts";
import type { Config } from "./orchestrator/config.ts";

const owned = new Set<string>();
const closed = new Set<string>();
const execOptions = { encoding: "utf8" as const, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 };

export function isMuxAvailable(): boolean {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return false;
  try { childProcess.execFileSync("herdr", ["--version"], execOptions); return true; } catch { return false; }
}
export function muxSetupHint(): string {
  return "Start Pi inside a Herdr pane with herdr on PATH (HERDR_ENV=1 and HERDR_PANE_ID required).";
}
function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) throw new Error(muxSetupHint());
}
function result(output: string, operation: string): any {
  let response;
  try { response = JSON.parse(output); }
  catch { throw new Error(`Herdr ${operation} returned ${output.trim() ? "invalid JSON" : "empty output; expected JSON"}`); }
  if (!response || typeof response !== "object") throw new Error(`Herdr ${operation} returned no result`);
  if (response.error) throw new Error(`Herdr ${response.error.code}: ${response.error.message}`);
  if (!response.result) throw new Error("Herdr returned no result");
  return response.result;
}
function herdrError(error: unknown): Error {
  // Herdr server errors arrive as JSON on stderr with a nonzero exit status.
  let detail;
  try { detail = JSON.parse(String((error as { stderr?: unknown })?.stderr ?? "")).error; }
  catch { /* Preserve transport and syntax errors that have no structured response. */ }
  if (typeof detail?.code === "string" && typeof detail?.message === "string") {
    return new Error(`Herdr ${detail.code}: ${detail.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
function call(args: string[]): string {
  requireHerdr();
  try { return childProcess.execFileSync("herdr", args, execOptions); }
  catch (error) { throw herdrError(error); }
}
export function shellEscape(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'"; }

export function createSurface(name: string, cwd: string, panes: Config["panes"]): string {
  return createSurfaceSplit(name, panes.direction, process.env.HERDR_PANE_ID, cwd);
}
export function createSurfaceSplit(
  _name: string, direction: "left" | "right" | "up" | "down",
  fromSurface = process.env.HERDR_PANE_ID, cwd = process.cwd(),
): string {
  requireHerdr();
  if (!fromSurface || (direction !== "right" && direction !== "down")) throw new Error("Herdr splits require an explicit parent pane and right/down direction");
  const pane = result(call(["pane", "split", "--pane", fromSurface, "--direction", direction, "--cwd", cwd, "--no-focus"]), "pane split").pane?.pane_id;
  if (typeof pane !== "string" || !pane || pane === fromSurface) throw new Error("Unexpected Herdr split response: missing new result.pane.pane_id");
  closed.delete(pane); owned.add(pane); return pane;
}
export function sendCommand(surface: string, command: string): void {
  if (!owned.has(surface)) throw new Error(`Refusing to run a command in unowned Herdr pane ${surface}`);
  // pane run acknowledges success via exit status only; stdout is empty.
  call(["pane", "run", surface, command]);
}
export function sendLongCommand(surface: string, command: string, options?: { scriptPath?: string; scriptPreamble?: string }): string {
  const scriptPath = options?.scriptPath ?? join(tmpdir(), "pi-subagent-scripts", `cmd-${randomUUID()}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });
  const preamble = options?.scriptPreamble?.split("\n").map(line => `# ${line}`).join("\n") ?? "";
  writeFileSync(scriptPath, `#!/bin/bash\n${preamble}\n${command}\n`, { mode: 0o700 });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`); return scriptPath;
}
export interface CompletionSignal { file: string; runId: string }

/** Publish only after the foreground command exits; rename keeps readers from seeing partial JSON. */
export function commandWithCompletion(command: string, completion: CompletionSignal): string {
  const temporary = `${completion.file}.tmp`;
  const prefix = JSON.stringify({ version: 1, runId: completion.runId }).slice(0, -1);
  return [
    `if ${command}; then`,
    "  pi_subagent_exit_code=0",
    "else",
    "  pi_subagent_exit_code=$?",
    "fi",
    "(",
    "  umask 077",
    `  printf '%s,"exitCode":%d}\\n' ${shellEscape(prefix)} "$pi_subagent_exit_code" > ${shellEscape(temporary)} &&`,
    `    mv -f -- ${shellEscape(temporary)} ${shellEscape(completion.file)}`,
    ")",
    'exit "$pi_subagent_exit_code"',
  ].join("\n");
}

function readCompletion(completion: CompletionSignal): PollResult | undefined {
  try {
    const data = JSON.parse(readFileSync(completion.file, "utf8"));
    if (data?.version === 1 && data.runId === completion.runId &&
      Number.isInteger(data.exitCode) && data.exitCode >= 0 && data.exitCode <= 255) {
      return { reason: "done", exitCode: data.exitCode };
    }
  } catch { /* Absent or invalid completion records do not terminate a run. */ }
}

function readArgs(surface: string, lines: number): string[] {
  return ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, Math.floor(lines)))];
}
export function readScreen(surface: string, lines = 50): string { return call(readArgs(surface, lines)); }
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const output = await new Promise<string>((resolve, reject) => {
    childProcess.execFile("herdr", readArgs(surface, lines), execOptions, (error, stdout) => {
      if (error) reject(herdrError(error)); else resolve(stdout);
    });
  });
  return output;
}
export function closeSurface(surface: string): void {
  if (closed.has(surface)) return;
  if (!owned.has(surface)) throw new Error(`Refusing to close unowned Herdr pane ${surface}`);
  closeLeasedSurface(surface);
}
/** Root lease records authorize closing descendants, including orphaned panes. */
export function closeLeasedSurface(surface: string): void {
  if (closed.has(surface)) return;
  try { result(call(["pane", "close", surface]), "pane close"); }
  catch (error) {
    // Only an explicit missing-pane response confirms closure. Transport failures do not.
    if (!/^Error: Herdr not_found:.*pane/i.test(String(error))) throw error;
  }
  owned.delete(surface); closed.add(surface);
}
export interface PollResult { reason: "done" | "error" | "stopped"; exitCode: number; errorMessage?: string; outcome?: Outcome }
function interpretExitSidecar(data: any): PollResult | undefined {
  if (isControlledStop(data?.outcome)) return { reason: "stopped", exitCode: 1, outcome: data.outcome };
  if (data?.type === "stopped") return { reason: "error", exitCode: 1, errorMessage: "Invalid controlled-stop metadata in sidecar." };
  if (data?.type === "error") {
    const errorMessage = typeof data.errorMessage === "string" && data.errorMessage.trim()
      ? data.errorMessage : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  // Success requires the current run's completion record, not an uncorrelated legacy sidecar.
  return undefined;
}
export const __pollForExitTest__ = { interpretExitSidecar };
function exitSidecar(sessionFile?: string): PollResult | undefined {
  if (!sessionFile) return;
  try {
    const path = `${sessionFile}.exit`;
    const outcome = readOutcome(sessionFile);
    if (outcome) return isControlledStop(outcome) ? { reason: "stopped", exitCode: 1, outcome }
      : { reason: "error", exitCode: 1, errorMessage: outcome.message, outcome };
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8"));
    rmSync(path, { force: true }); return interpretExitSidecar(data);
  } catch { /* Retry a partially written sidecar next tick. */ }
}
export async function pollForExit(surface: string, signal: AbortSignal,
  options: { interval: number; completion: CompletionSignal; sessionFile?: string; onTick?: (elapsed: number) => void },
): Promise<PollResult> {
  const start = Date.now();
  for (;;) {
    signal.throwIfAborted();
    const terminal = exitSidecar(options.sessionFile) ?? readCompletion(options.completion);
    if (terminal) return terminal;
    try {
      // Read only to detect a closed/disconnected pane, never to infer process completion.
      await readScreenAsync(surface, 1);
    } catch (error) {
      return exitSidecar(options.sessionFile) ?? readCompletion(options.completion) ?? { reason: "error", exitCode: 1,
        errorMessage: `Cannot read Herdr pane ${surface}; it may have closed or the server disconnected. ${String(error)}` };
    }
    options.onTick?.(Math.floor((Date.now() - start) / 1000));
    await delay(options.interval, undefined, { signal });
  }
}
