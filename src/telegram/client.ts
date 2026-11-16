// The one way the app builds a Telegram bot client.
//
// Telegram answers 429 "retry after N" when messages go out back to back. The official
// auto-retry plugin waits as long as Telegram asks and sends the request again; it also
// backs off and retries a 5xx. Both are bounded:
// - at most 2 retries per request;
// - a wait longer than 10 s isn't waited for (the call throws, and the run's own attempt
//   counter takes over).
// A network error is NOT retried here: the plugin would retry it without any bound.
import { Bot, GrammyError, type ApiClientOptions } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";

export const TELEGRAM_MAX_RETRIES = 2;
export const TELEGRAM_MAX_RETRY_WAIT_S = 10;

export function telegramBot(token: string, client?: ApiClientOptions): Bot {
  const bot = new Bot(token, client ? { client } : undefined);
  bot.api.config.use(autoRetry({
    maxRetryAttempts: TELEGRAM_MAX_RETRIES,
    maxDelaySeconds: TELEGRAM_MAX_RETRY_WAIT_S,
    rethrowHttpErrors: true,
  }));
  return bot;
}

/**
 * Telegram definitely refused a call such as getChatMember (a 400 like "user not found", or a
 * 403): for a membership check the answer is "not a member". A network error, a 429 or a 5xx
 * is transient instead and must not be read as "no".
 */
export function isDefiniteRefusal(err: unknown): boolean {
  return err instanceof GrammyError && (err.error_code === 400 || err.error_code === 403);
}

// Where a file that getFile returned can be downloaded from.
export function fileUrl(token: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}
