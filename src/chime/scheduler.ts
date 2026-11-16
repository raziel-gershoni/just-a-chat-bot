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
  // Chats whose fire() is still running (the classifier takes seconds): one at a time per chat.
  const firing = new Set<number>();

  const skip = (chatId: number, reason: string) => log("chime.skip", { chatId, reason });

  // Null when a chime may go ahead now, else why not. Checked before the classifier and again
  // right before the run is created, since a mention can be answered while the classifier works.
  async function blocked(chatId: number): Promise<string | null> {
    const now = deps.now();
    if (await hasActiveRun(deps.db, chatId, now)) return "active_run";
    const lastBot = await lastBotMessageAt(deps.db, chatId);
    if (lastBot && now.getTime() - lastBot.getTime() < cooldownMs) return "cooldown";
    return null;
  }

  async function fire(chatId: number): Promise<void> {
    if (firing.has(chatId)) return skip(chatId, "in_flight");
    firing.add(chatId);
    try {
      await decide(chatId);
    } finally {
      firing.delete(chatId);
    }
  }

  async function decide(chatId: number): Promise<void> {
    const { db } = deps;
    const group = await getGroup(db, chatId);
    if (!group || !group.active) return skip(chatId, "inactive");
    const settings = parseSettings(group.settings);
    if (!settings.chime.enabled) return skip(chatId, "chime_off");
    const before = await blocked(chatId);
    if (before) return skip(chatId, before);

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
    const after = await blocked(chatId);
    if (after) return skip(chatId, `${after}_after_classify`);
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
