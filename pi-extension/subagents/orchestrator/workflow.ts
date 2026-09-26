import { ensure, text, type TaskStep, type Workflow } from "./config.ts";

import { OutcomeError, errorOutcome, describeOutcome, isControlledStop, type Outcome } from "./outcome.ts";

export const SUMMARY_LIMIT = 8000;
export type Executor = (step: TaskStep) => Promise<{ summary: string; exitCode: number; outcome?: Outcome }>;

export async function executeWorkflow(workflow: Workflow, task: string, run: Executor, controller: AbortController): Promise<string> {
  text(task); let previous = "";
  try {
    for (const step of workflow.steps) {
      controller.signal.throwIfAborted();
      const group = "parallel" in step ? step.parallel : [step];
      const work = Promise.all(group.map(async item => {
        controller.signal.throwIfAborted();
        const result = await run({ agent: item.agent, task: item.task.replace(/{{(task|previous)}}/g,
          (_, key) => key === "task" ? task : previous.slice(0, SUMMARY_LIMIT)) });
        controller.signal.throwIfAborted();
        if (result.outcome) throw new OutcomeError(result.outcome);
        ensure(result.exitCode === 0, `${item.agent} failed (${result.exitCode}): ${result.summary.slice(0, SUMMARY_LIMIT)}`);
        return result.summary.slice(0, SUMMARY_LIMIT);
      }));
      let onAbort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      const summaries = await Promise.race([work, cancelled]).finally(() => controller.signal.removeEventListener("abort", onAbort));
      previous = summaries.join("\n\n").slice(0, SUMMARY_LIMIT);
    }
    return previous;
  } catch (e) { controller.abort(e); throw e; }
}

export class WorkflowRunner {
  private active?: AbortController;
  cancel(reason: unknown = "workflow cancelled"): void { this.active?.abort(reason instanceof Error ? reason : new Error(String(reason))); }
  start(workflow: Workflow, task: string, run: (step: TaskStep, signal: AbortSignal) => ReturnType<Executor>,
    complete: (text: string, outcome?: Outcome) => void, admitted: () => void = () => {}): Promise<void> {
    ensure(!this.active, "workflow busy; wait for existing tasks to close");
    text(task);
    admitted();
    const controller = new AbortController(); this.active = controller;
    return executeWorkflow(workflow, task, step => run(step, controller.signal), controller)
      .then(summary => complete(`Workflow completed:\n${summary}`), error => {
        const outcome = errorOutcome(error);
        return complete(isControlledStop(outcome) ? `Workflow ${describeOutcome(outcome)}` : `Workflow failed: ${String(error)}`, outcome);
      })
      .catch(() => {}) // A replaced Pi session may reject completion delivery.
      .finally(() => { if (this.active === controller) this.active = undefined; });
  }
}
