// Graceful stop on SIGTERM/SIGINT (Next installs no handler with NEXT_MANUAL_SIG_HANDLE=true).
// Waits for in-flight webhook handlers and running runs, then exits. Unfinished runs stay in
// the DB; the next instance's sweep resumes them.
import type { Runner } from "../agent/runner";
import { errorText } from "../util/errors";
import { log } from "../util/log";
import type { Inflight } from "./inflight";

export function installShutdown(
  runner: Pick<Runner, "stopAccepting" | "drain">,
  stops: (() => void)[],
  webhooks?: Pick<Inflight, "idle" | "count">,
): void {
  let shuttingDown = false;
  // Each step has its own try: one failing step never skips the drain.
  const attempt = async (name: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      log("shutdown.step_failed", { step: name, error: errorText(err) });
    }
  };
  const handle = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown.start", { signal, webhooks_in_flight: webhooks?.count() ?? 0 });
    void (async () => {
      await attempt("stop_accepting", () => runner.stopAccepting());
      for (const [i, stop] of stops.entries()) await attempt(`stop_${i}`, stop);
      await attempt("webhooks_idle", () => webhooks?.idle());
      await attempt("drain", () => runner.drain());
      log("shutdown.done", { signal });
      process.exit(0);
    })();
  };
  process.once("SIGTERM", () => handle("SIGTERM"));
  process.once("SIGINT", () => handle("SIGINT"));
}
