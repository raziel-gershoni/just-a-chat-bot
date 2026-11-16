import type { CallbackQuery, ChatMemberUpdated, Message, MessageReactionUpdated, Update } from "grammy/types";
import type { Env } from "../config/env";
import { getGroup, markAdminHintSent, migrateChat, setGroupActive } from "../db/repo/groups";
import { claimReactionRun, getMessage, insertMessage, updateMessageText } from "../db/repo/messages";
import { createRun } from "../db/repo/runs";
import type { Db } from "../db/types";
import { t } from "../i18n";
import { parseSettings } from "../settings/schema";
import { sendText } from "../telegram/send";
import type { TgApi } from "../telegram/types";
import { log } from "../util/log";
import { ensureGroup } from "./access";
import { messageToRow } from "./ingest";
import { handlePrivateMessage } from "./private";
import { detectTrigger, reactionTrigger } from "./triggers";

export type BotDeps = {
  db: Db;
  tg: TgApi;
  env: Pick<Env, "TELEGRAM_OWNER_ID" | "TELEGRAM_MINIAPP_SHORT_NAME">;
  botId: number;
  botUsername: string;
  enqueue(chatId: number, delayMs?: number): void;
  chime: { onHumanMessage(chatId: number): void };
  onCallback(q: CallbackQuery): Promise<void>;
  /** Fire-and-forget; logs its own failures. */
  deleteFiles(ids: string[]): void;
  now(): Date;
};

const ALBUM_WAIT_MS = 2000;
const isGroupChat = (type: string) => type === "group" || type === "supergroup";
const ignored = (reason: string, fields: Record<string, unknown> = {}) => log("bot.ignored", { reason, ...fields });
const fullName = (u: { first_name: string; last_name?: string }) =>
  [u.first_name, u.last_name].filter(Boolean).join(" ");

/** Routes one update. Throws on DB failure so the webhook route can answer 500 and Telegram retries. */
export async function handleUpdate(update: Update, deps: BotDeps): Promise<void> {
  if (update.my_chat_member) return onMyChatMember(update.my_chat_member, deps);
  if (update.chat_member) return onChatMember(update.chat_member, deps);
  if (update.message) return onMessage(update.message, deps);
  if (update.edited_message) return onEdited(update.edited_message, deps);
  if (update.message_reaction) return onReaction(update.message_reaction, deps);
  if (update.callback_query) return deps.onCallback(update.callback_query);
  ignored("unhandled_update_kind", { update_id: update.update_id });
}

async function onMyChatMember(u: ChatMemberUpdated, deps: BotDeps): Promise<void> {
  const chat = u.chat;
  if (u.new_chat_member.user.id !== deps.botId) return ignored("not_about_bot", { chat_id: chat.id });
  const from = u.old_chat_member.status;
  const to = u.new_chat_member.status;
  if (chat.type === "channel") {
    await deps.tg.leaveChat(chat.id);
    return ignored("channel_left", { chat_id: chat.id });
  }
  if (!isGroupChat(chat.type)) return ignored("private_member_change", { chat_id: chat.id, status: to });

  if (to === "left" || to === "kicked") {
    await setGroupActive(deps.db, chat.id, false);
    return;
  }
  if ((to === "member" || to === "administrator") && (from === "left" || from === "kicked")) {
    const group = await ensureGroup(deps, chat, u.from);
    if (group && to === "member" && !group.adminHintSent) {
      await sendText(deps.tg, chat.id, t(parseSettings(group.settings).language, "adminHint"));
      await markAdminHintSent(deps.db, chat.id);
    }
    return;
  }
  ignored("member_change_noop", { chat_id: chat.id, from, to });
}

async function onChatMember(u: ChatMemberUpdated, deps: BotDeps): Promise<void> {
  if (u.new_chat_member.user.id !== deps.env.TELEGRAM_OWNER_ID) return ignored("not_owner", { chat_id: u.chat.id });
  const to = u.new_chat_member.status;
  if (to !== "left" && to !== "kicked") return ignored("owner_still_here", { chat_id: u.chat.id, status: to });
  await deps.tg.leaveChat(u.chat.id);
  await setGroupActive(deps.db, u.chat.id, false);
}

async function onMessage(msg: Message, deps: BotDeps): Promise<void> {
  const chat = msg.chat;
  if (chat.type === "private") return handlePrivateMessage(msg, deps);
  if (!isGroupChat(chat.type)) return ignored("chat_type", { chat_id: chat.id, type: chat.type });

  if (msg.migrate_to_chat_id !== undefined) {
    await migrateChat(deps.db, chat.id, msg.migrate_to_chat_id);
    return;
  }
  if (msg.from?.is_bot) return ignored("from_bot", { chat_id: chat.id });

  const group = await ensureGroup(deps, chat, msg.from);
  if (!group) return;
  const stored = await insertMessage(deps.db, messageToRow(msg));
  if (!stored) return ignored("duplicate_message", { chat_id: chat.id, message_id: msg.message_id });
  if (stored.pruned.length) deps.deleteFiles(stored.pruned);

  const trigger = detectTrigger(msg, deps);
  if (trigger) {
    await createRun(deps.db, {
      chatId: chat.id,
      threadId: stored.threadId,
      trigger: {
        type: trigger,
        messageId: msg.message_id,
        targetMessageId: msg.message_id,
        requesterId: msg.from?.id ?? null,
        requesterName: msg.from ? fullName(msg.from) : null,
      },
    });
    deps.enqueue(chat.id, msg.media_group_id ? ALBUM_WAIT_MS : 0);
    return;
  }
  if (parseSettings(group.settings).chime.enabled) deps.chime.onHumanMessage(chat.id);
  else ignored("no_trigger_chime_off", { chat_id: chat.id });
}

async function onEdited(msg: Message, deps: BotDeps): Promise<void> {
  if (!isGroupChat(msg.chat.type)) return ignored("edit_not_group", { chat_id: msg.chat.id });
  await updateMessageText(
    deps.db,
    msg.chat.id,
    msg.message_id,
    msg.text ?? msg.caption ?? "",
    msg.entities ?? msg.caption_entities ?? null,
  );
}

async function onReaction(r: MessageReactionUpdated, deps: BotDeps): Promise<void> {
  const chatId = r.chat.id;
  const group = await getGroup(deps.db, chatId);
  if (!group?.active) return ignored("reaction_inactive_group", { chat_id: chatId });
  if (!reactionTrigger(r, parseSettings(group.settings).triggerEmoji)) {
    return ignored("reaction_not_trigger", { chat_id: chatId });
  }
  const stored = await getMessage(deps.db, chatId, r.message_id);
  if (!stored) {
    return ignored("reaction_message_unknown", { chat_id: chatId, message_id: r.message_id });
  }
  if (!(await claimReactionRun(deps.db, chatId, r.message_id))) {
    return ignored("reaction_already_ran", { chat_id: chatId, message_id: r.message_id });
  }
  await createRun(deps.db, {
    chatId,
    threadId: stored.threadId,
    trigger: {
      type: "reaction",
      messageId: r.message_id,
      targetMessageId: r.message_id,
      requesterId: r.user?.id ?? null,
      requesterName: r.user ? fullName(r.user) : null,
      emoji: parseSettings(group.settings).triggerEmoji,
    },
  });
  deps.enqueue(chatId);
}
