import { randomBytes } from "node:crypto";
import type { Chat, User } from "grammy/types";
import { getGroup, setGroupActive, upsertGroup, type Group } from "../db/repo/groups";
import { pickLang, t, type MsgKey } from "../i18n";
import { defaultSettings, parseSettings } from "../settings/schema";
import { isDefiniteRefusal } from "../telegram/client";
import { sendText } from "../telegram/send";
import { errorText } from "../util/errors";
import { log } from "../util/log";
import type { BotDeps } from "./dispatch";

/**
 * A transient failure (network, 429, 5xx) throws, so the webhook answers 500 and Telegram
 * redelivers the update later: a Telegram hiccup must not make the bot leave the owner's group.
 */
async function ownerIsMember(deps: BotDeps, chatId: number): Promise<boolean> {
  try {
    const m = await deps.tg.getChatMember(chatId, deps.env.TELEGRAM_OWNER_ID);
    if (m.status === "creator" || m.status === "administrator" || m.status === "member") return true;
    if (m.status === "restricted" && m.is_member) return true;
    log("bot.owner_not_member", { chat_id: chatId, status: m.status });
    return false;
  } catch (err) {
    if (isDefiniteRefusal(err)) {
      log("bot.owner_not_member", { chat_id: chatId, refused: errorText(err) });
      return false;
    }
    log("bot.owner_check_failed", { chat_id: chatId, error: errorText(err) });
    throw err;
  }
}

/**
 * Posts `textKey` with the group's settings button (the Mini App link carrying the group token).
 * The one place that builds that button: the welcome and the /settings command both use it.
 */
export async function postSettingsButton(
  deps: Pick<BotDeps, "tg" | "botUsername" | "env">,
  group: Group,
  textKey: Extract<MsgKey, "welcome" | "settingsCommand">,
  opts: { replyTo?: number; threadId?: number | null } = {},
): Promise<void> {
  const lang = parseSettings(group.settings).language;
  const url = `https://t.me/${deps.botUsername}/${deps.env.TELEGRAM_MINIAPP_SHORT_NAME}?startapp=${group.token}`;
  await sendText(deps.tg, group.chatId, t(lang, textKey), {
    ...opts,
    buttons: [[{ text: t(lang, "settingsButton"), url }]],
  });
}

/**
 * The group row for a chat the bot is in, creating it when the owner is a member. Returns
 * null (after leaving the chat) when the owner is not. An active group returns at once, so a
 * redelivered join never posts a second welcome.
 */
export async function ensureGroup(
  deps: BotDeps,
  chat: Pick<Chat, "id"> & { title?: string },
  adder: User | undefined,
): Promise<Group | null> {
  const existing = await getGroup(deps.db, chat.id);
  if (existing?.active) return existing;

  if (!(await ownerIsMember(deps, chat.id))) {
    log("bot.leaving_group", {
      chat_id: chat.id,
      adder_id: adder?.id ?? null,
      adder_name: adder ? [adder.first_name, adder.last_name].filter(Boolean).join(" ") : null,
      adder_username: adder?.username ?? null,
    });
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
  await postSettingsButton(deps, group, "welcome");
  return group;
}
