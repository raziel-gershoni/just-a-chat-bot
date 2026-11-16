// Graceful stop on SIGTERM/SIGINT (Next installs no handler with NEXT_MANUAL_SIG_HANDLE=true).
// Unfinished runs stay leased in the DB; the next instance's sweep resumes them.
import type { Runner } from "../agent/runner";
import { errorText } from "../util/errors";
import { log } from "../util/log";

export function installShutdown(runner: Pick<Runner, "stopAccepting" | "drain">, stops: (() => void)[]): void {
  let shuttingDown = false;
  const handle = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown.start", { signal });
    void (async () => {
      try {
        runner.stopAccepting();
        for (const stop of stops) stop();
        await runner.drain();
        log("shutdown.done", { signal });
      } catch (err) {
        log("shutdown.failed", { signal, error: errorText(err) });
      }
      process.exit(0);
    })();
  };
  process.once("SIGTERM", () => handle("SIGTERM"));
  process.once("SIGINT", () => handle("SIGINT"));
}
