import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ACTIVITY_EVENT = "pi-orchestrator:activity";
export const ACTIVITY_REQUEST = "pi-orchestrator:activity-request";

/** Session-local holds, independent of pane accounting and child auto-exit. */
export class BackgroundActivity {
  private holds = new Set<symbol>();
  private closed = false;
  constructor(private publish: (snapshot: { busy: boolean }) => void) {}

  snapshot(): void { if (!this.closed) this.publish({ busy: this.holds.size > 0 }); }
  start(): void { this.closed = false; this.snapshot(); }
  shutdown(): void { this.closed = true; this.holds.clear(); }

  begin(): () => void {
    if (this.closed) return () => {};
    const token = Symbol();
    this.holds.add(token);
    if (this.holds.size === 1) this.snapshot();
    return () => {
      // Idempotent; stale completions cannot release a new session's holds.
      if (this.holds.delete(token) && this.holds.size === 0) this.snapshot();
    };
  }

  async track<T>(work: () => Promise<T>): Promise<T> {
    const finish = this.begin();
    try { return await work(); }
    finally { finish(); }
  }
}

/** Subscribe before requesting: the response is emitted in the request call stack. */
export function installBackgroundActivity(pi: ExtensionAPI): BackgroundActivity {
  const activity = new BackgroundActivity(snapshot => pi.events.emit(ACTIVITY_EVENT, snapshot));
  let unsubscribe: (() => void) | undefined;
  const subscribe = () => { unsubscribe ??= pi.events.on(ACTIVITY_REQUEST, () => activity.snapshot()); };
  subscribe();
  pi.on("session_start", () => { subscribe(); activity.start(); });
  pi.on("session_shutdown", () => {
    unsubscribe?.(); unsubscribe = undefined;
    // Do not advertise idle during teardown. Consumers reset to unknown/busy.
    activity.shutdown();
  });
  return activity;
}
