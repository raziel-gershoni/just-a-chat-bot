import { getMessage } from "@/src/db/repo/messages";
import { createRun } from "@/src/db/repo/runs";
import type { RunTrigger } from "@/src/db/schema";
import type { Db } from "@/src/db/types";

/**
 * Create the chime run in the topic of the message it targets (same rule as reaction runs), so
 * the window, typing, answer and stored answer rows all stay in that forum thread.
 */
export async function createChimeRun(db: Db, chatId: number, trigger: RunTrigger) {
  const target = await getMessage(db, chatId, trigger.targetMessageId);
  return createRun(db, { chatId, threadId: target?.threadId ?? null, trigger });
}
