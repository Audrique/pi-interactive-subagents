import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Extension-owned terminal metadata; never change Pi's native stopReason union. */
export type Outcome =
  | { status: "stopped"; code: "configured_limit"; setting: "limits.maxTurnsPerRun" | "limits.maxTokensPerSession"; limit: number; originLease: string }
  | { status: "failed"; message: string };

export function isControlledStop(value: any): value is Extract<Outcome, { status: "stopped" }> {
  return value?.status === "stopped" && value.code === "configured_limit" &&
    ["limits.maxTurnsPerRun", "limits.maxTokensPerSession"].includes(value.setting) &&
    Number.isSafeInteger(value.limit) && value.limit > 0 && typeof value.originLease === "string";
}
export function stopTitle(outcome: Extract<Outcome, { status: "stopped" }>): string {
  return `Stopped: configured ${outcome.setting === "limits.maxTurnsPerRun" ? "turn" : "token"} limit reached (${outcome.limit})`;
}
export function describeOutcome(outcome: Outcome): string {
  if (!isControlledStop(outcome)) return outcome.message;
  return `${stopTitle(outcome)}\n${outcome.setting} = ${outcome.limit}. Work is incomplete. Continue with a smaller task, or explicitly change the limit for a future run.`;
}
export class OutcomeError extends Error {
  constructor(readonly outcome: Outcome) { super(describeOutcome(outcome)); this.name = "OrchestratorOutcome"; }
}
export function errorOutcome(error: unknown): Outcome {
  const value = (error as any)?.outcome;
  return isControlledStop(value) || (value?.status === "failed" && typeof value.message === "string")
    ? value : { status: "failed", message: String(error) };
}
export function readOutcome(sessionFile: string): Outcome | undefined {
  try {
    const value = JSON.parse(readFileSync(`${sessionFile}.outcome`, "utf8"));
    if (isControlledStop(value) || (value?.status === "failed" && typeof value.message === "string")) return value;
  } catch { /* Absent or not yet fully published. */ }
}
/** Durable first cause survives .exit consumption and late abort/cleanup writers.
 * A fresh launch clears both records before starting the child.
 */
export function reportOutcome(sessionFile: string, outcome: Outcome): Outcome {
  // Publish a complete record atomically without replacing another writer's cause.
  const temporary = `${sessionFile}.outcome-${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(outcome), { flag: "wx", mode: 0o600 });
    try { linkSync(temporary, `${sessionFile}.outcome`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { rmSync(temporary, { force: true }); }
  const first = readOutcome(sessionFile);
  if (!first) throw new Error("Could not read terminal outcome");
  writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: first.status === "stopped" ? "stopped" : "error",
    outcome: first, errorMessage: describeOutcome(first), stopReason: first.status === "stopped" ? "aborted" : "error" }), { mode: 0o600 });
  return first;
}
