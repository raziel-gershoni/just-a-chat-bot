// Runs once per process from instrumentation.ts. Each step's failure is logged and never blocks
// the others; startup() itself must not throw.
import type { Runner } from "../agent/runner";
import type { Env } from "../config/env";
import type { Db } from "../db/types";
import type { TgApi } from "../telegram/types";
import { errorText } from "../util/errors";
import { log } from "../util/log";
import { deployPing } from "./deploy-ping";
import { installShutdown } from "./shutdown";
import { startSweeper, sweep } from "./sweeper";

export const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "message_reaction",
  "my_chat_member",
  "chat_member",
] as const;

export type StartupDeps = {
  db: Db;
  tg: Pick<TgApi, "setWebhook" | "sendMessage">;
  runner: Pick<Runner, "enqueue" | "stopAccepting" | "drain">;
  env: Pick<Env, "TELEGRAM_WEBHOOK_SECRET" | "TELEGRAM_OWNER_ID" | "PUBLIC_DOMAIN" | "GIT_SHA" | "GIT_MESSAGE">;
  /** Extra stop functions for shutdown (the chime timers). */
  stops: (() => void)[];
  now(): Date;
  startSweeper?: typeof startSweeper;
};

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log(`startup.${name}_failed`, { error: errorText(err) });
  }
}

export async function startup(deps: StartupDeps, opts: { installShutdown?: typeof installShutdown } = {}): Promise<void> {
  const { env } = deps;

  await step("webhook", async () => {
    if (!env.PUBLIC_DOMAIN) {
      log("startup.webhook_skipped", { reason: "no_public_domain" });
      return;
    }
    await deps.tg.setWebhook(`https://${env.PUBLIC_DOMAIN}/api/telegram`, {
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: [...ALLOWED_UPDATES],
    });
    log("startup.webhook_set", { domain: env.PUBLIC_DOMAIN });
  });

  await step("deploy_ping", async () => {
    const sent = await deployPing({ db: deps.db, tg: deps.tg, ownerId: env.TELEGRAM_OWNER_ID, sha: env.GIT_SHA, message: env.GIT_MESSAGE });
    log("startup.deploy_ping", { sent });
  });

  const sweepDeps = { db: deps.db, runner: deps.runner, now: deps.now };
  await step("sweep", () => sweep(sweepDeps));

  const stops = [...deps.stops];
  await step("sweeper", async () => {
    stops.push((deps.startSweeper ?? startSweeper)(sweepDeps));
  });

  await step("shutdown_hook", async () => {
    (opts.installShutdown ?? installShutdown)(deps.runner, stops);
  });
}
