// Process-wide singletons, built once. Later tasks register their parts (runner, chime scheduler,
// bakery) here; stored on globalThis so a dev hot-reload doesn't build a second set (and with it
// a second set of timers).
import Anthropic from "@anthropic-ai/sdk";
import type { Bot } from "grammy";
import type { CallbackQuery, Update } from "grammy/types";
import type { WebhookDeps } from "@/app/api/telegram/route";
import { handleUpdate, type BotDeps } from "@/src/bot/dispatch";
import { env } from "@/src/config/env";
import { db } from "@/src/db/client";
import { telegramBot } from "@/src/telegram/client";
import { errorText } from "@/src/util/errors";
import { log } from "@/src/util/log";

export type ServerDeps = {
  db: ReturnType<typeof db>;
  bot: Bot;
  tg: Bot["api"];
  anthropic: Anthropic;
  /** Parts later tasks fill in; until then each logs that it was called unwired. */
  hooks: Pick<BotDeps, "enqueue" | "chime" | "onCallback" | "deleteFiles">;
  /** Runs `bot.init()` (one getMe) once; every caller shares the result. */
  botInfo(): Promise<{ id: number; username: string }>;
  webhook: WebhookDeps;
};

const unwired = (what: string) => log("deps.unwired", { what });

function build(): ServerDeps {
  const e = env();
  const database = db();
  const bot = telegramBot(e.TELEGRAM_BOT_TOKEN);
  const anthropic = new Anthropic({ apiKey: e.ANTHROPIC_API_KEY, maxRetries: 4 });

  const hooks: ServerDeps["hooks"] = {
    enqueue: () => unwired("enqueue"),
    chime: { onHumanMessage: () => unwired("chime") },
    onCallback: async (q: CallbackQuery) => unwired(`callback:${q.id}`),
    deleteFiles: () => unwired("deleteFiles"),
  };

  let initing: Promise<{ id: number; username: string }> | null = null;
  const botInfo = () => {
    if (!initing) {
      const attempt = bot.init().then(() => ({ id: bot.botInfo.id, username: bot.botInfo.username }));
      // A failed getMe must not be cached forever: the next update tries again.
      attempt.catch((err) => {
        log("deps.bot_init_failed", { error: errorText(err) });
        if (initing === attempt) initing = null;
      });
      initing = attempt;
    }
    return initing;
  };

  const handle = async (update: Update) => {
    const me = await botInfo();
    await handleUpdate(update, {
      db: database,
      tg: bot.api,
      env: e,
      botId: me.id,
      botUsername: me.username,
      ...hooks,
      now: () => new Date(),
    });
  };

  return {
    db: database,
    bot,
    tg: bot.api,
    anthropic,
    hooks,
    botInfo,
    webhook: { secret: e.TELEGRAM_WEBHOOK_SECRET, db: database, handle },
  };
}

const KEY = Symbol.for("just-a-chat-bot.serverDeps");
type Holder = { [KEY]?: ServerDeps };

export function serverDeps(): ServerDeps {
  const g = globalThis as Holder;
  return (g[KEY] ??= build());
}
