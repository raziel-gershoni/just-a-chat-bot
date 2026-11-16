import type { Message } from "grammy/types";
import type { NewMessage } from "../db/repo/messages";
import type { MessageMedia } from "../db/schema";

type OtherLabel = "video" | "voice" | "animation" | "audio" | "document" | "sticker";

function mediaOf(msg: Message): MessageMedia | null {
  if (msg.photo?.length) {
    const largest = msg.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    return { kind: "photo", fileId: largest.file_id, fileSize: largest.file_size, label: "photo" };
  }
  // An animation message also carries `document`, so it is checked first.
  if (msg.animation) return other("animation");
  if (msg.document) {
    if (msg.document.mime_type === "application/pdf") {
      return {
        kind: "pdf",
        fileId: msg.document.file_id,
        fileSize: msg.document.file_size,
        mime: msg.document.mime_type,
        name: msg.document.file_name,
        label: "document",
      };
    }
    return other("document");
  }
  if (msg.sticker) {
    if (!msg.sticker.is_animated && !msg.sticker.is_video) {
      return { kind: "sticker", fileId: msg.sticker.file_id, fileSize: msg.sticker.file_size, label: "sticker" };
    }
    return other("sticker");
  }
  if (msg.video || msg.video_note) return other("video");
  if (msg.voice) return other("voice");
  if (msg.audio) return other("audio");
  return null;
}

function other(label: OtherLabel): MessageMedia {
  return { kind: "other", label };
}

/**
 * Pure: the message this one really replies to. In a forum topic Telegram sets
 * `reply_to_message` to the topic's root on every ordinary message; that is not a reply.
 */
export function replyTarget(msg: Message): Message["reply_to_message"] | undefined {
  const r = msg.reply_to_message;
  if (r && msg.is_topic_message && r.message_id === msg.message_thread_id) return undefined;
  return r;
}

// grammY's `Message.ServiceMessage & MsgWith<field>` variants: each is set only on a service message.
const SERVICE_FIELDS = [
  "new_chat_members", "left_chat_member", "new_chat_title", "new_chat_photo", "delete_chat_photo",
  "group_chat_created", "supergroup_chat_created", "channel_chat_created", "pinned_message",
  "message_auto_delete_timer_changed", "migrate_to_chat_id", "migrate_from_chat_id",
  "forum_topic_created", "forum_topic_edited", "forum_topic_closed", "forum_topic_reopened",
  "general_forum_topic_hidden", "general_forum_topic_unhidden",
  "video_chat_scheduled", "video_chat_started", "video_chat_ended", "video_chat_participants_invited",
  "users_shared", "chat_shared", "write_access_allowed", "proximity_alert_triggered", "boost_added",
  "chat_background_set", "paid_message_price_changed", "direct_message_price_changed",
  "chat_owner_left", "chat_owner_changed", "managed_bot_created", "poll_option_added", "poll_option_deleted",
  "checklist_tasks_done", "checklist_tasks_added", "giveaway_created", "giveaway_completed",
  "successful_payment", "refunded_payment", "gift_upgrade_sent", "web_app_data",
] as const;

/**
 * Pure: a service message (join, leave, pin, title change...), by its service fields. Polls,
 * locations, venues, contacts, dice and the like are user content, not service messages.
 */
export function isServiceMessage(msg: Message): boolean {
  return SERVICE_FIELDS.some((f) => (msg as unknown as Record<string, unknown>)[f] != null);
}

/** Pure: a Telegram message as a row for the messages table. */
export function messageToRow(msg: Message): NewMessage {
  const from = msg.from;
  const fromName = from
    ? [from.first_name, from.last_name].filter(Boolean).join(" ")
    : (msg.sender_chat?.title ?? "");
  return {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    threadId: msg.is_topic_message ? (msg.message_thread_id ?? null) : null,
    fromId: from?.id ?? null,
    fromName,
    isBot: !msg.sender_chat && (from?.is_bot ?? false),
    date: new Date(msg.date * 1000),
    text: msg.text ?? msg.caption ?? "",
    entities: msg.entities ?? msg.caption_entities ?? null,
    replyToId: replyTarget(msg)?.message_id ?? null,
    media: mediaOf(msg),
    mediaGroupId: msg.media_group_id ?? null,
  };
}
