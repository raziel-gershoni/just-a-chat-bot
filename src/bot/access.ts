import { randomBytes } from "node:crypto";
import type { Chat, User } from "grammy/types";
import { getGroup, setGroupActive, upsertGroup, type Group } from "../db/repo/groups";
import { pickLang, t } from "../i18n";
import { defaultSettings, parseSettings } from "../settings/schema";
import { sendText } from "../telegram/send";
import { errorText } from "../util/errors";
import { log } from "../util/log";
import type { BotDeps } from "./dispatch";

async function ownerIsMember(deps: BotDeps, chatId: number): Promise<boolean> {
  try {
    const m = await deps.tg.getChatMember(chatId, deps.env.TELEGRAM_OWNER_ID);
    if (m.status === "creator" || m.status === "administrator" || m.status === "member") return true;
    if (m.status === "restricted" && m.is_member) return true;
    log("bot.owner_not_member", { chat_id: chatId, status: m.status });
    return false;
  } catch (err) {
    // Strangers must not get in: an unanswerable check counts as "not allowed".
    log("bot.owner_check_failed", { chat_id: chatId, error: errorText(err) });
    return false;
  }
}

/**
 * The group row for a chat the bot is in, creating it when the owner is a member. Returns
 * null (after leaving the chat) when the owner is not.
 */
export async function ensureGroup(
  deps: BotDeps,
  chat: Pick<Chat, "id"> & { title?: string },
  adder: User | undefined,
): Promise<Group | null> {
  const existing = await getGroup(deps.db, chat.id);
  if (existing?.active) return existing;

  if (!(await ownerIsMember(deps, chat.id))) {
    try {
      await sendText(deps.tg, chat.id, t(pickLang(adder?.language_code), "ownerMissingLeaving"));
    } catch (err) {
      log("bot.leave_notice_failed", { chat_id: chat.id, error: errorText(err) });
    }
    await deps.tg.leaveChat(chat.id);
    await setGroupActive(deps.db, chat.id, false);
    return null;
  }

  const group = await upsertGroup(deps.db, {
    chatId: chat.id,
    title: chat.title ?? "",
    settings: { ...defaultSettings(pickLang(adder?.language_code)) },
    token: randomBytes(16).toString("base64url"),
  });
  const lang = parseSettings(group.settings).language;
  const url = `https://t.me/${deps.botUsername}/${deps.env.TELEGRAM_MINIAPP_SHORT_NAME}?startapp=${group.token}`;
  await sendText(deps.tg, chat.id, t(lang, "welcome"), {
    buttons: [[{ text: t(lang, "settingsButton"), url }]],
  });
  return group;
}
