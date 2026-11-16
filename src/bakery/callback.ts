import type { CallbackQuery } from "grammy/types";
import { t, type Lang } from "../i18n";
import { sendText } from "../telegram/send";
import type { TgApi } from "../telegram/types";
import { errorText } from "../util/errors";
import { log } from "../util/log";
import type { BakeryApi } from "./api";

const DATA = /^mcp:(approve|reject):(\d+)$/;
const ANSWER_MAX = 200;

// At most 200 code points (Telegram's limit for a callback answer), cut on a code-point
// boundary so Hebrew and emoji never break, with an ellipsis when cut.
export function truncate200(s: string): string {
  const chars = Array.from(s);
  if (chars.length <= ANSWER_MAX) return s;
  return chars.slice(0, ANSWER_MAX - 1).join("") + "…";
}

// Handles a press on a proposal card. Returns false when the data isn't a bakery button.
export async function handleBakeryCallback(
  q: CallbackQuery,
  deps: { tg: TgApi; bakery: BakeryApi | null; lang: (chatId: number) => Promise<Lang> },
): Promise<boolean> {
  const m = DATA.exec(q.data ?? "");
  if (!m) return false;
  const decision = m[1] === "approve" ? "approve" : "reject";
  const id = Number(m[2]);
  const card = q.message;
  const chatId = card?.chat.id;

  const result = deps.bakery
    ? await deps.bakery.decide(id, q.from.id, decision)
    : { status: 0 as number, outcome: undefined, message: undefined };
  if (result.status !== 200) {
    log("bakery.decision", { id, status: result.status, outcome: result.outcome ?? null, configured: deps.bakery !== null });
  }

  const answer = async (text: string, showAlert: boolean) => {
    try {
      await deps.tg.answerCallbackQuery(q.id, { text, show_alert: showAlert });
    } catch (err) {
      log("bakery.callback_answer_failed", { id, error: errorText(err) });
    }
  };

  // A 401 (key wrong or replaced) or a network failure (status 0) keeps the buttons and shows
  // the "unreachable" alert, whatever body came with it.
  const unreachable = result.status === 401 || result.status === 0;
  if (!unreachable && result.outcome && result.message) {
    const notOwner = result.outcome === "not_owner";
    await answer(truncate200(result.message), notOwner);
    if (notOwner || !card) return true;
    try {
      await deps.tg.editMessageReplyMarkup(card.chat.id, card.message_id);
    } catch (err) {
      log("bakery.card_buttons_remove_failed", { id, error: errorText(err) });
    }
    try {
      await sendText(deps.tg, card.chat.id, result.message, {
        replyTo: card.message_id,
        threadId: card.message_thread_id ?? null,
      });
    } catch (err) {
      log("bakery.decision_reply_failed", { id, error: errorText(err) });
    }
    return true;
  }

  let lang: Lang = "en";
  if (chatId !== undefined) {
    try {
      lang = await deps.lang(chatId);
    } catch (err) {
      log("bakery.lang_lookup_failed", { chat_id: chatId, error: errorText(err) });
    }
  }
  await answer(t(lang, "bakeryUnreachable"), true);
  return true;
}
