// Periodic housekeeping. Hands every chat whose head run is claimable (queued, released, or left
// behind by a crashed or replaced instance whose lease expired) to the runner, then prunes
// finished runs and old update ids.
import type { Runner } from "../agent/runner";
import { chatsWithPendingRuns, pruneRuns } from "../db/repo/runs";
import { pruneUpdates } from "../db/repo/updates";
import type { Db } from "../db/types";
import { errorText } from "../util/errors";
import { log } from "../util/log";

export type SweepDeps = { db: Db; runner: Pick<Runner, "enqueue">; now(): Date };

const DAY_MS = 86_400_000;
const RUNS_KEPT_MS = 30 * DAY_MS;
// Telegram keeps undelivered updates for 24 h, so a redelivery can't be older than this.
const UPDATES_KEPT_MS = 2 * DAY_MS;

export async function sweep(deps: SweepDeps): Promise<void> {
  const now = deps.now();
  const chats = await chatsWithPendingRuns(deps.db, now);
  if (chats.length > 0) log("sweep.recover", { chat_ids: chats });
  for (const chatId of chats) deps.runner.enqueue(chatId);
  await pruneRuns(deps.db, new Date(now.getTime() - RUNS_KEPT_MS));
  await pruneUpdates(deps.db, new Date(now.getTime() - UPDATES_KEPT_MS));
}

/** Sweeps every `intervalMs`; returns the function that stops it. */
export function startSweeper(deps: SweepDeps, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    sweep(deps).catch((err) => log("sweep.failed", { error: errorText(err) }));
  }, intervalMs);
  return () => clearInterval(timer);
}
