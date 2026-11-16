// Next calls register() once per server process (not during `next build`). Node runtime only.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startup } = await import("./src/server/startup");
    const { serverDeps } = await import("./src/server/deps");
    try {
      await startup(serverDeps().startup);
    } catch (err) {
      const { log } = await import("./src/util/log");
      const { errorText } = await import("./src/util/errors");
      log("startup.failed", { error: errorText(err) });
    }
  }
}
