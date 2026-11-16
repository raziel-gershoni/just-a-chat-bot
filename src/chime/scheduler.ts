import type { Llm } from "../agent/llm";
import { bakeryConfig } from "../bakery/config";
import { getGroup } from "../db/repo/groups";
import { lastBotMessageAt, recentMessages } from "../db/repo/messages";
import { hasActiveRun } from "../db/repo/runs";
import type { RunTrigger } from "../db/schema";
import type { Db } from "../db/types";
import { parseSettings } from "../settings/schema";
import { errorText } from "../util/errors";
import { log } from "../util/log";
import { chimeTranscript, classifyChime } from "./classifier";

export const CHIME_INPUT_MESSAGES = 30;

export type ChimeSchedulerDeps = {
  db: Db;
  llm: Pick<Llm, "classify">;
  now: () => Date;
  debounceMs?: number;
  cooldownMs?: number;
  /** createRun + runner.enqueue (wired in Task 13). */
  enqueueRun: (chatId: number, trigger: RunTrigger) => Promise<void>;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  /** Whether the bakery server is configured; defaults to the process env. */
  bakeryConfigured?: () => boolean;
};

export function createChimeScheduler(deps: ChimeSchedulerDeps): { onHumanMessage(chatId: number): void; stop(): void } {
  const debounceMs = deps.debounceMs ?? 30_000;
  const cooldownMs = deps.cooldownMs ?? 600_000;
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const bakeryConfigured = deps.bakeryConfigured ?? (() => bakeryConfig({ BAKERY_URL: process.env.BAKERY_URL, BAKERY_MCP_KEY: process.env.BAKERY_MCP_KEY }) !== null);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const skip = (chatId: number, reason: string) => log("chime.skip", { chatId, reason });

  async function fire(chatId: number): Promise<void> {
    const { db } = deps;
    const group = await getGroup(db, chatId);
    if (!group || !group.active) return skip(chatId, "inactive");
    const settings = parseSettings(group.settings);
    if (!settings.chime.enabled) return skip(chatId, "chime_off");
    const now = deps.now();
    if (await hasActiveRun(db, chatId, now)) return skip(chatId, "active_run");
    const lastBot = await lastBotMessageAt(db, chatId);
    if (lastBot && now.getTime() - lastBot.getTime() < cooldownMs) return skip(chatId, "cooldown");

    const recent = await recentMessages(db, chatId, CHIME_INPUT_MESSAGES);
    const latest = recent[recent.length - 1];
    if (!latest) return skip(chatId, "no_messages");
    if (latest.isBot) return skip(chatId, "last_is_bot");
    const rows = group.forgetBefore ? recent.filter((r) => r.date > group.forgetBefore!) : recent;
    const last = rows[rows.length - 1];
    if (!last) return skip(chatId, "no_messages");

    const d = await classifyChime(
      { llm: deps.llm },
      { transcript: chimeTranscript(rows), eagerness: settings.chime.eagerness, bakery: settings.bakery && bakeryConfigured() },
    );
    if (!d) return skip(chatId, "classifier_failed");
    log("chime.decision", { chatId, chime: d.chime, reason: d.reason });
    if (!d.chime) return;
    await deps.enqueueRun(chatId, {
      type: "chime",
      messageId: last.messageId,
      targetMessageId: last.messageId,
      requesterId: null,
      requesterName: null,
    });
  }

  return {
    onHumanMessage(chatId) {
      const prev = timers.get(chatId);
      if (prev !== undefined) clearT(prev);
      timers.set(
        chatId,
        setT(() => {
          timers.delete(chatId);
          return fire(chatId).catch((err) => log("chime.error", { chatId, error: errorText(err) }));
        }, debounceMs),
      );
    },
    stop() {
      for (const h of timers.values()) clearT(h);
      timers.clear();
    },
  };
}
