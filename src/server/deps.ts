// Process-wide singletons, built once. Later tasks register their parts (runner, chime scheduler,
// bakery) here; stored on globalThis so a dev hot-reload doesn't build a second set (and with it
// a second set of timers).
import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";
import type { CallbackQuery, Update } from "grammy/types";
import type { WebhookDeps } from "@/app/api/telegram/route";
import { anthropicLlm } from "@/src/agent/llm";
import { processRun } from "@/src/agent/loop";
import { createRunner, type Runner } from "@/src/agent/runner";
import { bakeryApi } from "@/src/bakery/api";
import { handleBakeryCallback } from "@/src/bakery/callback";
import { bakeryConfig } from "@/src/bakery/config";
import { handleUpdate, type BotDeps } from "@/src/bot/dispatch";
import { createChimeRun } from "@/src/chime/enqueue";
import { createChimeScheduler } from "@/src/chime/scheduler";
import { env } from "@/src/config/env";
import { db } from "@/src/db/client";
import { getGroup } from "@/src/db/repo/groups";
import type { MiniDeps } from "@/src/miniapp/service";
import { getModels } from "@/src/models/catalog";
import { parseSettings } from "@/src/settings/schema";
import { createInflight } from "@/src/server/inflight";
import type { StartupDeps } from "@/src/server/startup";
import { telegramBot } from "@/src/telegram/client";
import { errorText } from "@/src/util/errors";
import { log } from "@/src/util/log";

export type ServerDeps = {
  db: ReturnType<typeof db>;
  bot: Bot;
  tg: Bot["api"];
  runner: Runner;
  hooks: Pick<BotDeps, "enqueue" | "chime" | "onCallback" | "deleteFiles">;
  /** Runs `bot.init()` (one getMe) once; every caller shares the result. */
  botInfo(): Promise<{ id: number; username: string }>;
  webhook: WebhookDeps;
  /** What the Mini App API needs. */
  miniapp: MiniDeps;
  /** Everything startup() needs. */
  startup: StartupDeps;
};

const LEASE_MS = 120_000;
const RENEW_MS = 30_000;
const TYPING_MS = 4_000;

function build(): ServerDeps {
  const e = env();
  const database = db();
  const bot = telegramBot(e.TELEGRAM_BOT_TOKEN);
  const llm = anthropicLlm(e.ANTHROPIC_API_KEY);
  const now = () => new Date();
  // Unique per process: replicas of one deployment, and a crash-restarted process, never share it.
  const owner = `${e.DEPLOYMENT_ID ?? "local"}:${randomUUID()}`;
  log("server.lease_owner", { owner });

  const lang = async (chatId: number) => {
    const group = await getGroup(database, chatId);
    return parseSettings(group?.settings).language;
  };

  // Fire-and-forget: a failed delete only leaves an orphan file on Anthropic's side.
  const deleteFiles = (ids: string[]) => {
    for (const id of ids) {
      llm.deleteFile(id).catch((err) => log("deps.delete_file_failed", { file_id: id, error: errorText(err) }));
    }
  };

  // botInfo is declared below; processRun resolves it inside its own error handling.
  const runner: Runner = createRunner({
    db: database,
    tg: bot.api,
    owner,
    leaseMs: LEASE_MS,
    renewMs: RENEW_MS,
    typingMs: TYPING_MS,
    now,
    process: async (run) => {
      // Read from env at call time and never stored.
      const cfg = bakeryConfig({ BAKERY_URL: e.BAKERY_URL, BAKERY_MCP_KEY: e.BAKERY_MCP_KEY });
      await processRun(run, {
        db: database,
        tg: bot.api,
        llm,
        owner,
        now,
        bakeryCfg: cfg,
        bakery: cfg ? bakeryApi(cfg) : null,
        token: e.TELEGRAM_BOT_TOKEN,
        fetch,
        models: () => getModels({ db: database, llm, now }),
        botName: async () => (await botInfo()).username,
        deleteFiles,
      });
    },
  });

  const chime = createChimeScheduler({
    db: database,
    llm,
    now,
    enqueueRun: async (chatId, trigger) => {
      await createChimeRun(database, chatId, trigger);
      runner.enqueue(chatId);
    },
  });

  const hooks: ServerDeps["hooks"] = {
    enqueue: (chatId, delayMs) => runner.enqueue(chatId, delayMs),
    chime,
    onCallback: async (q: CallbackQuery) => {
      const cfg = bakeryConfig({ BAKERY_URL: e.BAKERY_URL, BAKERY_MCP_KEY: e.BAKERY_MCP_KEY });
      const handled = await handleBakeryCallback(q, { tg: bot.api, bakery: cfg ? bakeryApi(cfg) : null, lang });
      if (handled) return;
      log("callback.unhandled", { data: q.data ?? null, chat_id: q.message?.chat.id ?? null });
      await bot.api
        .answerCallbackQuery(q.id)
        .catch((err) => log("callback.answer_failed", { error: errorText(err) }));
    },
    deleteFiles,
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

  const webhooks = createInflight();
  const handle = async (update: Update) => {
    const me = await botInfo();
    await handleUpdate(update, {
      db: database,
      tg: bot.api,
      env: e,
      botId: me.id,
      botUsername: me.username,
      ...hooks,
      now,
    });
  };

  return {
    db: database,
    bot,
    tg: bot.api,
    runner,
    hooks,
    botInfo,
    miniapp: {
      db: database,
      tg: bot.api,
      llm,
      now,
      env: {
        TELEGRAM_BOT_TOKEN: e.TELEGRAM_BOT_TOKEN,
        TELEGRAM_OWNER_ID: e.TELEGRAM_OWNER_ID,
        JWT_SECRET: e.JWT_SECRET,
        BAKERY_URL: e.BAKERY_URL,
        BAKERY_MCP_KEY: e.BAKERY_MCP_KEY,
      },
    },
    webhook: { secret: e.TELEGRAM_WEBHOOK_SECRET, db: database, handle, inflight: webhooks },
    startup: { db: database, tg: bot.api, runner, env: e, stops: [chime.stop], webhooks, now },
  };
}

const KEY = Symbol.for("just-a-chat-bot.serverDeps");
type Holder = { [KEY]?: ServerDeps };

export function serverDeps(): ServerDeps {
  const g = globalThis as Holder;
  return (g[KEY] ??= build());
}
